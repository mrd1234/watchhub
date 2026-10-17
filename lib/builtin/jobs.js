// jobs: one-off runs queued in <instance>/jobs.json (`watchhub add-job '<json>'`): each is polled
// until it ends, its result reported once, then dropped. Kinds:
//   {"kind":"gh-run","repo":"owner/name","id":"123","label":"x"}                       GitHub Actions run (REST, ETag)
//   {"kind":"codebuild","ids":["proj:uuid"],"profile":"p","region":"r","label":"x"}    (or "id")
//   {"kind":"codepipeline","pipeline":"name","id":"execution-id","profile":"p","region":"r","label":"x"}
//   {"kind":"amplify","app":"appId","branch":"b","id":"jobId","profile":"p","region":"r","label":"x"}
// Any entry may set "scope"; otherwise the scope rules match the label. A malformed entry is
// reported once and dropped; an entry that cannot be read is reported at the third failure and
// dropped at the fiftieth, so a dead job never polls forever.
const fs = require("fs");
const { readJson, writeAtomic, withFileLock } = require("../util");

module.exports = (api) => {
  const aws = (j, args) => api.runJson("aws", [...args, "--profile", j.profile, "--region", j.region, "--output", "json"], 30);
  // Final status, or null while the job is still going.
  const STATUS = {
    async codebuild(j) {
      const { builds = [] } = await aws(j, ["codebuild", "batch-get-builds", "--ids", ...(j.ids || [j.id])]);
      if (!builds.length) throw new Error("build not found");
      const s = builds.map((b) => b.buildStatus);
      if (s.includes("IN_PROGRESS")) return null;
      return s.every((x) => x === "SUCCEEDED") ? "SUCCEEDED" : s.find((x) => x !== "SUCCEEDED");
    },
    async codepipeline(j) {
      const { pipelineExecution: e } = await aws(j, ["codepipeline", "get-pipeline-execution", "--pipeline-name", j.pipeline, "--pipeline-execution-id", j.id]);
      return ["InProgress", "Stopping"].includes(e.status) ? null : e.status.toUpperCase();
    },
    async amplify(j) {
      const { job } = await aws(j, ["amplify", "get-job", "--app-id", j.app, "--branch-name", j.branch, "--job-id", String(j.id)]);
      const s = job.summary.status;
      return ["PENDING", "PROVISIONING", "RUNNING", "CANCELLING"].includes(s) ? null : s === "SUCCEED" ? "SUCCEEDED" : s;
    },
    async "gh-run"(j, st, next, cfg) {
      const r = await api.ghGet(`repos/${j.repo}/actions/runs/${j.id}`, st.etags || {}, next, (x) => ({ status: x.status, conclusion: x.conclusion }), cfg);
      return r.status === "completed" ? (r.conclusion || "completed").toUpperCase() : null;
    },
  };
  const valid = (j) => j && STATUS[j.kind] && (j.kind === "gh-run" ? j.repo && j.id : j.kind === "codebuild" ? (j.id || (j.ids && j.ids.length)) && j.profile && j.region : j.id && j.profile && j.region);

  return {
    name: "jobs",
    env: ["GITHUB_TOKEN|GH_TOKEN?"],
    intervalSec: 60,
    enabled: (cfg) => cfg.probes?.jobs !== false,
    async check(st = {}, cfg, env) {
      const file = api.paths.jobs;
      const jobs = readJson(file, []);
      const events = [], done = new Set(), errors = {}, next = {}, said = new Set();
      const say = (scope, text) => { const k = text.replace(/^JOB /, ""); if (said.has(k)) return; said.add(k); events.push({ scope, text }); };   // two queue entries for one job: one line
      for (const j of jobs) {
        const label = j.label || `${j.kind} ${j.id || (j.ids || []).join(",")}`;
        const scope = j.scope || api.scopeOf(cfg, { label });
        if (!valid(j)) { events.push({ scope, text: `JOB ${label} dropped: malformed entry (${j.kind ? "kind " + j.kind : "no kind"})` }); done.add(j.key); continue; }
        try {
          const s = await STATUS[j.kind](j, st, next, cfg);
          if (s) { say(scope, `JOB ${label} ${s}`); done.add(j.key); }
        } catch (e) {
          const n = (j.errors || 0) + 1;
          errors[j.key] = n;
          if (n === 3) events.push({ scope, text: `JOB ${label} cannot be read: ${e.message.slice(0, 120)}` });
          if (n >= 50) { events.push({ scope, text: `JOB ${label} dropped after ${n} failed reads: ${e.message.slice(0, 100)}` }); done.add(j.key); }
        }
      }
      // re-read under the queue lock so a job added while we were polling is kept, and no add-job is lost
      const left = withFileLock(file, () => {
        const l = readJson(file, []).filter((j) => !done.has(j.key)).map((j) => ({ ...j, errors: j.key in errors ? errors[j.key] : (j.errors || 0) }));
        if (jobs.length || l.length) writeAtomic(file, JSON.stringify(l, null, 1));
        return l;
      });
      return { events, state: { pending: left.map((j) => j.label || j.key), etags: next } };
    },
    now: (d) => ((d.pending || []).length ? `${d.pending.length} pending: ${d.pending.join(", ")}` : "none pending"),
  };
};
