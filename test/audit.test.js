// Cases from the 15 Oct adversarial audit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-audit-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, ...extra })); return dir; };
function waiter(dir, inbox, extra = []) {
  const child = spawn(process.execPath, [BIN, "wait", inbox, ...extra, "--instance", dir], { windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return { child, done: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err }))) };
}

test("a superseded waiter never prints or acks a burst; the new waiter gets it", async (t) => {
  const dir = mk({ engine: { settleSec: 2 } });
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "inbox", "--filter", "x", "--ttl", "10m");
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  const a = waiter(dir, "inbox");
  await sleep(1500);
  const b = waiter(dir, "inbox");          // takes the lease at once
  await sleep(300);
  subs.deliver(inst.paths, "inbox", "2026-01-01T00:00:00.000Z | custom:x | custom | match: for b only");
  const ra = await a.done, rb = await b.done;
  assert.equal(ra.code, 3, ra.out);
  assert.doesNotMatch(ra.out, /for b only/);
  assert.equal(rb.code, 0, rb.err);
  assert.match(rb.out, /for b only/);
});

test("quiet-only bursts do not wake; they ride along with the next real line", async (t) => {
  const dir = mk({ engine: { settleSec: 1 } });
  fs.mkdirSync(path.join(dir, "plans"));
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:x"], on: [{ match: "moved", quiet: true }, { match: "merged", do: "act" }] }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "inbox", "--plan", "p", "--ttl", "10m");
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  const w = waiter(dir, "inbox");
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", `${new Date().toISOString()} | custom:x | custom | moved 1`);   // a current stamp: a low line older than 4 h wakes by design
  await sleep(4000);
  assert.equal(w.child.exitCode, null, "woke on a quiet line");
  subs.deliver(inst.paths, "inbox", "2026-01-01T00:00:01.000Z | custom:x | custom | merged 2");
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /merged 2/);
  assert.match(r.out, /- act/);
  assert.match(r.out, /ALSO \(low priority, 1 line since the last burst[^\n]*\n- custom:x: 1; moved 1/);   // the low line rides along, grouped by probe
  assert.doesNotMatch(r.out, /\| moved 1/);
});

test("a notice reaches every inbox without waking it; --wake wakes", async (t) => {
  const dir = mk({ engine: { settleSec: 1 } });
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  cli(dir, "sub", "inbox", "--filter", "x", "--ttl", "10m");
  const w = waiter(dir, "inbox");
  await sleep(1000);
  assert.match(cli(dir, "notice", "planned work, nothing to do"), /notice sent to 1 inbox: inbox/);
  await sleep(4000);
  assert.equal(w.child.exitCode, null, "a plain notice woke the inbox");
  cli(dir, "notice", "look now", "--wake");
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ALSO [^\n]*\n- notice: 1; planned work, nothing to do/);   // the quiet notice rides along in the ALSO block
  assert.match(r.out, /WAKE: look now/);
});

test("a stale lock with a reused pid does not count as a running engine", () => {
  const dir = mk();
  const inst = require("../lib/instance").resolve(dir);
  const { enginePid } = require("../lib/engine");
  fs.writeFileSync(inst.paths.lock, String(process.pid));   // alive pid, but never touched again
  const old = new Date(Date.now() - 10 * 60000);
  fs.utimesSync(inst.paths.lock, old, old);
  assert.equal(enginePid(inst.paths), 0);
  fs.utimesSync(inst.paths.lock, new Date(), new Date());
  assert.equal(enginePid(inst.paths), process.pid);
});

test("a fresh subscription starts clean: old inbox lines do not wake it", async (t) => {
  const dir = mk();
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  subs.deliver(inst.paths, "inbox", "2026-01-01T00:00:00.000Z | watchhub | all | SUBSCRIPTION inbox expired (ttl)");
  cli(dir, "sub", "inbox", "--filter", "x", "--ttl", "10m");
  const w = waiter(dir, "inbox");
  await sleep(2500);
  assert.equal(w.child.exitCode, null, "woke on a stale line");
  assert.match(cli(dir, "unsub", "inbox"), /its waiter \(pid \d+\) hands over what is unread/);
  const r = await w.done;
  assert.match(r.out, /1 unread line from before this subscription set aside/);   // the waiter hands over what the unsub left it
  assert.ok(!r.out.includes("SUBSCRIPTION inbox expired"), "the stale line stays set aside");
});

test("stop never clears the lock of a live engine, even when its heartbeat is stale", async (t) => {
  const dir = mk();
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const lock = path.join(dir, "engine.lock");
  const pid = Number(fs.readFileSync(lock, "utf8"));
  const old = new Date(Date.now() - 10 * 60000);
  fs.utimesSync(lock, old, old);                          // as after a long sleep: the engine is alive, the heartbeat looks stale
  const { enginePid } = require("../lib/engine");
  assert.equal(enginePid(require("../lib/instance").resolve(dir).paths), 0, "a stale heartbeat reads as not running");
  assert.ok(cli(dir, "stop").includes(`stopped (pid ${pid})`), "stop still finds and ends it by the lock's pid");
  assert.ok(!fs.existsSync(lock));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("an engine whose lock another live engine holds leaves on its own heartbeat", async (t) => {
  const dir = mk();
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const lock = path.join(dir, "engine.lock");
  const pid = Number(fs.readFileSync(lock, "utf8"));
  // this test process poses as another engine holding the lock: its command line must look like one
  const other = spawn(process.execPath, ["-e", "process.argv.push('watchhub.js','engine'); setTimeout(()=>{}, 120000)", "--", "watchhub.js", "engine"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { other.kill(); } catch {} });
  fs.writeFileSync(lock, String(other.pid));
  await sleep(31000);                                      // one heartbeat
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the engine should have exited");
  assert.match(fs.readFileSync(path.join(dir, "engine.log"), "utf8"), /engine\.lock is held by live engine pid .*; this engine .* leaves to it[\s\S]*engine exit \(code 3\)/);   // 3: a launcher behind it stands by
  fs.rmSync(lock, { force: true });
});

test("stop asks the engine to end itself: streams are aborted, state flushed, the exit logged", async (t) => {
  const dir = mk();
  fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "watches", "tail.json"), JSON.stringify({ name: "tail", exec: { command: "echo up; sleep 300" } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  await sleep(2500);
  const out = cli(dir, "stop");
  assert.match(out, /stopped \(pid \d+\)/);
  const log = fs.readFileSync(path.join(dir, "engine.log"), "utf8");
  assert.match(log, /engine stopping \(requested\)/);
  assert.match(log, /engine exit \(code 0\)/);
  assert.ok(!fs.existsSync(path.join(dir, "engine.stop")));
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.ok(state["custom:tail"], "state was flushed on the way out");
});
