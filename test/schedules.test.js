// Layer 1: one-off schedules. The store, the engine's tick (fire first, remove after; late; a removal that
// fails; a file that does not parse), the CLI (at, in, schedules, unschedule, the default target, the hold
// it arranges), the waiter's urgency, the strict reads, and the sink retries that came with it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const schedules = require("../lib/schedules");
const subs = require("../lib/subs");
const ctl = require("../lib/ctl");
const { Engine } = require("../lib/engine");
const sinks = require("../lib/sinks");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (cfg = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-sched-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 0, cooldownSec: 0 }, ...cfg }));
  for (const d of ["inbox", "subscriptions", "plans", "sinks", "watches"]) fs.mkdirSync(path.join(dir, d));
  return require("../lib/instance").resolve(dir);
};
// the CLI as a person runs it; env adds to this process's, with the harness variables taken out so the
// test machine's own session never becomes a default target
const cli = (inst, args, env = {}) => {
  const base = { ...process.env }; delete base.WATCHHUB_INBOX; delete base.CLAUDE_CODE_SESSION_ID;
  return execFileSync(process.execPath, [BIN, ...args, "--instance", inst.dir], { encoding: "utf8", windowsHide: true, cwd: inst.dir, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
};
const cliFails = (inst, args, re, env) => assert.throws(() => cli(inst, args, env), (e) => { assert.match(String(e.stderr), re); return true; });
const eventsOf = (inst) => { try { return fs.readFileSync(inst.paths.events, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const inboxOf = (inst, inbox) => { try { return fs.readFileSync(path.join(inst.paths.inbox, `${inbox}.log`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const entry = (over = {}) => ({ id: "abc123", due: new Date(Date.now() - 1000).toISOString(), targets: { inboxes: ["x"], sinks: [] }, text: "check the deploy", created: new Date().toISOString(), ...over });
const engineFor = (inst) => { const e = new Engine(inst); e.loadSubs(); return e; };

test("parseWhen: HH:MM is the next such time, today or tomorrow; ISO must be ahead and within a year", () => {
  const now = new Date(2026, 9, 17, 10, 0, 0);          // 10:00 local
  let d = schedules.parseWhen("15:30", now);
  assert.equal(d.getHours(), 15); assert.equal(d.getMinutes(), 30); assert.equal(d.getDate(), 17);
  d = schedules.parseWhen("09:00", now);                // already passed today
  assert.equal(d.getDate(), 18); assert.equal(d.getHours(), 9);
  d = schedules.parseWhen("10:00", now);                // this very minute counts as passed
  assert.equal(d.getDate(), 18);
  assert.throws(() => schedules.parseWhen("25:00", now), /not a time of day/);
  assert.throws(() => schedules.parseWhen("soon", now), /not a time/);
  assert.throws(() => schedules.parseWhen("2026-10-17T09:00", now), /already passed/);
  assert.throws(() => schedules.parseWhen("2028-01-01T09:00", now), /more than a year ahead/);
  assert.equal(schedules.parseWhen("2026-10-20T09:00", now).getTime(), new Date(2026, 9, 20, 9, 0).getTime());
});

test("afterDuration: 90s, 20m, 2h, 1d; nothing else", () => {
  const now = new Date(2026, 9, 17, 10, 0, 0);
  assert.equal(schedules.afterDuration("90s", now) - now, 90000);
  assert.equal(schedules.afterDuration("20m", now) - now, 1200000);
  assert.equal(schedules.afterDuration("2h", now) - now, 7200000);
  assert.equal(schedules.afterDuration("1d", now) - now, 86400000);
  assert.throws(() => schedules.afterDuration("0m", now), /more than zero/);
  assert.throws(() => schedules.afterDuration("400d", now), /a year or less/);
  assert.throws(() => schedules.afterDuration("15:30", now), /not a duration/);
  assert.throws(() => schedules.afterDuration("", now), /not a duration/);
});

test("the store: add checks the text and the targets, keeps the list sorted, caps it, and remove gives the entry back", () => {
  const inst = mk(), p = inst.paths, due = new Date(Date.now() + 3600000);
  assert.throws(() => schedules.add(p, { due, inboxes: ["x"], text: "  " }), /text is empty/);
  assert.throws(() => schedules.add(p, { due, inboxes: ["x"], text: "a".repeat(501) }), /500 characters/);
  assert.throws(() => schedules.add(p, { due, inboxes: ["x"], text: "two\nlines" }), /one line/);
  assert.throws(() => schedules.add(p, { due, text: "no target" }), /needs a target/);
  assert.throws(() => schedules.add(p, { due, scope: "bad scope!", text: "t" }), /scope must be/);
  const later = schedules.add(p, { due: new Date(Date.now() + 7200000), inboxes: ["x"], text: "later" });
  const sooner = schedules.add(p, { due, sinks: ["slack"], scope: "team", text: "sooner", by: "s-abc" });
  assert.match(later.id, /^[0-9a-f]{6}$/);
  assert.deepEqual(sooner.targets, { inboxes: [], sinks: ["slack"], scope: "team" });
  assert.equal(sooner.by, "s-abc");
  const list = schedules.read(p);
  assert.deepEqual(list.map((e) => e.text), ["sooner", "later"]);   // soonest first on disk
  assert.equal(schedules.remove(p, "nope"), null);
  assert.equal(schedules.remove(p, later.id).text, "later");
  assert.equal(schedules.read(p).length, 1);
  // the cap
  const full = Array.from({ length: schedules.MAX }, (_, i) => entry({ id: i.toString(16).padStart(6, "0"), due: new Date(Date.now() + 1e6 + i).toISOString() }));
  fs.writeFileSync(p.schedules, JSON.stringify(full));
  assert.throws(() => schedules.add(p, { due, inboxes: ["x"], text: "one more" }), /1000 schedules are already pending/);
});

test("readStrict: a file that does not parse is set aside and reported, never written over; odd entries are left out", () => {
  const inst = mk(), p = inst.paths, said = [];
  fs.writeFileSync(p.schedules, "{not json");
  assert.deepEqual(schedules.readStrict(p, (m) => said.push(m)), []);
  assert.ok(!fs.existsSync(p.schedules), "the bad file is moved");
  assert.ok(fs.readdirSync(inst.dir).some((f) => f.startsWith("schedules.json.bad-")), "and kept beside it");
  assert.match(said[0], /could not be read as JSON; set aside/);
  // a write after the set-aside starts from empty rather than over the bad file
  schedules.add(p, { due: new Date(Date.now() + 60000), inboxes: ["x"], text: "fresh" });
  assert.equal(schedules.read(p).length, 1);
  fs.writeFileSync(p.schedules, JSON.stringify({ not: "a list" }));
  said.length = 0;
  assert.deepEqual(schedules.readStrict(p, (m) => said.push(m)), []);
  assert.match(said[0], /does not hold a list/);
  fs.writeFileSync(p.schedules, JSON.stringify([entry({ id: "b", due: "2030-01-01T00:00:00Z" }), { text: "no id" }, entry({ id: "a", due: "2029-01-01T00:00:00Z" }), entry({ id: "c", due: "never" })]));
  said.length = 0;
  assert.deepEqual(schedules.readStrict(p, (m) => said.push(m)).map((e) => e.id), ["a", "b"]);
  assert.match(said[0], /2 schedule entries without an id or a due time left out/);
});

test("engine tick: a due schedule is one line in events.log, delivered to its inbox directly, then removed; one not yet due waits", () => {
  const inst = mk(), p = inst.paths, e = engineFor(inst);
  fs.writeFileSync(p.schedules, JSON.stringify([entry(), entry({ id: "later1", due: new Date(Date.now() + 3600000).toISOString(), text: "not yet" })]));
  e.tickSchedules();
  const ev = eventsOf(inst);
  assert.equal(ev.length, 1);
  assert.match(ev[0], /^\S+ \| schedule \| all \| SCHEDULED abc123 check the deploy$/);
  assert.deepEqual(inboxOf(inst, "x"), ev);                        // no subscription needed: delivery is direct
  assert.deepEqual(schedules.read(p).map((x) => x.id), ["later1"]);
  assert.equal(e.fired.size, 0);
  e.tickSchedules();
  assert.equal(eventsOf(inst).length, 1, "nothing fires twice");
});

test("engine tick: a schedule due a while ago (the engine was down) fires once, marked late", () => {
  const inst = mk(), e = engineFor(inst);
  const due = new Date(Date.now() - 10 * 60000);
  fs.writeFileSync(inst.paths.schedules, JSON.stringify([entry({ due: due.toISOString() })]));
  e.tickSchedules();
  const [line] = eventsOf(inst);
  assert.match(line, new RegExp(`SCHEDULED abc123 check the deploy \\(late, due ${schedules.describe(due.toISOString())}\\)$`));
});

test("engine tick: a scope target is an ordinary line, and an inbox named as well is not given it twice", () => {
  const inst = mk(), p = inst.paths;
  subs.save(p, subs.make(p, { inbox: "team-a", scope: "team", probes: ["schedule"], ttl: "1h" }));
  subs.save(p, subs.make(p, { inbox: "other", scope: "ops", probes: ["schedule"], ttl: "1h" }));
  const e = engineFor(inst);
  fs.writeFileSync(p.schedules, JSON.stringify([entry({ targets: { inboxes: ["team-a", "direct"], sinks: [], scope: "team" } })]));
  e.tickSchedules();
  const ev = eventsOf(inst);
  assert.equal(ev.length, 1, "one line in the log however many targets");
  assert.match(ev[0], /\| schedule \| team \| SCHEDULED abc123 /);
  assert.equal(inboxOf(inst, "team-a").length, 1, "the matcher delivered it once; the direct delivery saw that");
  assert.equal(inboxOf(inst, "direct").length, 1);
  assert.equal(inboxOf(inst, "other").length, 0, "another scope's inbox never sees it");
});

test("engine tick: when the entry cannot be removed, the line is not emitted again, and the removal is tried next tick", () => {
  const inst = mk(), p = inst.paths, e = engineFor(inst), logs = [];
  e.log = (m) => logs.push(m);
  fs.writeFileSync(p.schedules, JSON.stringify([entry()]));
  const real = schedules.remove;
  schedules.remove = () => { throw new Error("disk full"); };
  try { e.tickSchedules(); e.tickSchedules(); } finally { schedules.remove = real; }
  assert.equal(eventsOf(inst).length, 1);
  assert.ok(e.fired.has("abc123"));
  assert.ok(logs.some((m) => /not removed from schedules.json: disk full; tried again next tick/.test(m)));
  e.tickSchedules();
  assert.equal(schedules.read(p).length, 0);
  assert.equal(e.fired.size, 0);
  assert.equal(eventsOf(inst).length, 1);
});

test("engine tick: a schedules.json that does not parse is set aside with a health line, and the engine carries on", () => {
  const inst = mk(), p = inst.paths, e = engineFor(inst);
  fs.writeFileSync(p.schedules, "[{broken");
  e.tickSchedules();
  const ev = eventsOf(inst);
  assert.equal(ev.length, 1);
  assert.match(ev[0], /\| watch \| all \| schedules.json could not be read as JSON; set aside as schedules.json.bad-/);
  assert.ok(!fs.existsSync(p.schedules));
  schedules.add(p, { due: new Date(Date.now() - 1), inboxes: ["x"], text: "after" });
  e.tickSchedules();
  assert.equal(inboxOf(inst, "x").length, 1);
});

test("engine: state.json that does not parse is set aside at start and reported, not written over", () => {
  const inst = mk();
  fs.writeFileSync(inst.paths.state, "{{{");
  const e = new Engine(inst);
  assert.deepEqual(e.state, {});
  assert.equal(e.startNotes.length, 1);
  assert.match(e.startNotes[0], /state.json could not be read as JSON; set aside as state.json.bad-/);
  assert.ok(fs.readdirSync(inst.dir).some((f) => f.startsWith("state.json.bad-")));
  fs.writeFileSync(inst.paths.state, "[1,2]");
  assert.match(new Engine(inst).startNotes[0], /did not hold an object/);
});

test("ownInbox: WATCHHUB_INBOX, then the project's .watchhub.json, then the Claude Code session; null with none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-own-"));
  assert.equal(ctl.ownInbox({}, dir), null);
  assert.equal(ctl.ownInbox({ CLAUDE_CODE_SESSION_ID: "3f9a-BC12-xyz" }, dir), "s-3f9abc12xy");
  fs.writeFileSync(path.join(dir, ".watchhub.json"), JSON.stringify({ inbox: "release" }));
  assert.equal(ctl.ownInbox({ CLAUDE_CODE_SESSION_ID: "3f9a" }, dir), "release");
  assert.equal(ctl.ownInbox({ WATCHHUB_INBOX: "ops", CLAUDE_CODE_SESSION_ID: "3f9a" }, dir), "ops");
});

test("CLI: in and at save a schedule, hold the inbox with a schedule-only subscription, and say what they did", () => {
  const inst = mk(), p = inst.paths;
  let out = cli(inst, ["in", "20m", "check the deploy"], { WATCHHUB_INBOX: "s-abc123def4" });
  assert.match(out, /^scheduled [0-9a-f]{6} for \d\d:\d\d \(in 20m\) -> inbox s-abc123def4: check the deploy; cancel with watchhub unschedule [0-9a-f]{6}/);
  let [e] = schedules.read(p);
  assert.deepEqual(e.targets, { inboxes: ["s-abc123def4"], sinks: [] });
  assert.ok(Math.abs(Date.parse(e.due) - Date.now() - 1200000) < 5000);
  // the hold: a subscription that takes schedule lines only, lasting a day past the due time
  const s = subs.get(p, "s-abc123def4");
  assert.equal(s.label, "schedules"); assert.deepEqual(s.probes, ["schedule"]); assert.equal(s.scope, "schedules");
  assert.ok(Date.parse(s.expires) >= Date.parse(e.due) + 86400000 - 5000);
  assert.ok(subs.matcher(p, s)(require("../lib/events").parse(require("../lib/events").format("schedule", "schedules", "SCHEDULED x y"))));
  assert.ok(!subs.matcher(p, s)(require("../lib/events").parse(require("../lib/events").format("schedule", "team", "SCHEDULED x y"))), "a line scheduled for a scope is not this inbox's");
  assert.ok(!subs.matcher(p, s)(require("../lib/events").parse(require("../lib/events").format("pr-checks", "all", "CHECKS a#1 x all green"))));
  // an existing subscription with a nearer expiry is kept past the schedule; one that lasts longer is left alone
  subs.save(p, subs.make(p, { inbox: "team", filter: "MERGED", ttl: "1h", label: "release" }));
  cli(inst, ["at", "2027-01-01T09:00", "team", "new year"]);
  const t = subs.get(p, "team");
  assert.equal(t.label, "release"); assert.equal(t.filter, "MERGED");
  assert.ok(Date.parse(t.expires) >= Date.parse("2027-01-02T09:00") - 1000);
  subs.save(p, subs.make(p, { inbox: "long", filter: "x", ttl: "30d" }));
  const before = subs.get(p, "long").expires;
  cli(inst, ["in", "5m", "long", "soon"]);
  assert.equal(subs.get(p, "long").expires, before);
  // several inboxes, a sink and a scope in one go; --from records who asked
  require("../lib/sinks").save(p.sinks, { name: "toast", toast: {} });
  out = cli(inst, ["in", "2h", "a1", "b2", "all hands", "--sink", "toast", "--scope", "team", "--from", "s-abc123def4"]);
  assert.match(out, /-> inbox a1, b2; sink toast; scope team: all hands/);
  e = schedules.read(p).find((x) => x.text === "all hands");
  assert.deepEqual(e.targets, { inboxes: ["a1", "b2"], sinks: ["toast"], scope: "team" });
  assert.equal(e.by, "s-abc123def4");
  // the list, soonest first, and cancelling
  out = cli(inst, ["schedules"]);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /\(in [45]m\)  inbox long: soon$/);
  assert.match(lines[3], /inbox team: new year \(from .*\)$|inbox team: new year$/);
  const json = JSON.parse(cli(inst, ["schedules", "--json"]));
  assert.equal(json.length, 4);
  out = cli(inst, ["unschedule", json[0].id]);
  assert.match(out, /^schedule [0-9a-f]{6} cancelled \(was \d\d:\d\d: soon\)/);
  assert.equal(schedules.read(p).length, 3);
  cliFails(inst, ["unschedule", "zzzzzz"], /no schedule zzzzzz/);
  cliFails(inst, ["unschedule"], /usage: watchhub unschedule/);
});

test("CLI: at and in refuse a missing target, a word where an inbox should be, a sink that does not exist, and bad times", () => {
  const inst = mk();
  cliFails(inst, ["in", "20m", "no target here"], /say where the line goes/);
  cliFails(inst, ["in", "20m", "Deploy Now", "text"], /Deploy Now is not an inbox name .*the text goes last/);
  cliFails(inst, ["in", "20m", "x", "text", "--sink", "nope"], /no sink nope/);
  cliFails(inst, ["in", "20m", "x", "text", "--sink"], /--sink needs a sink name/);
  cliFails(inst, ["in", "20m", "x", "text", "--from", "Bad Name"], /--from takes an inbox name/);
  cliFails(inst, ["in", "soon", "x", "text"], /not a duration/);
  cliFails(inst, ["at", "25:99", "x", "text"], /not a time of day/);
  cliFails(inst, ["at"], /usage: watchhub at/);
  cliFails(inst, ["in", "20m"], /usage: watchhub in/);
  assert.equal(cli(inst, ["schedules"]).trim(), "no schedules pending");
});

test("the waiter treats a schedule line as urgent, whatever the subscription or plan says", () => {
  const inst = mk(), p = inst.paths, { levelOf } = require("../lib/waiter"), events = require("../lib/events");
  fs.writeFileSync(path.join(p.plans, "quiet.json"), JSON.stringify({ name: "quiet", probes: ["schedule"], on: [{ match: "SCHEDULED", level: "low", do: "later" }] }));
  const sub = subs.make(p, { inbox: "s-x", plan: "quiet", priority: "low", ttl: "1h" });
  const plan = require("../lib/plans").load(p.plans, "quiet");
  assert.equal(levelOf(p, sub, plan, null, events.format("schedule", "all", "SCHEDULED abc123 check")), "urgent");
  assert.equal(levelOf(p, sub, plan, null, events.format("pr-checks", "all", "CHECKS a#1 x all green")), "low");
});

test("twoway.remember reads replies.json strictly: a broken file is set aside, the handle still recorded", () => {
  const twoway = require("../lib/twoway"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-tw-")), f = path.join(dir, "replies.json"), said = [];
  fs.writeFileSync(f, "not json at all");
  const h = twoway.remember(f, "slack", { channel: "C1", ts: "1.2" }, Date.now(), (m) => said.push(m));
  assert.match(h, /^r[0-9a-f]{8}$/);
  assert.match(said[0], /replies.json could not be read as JSON; set aside/);
  assert.ok(fs.readdirSync(dir).some((x) => x.startsWith("replies.json.bad-")));
  assert.equal(twoway.lookup(f, h).probe, "slack");
});

test("sinks: a batch that fails to send is kept and sent again, a sink fixed meanwhile gets every line, and the held lines are capped", async (t) => {
  let fail = true, got = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push(JSON.parse(b)); res.statusCode = fail ? 500 : 200; res.end(fail ? "down" : "ok"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-retry-"));
  fs.mkdirSync(path.join(dir, "sinks"));
  process.env.RETRY_URL = `http://127.0.0.1:${server.address().port}/hook`;
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${RETRY_URL}", body: { text: "{text}" } } }));
  const logs = [], emitted = [];
  const sender = new sinks.Sender(path.join(dir, "sinks"), (m) => logs.push(m), (m) => emitted.push(m), { retryMs: [300, 300, 300] });
  sender.push("hook", "2026-01-01T00:00:00.000Z | schedule | all | SCHEDULED a1 first");
  await sleep(100);
  assert.equal(got.length, 1, "the first try went out");
  assert.match(logs[0], /sink hook: HTTP 500 .*\(1 line kept, sent again in 0 s\)/);
  sender.push("hook", "2026-01-01T00:00:01.000Z | p | s | second");    // during the pause: queued behind the retry
  await sleep(100);
  assert.equal(got.length, 1, "nothing is sent during the pause");
  await sleep(900);                                                    // more failures: three in a row says so, once
  assert.ok(got.length >= 3, `tries: ${got.length}`);
  assert.equal(emitted.filter((m) => /sink hook failing: HTTP 500/.test(m)).length, 1);
  fail = false;
  await sleep(400);
  const ok = got[got.length - 1];
  assert.match(ok.text, /SCHEDULED a1 first\nsecond/, "the kept lines and the one queued meanwhile go out together, in order");
  assert.ok(emitted.some((m) => /sink hook works again/.test(m)));
  // the cap: a sink down for good holds the newest MAX_HELD lines and says what it dropped
  fail = true; got = []; logs.length = 0;
  for (let i = 0; i < sinks.MAX_HELD + 30; i++) sender.push("hook", `2026-01-01T00:00:02.000Z | p | s | line ${i}`);
  await sleep(150);
  const q = sender.queues.get("hook");
  assert.ok(q.lines.length <= sinks.MAX_HELD, `held ${q.lines.length}`);
  assert.ok(logs.some((m) => /oldest dropped, over 200 held/.test(m)));
  assert.match(q.lines[q.lines.length - 1], /line 229$/, "the newest survive");
  clearTimeout(q.retry);
});
