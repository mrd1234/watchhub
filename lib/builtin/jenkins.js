// jenkins: finished builds of the jobs you name, as the probe `jenkins`.
//   BUILD <job> #812 SUCCESS | FAILURE | UNSTABLE | ABORTED
//   JENKINS <job> failing: HTTP 404 ... / JENKINS <job> works again     one job that cannot be read; the others go on
// Switched on by an instance.json `jenkins` section:
//   "jenkins": { "base": "https://ci.example.com", "scope": "builds",
//                "jobs": ["api-build", "folder/web-deploy"],            (folder and job names as Jenkins shows them, joined by /; a multibranch branch feature/x is the job feature%2Fx)
//                "userEnv": "JENKINS_USER", "tokenEnv": "JENKINS_TOKEN" }
// Auth: the user name and an API token from the environment or ~/.watchhub/env (both optional, for
// a server that lets anyone read). One request per job per poll, the latest ten builds; a build
// still running on the first poll is reported when it ends, older ones are only recorded.
module.exports = (api) => {
  const names = (j) => [j.userEnv || "JENKINS_USER", j.tokenEnv || "JENKINS_TOKEN"];
  return {
    name: "jenkins",
    env: (cfg) => names(cfg.jenkins || {}).map((n) => `${n}?`),
    intervalSec: 60,
    enabled: (cfg) => !!cfg.jenkins?.base && !!cfg.jenkins.jobs?.length && cfg.probes?.jenkins !== false,
    async check(st, cfg, env) {
      const j = cfg.jenkins, [u, t] = names(j).map((n) => env[n]);
      const headers = { Accept: "application/json", ...(u && t ? { Authorization: "Basic " + Buffer.from(`${u}:${t}`).toString("base64") } : {}) };
      const base = j.base.replace(/\/+$/, ""), prev = st?.jobs || {}, jobs = {}, events = [];
      const scopeOf = (job) => j.scope || api.scopeOf(cfg, { label: job });
      const { failing, notes } = await api.perEntry(st?.failing, j.jobs.map((job) => ({
        key: job,
        keep: () => { if (prev[job]) jobs[job] = prev[job]; },
        run: async () => {
          const url = `${base}/${job.split("/").map((p) => `job/${encodeURIComponent(p)}`).join("/")}/api/json?tree=builds[number,result,building]{0,10}`;
          const { builds = [] } = await api.fetchJson(url, { headers }, 20);
          const out = api.finished(prev[job]?.seen, builds.map((b) => ({ id: b.number, done: !b.building && !!b.result, result: b.result })));
          for (const b of out.done.reverse()) events.push({ scope: scopeOf(job), text: `BUILD ${job} #${b.id} ${b.result}` });   // the API lists newest first
          jobs[job] = { seen: out.seen, last: builds[0] ? `#${builds[0].number} ${builds[0].building ? "running" : builds[0].result}` : "no builds" };
        },
      })));
      for (const n of notes) events.push({ scope: scopeOf(n.key), text: `JENKINS ${n.text}` });
      return { events, state: { jobs, failing } };
    },
    now: (d) => Object.entries(d.jobs || {}).map(([n, x]) => `${n} ${x.last}`).join(", ") || "no jobs",
  };
};
