// End to end: a real engine on a temporary instance, a file watch, a subscription, a waiter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waiter(dir, inbox, extra = []) {
  const child = spawn(process.execPath, [BIN, "wait", inbox, ...extra, "--instance", dir], { windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
  return { child, done };
}

test("engine delivers a file watch hit to a subscribed inbox; the waiter prints it, acks and exits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1 } }));
  const log = path.join(dir, "app.log");
  fs.writeFileSync(log, "start\n");
  cli(dir, "watch", "add", JSON.stringify({ name: "applog", intervalSec: 5, file: { path: log, match: "FAILED" } }));
  cli(dir, "plan", "add", (() => { const f = path.join(dir, "p.json"); fs.writeFileSync(f, JSON.stringify({ name: "p", probes: ["custom:applog"], on: [{ match: "FAILED", do: "look at the log" }] })); return f; })());
  assert.match(cli(dir, "start"), /started \(pid \d+\)/);
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  assert.match(cli(dir, "sub", "lane1", "--plan", "p", "--ttl", "10m"), /subscription lane1 added/);
  await sleep(1500); // the engine picks up the subscription folder change
  const w = waiter(dir, "lane1");
  await sleep(6500); // first poll records the baseline
  fs.appendFileSync(log, "job FAILED badly\n");
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /custom:applog \| custom \| line: job FAILED badly/);
  assert.match(r.out, /INSTRUCTIONS\n- look at the log/);
  assert.match(cli(dir, "subs"), /lane1: plan p/);
  assert.doesNotMatch(cli(dir, "subs"), /UNACKNOWLEDGED/);
  const status = cli(dir, "status");
  assert.match(status, /running \(pid/);
  assert.match(status, /custom:applog: last run/);
});

test("a second waiter for the same inbox supersedes the first, which exits 3 on its own", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "lane2", "--filter", "nothing-ever", "--ttl", "10m");
  const a = waiter(dir, "lane2");
  await sleep(1500);
  const b = waiter(dir, "lane2");
  t.after(() => { try { b.child.kill(); } catch {} });
  const ra = await a.done;
  assert.equal(ra.code, 3);
  assert.match(ra.out, /SUPERSEDED: another waiter took inbox lane2/);   // on stdout, so the session reading the task sees it
  b.child.kill();
  await b.done;
});

test("an unacknowledged burst is delivered on the next arm, and unsub ends a waiter", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "lane3", "--filter", "x", "--ttl", "10m");
  const subs = require("../lib/subs");
  const inst = require("../lib/instance").resolve(dir);
  subs.deliver(inst.paths, "lane3", "2026-01-01T00:00:00.000Z | custom:x | custom | match: earlier");
  const w = waiter(dir, "lane3");
  const r = await w.done;
  assert.equal(r.code, 0);
  assert.match(r.out, /match: earlier/);
  const w2 = waiter(dir, "lane3");
  await sleep(1000);
  cli(dir, "unsub", "lane3");
  const r2 = await w2.done;
  assert.equal(r2.code, 0);
  assert.match(r2.out, /SUBSCRIPTION lane3 removed/);
});

test("webhook stream: a POST on the loopback listener becomes an event", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  const port = 47000 + Math.floor(Math.random() * 900);
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, webhook: { port } }));
  cli(dir, "watch", "add", JSON.stringify({ name: "hook", webhook: { path: "/gh", text: "{action} #{number}" } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "lane4", "--probes", "custom:hook", "--ttl", "10m");
  await sleep(2000);
  const w = waiter(dir, "lane4");
  await sleep(1000);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/gh", method: "POST" }, (res) => { assert.equal(res.statusCode, 204); resolve(); });
    req.on("error", reject);
    req.end(JSON.stringify({ action: "merged", number: 42 }));
  });
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /custom:hook \| custom \| merged #42/);
});

test("exec stream: lines from a long-running command are events and the stream restarts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  const script = path.join(dir, "feed.js");
  fs.writeFileSync(script, "setTimeout(()=>{console.log('tick 1');setTimeout(()=>process.exit(0),200)},300)");
  cli(dir, "watch", "add", JSON.stringify({ name: "feed", exec: { command: `node "${script}"` } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "lane5", "--probes", "custom:feed", "--ttl", "10m");
  await sleep(1500);
  const w = waiter(dir, "lane5");
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /custom:feed \| custom \| line: tick 1/);
  await sleep(6500); // ended normally -> restarted after 5 s -> another tick lands in the inbox
  const u = require("../lib/subs").unacked(require("../lib/instance").resolve(dir).paths, "lane5");
  assert.match(u.text, /tick 1/);
});

test("a module that throws in its own timer or emits a null line does not take the engine down", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-e2e-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.mkdirSync(path.join(dir, "modules"));
  fs.writeFileSync(path.join(dir, "modules", "boom.js"), `module.exports = { name: "boom", stream: true, enabled: () => true,
  async start(ctx) {
    ctx.running();
    setTimeout(() => { throw new Error("boom in a timer"); }, 300);
    setTimeout(() => ctx.emit(null), 600);
    setTimeout(() => ctx.emit("still here"), 2500);
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
  } };
`);
  cli(dir, "sub", "lane6", "--probes", "boom", "--ttl", "10m");
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const w = waiter(dir, "lane6");
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /boom \| all \| still here/);
  const log = fs.readFileSync(path.join(dir, "engine.log"), "utf8");
  assert.match(log, /uncaught exception \(kept running, 1 in 10 min\): Error: boom in a timer/);
  assert.match(log, /boom: line not emitted: TypeError/);
  assert.doesNotMatch(log, /fatal:/);
});
