const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const plans = require("../lib/plans");
const waiter = require("../lib/waiter");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-prio-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 3 }, ...extra })); fs.mkdirSync(path.join(dir, "plans")); return dir; };
const run = (dir, inbox) => { const child = spawn(process.execPath, [BIN, "wait", inbox, "--instance", dir], { windowsHide: true }); let out = ""; child.stdout.on("data", (d) => (out += d)); return { child, done: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out }))) }; };
const now = () => new Date().toISOString();

test("levelOf: rule priority, plan priority, subscription priority, urgent regex, notices and health lines", () => {
  const p = plans.check({ name: "p", priority: "low", on: [{ match: "^DM ", do: "answer", priority: "urgent" }, { match: "MERGED", do: "deploy" }, { match: "moved", quiet: true }] });
  const paths = { modules: "no-such", watches: "no-such" };
  const sub = { inbox: "a", plan: "p" };
  const L = (text, probe = "custom:x") => waiter.levelOf(paths, sub, p, null, `${now()} | ${probe} | team | ${text}`);
  assert.equal(L("DM Dev: hi"), "urgent");
  assert.equal(L("MERGED a#1"), "normal");          // a matched rule with a do: normal, whatever the plan's default
  assert.equal(L("moved to QA"), "low");            // quiet: true
  assert.equal(L("something else"), "low");         // no rule: the plan's priority
  assert.equal(waiter.levelOf(paths, { inbox: "b", priority: "low" }, null, null, `${now()} | pr-merges | team | MERGED x`), "low");
  assert.equal(waiter.levelOf(paths, { inbox: "b" }, null, /MERGED/, `${now()} | pr-merges | team | MERGED x`), "urgent");
  assert.equal(waiter.levelOf(paths, { inbox: "b" }, null, null, `${now()} | notice | all | restart soon`), "low");
  assert.equal(waiter.levelOf(paths, { inbox: "b" }, null, null, `${now()} | notice | all | WAKE: now`), "normal");
  assert.equal(waiter.levelOf(paths, { inbox: "b", scope: "team" }, null, null, `${now()} | watch | all | probe vpn failing: x`), "low");
  assert.equal(waiter.levelOf(paths, { inbox: "b", scope: "team" }, null, /sink slack failing/, `${now()} | watch | all | sink slack failing: 500`), "urgent");   // an explicit urgent beats the quiet rules
  assert.equal(waiter.levelOf(paths, { inbox: "b", scope: "team" }, null, null, `${now()} | watch | all | sink slack failing: 500`), "low");
  assert.throws(() => plans.check({ name: "p", on: [{ match: "x", do: "y", priority: "high" }] }), /priority must be one of/);
  const block = waiter.alsoBlock([`${now()} | custom:slack-inbox | custom | Dev: one`, `${now()} | custom:slack-inbox | custom | Dev: two`, `${now()} | custom:slack-inbox | custom | Dev: three`, `${now()} | notice | all | hello`], "inbox");
  assert.match(block, /ALSO \(low priority, 4 lines since the last burst; full text: watchhub events --inbox inbox\)/);
  assert.match(block, /- custom:slack-inbox: 3 lines; last: Dev: two \| Dev: three/);
  assert.match(block, /- notice: 1; hello/);
});

test("urgent wakes before the settle; low rides along; a low backlog of 50 wakes on its own", async (t) => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:x"], priority: "low", on: [{ match: "^DM ", do: "answer now", priority: "urgent" }] }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  assert.match(cli(dir, "sub", "inbox", "--plan", "p", "--ttl", "10m"), /subscription inbox added/);
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  let w = run(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | mention one`);
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | mention two`);
  await sleep(2000);
  assert.equal(w.child.exitCode, null, "woke on low lines");
  const t0 = Date.now();
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | DM Dev: urgent thing`);
  const r = await w.done;
  assert.ok(Date.now() - t0 < 2500, `urgent waited for the settle (${Date.now() - t0} ms)`);   // settle is 3 s; urgent must not wait it out
  assert.equal(r.code, 0);
  assert.match(r.out, /DM Dev: urgent thing\n/);
  assert.match(r.out, /- answer now/);
  assert.match(r.out, /ALSO \(low priority, 2 lines[^\n]*\n- custom:x: 2 lines; last: mention one \| mention two/);
  // a low backlog: nothing for 49 lines, a wake at 50, printed as a backlog block
  w = run(dir, "inbox");
  await sleep(1000);
  for (let i = 1; i <= 49; i++) subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | mention ${i}`);
  await sleep(4500);
  assert.equal(w.child.exitCode, null, "woke under the cap");
  subs.deliver(inst.paths, "inbox", `${now()} | custom:x | custom | mention 50`);
  const r2 = await w.done;
  assert.equal(r2.code, 0);
  assert.match(r2.out, /^LOW-PRIORITY BACKLOG for inbox inbox/);
  assert.match(r2.out, /- custom:x: 50 lines; last: mention 49 \| mention 50/);
  assert.doesNotMatch(r2.out, /INSTRUCTIONS/);
  // --priority on a plain subscription, and the sub command says so
  assert.match(cli(dir, "sub", "quiet-inbox", "--filter", "custom:x", "--priority", "low", "--ttl", "10m"), /low priority: lines ride along/);
  assert.match(cli(dir, "subs"), /quiet-inbox: .*priority low/);
  assert.throws(() => cli(dir, "sub", "bad", "--filter", "x", "--priority", "high"), /priority must be one of/);
});
