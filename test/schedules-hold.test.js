// The hold `at` / `in` arrange for an inbox: made before anything else can go wrong, let go once the inbox's last
// schedule has fired, and never confused with a subscription the inbox had of its own. Plus the engine's rule
// that a stale engine does not write state.json on exit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const schedules = require("../lib/schedules");
const subs = require("../lib/subs");
const { Engine } = require("../lib/engine");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-hold-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 0 } }));
  for (const d of ["inbox", "subscriptions", "plans", "sinks", "watches"]) fs.mkdirSync(path.join(dir, d));
  return require("../lib/instance").resolve(dir);
};
const cli = (inst, args, env = {}) => {
  const base = { ...process.env }; delete base.WATCHHUB_INBOX; delete base.CLAUDE_CODE_SESSION_ID;
  return execFileSync(process.execPath, [BIN, ...args, "--instance", inst.dir], { encoding: "utf8", windowsHide: true, cwd: inst.dir, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
};
const makeDue = (inst, id) => { const list = schedules.read(inst.paths); for (const e of list) if (e.id === id) e.due = new Date(Date.now() - 1000).toISOString(); fs.writeFileSync(inst.paths.schedules, JSON.stringify(list)); };

test("a default target that fails the inbox rule is refused before anything is saved", () => {
  const inst = mk();
  assert.throws(() => cli(inst, ["in", "20m", "look"], { WATCHHUB_INBOX: "Release Lead" }), (e) => { assert.match(String(e.stderr), /Release Lead \(from WATCHHUB_INBOX, .*\) is not an inbox name/); return true; });
  assert.equal(schedules.read(inst.paths).length, 0, "nothing was written");
  assert.equal(subs.list(inst.paths).length, 0);
});

test("the hold is let go once the inbox's last schedule has fired, and never a subscription the inbox had of its own", () => {
  const inst = mk(), p = inst.paths;
  // two schedules for an inbox that had nothing: one hold subscription, kept while either is pending
  const first = /scheduled ([0-9a-f]{6})/.exec(cli(inst, ["in", "5m", "s-h", "first"]))[1];
  const second = /scheduled ([0-9a-f]{6})/.exec(cli(inst, ["in", "10m", "s-h", "second"]))[1];
  assert.ok(schedules.isHold(subs.get(p, "s-h")));
  const e = new Engine(inst); e.loadSubs();
  const logs = []; e.log = (m) => logs.push(m);
  makeDue(inst, first);
  e.tickSchedules();
  assert.ok(subs.get(p, "s-h"), "the second schedule still needs the hold");
  assert.equal(fs.readFileSync(path.join(p.inbox, "s-h.log"), "utf8").split("\n").filter(Boolean).length, 1);
  makeDue(inst, second);
  e.tickSchedules();
  assert.equal(subs.get(p, "s-h"), null, "nothing pending: the hold is gone");
  assert.ok(logs.some((m) => /subscription s-h removed: it was held for its schedules and none is pending/.test(m)));
  assert.equal(fs.readFileSync(path.join(p.inbox, "s-h.log"), "utf8").split("\n").filter(Boolean).length, 2, "both lines were delivered first");
  // an inbox with its own subscription keeps it, extended, whatever the schedules do
  subs.save(p, subs.make(p, { inbox: "team", filter: "MERGED", ttl: "1h", label: "release" }));
  const third = /scheduled ([0-9a-f]{6})/.exec(cli(inst, ["in", "5m", "team", "third"]))[1];
  assert.ok(!schedules.isHold(subs.get(p, "team")));
  makeDue(inst, third);
  e.tickSchedules();
  const kept = subs.get(p, "team");
  assert.equal(kept.filter, "MERGED");
  assert.ok(Date.parse(kept.expires) > Date.now() + 23 * 3600000, "kept a day past the schedule");
});

test("isHold tells the schedule-only subscription from everything else", () => {
  assert.ok(schedules.isHold({ inbox: "x", ...schedules.HOLD }));
  assert.ok(!schedules.isHold({ inbox: "x", probes: ["schedule"], scope: "team" }));
  assert.ok(!schedules.isHold({ inbox: "x", probes: ["schedule", "jobs"], scope: "schedules" }));
  assert.ok(!schedules.isHold({ inbox: "x", ...schedules.HOLD, filter: "x" }));
  assert.ok(!schedules.isHold(null));
});

test("an engine writes state on exit only while the lock is its own or gone", () => {
  const inst = mk(), e = new Engine(inst);
  assert.equal(e.lockIsMine(), true, "no lock: a stop cleared it, the state may land");
  fs.writeFileSync(inst.paths.lock, String(process.pid));
  assert.equal(e.lockIsMine(), true);
  fs.writeFileSync(inst.paths.lock, String(process.pid + 1));
  assert.equal(e.lockIsMine(), false, "another engine holds it: this one's state is stale");
});
