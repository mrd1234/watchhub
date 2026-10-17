// Gaps the coverage review named: log rotation, and the waiter's size and age caps on a low backlog.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-cov-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1 }, ...extra })); fs.mkdirSync(path.join(dir, "plans")); return dir; };
const run = (dir, inbox) => { const child = spawn(process.execPath, [BIN, "wait", inbox, "--instance", dir], { windowsHide: true }); let out = ""; child.stdout.on("data", (d) => (out += d)); return { child, done: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out }))) }; };

test("events.log and engine.log rotate once over their limits", async (t) => {
  const dir = mk({ engine: { eventsLogMaxMb: 0.001, settleSec: 1 } });   // 1 KB: a few lines
  fs.writeFileSync(path.join(dir, "engine.log"), "x".repeat(5 * 1024 * 1024 + 1));   // already over the 5 MB engine.log limit
  fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "watches", "chatty.json"), JSON.stringify({ name: "chatty", exec: { command: "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo line number $i with some padding to make it longer; done; sleep 30" } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  await sleep(4000);
  assert.ok(fs.existsSync(path.join(dir, "engine.log.1")), "engine.log was rotated on the first write");
  assert.ok(fs.statSync(path.join(dir, "engine.log")).size < 100 * 1024);
  assert.ok(fs.existsSync(path.join(dir, "events.log.1")), "events.log was rotated once it passed its limit");
  assert.ok(fs.statSync(path.join(dir, "events.log")).size < 4096);
});

test("a low backlog wakes on size (256 KB) and on age (4 h), not only on count", async (t) => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:x"], priority: "low" }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "inbox", "--plan", "p", "--ttl", "10m");
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  // size: one enormous low line
  let w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${new Date().toISOString()} | custom:x | custom | ${"big ".repeat(70000)}`);
  let r = await w.done;
  assert.equal(r.code, 0);
  assert.match(r.out, /^LOW-PRIORITY BACKLOG/);
  assert.match(r.out, /- custom:x: 1; big big/);
  // age: a low line stamped five hours ago wakes at once
  w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${new Date(Date.now() - 5 * 3600 * 1000).toISOString()} | custom:x | custom | old news`);
  r = await w.done;
  assert.equal(r.code, 0);
  assert.match(r.out, /- custom:x: 1; old news/);
  // and a fresh small low line does not
  w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${new Date().toISOString()} | custom:x | custom | fresh and small`);
  await sleep(3000);
  assert.equal(w.child.exitCode, null, "woke on a fresh low line");
  w.child.kill();
  await w.done;
});

test("a probe's first poll after a start never repeats a line the log already holds", async (t) => {
  const dir = mk();
  fs.mkdirSync(path.join(dir, "watches"));
  // a command watch whose match is already true: its first poll re-derives the same line every start
  fs.writeFileSync(path.join(dir, "watches", "flag.json"), JSON.stringify({ name: "flag", command: "echo READY", match: "READY", intervalSec: 3600 }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  await sleep(3000);
  assert.equal((cli(dir, "events").match(/match: READY/g) || []).length, 1);
  cli(dir, "stop"); fs.rmSync(path.join(dir, "state.json"));   // as after a lost flush: the first poll re-derives the line
  cli(dir, "start");
  await sleep(3000);
  assert.equal((cli(dir, "events").match(/match: READY/g) || []).length, 1, "the restart repeated a known line");
  assert.match(fs.readFileSync(path.join(dir, "engine.log"), "utf8"), /first poll repeated a known line, not emitted: match: READY/);
  assert.doesNotMatch(cli(dir, "events"), /engine started/);
});
