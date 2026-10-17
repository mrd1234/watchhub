const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const timer = require("../lib/kinds/timer");
const sources = require("../lib/sources");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-feat-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, ...extra })); return dir; };

test("timer kind: every and at, never a stale slot", async () => {
  sources.validate({ name: "t", timer: { every: "2h" } });
  assert.throws(() => sources.validate({ name: "t", timer: { every: "10" } }), /at least 60/);
  assert.throws(() => sources.validate({ name: "t", timer: { at: "25:00" } }), /HH:MM/);
  const created = new Date(Date.now() - 3 * 3600 * 1000).toISOString();     // created three hours ago, every 2 h
  let r = await timer.poll({ name: "t", created, timer: { every: "2h" } }, undefined);
  assert.deepEqual(r.events, []);                                            // first run records the slot
  r = await timer.poll({ name: "t", created, timer: { every: "2h" } }, r.state);
  assert.deepEqual(r.events, ["due t"]);                                     // that slot has passed: due once
  assert.ok(r.state.next > Date.now());
  r = await timer.poll({ name: "t", created, timer: { every: "2h" } }, r.state);
  assert.deepEqual(r.events, []);
  const a = await timer.poll({ name: "d", timer: { at: ["09:00", "17:30"] }, text: "DIGEST DUE" }, undefined);
  assert.ok(a.state.next > Date.now() && a.state.next <= Date.now() + 24 * 3600 * 1000);
});

test("events query and stats read the log; sub --once removes itself after the burst", async (t) => {
  const dir = mk({ engine: { settleSec: 1 } });
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  assert.match(cli(dir, "sub", "inbox", "--filter", "x", "--ttl", "10m", "--once"), /once: removed after its first burst/);
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  const child = spawn(process.execPath, [BIN, "wait", "inbox", "--instance", dir], { windowsHide: true });
  let out = ""; child.stdout.on("data", (d) => (out += d));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  await sleep(1000);
  subs.deliver(inst.paths, "inbox", "2026-01-01T00:00:00.000Z | custom:x | custom | match: once");
  assert.equal(await done, 0);
  assert.match(out, /match: once/);
  assert.match(out, /once: subscription inbox removed/);
  assert.match(cli(dir, "subs"), /no subscriptions/);
  assert.match(cli(dir, "events", "--grep", "match: once"), /match: once/);
  assert.doesNotMatch(cli(dir, "events"), /engine started/);   // a start is log-only, never a wake
  assert.match(cli(dir, "events", "--since", "1s", "--grep", "nothing-like-this"), /no events in the last 1s matching/);
  assert.match(cli(dir, "events", "--inbox", "inbox"), /match: once/);
  const s = cli(dir, "stats");
  assert.match(s, /wakes: 1 \(inbox 1\)/);
  assert.match(s, /events: \d+/);
});
