// datadog: monitors, metric thresholds and log counts, as the probe `datadog`.
//   MONITOR <name> Alert|OK                              a monitor group entering Alert, or leaving it (OK after Alert)
//   METRIC <name> above 85: 91 (3 polls) / back          a query's latest point past a bound (hysteresis in polls)
//   LOGS <name> 23 in 5m (threshold 10) / back           a log search returning more hits than the threshold
// Switched on by an instance.json `datadog` section:
//   "datadog": { "site": "datadoghq.eu", "scope": "team",
//                "monitors": { "hosts": ["staging-api", "prod-api", "db-1"], "states": ["Alert"], "minGapMin": 30 },
//                "monitorTags": ["env:staging"],
//                "metrics": [{ "name": "api-cpu", "query": "avg:system.cpu.user{host:staging-api}", "window": "5m", "above": 85, "for": 3,
//                               "unit": "%", "display": { "type": "dial", "min": 0, "max": 100 } }],   (unit and display optional: see metrics.js)
//                "logs":    [{ "name": "api-errors", "query": "service:web-api status:error", "window": "5m", "over": 10 }] }
// Auth: a personal access token in DD_PAT (Bearer), else DD_API_KEY and DD_APP_KEY; from the
// environment or ~/.watchhub/env, never in a file here.
// One request per monitor list, per metric and per log search, each poll; nothing is paged.
const { parseDuration } = require("../util");
const { detect } = require("../diff");

const base = (cfg) => `https://api.${cfg.datadog.site || "datadoghq.com"}`;
const headers = (env) => {
  if (env.DD_PAT) return { Authorization: `Bearer ${env.DD_PAT}`, "Content-Type": "application/json" };
  if (!env.DD_API_KEY || !env.DD_APP_KEY) throw new Error("DD_PAT (or DD_API_KEY and DD_APP_KEY) not set (put it in ~/.watchhub/env)");
  return { "DD-API-KEY": env.DD_API_KEY, "DD-APPLICATION-KEY": env.DD_APP_KEY, "Content-Type": "application/json" };
};

module.exports = (api) => ({
  headers,
  name: "datadog",
  env: ["DD_PAT|DD_API_KEY", "DD_APP_KEY?"],   // a personal token alone, or an API key with its application key
  intervalSec: 60,
  enabled: (cfg) => !!cfg.datadog && cfg.probes?.datadog !== false,
  async check(st, cfg, env) {
    const d = cfg.datadog, H = headers(env), now = Math.floor(Date.now() / 1000);
    const state = { monitors: {}, metrics: {}, logs: {}, ...(st || {}) };
    const events = [], scope = d.scope, metrics = [];
    const push = (text) => events.push(scope ? { scope, text } : text);
    if (d.monitors) {
      // monitors: true relays every group; an object narrows it: hosts (substrings matched against the group,
      // the monitor's tags and its resolved name; empty = all), states to relay (default Alert, plus the
      // recovery to OK from a relayed state), minGapMin between lines for the same group (default 30)
      const mo = typeof d.monitors === "object" ? d.monitors : {};
      const hosts = (mo.hosts || []).map((h) => String(h).toLowerCase());
      const states = new Set(mo.states || ["Alert"]);
      const gapMs = (mo.minGapMin ?? 30) * 60000;
      const params = [`group_states=alert,warn,no%20data`, ...(d.monitorTags?.length ? [`monitor_tags=${d.monitorTags.map(encodeURIComponent).join(",")}`] : [])];
      const list = await api.fetchJson(`${base(cfg)}/api/v1/monitor?${params.join("&")}`, { headers: H }, 20);
      const next = {}, nowMs = Date.now();
      const allowed = (text) => !hosts.length || hosts.some((h) => text.toLowerCase().includes(h));
      for (const m of list) {
        // one entry per group (host, instance, service...) when the monitor reports groups; the monitor itself otherwise
        const groups = m.state?.groups && Object.keys(m.state.groups).length ? Object.entries(m.state.groups).map(([g, x]) => [g, x.status || "OK"]) : [["", m.overall_state || "OK"]];
        for (const [group, raw] of groups) {
          const s = { ok: "OK", alert: "Alert", warn: "Warn", "no data": "No Data" }[String(raw).toLowerCase()] || String(raw);   // group statuses come lower-case
          const key = `${m.id}${group ? ":" + group : ""}`;
          const tags = Object.fromEntries(group.split(",").map((t) => t.split(":")).filter((p) => p.length === 2));
          const name = api.oneLine(String(m.name).replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, k) => tags[k.replace(/\.name$/, "")] || tags[k] || k), 80);
          const prev = state.monitors[key] || {};
          next[key] = { s, at: prev.at, last: prev.last };
          if (prev.s === undefined || prev.s === s) continue;
          if (!allowed(`${group} ${(m.tags || []).join(" ")} ${name}`)) continue;
          const relay = states.has(s) || (s === "OK" && states.has(prev.last || ""));   // a recovery counts only from a relayed state
          if (!relay) continue;
          if (prev.at && nowMs - prev.at < gapMs) continue;   // a flap: one line per group per gap
          push(`MONITOR ${name}${group ? ` [${group}]` : ""} ${s}`);
          next[key] = { s, at: nowMs, last: s };
        }
      }
      state.monitors = next;
    }
    for (const m of d.metrics || []) {
      const from = now - parseDuration(m.window || "5m");
      const r = await api.fetchJson(`${base(cfg)}/api/v1/query?from=${from}&to=${now}&query=${encodeURIComponent(m.query)}`, { headers: H }, 20);
      const point = r.series?.[0]?.pointlist?.filter((p) => p[1] != null).at(-1)?.[1];   // the newest bucket is often still empty (CloudWatch metrics land minutes late)
      const spec = { value: "v", above: m.above, below: m.below, for: m.for };
      if (spec.above === undefined && spec.below === undefined) throw new Error(`metric ${m.name} needs above or below`);
      const out = detect(spec, state.metrics[m.name], { v: point });
      state.metrics[m.name] = out.state;
      for (const e of out.events) push(`METRIC ${m.name} ${e.replace(/^value v /, "")}`);
      metrics.push({ name: m.name, scope, value: Number.isFinite(point) ? point : null, description: m.description, unit: m.unit, display: m.display, above: m.above, below: m.below, past: !!out.state.past });
    }
    for (const l of d.logs || []) {
      const from = now - parseDuration(l.window || "5m");
      const r = await api.fetchJson(`${base(cfg)}/api/v2/logs/events/search`, { method: "POST", headers: H, body: JSON.stringify({ filter: { query: l.query, from: new Date(from * 1000).toISOString(), to: new Date(now * 1000).toISOString() }, page: { limit: Math.min(1000, Number(l.over) + 1) } }) }, 20);
      const n = (r.data || []).length;
      const was = !!state.logs[l.name]?.over, past = n > Number(l.over);
      if (past && !was) push(`LOGS ${l.name} ${n}${n > Number(l.over) ? "+" : ""} in ${l.window || "5m"} (threshold ${l.over})`);
      if (!past && was) push(`LOGS ${l.name} back: ${n} in ${l.window || "5m"}`);
      state.logs[l.name] = { over: past, n };
    }
    return { events, state, metrics };   // [] when none are set, which clears any taken out
  },
  now: (s) => [
    Object.keys(s.monitors || {}).length ? `${Object.values(s.monitors).filter((x) => (x.s || x) !== "OK").length} of ${Object.keys(s.monitors).length} monitor groups not OK` : null,
    ...Object.entries(s.metrics || {}).map(([n, m]) => `${n} ${m.value ?? "?"}${m.past ? " PAST" : ""}`),
    ...Object.entries(s.logs || {}).map(([n, l]) => `${n} ${l.n}${l.over ? " OVER" : ""}`),
  ].filter(Boolean).join(", ") || "nothing configured",
});
