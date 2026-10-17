const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const kind = require("../lib/kinds/slack");
const sinks = require("../lib/sinks");
const sources = require("../lib/sources");

// a fake slack.com/api: auth.test, conversations.list/open/history, users.info, chat.postMessage
function fakeSlack() {
  const posted = [], messages = [], errs = { CNOPE12: "channel_not_found" };   // messages newest last; ts = "<n>.000"; errs: what a channel's history answers instead
  let n = 0;
  const add = (user, text, extra = {}) => { const m = { ts: `${++n}.000000`, user, text, ...extra }; messages.push(m); return m; };
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const method = req.url.replace(/^\//, ""), body = Object.fromEntries(new URLSearchParams(b));
      if (req.headers["content-type"] !== "application/x-www-form-urlencoded") return res.end(JSON.stringify({ ok: false, error: "not_form_encoded" }));
      const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== "Bearer xoxp-test") return reply({ ok: false, error: "invalid_auth" });
      if (method === "auth.test") return reply({ ok: true, user: "mark", user_id: "UME", team: "T" });
      if (method === "conversations.list") return reply({ ok: true, channels: body.types.startsWith("im") ? [{ id: "DME", user: "UME" }, { id: "DDEV", user: "UDEV" }] : [{ name: "watchhub", id: "C1" }, { name: "team", id: "C2" }], response_metadata: { next_cursor: "" } });
      if (method === "conversations.open") return reply({ ok: true, channel: { id: "DME" } });
      if (method === "search.messages") {
        const hit = body.query === "to:me" ? (m) => (m.channel || "").startsWith("D") && m.user !== "UME" : (m) => m.text.includes(body.query);
        return reply({ ok: true, messages: { matches: messages.filter(hit).map((m) => ({ ts: m.ts, user: m.user, username: m.user.toLowerCase(), text: m.text, ...(m.permalink ? { permalink: m.permalink } : {}), channel: (m.channel || "C1").startsWith("D") ? { id: m.channel, name: m.user } : { id: "C2", name: "team" } })).reverse() } });
      }
      if (method === "users.info") return reply(body.user ? { ok: true, user: { name: body.user.toLowerCase(), real_name: body.user === "UME" ? "Mark" : "Dev " + body.user } } : { ok: false, error: "user_not_found" });
      if (method === "conversations.history") {
        if (errs[body.channel]) return reply({ ok: false, error: errs[body.channel] });
        if (body.channel === "CLIMIT1") { res.statusCode = 429; return reply({ ok: false, error: "ratelimited" }); }
        let list = messages.filter((m) => (m.channel || "C1") === body.channel && (!body.oldest || Number(m.ts) > Number(body.oldest)));
        list = list.slice(-(body.limit || 100)).reverse();
        return reply({ ok: true, messages: list });
      }
      if (method === "chat.postMessage") { if (body.channel === "C2") return reply({ ok: false, error: "not_in_channel" }); posted.push({ channel: body.channel, text: body.text, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) }); return reply({ ok: true, ts: "9.000" }); }
      reply({ ok: false, error: "unknown_method" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ posted, add, errs, env: { SLACK_API_URL: `http://127.0.0.1:${srv.address().port}`, SLACK_USER_TOKEN: "xoxp-test" }, close: () => srv.close() })));
}

test("slack kind: baseline, then only new messages, own ones skipped, match applied, names resolved", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  assert.throws(() => sources.validate({ name: "x", slack: {} }), /slack needs channel/);
  const w = sources.validate({ name: "feed", slack: { channel: "#watchhub", match: "^\\[wh\\]" } });
  f.add("UME", "[wh] before baseline");
  let r = await kind.poll(w, undefined, {}, f.env);
  assert.deepEqual(r.events, []); assert.equal(r.state.lasts.C1, "1.000000"); assert.equal(r.state.channels.watchhub, "C1");
  r = await kind.poll(w, r.state, {}, f.env);
  assert.deepEqual(r.events, []);                                            // nothing new
  f.add("UME", "[wh] my own agent line");                                    // skipped: ignoreSelf
  f.add("UDEV", "morning all");                                              // skipped: no match
  f.add("UDEV", "[wh] MERGED webapp#1 by dev", { subtype: undefined });
  f.add("UDEV", "joined", { subtype: "channel_join" });                      // skipped: a join
  r = await kind.poll(w, r.state, {}, f.env);
  // every line says where an answer goes: a channel message is answered in its thread
  assert.deepEqual(r.events, [{ text: "Dev UDEV: [wh] MERGED webapp#1 by dev", reply: { channel: "C1", thread: "4.000000" } }]);
  assert.equal(r.state.lasts.C1, "5.000000"); assert.equal(r.state.users.UDEV, "Dev UDEV"); assert.equal(r.state.self, "UME");
  // ignoreSelf false and no match: everything, including own lines, @me resolves through conversations.open
  const mine = sources.validate({ name: "dm", slack: { channel: "@me", ignoreSelf: false } });
  let d = await kind.poll(mine, undefined, {}, f.env);
  assert.equal(d.state.me, "DME");
  f.add("UME", "typed in my own dm", { channel: "DME" });
  d = await kind.poll(mine, d.state, {}, f.env);
  assert.deepEqual(d.events, ["Mark: typed in my own dm"]);   // reads itself with no replyText: no handle, an answer would read back
  const wrapped = sources.validate({ name: "dm2", slack: { channel: "@me", ignoreSelf: false, match: "^(?!\\[wh\\])", replyText: "[wh] {text}" } });
  let d2 = await kind.poll(wrapped, undefined, {}, f.env);
  f.add("UME", "another", { channel: "DME" });
  d2 = await kind.poll(wrapped, d2.state, {}, f.env);
  assert.deepEqual(d2.events, [{ text: "Mark: another", reply: { channel: "DME", wrap: "[wh] {text}" } }]);   // a DM is answered in the DM, wrapped
  // the self-DM as a command channel: own lines kept, bot posts and [wh] sink posts dropped
  const notes = sources.validate({ name: "notes", slack: { channel: "@me", ignoreSelf: false, ignoreBots: true, match: "^(?!\\[wh\\])" } });
  let n = await kind.poll(notes, undefined, {}, f.env);
  f.add("UME", "[wh] MERGED x#1", { channel: "DME" });
  f.add("UME", "deploy staging after lunch", { channel: "DME" });
  f.add("", "webhook line", { channel: "DME", bot_id: "B1", subtype: "bot_message", username: "watchhub" });
  n = await kind.poll(notes, n.state, {}, f.env);
  assert.deepEqual(n.events.map((e) => e.text ?? e), ["Mark: deploy staging after lunch"]);
  await assert.rejects(kind.poll(sources.validate({ name: "bad", slack: { channel: "CNOPE12" } }), undefined, {}, f.env), /channel_not_found/);
  // @dms: every DM conversation, the sender named; @mentions: anywhere, prefixed with the channel
  const inbox = sources.validate({ name: "inbox", slack: { channel: ["@dms", "@mentions"] } });
  let i = await kind.poll(inbox, undefined, {}, f.env);
  assert.deepEqual(i.events, []); assert.deepEqual(Object.keys(i.state.lasts).sort(), ["@dms", "@mentions"]);
  f.add("UDEV", "got a minute?", { channel: "DDEV" });
  f.add("UME", "my reply", { channel: "DDEV" });                             // own: skipped
  f.add("UDEV", "<@UME> can you look at #team", { channel: "C2" });
  i = await kind.poll(inbox, i.state, {}, f.env);
  assert.deepEqual(i.events, [{ text: "DM Dev UDEV: got a minute?", reply: { channel: "DDEV" } }, { text: "#team Dev UDEV: <@UME> can you look at #team", reply: { channel: "C2", thread: "13.000000" } }]);
  i = await kind.poll(inbox, i.state, {}, f.env);
  assert.deepEqual(i.events, []);
  await assert.rejects(kind.poll(w, undefined, {}, { ...f.env, SLACK_USER_TOKEN: "" }), /SLACK_USER_TOKEN not set/);
  await assert.rejects(kind.poll(w, undefined, {}, { ...f.env, SLACK_USER_TOKEN: "wrong" }), /invalid_auth/);
});

test("slack sink: posts as the person to a named channel; a 200 with ok:false is a failure", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const s = sinks.check({ name: "team", slack: { channel: "#watchhub", text: "[wh] {text}" } });
  await sinks.send(s, sinks.context(["2026-01-01T00:00:00.000Z | pr-merges | team | MERGED a#1"]), f.env);
  assert.deepEqual(f.posted, [{ channel: "C1", text: "[wh] MERGED a#1" }]);
  await assert.rejects(sinks.send(sinks.check({ name: "team", slack: { channel: "#team" } }), sinks.context(["x"]), f.env), /not_in_channel/);
  await assert.rejects(sinks.send(sinks.check({ name: "n", slack: { channel: "#nope" } }), sinks.context(["x"]), f.env), /no channel #nope/);
  // the generic http sink sees the same ok:false
  const h = sinks.check({ name: "h", http: { url: "${SLACK_API_URL}/chat.postMessage", headers: { Authorization: "Bearer ${SLACK_USER_TOKEN}", "Content-Type": "application/x-www-form-urlencoded" }, body: "channel=C2&text={text}" } });
  await assert.rejects(sinks.send(h, sinks.context(["x"]), f.env), /said not_in_channel/);
  assert.throws(() => sinks.check({ name: "b", slack: {} }), /slack.channel/);
});

test("slack kind: an answer goes to the thread a message is in, from history or a search hit's permalink; send posts there", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const w = sources.validate({ name: "feed", slack: { channel: "#watchhub" } });
  let r = await kind.poll(w, undefined, {}, f.env);
  f.add("UDEV", "a reply in a thread", { thread_ts: "1.500000" });
  r = await kind.poll(w, r.state, {}, f.env);
  assert.deepEqual(r.events[0].reply, { channel: "C1", thread: "1.500000" });
  const dms = sources.validate({ name: "dms", slack: { channel: "@dms" } });
  let d = await kind.poll(dms, undefined, {}, f.env);
  f.add("UDEV", "in a DM thread", { channel: "DDEV", permalink: "https://x.slack.com/archives/DDEV/p3?thread_ts=2.000000&cid=DDEV" });
  d = await kind.poll(dms, d.state, {}, f.env);
  assert.deepEqual(d.events[0].reply, { channel: "DDEV", thread: "2.000000" });
  await kind.send(w, { channel: "C1", thread: "1.500000" }, "on it", { env: f.env });
  await kind.send(w, { channel: "DDEV" }, "sure", { env: f.env });
  assert.deepEqual(f.posted, [{ channel: "C1", text: "on it", thread_ts: "1.500000" }, { channel: "DDEV", text: "sure" }]);
  await assert.rejects(kind.send(w, {}, "x", { env: f.env }), /no channel to answer in/);
  // a watch passes the answer target on with its scope, and answers through the kind
  const p = sources.toProbe({ ...w, scope: "team" });
  f.add("UDEV", "next one");
  const e = await p.check(r.state, {}, f.env);
  assert.deepEqual(e.events, [{ scope: "team", text: "Dev UDEV: next one", reply: { channel: "C1", thread: "3.000000" } }]);
  await p.send({ channel: "C1" }, "from the watch", { env: f.env });
  assert.deepEqual(f.posted.at(-1), { channel: "C1", text: "from the watch" });
  assert.equal(sources.toProbe({ name: "t", timer: { every: "1h", text: "x" } }).send, undefined);   // a kind that cannot answer has no send
});

test("slack builtin: on with a slack section, one line per message labelled by place, answers through the kind", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const p = require("../lib/builtin/slack")(require("../lib/api"));
  assert.equal(p.name, "slack");
  assert.ok(p instanceof require("../lib/api").TwoWay);
  assert.equal(p.watch, undefined);   // the engine reads .watch as a JSON watch (ttl, once, sinks)
  assert.equal(p.enabled({}), false);
  assert.equal(p.enabled({ slack: { read: ["#watchhub"] }, probes: { slack: false } }), false);
  assert.equal(p.enabled({ slack: { read: ["#watchhub"] } }), true);
  assert.deepEqual(p.env({ slack: { read: ["#watchhub"], tokenEnv: "MY_SLACK" } }), ["MY_SLACK"]);
  const one = { slack: { read: ["#watchhub"], scope: "team" } };
  let r = await p.check(undefined, one, f.env);
  f.add("UDEV", "hello");
  r = await p.check(r.state, one, f.env);
  assert.deepEqual(r.events, [{ scope: "team", text: "SLACK #watchhub Dev UDEV: hello", reply: { channel: "C1", thread: "1.000000" } }]);
  const two = { slack: { read: ["@me", "#watchhub"], ignoreBots: true } };
  let s = await p.check(undefined, two, f.env);
  f.add("UDEV", "in the channel"); f.add("UDEV", "in my notes", { channel: "DME" });
  s = await p.check(s.state, two, f.env);
  assert.deepEqual(s.events.map((e) => [e.scope, e.text]), [["all", "SLACK self Dev UDEV: in my notes"], ["all", "SLACK #watchhub Dev UDEV: in the channel"]]);
  const dms = { slack: { read: ["@dms"] } };
  let d = await p.check(undefined, dms, f.env);
  f.add("UDEV", "ping", { channel: "DDEV" });
  d = await p.check(d.state, dms, f.env);
  assert.deepEqual(d.events.map((e) => e.text), ["SLACK DM Dev UDEV: ping"]);
  await p.send({ channel: "DDEV" }, "pong", { cfg: dms, env: f.env });
  assert.deepEqual(f.posted, [{ channel: "DDEV", text: "pong" }]);
});

test("slack builtin: each place keeps its own options, sinks and reply wrapping; the section gives the defaults", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const p = require("../lib/builtin/slack")(require("../lib/api"));
  const cfg = { slack: { scope: "team", ignoreBots: true, sinks: ["toast"], read: ["@dms", { channel: "@me", ignoreSelf: false, match: "^(?!\\[wh\\])", sinks: [], replyText: "[wh] {text}", scope: "notes" }] } };
  let r = await p.check(undefined, cfg, f.env);
  f.add("UDEV", "ping", { channel: "DDEV" }); f.add("UME", "do the thing", { channel: "DME" }); f.add("UME", "[wh] done", { channel: "DME" });
  r = await p.check(r.state, cfg, f.env);
  assert.deepEqual(r.events.map((e) => [e.scope, e.text, e.sinks]), [["team", "SLACK DM Dev UDEV: ping", ["toast"]], ["notes", "SLACK self Mark: do the thing", undefined]]);
  await p.send(r.events[1].reply, "on it", { cfg, env: f.env });
  await p.send(r.events[0].reply, "pong", { cfg, env: f.env });
  await p.send(r.events[1].reply, "again", { cfg: {}, env: f.env });                 // the wrapping is the one the line was read with, whatever the config says now
  await p.send({ channel: "DME", read: "@me" }, "old", { cfg, env: f.env });          // a 1.4.3 handle names its place: that place's wrapping now
  f.posted.pop().text === "[wh] old" || assert.fail("1.4.3 handle not wrapped");
  assert.deepEqual(f.posted, [{ channel: "DME", text: "[wh] on it" }, { channel: "DDEV", text: "pong" }, { channel: "DME", text: "[wh] again" }]);   // only the self-DM answer is wrapped
  const bare = { slack: { read: [{ channel: "@me", ignoreSelf: false, match: "^(?!\\[wh\\])" }] } };
  let b = await p.check(undefined, bare, f.env);
  f.add("UME", "a note", { channel: "DME" });
  b = await p.check(b.state, bare, f.env);
  assert.deepEqual(b.events, [{ scope: "all", text: "SLACK self Mark: a note" }]);   // reading itself with no wrapping: no handle, an answer would come back
  await assert.rejects(p.check(undefined, { slack: { read: [{ channel: "@me", ignoreSelf: false, replyText: "[wh] {text}" }] } }, f.env), /match refuses/);
  await assert.rejects(p.check(undefined, { slack: { read: ["@dms", { channel: "@dms", scope: "x" }] } }, f.env), /lists @dms twice/);
  await assert.rejects(p.check(undefined, { slack: { read: [{ channel: ["@dms", "@me"] }] } }, f.env), /one channel each/);
  await assert.rejects(p.check(undefined, { slack: { read: [{ channel: "@me", replyText: "[wh]" }] } }, f.env), /must contain \{text\}/);
  await assert.rejects(p.check(undefined, { slack: { read: ["@me"], sinks: "toast" } }, f.env), /list of sink names/);
});

test("the engine sends a line on to the sinks the event names", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-evsinks-"));
  fs.writeFileSync(path.join(dir, "instance.json"), "{}");
  const { Engine } = require("../lib/engine");
  const e = new Engine(require("../lib/instance").resolve(dir)); e.log = () => {};
  const pushed = []; e.sender.push = (n, line) => pushed.push([n, line.split(" | ").slice(1).join(" | ")]);
  e.emit("slack", { scope: "team", text: "SLACK DM dev: hi", sinks: ["toast", "toast", 7] });
  e.emit("slack", { scope: "team", text: "SLACK #team dev: hello" });
  assert.deepEqual(pushed, [["toast", "slack | team | SLACK DM dev: hi"]]);
});

test("doctor checks the token the slack section reads with", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-slackdoc-"));
  const cfgFile = path.join(dir, "instance.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ probes: { jobs: false }, slack: { read: ["@dms"] } }));
  const inst = require("../lib/instance").resolve(dir), { doctor } = require("../lib/doctor");
  assert.ok((await doctor(inst, { ...f.env })).some((l) => /^ok {4}slack: token works as mark in T/.test(l)));
  fs.writeFileSync(cfgFile, JSON.stringify({ probes: { jobs: false, slack: false }, slack: { read: ["@dms"] } }));
  assert.ok(!(await doctor(inst, { ...f.env })).some((l) => / slack: /.test(l)));   // switched off: not checked
  fs.writeFileSync(cfgFile, JSON.stringify({ probes: { jobs: false }, slack: { read: ["@dms", { channel: "@me", sinks: ["nope"] }] } }));
  assert.ok((await doctor(inst, { ...f.env })).some((l) => /^FAIL {2}sink nope: named by/.test(l)));
});

test("slack builtin: a place that cannot be read says so once and the others carry on; none readable fails the probe", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const p = require("../lib/builtin/slack")(require("../lib/api"));
  const cfg = { slack: { scope: "team", read: ["#watchhub", "CNOPE12"] } };
  let r = await p.check(undefined, cfg, f.env);
  assert.deepEqual(r.events, []);   // one failed poll is a blip: silent
  r = await p.check(r.state, cfg, f.env);
  assert.equal(r.events.length, 1); assert.match(r.events[0].text, /^SLACK CNOPE12 unreadable: .*channel_not_found/);
  f.add("UDEV", "still here");
  r = await p.check(r.state, cfg, f.env);
  assert.deepEqual(r.events.map((e) => e.text), ["SLACK #watchhub Dev UDEV: still here"]);   // said once, not every poll
  r = await p.check(r.state, { slack: { scope: "team", read: ["#watchhub"] } }, f.env);
  assert.equal(r.state.errors, undefined);
  await assert.rejects(p.check(undefined, { slack: { read: ["CNOPE12"] } }, f.env), /channel_not_found/);
});

test("slack builtin: a place's changed reason is said again, and its recovery once", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const p = require("../lib/builtin/slack")(require("../lib/api"));
  const cfg = { slack: { scope: "team", read: ["#watchhub", "CNOPE12"] } };
  let r = await p.check(undefined, cfg, f.env);
  r = await p.check(r.state, cfg, f.env);
  f.errs.CNOPE12 = "not_in_channel";
  r = await p.check(r.state, cfg, f.env);
  assert.equal(r.events.length, 1); assert.match(r.events[0].text, /^SLACK CNOPE12 unreadable: .*not_in_channel/);
  delete f.errs.CNOPE12;
  r = await p.check(r.state, cfg, f.env);
  assert.deepEqual(r.events.map((e) => e.text), ["SLACK CNOPE12 readable again"]);
  r = await p.check(r.state, cfg, f.env);
  assert.deepEqual(r.events, []);
  f.errs.CNOPE12 = "channel_not_found";
  r = await p.check(r.state, cfg, f.env);
  delete f.errs.CNOPE12;
  r = await p.check(r.state, cfg, f.env);
  assert.deepEqual(r.events, []);   // a blip that was never told has no recovery to tell
});

test("slack builtin: a rate limit on one place fails the probe, so the engine backs off", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const p = require("../lib/builtin/slack")(require("../lib/api"));
  await assert.rejects(p.check(undefined, { slack: { read: ["#watchhub", "CLIMIT1"] } }, f.env), /429/);
});

test("slack kind: more messages than one poll shows are counted, not dropped silently", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const w = { name: "feed", slack: { channel: "#watchhub" } };
  let r = await kind.poll(w, undefined, {}, f.env);
  for (let i = 0; i < 12; i++) f.add("UDEV", `m${i}`);
  r = await kind.poll(w, r.state, {}, f.env);
  assert.equal(r.events.length, 11);
  assert.equal(r.events[0], "2 earlier messages not shown (more than 10 in one poll)");
  assert.equal(r.events[1].text, "Dev UDEV: m2");
});

test("doctor: a single read object is checked, and a place sent to a Slack-posting sink is warned about", async (t) => {
  const f = await fakeSlack(); t.after(() => f.close());
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-slackdoc2-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, slack: { read: { channel: "@dms" }, sinks: ["team"] } }));
  const inst = require("../lib/instance").resolve(dir), { doctor } = require("../lib/doctor");
  fs.mkdirSync(inst.paths.sinks, { recursive: true });
  fs.writeFileSync(path.join(inst.paths.sinks, "team.json"), JSON.stringify({ name: "team", slack: { channel: "#team" } }));
  const out = await doctor(inst, { ...f.env });
  assert.ok(out.some((l) => /^ok {4}slack: token works/.test(l)));
  assert.ok(out.some((l) => /^warn {2}sink team: posts to Slack as you, and slack.read @dms sends its lines there/.test(l)));
});
