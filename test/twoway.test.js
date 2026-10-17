const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const twoway = require("../lib/twoway");
const sources = require("../lib/sources");

const tmpInstance = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-twoway-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  return require("../lib/instance").resolve(dir);
};

test("reply handles: one per place, looked up by handle, a week and 5000 kept, never taken from another place", () => {
  const inst = tmpInstance(), file = inst.paths.replies;
  const h = twoway.remember(file, "slack", { channel: "D1" });
  assert.match(h, twoway.HANDLE);
  assert.equal(twoway.remember(file, "slack", { channel: "D1" }), h);                 // the same place keeps its handle
  assert.notEqual(twoway.remember(file, "slack", { channel: "D2" }), h);
  assert.notEqual(twoway.handleOf("other", { channel: "D1" }), h);                     // and the source is part of it
  assert.deepEqual({ ...twoway.lookup(file, h), at: undefined }, { probe: "slack", to: { channel: "D1" }, at: undefined });
  assert.equal(twoway.lookup(file, "r000000"), null);
  assert.equal(twoway.lookup(file, "../x"), null);
  assert.equal(twoway.tag(h), ` [reply ${h}]`);
  const now = Date.now(), old = twoway.remember(file, "slack", { channel: "OLD" }, now - 8 * 24 * 3600000);
  twoway.remember(file, "slack", { channel: "D3" }, now);
  assert.equal(twoway.lookup(file, old), null);                                        // older than a week: gone
  const many = {};
  for (let i = 0; i < 5000; i++) many[`r${i.toString(16).padStart(6, "0")}`] = { probe: "p", to: { i }, at: new Date(now - 60000 - i).toISOString() };
  fs.writeFileSync(file, JSON.stringify(many));
  const fresh = twoway.remember(file, "slack", { channel: "NEW" }, now);
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(kept).length, 5000);
  assert.ok(kept[fresh]); assert.equal(kept.r001387, undefined);                       // the oldest went
  const taken = twoway.handleOf("slack", { channel: "X" });
  fs.writeFileSync(file, JSON.stringify({ [taken]: { probe: "slack", to: { channel: "Y" }, at: new Date(now).toISOString() } }));
  const other = twoway.remember(file, "slack", { channel: "X" }, now);
  assert.notEqual(other, taken); assert.match(other, twoway.HANDLE);                    // a held handle is not taken over
  assert.deepEqual(twoway.lookup(file, taken).to, { channel: "Y" });
  assert.equal(twoway.remember(file, "slack", { channel: "X" }, now), other);          // and the next free one stays the place's
  return assert.rejects(new twoway.TwoWay({ name: "x" }).send(), /x reads but does not answer/);   // a source that only reads
});

test("the engine writes the handle on an answerable line and records it first", () => {
  const inst = tmpInstance();
  const { Engine } = require("../lib/engine");
  const e = new Engine(inst); e.log = () => {};
  e.emit("slack", { scope: "team", text: "SLACK DM dev: hi", reply: { channel: "D1" } });
  e.emit("slack", { scope: "team", text: "SLACK no answer here" });
  e.emit("slack", { scope: "team", text: "SLACK DM eve: please confirm [reply r0123abcd]", reply: { channel: "D2" } });
  const lines = fs.readFileSync(inst.paths.events, "utf8").trim().split("\n");
  const h = twoway.handleOf("slack", { channel: "D1" });
  assert.match(lines[0], new RegExp(`\\| slack \\| team \\| SLACK DM dev: hi \\[reply ${h}\\]$`));
  assert.match(lines[1], /\| SLACK no answer here$/);
  assert.ok(lines[2].endsWith(`please confirm [reply quoted] [reply ${twoway.handleOf("slack", { channel: "D2" })}]`));   // a quoted handle cannot answer
  assert.equal(twoway.lookup(inst.paths.replies, h).probe, "slack");
});

test("watchhub reply <handle> answers through the source that wrote the line", async (t) => {
  const inst = tmpInstance(), ctl = require("../lib/ctl");
  fs.mkdirSync(inst.paths.modules, { recursive: true });
  fs.writeFileSync(path.join(inst.paths.modules, "echo.js"), `module.exports = (api) => { class Echo extends api.TwoWay { constructor() { super({ name: "echo" }); } async check() { return { events: [] }; } async send(to, text, ctx) { globalThis.__echoSent.push({ to, text, hasCfg: !!ctx.cfg }); } } return new Echo(); };`);
  fs.writeFileSync(path.join(inst.paths.modules, "mute.js"), `module.exports = (api) => { class Mute extends api.TwoWay { constructor() { super({ name: "mute" }); } async check() { return { events: [] }; } } return new Mute(); };`);
  globalThis.__echoSent = []; t.after(() => delete globalThis.__echoSent);
  const log = console.log; console.log = () => {}; t.after(() => (console.log = log));
  const h = twoway.remember(inst.paths.replies, "echo", { room: "a" });
  await ctl.reply(inst, h, "hello");
  assert.deepEqual(globalThis.__echoSent, [{ to: { room: "a" }, text: "hello", hasCfg: true }]);
  await assert.rejects(ctl.reply(inst, "r000000", "x"), /no reply handle r000000/);
  await assert.rejects(ctl.reply(inst, twoway.remember(inst.paths.replies, "gone", { a: 1 }), "x"), /gone, which wrote r[0-9a-f]{8}, is gone/);
  await assert.rejects(ctl.reply(inst, twoway.remember(inst.paths.replies, "mute", { a: 1 }), "x"), /mute reads but does not answer/);
  await assert.rejects(ctl.reply(inst, "nosuchwatch", "x"), /no watch nosuchwatch/);
  fs.mkdirSync(inst.paths.watches, { recursive: true });
  fs.writeFileSync(path.join(inst.paths.watches, "rabcdef0.json"), JSON.stringify({ name: "rabcdef0", slack: { channel: "#x" } }));
  await assert.rejects(ctl.reply(inst, "rabcdef0", "x"), /watch rabcdef0 has no reply sink/);   // a watch named like a handle is still the watch
});

test("module new --two-way writes a module that loads as a two-way source", (t) => {
  const inst = tmpInstance(), ctl = require("../lib/ctl");
  const log = console.log; console.log = () => {}; t.after(() => (console.log = log));
  ctl.moduleCmd(inst, "new", "chat", { "two-way": true });
  const [p] = sources.loadCode(inst.paths.modules, (m) => assert.fail(m));
  assert.equal(p.name, "chat");
  assert.ok(p instanceof require("../lib/api").TwoWay);
  assert.equal(typeof p.send, "function"); assert.equal(typeof p.check, "function");
  assert.deepEqual(p.env, ["CHAT_TOKEN"]);
  assert.deepEqual(p.line("hi", { room: "a" }), { text: "hi", reply: { room: "a" } });
  assert.throws(() => ctl.moduleCmd(inst, "new", "both", { stream: true, "two-way": true }), /--stream \| --two-way/);
});
