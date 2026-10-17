// versions: the deployed build of a service per environment, as the probe `stamps`: one event
// (`STAMP <env> <label> <version>`) when the version an endpoint reports changes and holds for two
// polls (a rolling deploy answers old and new in turn). The first run records versions without
// reporting them; unreachable hosts are skipped, and only when none answers does the probe fail.
// Switched on by an instance.json `stamps` section:
//   "stamps": { "scope": "team", "label": "api", "path": "/api/version", "value": "data.commit.short",
//               "hosts": { "staging": "staging.api.example.com", "prod": "api.example.com" } }
// `value` is the path to the version inside the JSON the endpoint returns (default data.commit.short);
// `label` names what is stamped (default api). `hosts` values may carry a scheme; https is assumed.
module.exports = (api) => ({
  name: "stamps",
  intervalSec: 60,
  enabled: (cfg) => !!cfg.stamps?.hosts && cfg.probes?.stamps !== false,
  async check(st, cfg) {
    const { path: p = "/", hosts, value = "data.commit.short", label = "api" } = cfg.stamps;
    const next = { ...(st || {}) }, events = [];
    const got = await Promise.all(Object.entries(hosts).map(async ([env, host]) => {
      const url = /^https?:\/\//.test(host) ? `${host}${p}` : `https://${host}${p}`;
      try { const v = api.pick(await api.fetchJson(url, {}, 15), value); return [env, v == null ? null : String(v)]; } catch { return [env, null]; }
    }));
    if (got.every(([, s]) => !s)) throw new Error("no stamp host reachable");
    for (const [env, short] of got) {
      if (!short) continue;
      const prev = typeof st?.[env] === "string" ? { stamp: st[env], seen: st[env] } : st?.[env];
      if (!prev) { next[env] = { stamp: short, seen: short }; continue; }
      const agreed = prev.seen === short;
      if (agreed && prev.stamp !== short) events.push({ scope: cfg.stamps.scope || api.scopeOf(cfg, { label: env }), text: `STAMP ${env} ${label} ${short}` });
      next[env] = { stamp: agreed ? short : prev.stamp, seen: short };
    }
    return { events, state: next };
  },
  now: (d) => Object.entries(d).map(([e, s]) => `${e} ${s && s.stamp !== undefined ? s.stamp : s}`).join(", "),
});
