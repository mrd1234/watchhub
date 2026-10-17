// deploys: finished AWS CodePipeline executions and Amplify jobs, as the probe `deploys`, through the
// aws CLI and its own profiles (sign in with `aws sso login`; the `aws` section's aws-auth probe says
// when a session expires).
//   DEPLOY <pipeline> 1a2b3c4d SUCCEEDED | FAILED | STOPPED | SUPERSEDED | CANCELLED
//   DEPLOY <name> job 42 SUCCEEDED | FAILED | CANCELLED
//   DEPLOY <name> failing: ... / DEPLOY <name> works again       one that cannot be read; the others go on
// Switched on by an instance.json `deploys` section; profile, region and scope at the top apply to
// every entry that does not set its own:
//   "deploys": { "profile": "deploy", "region": "eu-west-2", "scope": "release",
//                "pipelines": ["api-pipeline", { "name": "web-pipeline", "region": "us-east-1" }],
//                "amplify": [{ "app": "d1a2b3c4", "branch": "main", "name": "web" }] }
// One aws call per pipeline or branch per poll, the latest five runs; a run still going on the first
// poll is reported when it ends, older ones are only recorded.
const RUNNING = new Set(["INPROGRESS", "STOPPING", "PENDING", "PROVISIONING", "RUNNING", "CANCELLING"]);

module.exports = (api) => ({
  name: "deploys",
  intervalSec: 120,
  enabled: (cfg) => !!(cfg.deploys?.pipelines?.length || cfg.deploys?.amplify?.length) && cfg.probes?.deploys !== false,
  async check(st, cfg) {
    const d = cfg.deploys, prev = st?.runs || {}, runs = {}, events = [];
    const aws = (e, args) => {
      const profile = e.profile || d.profile, region = e.region || d.region;
      if (!profile || !region) throw new Error(`deploys entry ${e.name || e.app} needs a profile and a region (its own or the section's)`);
      return api.runJson("aws", [...args, "--profile", profile, "--region", region, "--output", "json"], 30);
    };
    const report = (key, label, e, list) => {
      const out = api.finished(prev[key]?.seen, list);
      const scope = e.scope || d.scope || api.scopeOf(cfg, { label });
      for (const r of out.done.reverse()) events.push({ scope, text: `DEPLOY ${label} ${r.label} ${r.status}` });   // both APIs list newest first
      runs[key] = { seen: out.seen, last: list[0] ? `${list[0].label} ${list[0].done ? list[0].status : "running"}` : "no runs" };
    };
    const status = (s) => (s === "SUCCEED" ? "SUCCEEDED" : s);
    const entries = [], labels = {}, scopes = {};
    const entry = (key, label, e, run) => { labels[key] = label; scopes[key] = e.scope || d.scope || api.scopeOf(cfg, { label }); entries.push({ key, run, keep: () => { if (prev[key]) runs[key] = prev[key]; } }); };
    for (const p of d.pipelines || []) {
      const e = typeof p === "string" ? { name: p } : p;
      entry(`pipeline:${e.name}`, e.name, e, async () => {
        const { pipelineExecutionSummaries: x = [] } = await aws(e, ["codepipeline", "list-pipeline-executions", "--pipeline-name", e.name, "--max-items", "5"]);
        report(`pipeline:${e.name}`, e.name, e, x.map((r) => { const s = String(r.status).toUpperCase(); return { id: r.pipelineExecutionId, label: String(r.pipelineExecutionId).slice(0, 8), status: s, done: !RUNNING.has(s) }; }));
      });
    }
    for (const e of d.amplify || []) {
      const label = e.name || `${e.app}/${e.branch}`;
      entry(`amplify:${e.app}/${e.branch}`, label, e, async () => {
        const { jobSummaries: x = [] } = await aws(e, ["amplify", "list-jobs", "--app-id", e.app, "--branch-name", e.branch, "--max-results", "5"]);
        report(`amplify:${e.app}/${e.branch}`, label, e, x.map((r) => ({ id: r.jobId, label: `job ${r.jobId}`, status: status(String(r.status).toUpperCase()), done: !RUNNING.has(String(r.status).toUpperCase()) })));
      });
    }
    // one pipeline or app that cannot be read (gone, a profile not signed in) does not stop the rest
    const { failing, notes } = await api.perEntry(st?.failing, entries);
    for (const n of notes) events.push({ scope: scopes[n.key], text: `DEPLOY ${n.text.replace(n.key, labels[n.key])}` });
    return { events, state: { runs, failing } };
  },
  now: (s) => Object.entries(s.runs || {}).map(([k, r]) => `${k.replace(/^\w+:/, "")} ${r.last}`).join(", ") || "nothing configured",
});
