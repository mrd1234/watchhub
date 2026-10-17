const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const sources = require("../lib/sources");
const api = require("../lib/api");

const by = (name) => sources.builtins(() => {}).find((p) => p.name === name);

test("datadog module: monitor groups, allowlist, Alert and its recovery only, flap gap; metric thresholds; log counts", async (t) => {
  let groups = { "host:staging-api": "OK", "host:prod-api": "OK" }, cpu = 40, logs = 2, seenKeys = null, monitorUrl = "";
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seenKeys = [req.headers["dd-api-key"], req.headers["dd-application-key"]]; if (req.url.startsWith("/api/v1/monitor")) monitorUrl = req.url;
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/api/v1/monitor")) return res.end(JSON.stringify([{ id: 1, name: "CPU high on {{host.name}}", tags: ["team:ops"], overall_state: "Alert", state: { groups: Object.fromEntries(Object.entries(groups).map(([g, st]) => [g, { status: st }])) } }, { id: 2, name: "Disk", overall_state: "Warn" }]));
      if (req.url.startsWith("/api/v1/query")) return res.end(JSON.stringify({ series: [{ pointlist: [[1, 10], [2, cpu], [3, null]] }] }));
      if (req.url === "/api/v2/logs/events/search") { const lim = JSON.parse(b).page.limit; return res.end(JSON.stringify({ data: Array.from({ length: Math.min(logs, lim) }, (_, i) => ({ id: i })) })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dd = by("datadog");
  const realBase = `http://127.0.0.1:${srv.address().port}`;
  const origFetch = api.fetchJson;
  api.fetchJson = (url, opts, tm) => origFetch(url.replace(/^https:\/\/api\.test\.local/, realBase), opts, tm);
  t.after(() => { api.fetchJson = origFetch; });
  const cfg = { datadog: { site: "test.local", scope: "staging", monitors: { hosts: ["staging-api"], minGapMin: 30 }, metrics: [{ name: "cpu", description: "d", query: "avg:cpu{*}", above: 85, for: 2 }], logs: [{ name: "errors", query: "status:error", window: "5m", over: 3 }] } };
  const env = { DD_API_KEY: "k", DD_APP_KEY: "a" };
  await assert.rejects(dd.check(undefined, cfg, {}, api), /DD_PAT \(or DD_API_KEY and DD_APP_KEY\) not set/);
  assert.deepEqual(dd.headers({ DD_PAT: "p" }), { Authorization: "Bearer p", "Content-Type": "application/json" });
  let s = await dd.check(undefined, cfg, env, api);
  assert.deepEqual(s.events, []);                                   // first sight: baselines
  assert.deepEqual(seenKeys, ["k", "a"]); assert.match(monitorUrl, /group_states=alert,warn,no%20data/);
  groups["host:staging-api"] = "Alert"; groups["host:prod-api"] = "Alert"; cpu = 90; logs = 5;
  s = await dd.check(s.state, cfg, env, api);
  assert.deepEqual(s.events, [{ scope: "staging", text: "MONITOR CPU high on staging-api [host:staging-api] Alert" }, { scope: "staging", text: "LOGS errors 4+ in 5m (threshold 3)" }]);   // prod-api is not allowlisted; cpu needs two polls
  groups["host:staging-api"] = "Warn";                                  // Warn is not relayed, and a flap inside the gap is not either
  s = await dd.check(s.state, cfg, env, api);
  assert.deepEqual(s.events.map((e) => e.text), ["METRIC cpu above 85: 90 (2 polls)"]);
  groups["host:staging-api"] = "OK"; cpu = 30; logs = 0;
  s = await dd.check(s.state, cfg, env, api);
  assert.deepEqual(s.events.map((e) => e.text), ["METRIC cpu back, not above 85: 30", "LOGS errors back: 0 in 5m"]);   // the recovery is held by the 30 min gap
  s.state.monitors["1:host:staging-api"].at -= 31 * 60000;             // the gap has passed: the recovery from Alert goes out
  groups["host:staging-api"] = "Alert";
  s = await dd.check(s.state, cfg, env, api);
  assert.deepEqual(s.events.map((e) => e.text), ["MONITOR CPU high on staging-api [host:staging-api] Alert"]);
  s.state.monitors["1:host:staging-api"].at -= 31 * 60000; groups["host:staging-api"] = "OK";
  s = await dd.check(s.state, cfg, env, api);
  assert.deepEqual(s.events.map((e) => e.text), ["MONITOR CPU high on staging-api [host:staging-api] OK"]);
  assert.match(dd.now(s.state), /of 3 monitor groups not OK, cpu 30, errors 0/);
  assert.equal(by("datadog").enabled({}), false);
});
