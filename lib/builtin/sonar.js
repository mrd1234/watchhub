// sonar: SonarCloud (or SonarQube) quality gates, as the probe `sonar`.
//   SONAR <project>@<branch> gate OK -> ERROR             a branch's gate changing
//   SONAR <project>#<pr> gate ERROR: <title>              a pull request's first verdict, or a change (OK -> ERROR)
//   SONAR <project> [pull requests] failing: HTTP 404 ... / works again   a project (or its pull requests) that cannot be read; the rest go on
// Switched on by an instance.json `sonar` section:
//   "sonar": { "base": "https://sonarcloud.io", "scope": "quality", "tokenEnv": "SONAR_TOKEN",
//              "projects": ["acme_api", { "key": "acme_web", "branches": ["main", "release"], "pullRequests": true, "scope": "web" }] }
// A project named alone watches its main branch. Token: SONAR_TOKEN (or sonar.tokenEnv) from the
// environment or ~/.watchhub/env, optional for public projects. Two requests per project per poll at
// most (its branches, its pull requests); a project's first poll only records the gates.
module.exports = (api) => ({
  name: "sonar",
  env: (cfg) => [`${cfg.sonar?.tokenEnv || "SONAR_TOKEN"}?`],
  intervalSec: 120,
  enabled: (cfg) => !!cfg.sonar?.projects?.length && cfg.probes?.sonar !== false,
  async check(st, cfg, env) {
    const s = cfg.sonar, base = (s.base || "https://sonarcloud.io").replace(/\/+$/, ""), token = env[s.tokenEnv || "SONAR_TOKEN"];
    const headers = { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    // known: what has had its first poll, `key` for a project's branches and `key#` for its pull
    // requests, so switching pullRequests on later records the open ones instead of reporting them all
    const prev = st?.gates || {}, known = new Set(st?.projects || []), gates = {}, events = [], seen = [], scopes = {};
    const entries = s.projects.flatMap((p) => {
      const e = typeof p === "string" ? { key: p } : p, q = `project=${encodeURIComponent(e.key)}`;
      const scope = e.scope || s.scope || api.scopeOf(cfg, { label: e.key });
      const prKey = `${e.key} pull requests`;
      scopes[e.key] = scopes[prKey] = scope;
      const say = (first, id, now, pr) => {
        const was = prev[id];
        gates[id] = now || was;                                   // an analysis pending (no status for a while) keeps the last verdict
        if (first || !now || was === now) return;                 // a first poll, an analysis still pending, or no change
        if (was === undefined && !pr) return;                     // a branch newly named in config: recorded, not news
        events.push({ scope, text: `SONAR ${id} gate ${was ? `${was} -> ` : ""}${now}${pr?.title ? `: ${api.oneLine(pr.title, 80)}` : ""}` });
      };
      // branches and pull requests are read apart (a token may see one and not the other); a part that
      // cannot be read keeps its gates and its first-poll mark until it can
      const part = (key, mark, pre, read) => ({
        key,
        keep: () => { for (const id of Object.keys(prev)) if (id.startsWith(pre)) gates[id] = prev[id]; if (known.has(mark)) seen.push(mark); },
        run: async () => { await read(); seen.push(mark); },
      });
      const out = [part(e.key, e.key, `${e.key}@`, async () => {
        const { branches = [] } = await api.fetchJson(`${base}/api/project_branches/list?${q}`, { headers }, 20);
        for (const b of branches.filter((b) => (e.branches ? e.branches.includes(b.name) : b.isMain))) say(!known.has(e.key), `${e.key}@${b.name}`, b.status?.qualityGateStatus || null);
      })];
      if (e.pullRequests) out.push(part(prKey, `${e.key}#`, `${e.key}#`, async () => {
        const { pullRequests = [] } = await api.fetchJson(`${base}/api/project_pull_requests/list?${q}`, { headers }, 20);
        for (const r of pullRequests) say(!known.has(`${e.key}#`), `${e.key}#${r.key}`, r.status?.qualityGateStatus || null, { title: r.title || r.branch });
      }));
      return out;
    });
    const { failing, notes } = await api.perEntry(st?.failing, entries);
    for (const n of notes) events.push({ scope: scopes[n.key], text: `SONAR ${n.text}` });
    return { events, state: { projects: [...new Set(seen)], gates, failing } };
  },
  now: (d) => Object.entries(d.gates || {}).map(([k, g]) => `${k} ${g || "pending"}`).join(", ") || "nothing configured",
});
