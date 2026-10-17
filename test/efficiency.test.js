// Token economy: the cooldown between wakes, instructions printed in full once per window, the one-line replay.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-eff-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1, cooldownSec: 6 }, ...extra })); fs.mkdirSync(path.join(dir, "plans")); return dir; };
const run = (dir, inbox) => { const child = spawn(process.execPath, [BIN, "wait", inbox, "--instance", dir], { windowsHide: true }); let out = ""; child.stdout.on("data", (d) => (out += d)); return { child, done: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out }))) }; };
const now = () => new Date().toISOString();

test("cooldown: a normal line right after a burst waits it out, an urgent one does not; a rule's text prints once per window; replay is one line", async (t) => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:x"], on: [{ match: "^MERGED", do: "deploy it, a long instruction that should not be printed on every single wake" }, { match: "^DM ", do: "answer", priority: "urgent" }] }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "inbox", "--plan", "p", "--ttl", "10m");
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  // burst 1: prints the rule in full
  let w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | MERGED a#1`);
  let r = await w.done;
  assert.equal(r.code, 0);
  assert.match(r.out, /- deploy it, a long instruction/);
  // burst 2, two seconds later: held by the 6 s cooldown, then printed with the rule named, not repeated
  const t0 = Date.now();
  w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | MERGED a#2`);
  await sleep(2000);
  assert.equal(w.child.exitCode, null, "woke inside the cooldown");
  r = await w.done;
  assert.ok(Date.now() - t0 >= 5500, `woke after ${Date.now() - t0} ms`);
  assert.match(r.out, /MERGED a#2/);
  assert.doesNotMatch(r.out, /- deploy it, a long instruction/);
  assert.match(r.out, /- as before for \/\^MERGED\/ \(text: watchhub plan show p\)/);
  // burst 3 at once: urgent ignores the cooldown
  const t1 = Date.now();
  w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | DM dev: now`);
  r = await w.done;
  assert.ok(Date.now() - t1 < 3500, `urgent waited ${Date.now() - t1} ms`);
  assert.match(r.out, /- answer\n/);
  // replay: a re-arm long after the last burst names it in one line instead of printing it again
  fs.writeFileSync(path.join(dir, "inbox", "inbox.last"), `${Math.floor(Date.now() / 1000) - 600}\nold line one\nold line two\n`);
  w = run(dir, "inbox");
  await sleep(1500);
  w.child.kill();
  r = await w.done;
  assert.match(r.out, /^\(previous burst: 2 lines printed 10 min ago; if that turn was lost: watchhub events --inbox inbox --since 1[12]m\)/);
  assert.doesNotMatch(r.out, /old line one/);
});
