const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("../lib/util");
const { detect } = require("../lib/diff");
const events = require("../lib/events");
const subs = require("../lib/subs");
const plans = require("../lib/plans");
const lease = require("../lib/lease");
const sources = require("../lib/sources");

const tmpInstance = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: {}, engine: { settleSec: 0 } }));
  return require("../lib/instance").resolve(dir);
};

test("durations, paths, templates", () => {
  assert.equal(util.parseDuration("90"), 90);
  assert.equal(util.parseDuration("15m"), 900);
  assert.equal(util.parseDuration("4h"), 14400);
  assert.equal(util.parseDuration("2d"), 172800);
  assert.throws(() => util.parseDuration("soon"));
  assert.equal(util.pick({ a: { b: [{ c: 7 }] } }, "a.b[0].c"), 7);
  assert.equal(util.pick({ a: 1 }, "a.b.c"), undefined);
  assert.equal(util.template("MERGED {repo}#{number} {missing}", { repo: "r", number: 4 }), "MERGED r#4 ");
  assert.equal(util.envSubst("Bearer ${LW_T}", { LW_T: "x" }), "Bearer x");
});

test("event line format round-trips", () => {
  const line = events.format("pr-merges", "team", "MERGED frontend#1 abc1234 title\nwith newline");
  const p = events.parse(line);
  assert.equal(p.probe, "pr-merges");
  assert.equal(p.scope, "team");
  assert.equal(p.text, "MERGED frontend#1 abc1234 title with newline");
  // pasted chat or ticket text can carry U+2028/U+2029, which `.` in the line regex does not cross
  const q = events.parse(events.format("board", "team", "TICKET COMMENT ABC-1 by Dev: first\u2028second\u2029third"));
  assert.ok(q, "the line still parses");
  assert.equal(q.text, "TICKET COMMENT ABC-1 by Dev: first second third");
});

test("detect: match reports when the matched text changes, including on the first run", () => {
  let r = detect({ match: "state=(\\w+)" }, undefined, "state=open");
  assert.deepEqual(r.events, ["match: state=open"]);
  r = detect({ match: "state=(\\w+)" }, r.state, "state=open");
  assert.deepEqual(r.events, []);
  r = detect({ match: "state=(\\w+)" }, r.state, "state=merged");
  assert.deepEqual(r.events, ["match: state=merged"]);
});

test("detect: items by id, changed field, templated text", () => {
  const spec = { items: "runs", id: "id", changed: "status", text: "{id} {status}" };
  let r = detect(spec, undefined, { runs: [{ id: 1, status: "queued" }] });
  assert.deepEqual(r.events, []);
  r = detect(spec, r.state, { runs: [{ id: 1, status: "done" }, { id: 2, status: "queued" }] });
  assert.deepEqual(r.events, ["changed 1 done", "new 2 queued"]);
});

test("detect: plain text compares with the last run", () => {
  let r = detect({}, undefined, "a");
  assert.deepEqual(r.events, []);
  r = detect({}, r.state, "a");
  assert.deepEqual(r.events, []);
  r = detect({}, r.state, "b");
  assert.deepEqual(r.events, ["output changed: b"]);
});

test("watch validation names the kind and the fault", () => {
  assert.throws(() => sources.validate({ name: "Bad" }), /lowercase/);
  assert.throws(() => sources.validate({ name: "x" }), /exactly one kind/);
  assert.throws(() => sources.validate({ name: "x", http: {} }), /http needs url/);
  assert.throws(() => sources.validate({ name: "x", command: "ls", tcp: { host: "h", port: 1 } }), /got command, tcp/);
  assert.equal(sources.kindOf(sources.validate({ name: "x", gh: { endpoint: "user" } }))[0], "github");
  assert.ok(sources.validate({ name: "x", exec: { command: "tail -f x" } }));
  assert.throws(() => sources.validate({ name: "x", webhook: { path: "nope" } }), /starting with/);
});

test("subscriptions: filter rules, scope, probes, plan selection", () => {
  const inst = tmpInstance();
  fs.mkdirSync(inst.paths.plans);
  plans.save(inst.paths.plans, { name: "p", scope: "team", probes: ["pr-merges", "custom:x"], on: [{ match: "^MERGED", do: "deploy" }, { match: "^TICKET MOVED", quiet: true }] });
  const ev = (probe, scope, text) => events.parse(events.format(probe, scope, text));
  fs.mkdirSync(path.join(inst.dir, "modules"));
  fs.writeFileSync(path.join(inst.dir, "modules", "vpn.js"), "module.exports = { name: 'vpn', check: async () => ({ events: [] }) };");
  fs.writeFileSync(path.join(inst.dir, "modules", "aws-auth.js"), "module.exports = { name: 'aws-auth', check: async () => ({ events: [] }) };");
  let m = subs.matcher(inst.paths, subs.make(inst.paths, { inbox: "a", filter: "vpn|aws-auth" }));
  assert.ok(m(ev("vpn", "all", "VPN cloud")));
  assert.ok(m(ev("watch", "all", "probe vpn failing: x")));
  assert.ok(!m(ev("board", "team", "TICKET NEW ABC-1")));
  // a job label is not a probe name: it is a regex over the line, so JOB lines match
  m = subs.matcher(inst.paths, subs.make(inst.paths, { inbox: "b2", filter: "5513-green|5810-hermetic-4a09a6665" }));
  assert.ok(m(ev("jobs", "all", "JOB 5513-green FAILURE")));
  assert.ok(!m(ev("jobs", "all", "JOB 5513-red FAILURE")));
  assert.equal(subs.filterMode(inst.paths, "jobs|watch").mode, "probes");
  assert.equal(subs.filterMode(inst.paths, "jobs|5513-green").mode, "regex");
  m = subs.matcher(inst.paths, subs.make(inst.paths, { inbox: "b", filter: "frontend#58\\b" }));
  assert.ok(m(ev("pr-checks", "team", "CHECKS frontend#58 abc all green")));
  assert.ok(!m(ev("pr-checks", "team", "CHECKS frontend#580 abc all green")));
  m = subs.matcher(inst.paths, subs.make(inst.paths, { inbox: "c", plan: "p" }));
  assert.ok(m(ev("pr-merges", "team", "MERGED frontend#1")));
  assert.ok(!m(ev("pr-merges", "nh", "MERGED webapp#1")));
  assert.ok(m(ev("custom:x", "custom", "match: hi")));
  assert.ok(m(ev("watch", "all", "probe pr-merges failing: boom")));
  assert.ok(!m(ev("board", "team", "TICKET NEW ABC-1")));
  m = subs.matcher(inst.paths, subs.make(inst.paths, { inbox: "d", scope: "nh", probes: ["board"] }));
  assert.ok(m(ev("board", "nh", "TICKET NEW VER10-1")));
  assert.ok(!m(ev("board", "team", "TICKET NEW ABC-1")));
  assert.throws(() => subs.make(inst.paths, { inbox: "Bad Inbox" }), /inbox must/);
  assert.throws(() => subs.make(inst.paths, { inbox: "e", plan: "nope" }), /no plan/);
});

test("plans: instructions and quiet rules", () => {
  const p = { name: "p", on: [{ match: "^MERGED", do: "deploy" }, { match: "^TICKET MOVED", quiet: true }], default: "read" };
  const lines = [events.format("pr-merges", "team", "MERGED frontend#1"), events.format("pr-merges", "team", "MERGED frontend#2"), events.format("board", "team", "TICKET NEW ABC-1")];
  const text = plans.instructions(p, lines);
  assert.match(text, /INSTRUCTIONS\n- deploy\n- read\n/);
  assert.ok(plans.quiet(p, events.format("board", "team", "TICKET MOVED ABC-1 a -> b")));
  assert.ok(!plans.quiet(p, lines[0]));
  assert.throws(() => plans.check({ name: "p", on: [{ match: "x" }] }), /needs match and do/);
});

test("inbox: deliver, unacked, ack, whole lines only", () => {
  const inst = tmpInstance();
  subs.deliver(inst.paths, "inbox", "one");
  subs.deliver(inst.paths, "inbox", "two");
  let u = subs.unacked(inst.paths, "inbox");
  assert.equal(u.text, "one\ntwo");
  subs.ack(inst.paths, "inbox", u.end);
  assert.equal(subs.unacked(inst.paths, "inbox").text, "");
  fs.appendFileSync(subs.inboxFile(inst.paths, "inbox"), "half");
  assert.equal(subs.unacked(inst.paths, "inbox").text, "");
  fs.appendFileSync(subs.inboxFile(inst.paths, "inbox"), " line\n");
  assert.equal(subs.unacked(inst.paths, "inbox").text, "half line");
});

test("lease: take, replace, release", () => {
  const inst = tmpInstance();
  const { replaced } = lease.take(inst.paths, "x", { session: "s1" });
  assert.equal(replaced, null);
  assert.ok(lease.mine(inst.paths, "x"));
  assert.equal(lease.list(inst.paths)[0].alive, true);
  lease.release(inst.paths, "x");
  assert.equal(lease.read(inst.paths, "x"), null);
  // a lease written before the rename says "lane": listed under its inbox, and swept when its process is gone
  fs.writeFileSync(path.join(inst.paths.leases, "old.json"), JSON.stringify({ lane: "old", pid: 999999 }));
  assert.equal(lease.list(inst.paths)[0].inbox, "old");
  assert.equal(lease.sweep(inst.paths), 1);
  assert.deepEqual(lease.list(inst.paths), []);
});

test("probe-health lines are quiet unless the subscription names the probe", () => {
  const subs = require("../lib/subs");
  const paths = { modules: "no-such-dir", watches: "no-such-dir" };
  subs.resetKnown();
  const line = "2026-01-01T00:00:00.000Z | watch | all | probe custom:slack-inbox failing: HTTP 429";
  assert.equal(subs.healthQuiet(paths, { inbox: "a", scope: "team" }, { name: "p", scope: "team" }, line), true);          // scope-wide plan: quiet
  assert.equal(subs.healthQuiet(paths, { inbox: "a", probes: ["custom:slack-inbox"] }, null, line), false);           // named outright: wakes
  assert.equal(subs.healthQuiet(paths, { inbox: "a" }, { name: "p", probes: ["custom:slack-inbox"] }, line), false);  // named by the plan: wakes
  assert.equal(subs.healthQuiet(paths, { inbox: "a", filter: "MERGED" }, null, "2026-01-01T00:00:00.000Z | pr-merges | team | MERGED x#1"), false); // not a health line
});

test("a probe is reported failing after three fails, or two spread over two minutes; a blip stays silent", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-fail-"));
  fs.writeFileSync(path.join(dir, "instance.json"), "{}");
  const { Engine } = require("../lib/engine");
  const e = new Engine(require("../lib/instance").resolve(dir));
  const lines = []; e.emit = (probe, t) => lines.push(`${probe} ${t}`); e.log = () => {};
  const p = { name: "pr-merges" }, s = e.slot(p.name);
  e.fail(p, s, new Error("fetch failed")); e.fail(p, s, new Error("fetch failed"));
  assert.deepEqual(lines, []);                                   // two quick fails: a blip
  e.fail(p, s, new Error("fetch failed"));
  assert.deepEqual(lines, ["watch probe pr-merges failing: fetch failed"]);
  const s2 = e.slot("board"); lines.length = 0;
  e.fail({ name: "board" }, s2, new Error("x")); s2.firstFail -= 130000; e.fail({ name: "board" }, s2, new Error("x"));
  assert.deepEqual(lines, ["watch probe board failing: x"]);     // two fails two minutes apart: sustained
});

test("a stream whose enabled() throws is logged and tried again in a minute, not dropped", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-guard-"));
  fs.writeFileSync(path.join(dir, "instance.json"), "{}");
  const { Engine } = require("../lib/engine");
  const e = new Engine(require("../lib/instance").resolve(dir));
  const logged = []; e.log = (m) => logged.push(m);
  await e.runStream({ name: "s", stream: true, enabled() { throw new Error("cfg bad"); } });
  assert.ok(e.timers.has("s"), "rescheduled");
  clearTimeout(e.timers.get("s"));
  assert.deepEqual(logged, ["s: not started: cfg bad"]);
});
