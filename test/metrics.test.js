const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const metrics = require("../lib/metrics");
const { detect } = require("../lib/diff");
const sources = require("../lib/sources");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-metrics-"));

test("metric block validation", () => {
  assert.doesNotThrow(() => metrics.checkDef({ description: "d", value: "(\\d+)G", unit: "GB", display: { type: "gauge", min: 0, max: 250, lowIsBad: true } }));
  assert.doesNotThrow(() => metrics.checkDef({ description: "d", display: { type: "custom:heatmap" } }));
  assert.doesNotThrow(() => metrics.checkDescription("memory each session uses"));
  for (const d of [undefined, "  ", 3, "x".repeat(401)]) assert.throws(() => metrics.checkDescription(d), /needs a description/);
  assert.doesNotThrow(() => sources.validate({ name: "disk", command: "df", metric: { value: "(1)G" } }), "a metric with no description does not stop its watch loading");
  assert.throws(() => metrics.checkDef({ description: "d", name: "Disk Free" }), /lowercase/);
  assert.throws(() => metrics.checkDef({ description: "d", value: "\\d+G" }), /capture group/);
  assert.throws(() => metrics.checkDef({ description: "d" }, true), /needs value/);
  assert.throws(() => metrics.checkDef({ description: "d", value: "(\\d+)", display: { type: "Big Dial" } }), /display type/);
  assert.throws(() => metrics.checkDef({ description: "d", value: "(\\d+)", display: { type: "dial", max: "100" } }), /max must be a number/);
  assert.throws(() => metrics.checkDef({ description: "d", value: "(\\d+)", display: { type: "dial", lowIsBad: "yes" } }), /lowIsBad/);
});

test("a watch's metric block is checked with the watch, on the kinds read each poll", () => {
  assert.doesNotThrow(() => sources.validate({ name: "disk", command: "df", metric: { description: "d", value: "(\\d+)G" } }));
  assert.doesNotThrow(() => sources.validate({ name: "lag", http: "https://x/q", value: "lag", metric: { description: "d", display: { type: "line" } } }));
  assert.throws(() => sources.validate({ name: "disk", command: "df", metric: { description: "d" } }), /needs value/);
  assert.throws(() => sources.validate({ name: "log", file: { path: "x.log" }, metric: { description: "d", value: "(\\d+)" } }), /metric works on/);
});

test("display defaults bad from the threshold, never warn", () => {
  assert.deepEqual(metrics.displayOf({ type: "dial" }, 85, undefined), { type: "dial", bad: 85 });
  assert.deepEqual(metrics.displayOf({ type: "gauge" }, undefined, 15), { type: "gauge", bad: 15, lowIsBad: true });
  assert.deepEqual(metrics.displayOf({ type: "gauge", bad: 10, lowIsBad: false }, undefined, 15), { type: "gauge", bad: 10, lowIsBad: false });
  assert.equal(metrics.displayOf(undefined, 85), undefined);
  assert.deepEqual(metrics.displayOf({ type: "gauge", bad: 10 }, undefined, 15), { type: "gauge", bad: 10, lowIsBad: true }, "lowIsBad follows below even when bad is set");
});

test("detect: no reading moves no bound, either way", () => {
  const w = { name: "cpu", description: "d", value: "cpu", above: 85 };
  const hot = detect(w, undefined, { cpu: 91 });
  assert.deepEqual(hot.events, ["value cpu above 85: 91"]);
  for (const v of [null, "", " ", true, "n/a", undefined]) {
    const r = detect(w, hot.state, { cpu: v });
    assert.deepEqual(r.events, [], `${JSON.stringify(v)} does not end the alert`);
    assert.equal(r.state.past, true);
  }
  const low = { name: "disk", description: "d", value: "free", below: 15 };
  assert.deepEqual(detect(low, undefined, { free: null }).events, [], "null is not 0 below 15");
  assert.deepEqual(detect(low, undefined, { free: false }).events, []);
  assert.equal(metrics.readValue({ metric: { description: "d" }, value: "x" }, { x: true }), null);
});

test("a regex-only metric takes no expect", () => {
  assert.throws(() => sources.validate({ name: "disk", command: "df", expect: "1", metric: { description: "d", value: "(\\d+)" } }), /expect needs a value path/);
});

test("a metric block taken out clears its entry: the poll reports an empty list", async () => {
  const p = sources.toProbe({ name: "plain", command: "echo hi" });
  const r = await p.check(undefined, {}, process.env);
  assert.deepEqual(r.metrics, []);
  const dir = tmp(), s = new metrics.Store(dir, { live: () => true, inboxes: () => [], log: () => {} });
  s.record("custom:plain", "all", 30, [{ name: "plain", description: "d", value: 3 }]);
  s.record("custom:plain", "all", 30, []);
  assert.deepEqual(s.latest, {});
});

test("store: a bad report is logged once and left out, the rest kept", () => {
  const logs = [], s = new metrics.Store(tmp(), { live: () => true, inboxes: () => [], log: (m) => logs.push(m) });
  const bad = { name: "cpu", description: "d", value: 1, display: { type: "Big Dial" } };
  s.record("datadog", "all", 60, [bad, { name: "mem", description: "d", value: 2 }]);
  s.record("datadog", "all", 60, [bad, { name: "mem", description: "d", value: 2 }]);
  s.record("datadog", "all", 60, [{ name: "Bad Name", description: "d", value: 1 }, { name: "bare", value: 1 }]);
  assert.equal(logs.filter((l) => l.includes("datadog/bare skipped: metric needs a description")).length, 1, "a metric with no description is left out");
  assert.equal(logs.filter((l) => /datadog\/cpu skipped: display type/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /Bad Name skipped/.test(l)).length, 1);
  assert.equal(s.latest["datadog/cpu"], undefined);
  assert.deepEqual(Object.keys(s.rejected), ["datadog/Bad Name", "datadog/bare"], "a name no longer reported is forgotten");
  s.hooks.live = () => false; s.flush();
  assert.deepEqual(s.rejected, {}, "a probe gone from the engine is forgotten");
});

test("store: history files never collide, and one under the older name moves to the new one", () => {
  const dir = tmp(), hooks = { live: () => true, inboxes: () => [], log: () => {} };
  fs.mkdirSync(path.join(dir, "metrics"));
  fs.writeFileSync(path.join(dir, "metrics", "custom_disk.disk.jsonl"), "{\"at\":\"x\",\"v\":1}\n");
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify({ metrics: { "custom:disk/disk": { probe: "custom:disk", name: "disk", value: 1, history: "metrics/custom_disk.disk.jsonl" } } }));
  const s = new metrics.Store(dir, hooks);
  assert.equal(s.latest["custom:disk/disk"].history, "metrics/custom_3a_disk.disk.jsonl");
  assert.equal(fs.readFileSync(path.join(dir, "metrics", "custom_3a_disk.disk.jsonl"), "utf8"), "{\"at\":\"x\",\"v\":1}\n");
  s.record("custom:disk", "all", 60, [{ name: "disk", description: "d", value: 2 }]);
  s.record("custom_disk", "all", 60, [{ name: "disk", description: "d", value: 3 }]);
  assert.notEqual(s.latest["custom:disk/disk"].history, s.latest["custom_disk/disk"].history);
});

test("http: a metric on a status watch keeps the status lines", async () => {
  const http = require("../lib/kinds/http");
  let status = 200;
  const api = { envSubst: (v) => v, detect, fetchText: async () => ({ status, body: "queue 12 deep", headers: new Map() }) };
  const w = { name: "q", http: "https://x", metric: { description: "d", value: "queue (\\d+)" } };
  const a = await http.poll(w, undefined, {}, {}, api);
  assert.equal(a.metric.value, 12);
  status = 503;
  const b = await http.poll(w, a.state, {}, {}, api);
  assert.deepEqual(b.events, ["status 200 -> 503"]);
  status = 200;
  let etagged = { status: 200, body: "queue 7 deep", headers: new Map([["etag", "E1"]]) };
  api.fetchText = async () => etagged;
  const c = await http.poll(w, b.state, {}, {}, api);
  assert.deepEqual(c.events, ["status 503 -> 200"]);
  etagged = { status: 304, body: "", headers: new Map() };
  const d = await http.poll(w, c.state, {}, {}, api);
  assert.deepEqual(d.events, [], "a 304 is the cached 200, not a status change");
  assert.equal(d.metric.value, 7);
  const legacy = await http.poll(w, { etag: "E1", body: "queue 7 deep" }, {}, {}, api);
  assert.equal(legacy.state.status, 200, "state from before the status was kept counts a 304 as 200");
});

test("github: a regex-only metric reads the full payload and its bound", async () => {
  const gh = require("../lib/kinds/github");
  const payload = { open_issues_count: 42, items: [] };
  const api = { detect, ghGet: async (ep, etags, next, reduce) => reduce(payload) };
  const w = { name: "issues", github: { endpoint: "repos/o/r" }, above: 40, metric: { description: "d", value: "\"open_issues_count\":(\\d+)" } };
  const r = await gh.poll(w, undefined, {}, {}, api);
  assert.equal(r.metric.value, 42);
  assert.deepEqual(r.events, ["issues above 40: 42"]);
});

test("github: a value path reads the whole response, and only that value is cached", async () => {
  const gh = require("../lib/kinds/github");
  let payload = { total_count: 3, workflow_runs: [{ id: 1, head_sha: "abc" }] }, cache;
  const api = { detect, ghGet: async (ep, etags, next, reduce) => { cache = etags; const d = reduce(payload); next[ep] = { etag: "E", data: d }; return d; } };
  const w = { name: "runs", github: { endpoint: "repos/o/r/actions/runs" }, value: "total_count", metric: { description: "d" } };
  const a = await gh.poll(w, { shape: "slim", etags: { "repos/o/r/actions/runs": { etag: "OLD", data: [] } } }, {}, {}, api);
  assert.deepEqual(cache, {}, "a cache cut to another shape is not reused");
  assert.deepEqual(a.state.etags["repos/o/r/actions/runs"].data, { v: 3 });
  assert.equal(a.metric.value, 3);
  payload = { total_count: 5, workflow_runs: [] };
  const b = await gh.poll(w, a.state, {}, {}, api);
  assert.deepEqual(b.events, ["value total_count: 3 -> 5"]);
  assert.ok(cache["repos/o/r/actions/runs"], "the same shape reuses its cache");
  const c = await gh.poll({ ...w, value: "workflow_runs[0].head_sha" }, undefined, {}, {}, { ...api, ghGet: async (ep, e, n, reduce) => reduce({ workflow_runs: [{ id: 1, head_sha: "abc" }] }) });
  assert.equal(c.state.value, "abc", "a field the slim list would drop is still read");
});

test("detect: a regex metric is quiet without a bound and tests the number with one", () => {
  const w = { name: "disk", command: "df", metric: { description: "d", value: "(\\d+)G free", unit: "GB" } };
  const a = detect(w, undefined, "31G free", "31G free");
  assert.deepEqual(a.events, []);
  assert.equal(a.metric.value, 31);
  assert.equal(a.metric.name, "disk");
  const b = detect({ ...w, below: 15 }, a.state, "12G free", "12G free");
  assert.deepEqual(b.events, ["disk below 15: 12"]);
  assert.equal(b.metric.past, true);
  const c = detect({ ...w, below: 15 }, b.state, "40G free", "40G free");
  assert.deepEqual(c.events, ["disk back, not below 15: 40"]);
  assert.equal(c.metric.past, false);
  assert.equal(detect(w, undefined, "no reading", "no reading").metric.value, null);
});

test("detect: the metric rides along with match and value watches", () => {
  const m = detect({ name: "disk", command: "df", match: "^LOW", metric: { description: "d", value: "(\\d+)G" } }, undefined, "LOW 11G free", "LOW 11G free");
  assert.deepEqual(m.events, ["match: LOW"]);
  assert.equal(m.metric.value, 11);
  assert.equal(m.metric.past, true);
  const v = detect({ name: "q", description: "d", value: "depth", above: 100, metric: { description: "d", name: "queue-depth", display: { type: "line" } } }, undefined, { depth: "140" });
  assert.equal(v.metric.value, 140);
  assert.equal(v.metric.name, "queue-depth");
  assert.equal(v.metric.above, 100);
});

test("store: latest values, a history line a minute, a flip always recorded, gone names dropped", () => {
  const dir = tmp();
  let live = true;
  const s = new metrics.Store(dir, { live: () => live, inboxes: (p, sc, n) => [`${sc}-${n}`], log: () => {} });
  s.record("custom:disk", "all", 60, [{ name: "disk", description: "d", value: 31, unit: "GB", display: { type: "gauge" }, below: 15, past: false }, { name: "other", description: "d", value: 1 }]);
  s.record("custom:disk", "all", 60, [{ name: "disk", description: "d", value: 30, display: { type: "gauge" }, below: 15, past: false }, { name: "other", description: "d", value: null }]);
  s.flush();
  let j = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  const e = j.metrics["custom:disk/disk"];
  assert.equal(e.value, 30);
  assert.equal(e.intervalSec, 60);
  assert.equal(e.description, "d");
  assert.deepEqual(e.display, { type: "gauge", bad: 15, lowIsBad: true });
  assert.deepEqual(e.inboxes, ["all-disk"]);
  assert.equal(e.history, "metrics/custom_3a_disk.disk.jsonl");
  assert.equal(j.metrics["custom:disk/other"].value, 1, "a reading that is not a number keeps the last good value");
  let hist = fs.readFileSync(path.join(dir, e.history), "utf8").trim().split("\n");
  assert.equal(hist.length, 1, "the second reading within the minute is not a history line");
  s.record("custom:disk", "all", 60, [{ name: "disk", description: "d", value: 9, below: 15, past: true }]);
  hist = fs.readFileSync(path.join(dir, e.history), "utf8").trim().split("\n");
  assert.equal(hist.length, 2, "a flip of past is always a history line");
  assert.equal(JSON.parse(hist[1]).v, 9);
  s.flush();
  j = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  assert.equal(j.metrics["custom:disk/other"], undefined, "a name the probe no longer reports is dropped");
  live = false; s.flush();
  j = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  assert.deepEqual(j.metrics, {}, "a probe gone from the engine is dropped");
});

test("store: history keeps a day", () => {
  const dir = tmp(), s = new metrics.Store(dir, { live: () => true, inboxes: () => [], log: () => {} });
  fs.mkdirSync(path.join(dir, "metrics"));
  const f = path.join(dir, "metrics", "x.y.jsonl"), now = Date.now();
  fs.writeFileSync(f, [{ at: new Date(now - 25 * 3600000).toISOString(), v: 1 }, { at: new Date(now - 3600000).toISOString(), v: 2 }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  s.prune(now);
  assert.deepEqual(fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).v), [2]);
});

test("watchhub metrics: one line per metric with its state, filtered by name, label or probe", () => {
  const dir = tmp(), now = new Date().toISOString(), old = new Date(Date.now() - 600000).toISOString();
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify({ at: now, metrics: {
    "datadog/web-cpu": { probe: "datadog", value: 72.456, at: now, intervalSec: 60, unit: "%", past: false, display: { warn: 70, bad: 85, label: "Web CPU" } },
    "datadog/db-free": { probe: "datadog", value: 0.3, at: now, intervalSec: 60, unit: "GB", past: true, display: { warn: 1, bad: 0.5, lowIsBad: true } },
    "datadog/api-p95": { probe: "datadog", value: 1234, at: old, intervalSec: 60, unit: "ms", past: false, display: { label: "API p95" } },
    "custom:disk/disk": { probe: "custom:disk", value: null, at: now, intervalSec: 60, past: false },
    "datadog/web-mem": { probe: "datadog", value: 93, at: now, intervalSec: 60, unit: "%", past: false, display: { warn: 75, bad: 90 } },
  } }));
  assert.equal(cli(dir, "metrics"), [
    "custom:disk/disk - none",
    "datadog/api-p95 1234 ms stale API p95",
    "datadog/db-free 0.3 GB PAST <0.5",
    "datadog/web-cpu 72.5% warn >85 Web CPU",
    "datadog/web-mem 93.0% bad >90",
  ].join("\n") + "\n");
  assert.equal(cli(dir, "metrics", "api p95"), "datadog/api-p95 1234 ms stale API p95\n");   // the label matches too
  assert.equal(cli(dir, "metrics", "--probe", "custom:disk"), "custom:disk/disk - none\n");
  assert.equal(cli(dir, "metrics", "nothing"), "no metric matches\n");
  assert.throws(() => cli(dir, "metrics", "--probe"), /usage: watchhub metrics/);
});

test("in the engine: a command watch's metric reaches metrics.json with its inboxes and history", async (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "watches", "disk.json"), JSON.stringify({ name: "disk", scope: "all", command: "echo 12G free", below: 15, metric: { description: "d", value: "(\\d+)G free", unit: "GB", display: { type: "gauge", min: 0, max: 250 } } }));
  cli(dir, "sub", "janitor", "--filter", "custom:disk");
  cli(dir, "sub", "release", "--filter", "^nothing$");
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const file = path.join(dir, "metrics.json"), until = Date.now() + 20000;
  while (!fs.existsSync(file) && Date.now() < until) await sleep(250);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const e = j.metrics["custom:disk/disk"];
  assert.equal(e.value, 12);
  assert.equal(e.past, true);
  assert.equal(e.unit, "GB");
  assert.deepEqual(e.display, { type: "gauge", min: 0, max: 250, bad: 15, lowIsBad: true });
  assert.deepEqual(e.inboxes, ["janitor"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, e.history), "utf8").trim()).v, 12);
  assert.match(cli(dir, "events", "--probe", "custom:disk"), /custom:disk \| all \| disk below 15: 12/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))._engine.version, require("../package.json").version, "the running engine says which watchhub it is");
});

test("doctor: a datadog metric or a watch metric with no description is a FAIL, the watch still loads", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, datadog: { site: "test.local", metrics: [{ name: "pga", query: "avg:x{*}" }, { name: "cpu", description: "d", query: "avg:y{*}" }] } }));
  fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "watches", "disk.json"), JSON.stringify({ name: "disk", command: "echo 1G", below: 5, metric: { value: "(1)G" } }));
  const d = await require("../lib/doctor").doctor(require("../lib/instance").resolve(dir), {});
  assert.ok(d.some((l) => /^FAIL {2}datadog metric pga: metric needs a description/.test(l)), d.join("\n"));
  assert.ok(!d.some((l) => /datadog metric cpu/.test(l)), d.join("\n"));
  assert.ok(d.some((l) => l.startsWith("FAIL  watch disk metric: metric needs a description") && l.includes("the watch still alerts")), d.join("\n"));
  assert.ok(d.some((l) => l.includes("watches") && l.includes("1 valid")), "the watch itself still loads");
});
