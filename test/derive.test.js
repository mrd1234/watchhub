const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const derive = require("../lib/kinds/derive");
const sources = require("../lib/sources");
const events = require("../lib/events");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fake stream context: events pushed by hand, emits and state captured
function ctx(state) {
  const ac = new AbortController(), out = [], subs = new Set();
  return { signal: ac.signal, state, out, emit: (t) => out.push(t), setState: (s) => (state = s), getState: () => state, running: () => {}, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, push: (line) => { for (const fn of subs) fn(events.parse(line)); }, stop: () => ac.abort() };
}
const line = (probe, text, at = new Date()) => events.format(probe, "all", text, at);

test("derive validation", () => {
  assert.throws(() => sources.validate({ name: "d", derive: {} }), /needs probes and\/or match/);
  assert.throws(() => sources.validate({ name: "d", derive: { probes: ["x"] } }), /needs rate .* silence/);
  assert.throws(() => sources.validate({ name: "d", derive: { probes: ["x"], rate: { window: "5s", over: 3 } } }), /at least 10 s/);
  assert.throws(() => sources.validate({ name: "d", derive: { probes: ["x"], rate: { window: "5m", over: 0 } } }), /rate.over/);
  assert.throws(() => sources.validate({ name: "d", derive: { match: "(", rate: { window: "5m", over: 2 } } }), /Invalid regular expression/);
  sources.validate({ name: "d", derive: { match: "outage|P1", rate: { window: "10m", over: 5 }, silence: { for: "1h" } } });
});

test("rate: one SPIKE line at the threshold, one when over; own lines and other probes not counted", async (t) => {
  const w = sources.validate({ name: "storm", derive: { probes: ["custom:slack-inbox"], rate: { window: "10s", over: 3 } } });
  const c = ctx(undefined);
  t.after(() => c.stop());   // a failed assertion must not leave the tick running
  const done = derive.start(w, c);
  c.push(line("custom:slack-inbox", "a")); c.push(line("other", "b")); c.push(line("custom:storm", "SPIKE: self"));
  c.push(line("custom:slack-inbox", "c"));
  assert.deepEqual(c.out, []);
  c.push(line("custom:slack-inbox", "d"));
  assert.deepEqual(c.out, ["SPIKE: 3 custom:slack-inbox lines in 10s (threshold 3)"]);
  c.push(line("custom:slack-inbox", "e")); c.push(line("custom:slack-inbox", "f"));
  assert.equal(c.out.length, 1, "no second SPIKE while spiking");
  assert.equal(c.getState().times.length, 5);
  // the window passes: the tick re-arms once under half the threshold
  c.getState().times = c.getState().times.map((t) => t - 11000);
  await sleep(4200);   // the re-arm tick runs every 3.75 s without a silence rule
  assert.deepEqual(c.out.slice(1), ["SPIKE over: custom:slack-inbox back to 0 lines in 10s"]);
  c.stop(); await done;
});

test("silence: SILENT after the quiet period, SILENT over on the next line, measured from saved state", async (t) => {
  const w = sources.validate({ name: "quiet", derive: { match: "STAMP", silence: { for: "10s" } } });
  const c = ctx({ lastSeen: Date.now() - 20000 });   // state from before a restart: already quiet for 20 s
  t.after(() => c.stop());
  const done = derive.start(w, c);
  await sleep(3000);
  assert.equal(c.out.length, 1); assert.match(c.out[0], /^SILENT: nothing from \/STAMP\/ for 10s \(last at /);
  c.push(line("stamps", "no match here"));
  assert.equal(c.out.length, 1);
  c.push(line("stamps", "STAMP staging api 1.2.3"));
  assert.match(c.out[1], /^SILENT over: \/STAMP\/ spoke again after 0 min/);
  assert.equal(c.getState().silent, false);
  c.stop(); await done;
});

test("in the engine: a derive watch sees the stream and its lines reach an inbox", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-derive-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1 } }));
  fs.mkdirSync(path.join(dir, "watches"));
  // a stream that prints four lines at once, and a derive watch that calls three in a minute a spike
  fs.writeFileSync(path.join(dir, "watches", "chatter.json"), JSON.stringify({ name: "chatter", exec: { command: "echo one; echo two; echo three; echo four; sleep 30" } }));
  fs.writeFileSync(path.join(dir, "watches", "storm.json"), JSON.stringify({ name: "storm", derive: { probes: ["custom:chatter"], rate: { window: "1m", over: 3 } } }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  await sleep(6000);
  const ev = cli(dir, "events", "--probe", "custom:storm");
  assert.match(ev, /custom:storm \| custom \| SPIKE: 3 custom:chatter lines in 1m \(threshold 3\)/);
  assert.equal((ev.match(/SPIKE:/g) || []).length, 1);
  assert.match(cli(dir, "watch", "list"), /storm: derive/);
});
