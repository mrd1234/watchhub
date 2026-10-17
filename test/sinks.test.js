const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, execFile } = require("child_process");
const sinks = require("../lib/sinks");
const plans = require("../lib/plans");
const sources = require("../lib/sources");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, env, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
// the receiver lives in this process, so a CLI call that must reach it cannot block the event loop
const cliAsync = (dir, env, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }, (e, out, err) => e ? reject(Object.assign(e, { stderr: err })) : resolve(out)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-sink-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1 }, ...extra })); return dir; };

// a local webhook that records every body it is posted
function receiver() {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ url: req.url, headers: req.headers, body: b }); res.statusCode = req.url.startsWith("/fail") ? 500 : 200; res.end("ok"); }); });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ got, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

test("sink validation: shape, names on watches, plans and rules", () => {
  assert.throws(() => sinks.check({ name: "x" }), /exactly one of http, toast/);
  assert.throws(() => sinks.check({ name: "Bad", http: { url: "https://a" } }), /name/);
  assert.throws(() => sinks.check({ name: "x", http: { url: "ftp://a" } }), /http\(s\) URL/);
  sinks.check({ name: "x", http: { url: "${SOME_URL}", body: "plain {text}" } });
  assert.throws(() => sources.validate({ name: "w", timer: { every: "1h" }, sinks: "slack" }), /sinks must be a list/);
  sources.validate({ name: "w", timer: { every: "1h" }, sinks: ["slack"] });
  assert.throws(() => plans.check({ name: "p", on: [{ match: "x", do: "y", sinks: [1] }] }), /on\[\]\.sinks/);
  const p = plans.check({ name: "p", sinks: ["slack"], default: "look", on: [{ match: "MERGED", do: "deploy", sinks: ["toast"] }, { match: "noise", quiet: true }, { match: "silent", do: "nothing", sinks: [] }] });
  assert.deepEqual(plans.sinksFor(p, "t | a | b | MERGED x").sinks, ["toast"]);         // the rule's own list
  assert.deepEqual(plans.sinksFor(p, "t | a | b | MERGED x").extra, { do: "deploy" });
  assert.deepEqual(plans.sinksFor(p, "t | a | b | other").sinks, ["slack"]);            // the plan's list
  assert.deepEqual(plans.sinksFor(p, "t | a | b | noise").sinks, []);                   // quiet goes nowhere
  assert.deepEqual(plans.sinksFor(p, "t | a | b | silent").sinks, []);                  // an empty list keeps the rule off every sink
});

test("context and body templating: one line and a batch", () => {
  const c1 = sinks.context(["2026-01-01T00:00:00.000Z | pr-merges | team | MERGED a#1"], { inbox: "x" });
  assert.equal(c1.text, "MERGED a#1"); assert.equal(c1.probe, "pr-merges"); assert.equal(c1.count, 1); assert.equal(c1.inbox, "x");
  const many = Array.from({ length: 25 }, (_, i) => `2026-01-01T00:00:00.000Z | p | s | line ${i}`);
  const c = sinks.context(many);
  assert.equal(c.count, 25);
  assert.match(c.text, /line 19\n\(\+5 more\)$/);
  assert.doesNotMatch(c.text, /line 20/);
});

test("http sink: posts a templated JSON body, batches a burst, reports failures", async (t) => {
  const r = await receiver();
  t.after(() => r.close());
  const s = sinks.check({ name: "hook", http: { url: "${HOOK_URL}/post", headers: { "X-Token": "${HOOK_TOKEN}" }, body: { text: "{text}", from: "{probe}", n: "{count}" } } });
  await sinks.send(s, sinks.context(["2026-01-01T00:00:00.000Z | pr-merges | team | MERGED a#1"]), { HOOK_URL: r.url, HOOK_TOKEN: "t0k" });
  assert.equal(r.got.length, 1);
  assert.deepEqual(JSON.parse(r.got[0].body), { text: "MERGED a#1", from: "pr-merges", n: "1" });
  assert.equal(r.got[0].headers["x-token"], "t0k");
  assert.equal(r.got[0].headers["content-type"], "application/json");
  await assert.rejects(sinks.send(s, sinks.context(["x"]), { HOOK_URL: r.url + "/fail", HOOK_TOKEN: "" }), /HTTP 500/);
  await assert.rejects(sinks.send(s, sinks.context(["x"]), { HOOK_URL: "", HOOK_TOKEN: "" }), /empty after substitution/);
  // the Sender: lines pushed while one send is in flight go out as one message
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-sender-"));
  fs.mkdirSync(path.join(dir, "sinks"));
  process.env.HOOK_URL = r.url; process.env.HOOK_TOKEN = "";
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/post", body: { text: "{text}" } } }));
  const logs = [], emitted = [];
  const sender = new sinks.Sender(path.join(dir, "sinks"), (m) => logs.push(m), (m) => emitted.push(m), { retryMs: [200, 200, 200] });   // short retry pauses for the test
  r.got.length = 0;
  for (let i = 0; i < 5; i++) sender.push("hook", `2026-01-01T00:00:00.000Z | p | s | line ${i}`);
  sender.push("nope", "2026-01-01T00:00:00.000Z | p | s | lost");
  await sleep(1500);
  assert.ok(r.got.length >= 1 && r.got.length <= 2, `got ${r.got.length} posts`);   // first line alone, the rest batched (or all in one)
  assert.equal(r.got.map((g) => JSON.parse(g.body).text).join("\n").split("\n").length, 5);
  assert.ok(logs.some((l) => /sink nope named but not defined/.test(l)));
  // a failed batch is kept and tried again; three failures in a row surface once as an engine line, then the recovery
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/fail", body: { text: "{text}" } } }));
  sender.reload();
  sender.push("hook", "2026-01-01T00:00:00.000Z | p | s | f0");
  await sleep(900);
  assert.equal(emitted.filter((m) => /sink hook failing: HTTP 500/.test(m)).length, 1);
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/post", body: { text: "{text}" } } }));
  sender.reload();
  sender.push("hook", "2026-01-01T00:00:00.000Z | p | s | back");
  await sleep(600);
  assert.ok(emitted.some((m) => /sink hook works again/.test(m)));
});

test("engine routes a line to sinks named by the watch, the subscription and the plan rule, once each", async (t) => {
  const r = await receiver();
  const dir = mk();
  t.after(() => { r.close(); try { cli(dir, {}, "stop"); } catch {} });
  const env = { HOOK_URL: r.url };
  assert.match(cli(dir, env, "sink", "add", JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/w", body: { text: "{text}", inbox: "{inbox}", do: "{do}" } } })), /sink hook added/);
  assert.match(cli(dir, env, "sink", "add", JSON.stringify({ name: "other", http: { url: "${HOOK_URL}/o", body: { text: "{text}" } } })), /sink other added/);
  assert.match(cli(dir, env, "sink", "list"), /hook: http POST \$\{HOOK_URL\}\/w\nother: http POST/);
  assert.match(await cliAsync(dir, env, "sink", "send", "hook", "hello there"), /sent to hook/);
  assert.equal(JSON.parse(r.got.pop().body).text, "hello there");
  assert.throws(() => cli(dir, env, "sub", "l0", "--filter", "x", "--sinks", "missing"), /no sink missing/);
  fs.mkdirSync(path.join(dir, "plans")); fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:tick"], sinks: ["other"], on: [{ match: "due tick", do: "say hi", sinks: ["hook"] }] }));
  cli(dir, env, "start");
  // a watch that fires on its first run and names a sink itself
  fs.writeFileSync(path.join(dir, "watches", "tick.json"), JSON.stringify({ name: "tick", command: "echo due tick", match: "due tick", intervalSec: 3600, sinks: ["hook"] }));
  assert.match(cli(dir, env, "sub", "inbox", "--plan", "p", "--sinks", "hook", "--ttl", "10m"), /every hit also goes to hook/);
  assert.match(cli(dir, env, "subs"), /sinks hook/);
  await sleep(4000);
  const posts = r.got.map((g) => ({ url: g.url, ...JSON.parse(g.body) }));
  const hook = r.got.filter((g) => /due tick/.test(JSON.parse(g.body).text));
  assert.equal(hook.length, 1, `hook got ${JSON.stringify(posts)}`);                // watch + sub + rule all named hook: one post
  assert.deepEqual(JSON.parse(hook[0].body), { text: "match: due tick", inbox: "inbox", do: "say hi" });
  assert.ok(!r.got.some((g) => g.url === "/o"), "the plan-level sink is overridden by the rule");
  assert.match(cli(dir, env, "watch", "list"), /sinks hook/);
  const d = cli(dir, env, "doctor");
  assert.match(d, /ok {4}sinks: hook, other\n/);   // both used: the watch and sub name hook, the plan names other
  assert.match(d, /env HOOK_URL: set in the environment/);
});

test("a sink removed while lines waited does not leave its queue stuck", async (t) => {
  const r = await receiver();
  t.after(() => r.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-sender2-"));
  fs.mkdirSync(path.join(dir, "sinks"));
  process.env.HOOK_URL = r.url;
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/post", body: { text: "{text}" } } }));
  const sender = new sinks.Sender(path.join(dir, "sinks"), () => {}, () => {});
  sender.push("hook", "2026-01-01T00:00:00.000Z | p | s | one");
  fs.rmSync(path.join(dir, "sinks", "hook.json")); sender.reload();
  sender.push("hook", "2026-01-01T00:00:00.000Z | p | s | lost");          // no sink: dropped, logged once
  await sleep(1500);
  fs.writeFileSync(path.join(dir, "sinks", "hook.json"), JSON.stringify({ name: "hook", http: { url: "${HOOK_URL}/post", body: { text: "{text}" } } })); sender.reload();
  sender.push("hook", "2026-01-01T00:00:00.000Z | p | s | after");
  await sleep(1500);
  assert.deepEqual(r.got.map((g) => JSON.parse(g.body).text), ["one", "after"]);
});

test("reply: a watch names the sink that answers where it reads, and watchhub reply sends through it", async (t) => {
  assert.throws(() => sources.validate({ name: "notes", timer: { every: "1h" }, reply: "Slack Me" }), /reply must be the name of the sink/);
  assert.throws(() => sources.validate({ name: "notes", timer: { every: "1h" }, reply: ["me"] }), /reply must be/);
  sources.validate({ name: "notes", timer: { every: "1h" }, reply: "me" });
  const r = await receiver(), dir = mk(), env = { HOOK_URL: r.url };
  t.after(() => r.close());
  fs.mkdirSync(path.join(dir, "watches"));
  fs.writeFileSync(path.join(dir, "watches", "notes.json"), JSON.stringify({ name: "notes", scope: "team", timer: { every: "1h" }, reply: "me" }));
  fs.writeFileSync(path.join(dir, "watches", "plain.json"), JSON.stringify({ name: "plain", timer: { every: "1h" } }));
  await assert.rejects(cliAsync(dir, env, "reply", "notes", "on it"), (e) => /replies through sink me, which is not defined/.test(e.stderr));
  cli(dir, env, "sink", "add", JSON.stringify({ name: "me", http: { url: "${HOOK_URL}/me", body: { text: "[wh] {text}", from: "{probe} {scope}" } } }));
  assert.match(cli(dir, env, "watch", "list"), /notes: timer.*reply me/);
  assert.match(await cliAsync(dir, env, "reply", "custom:notes", "on it"), /replied in notes through me/);
  assert.deepEqual(JSON.parse(r.got.pop().body), { text: "[wh] on it", from: "custom:notes team" });
  await assert.rejects(cliAsync(dir, env, "reply", "plain", "x"), (e) => /has no reply sink/.test(e.stderr));
  await assert.rejects(cliAsync(dir, env, "reply", "ghost", "x"), (e) => /no watch ghost/.test(e.stderr));
});
