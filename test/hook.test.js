// Claude Code hooks: start names the inbox (and subscribes from .watchhub.json), stop holds the turn and hands back the burst.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const hook = require("../lib/hook");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-hook-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, engine: { settleSec: 1, cooldownSec: 0 } })); fs.mkdirSync(path.join(dir, "plans")); return dir; };
// run a hook as Claude Code would: JSON on stdin, JSON on stdout
const runHook = (dir, which, input, extra = []) => { const child = spawn(process.execPath, [BIN, "hook", which, ...extra, "--instance", dir], { windowsHide: true }); let out = ""; child.stdout.on("data", (d) => (out += d)); child.stdin.end(JSON.stringify(input)); return { child, done: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out }))) }; };

test("hook start: names the inbox in one line; with a project .watchhub.json it subscribes too", async () => {
  const dir = mk();
  assert.equal(hook.inboxFor("3f9a-BC12-xyz"), "s-3f9abc12xy");
  let r = await runHook(dir, "start", { session_id: "abc123def456", cwd: dir }).done;
  assert.equal(r.code, 0);
  let j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(j.hookSpecificOutput.additionalContext, /^watchhub inbox for this session: s-abc123def4\. Subscribe once \(watchhub sub s-abc123def4 --label '<what you wait on>'/);
  assert.ok(j.hookSpecificOutput.additionalContext.length < 220, "the context stays one short line");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-proj-"));
  fs.writeFileSync(path.join(proj, ".watchhub.json"), JSON.stringify({ filter: "MERGED", ttl: "2h", priority: "low", label: "release merges" }));
  r = await runHook(dir, "start", { session_id: "abc123def456", cwd: proj }).done;
  j = JSON.parse(r.out);
  assert.match(j.hookSpecificOutput.additionalContext, /^watchhub inbox s-abc123def4 subscribed \(filter MERGED, until /);
  assert.match(cli(dir, "subs"), /s-abc123def4 \(release merges\): filter 'MERGED', priority low/);
});

test("sub --label names an inbox for people; subscribing again keeps it unless a new one is given", () => {
  const dir = mk();
  let out = cli(dir, "sub", "s-0123456789", "--filter", "MERGED");
  assert.match(out, /no label: run it again with --label/);
  out = cli(dir, "sub", "s-0123456789", "--filter", "MERGED", "--label", "  release 4.2 deploy ");
  assert.match(out, /^subscription s-0123456789 \(release 4.2 deploy\) replaced/);
  assert.doesNotMatch(out, /no label/);
  cli(dir, "sub", "s-0123456789", "--filter", "CHECKS");                       // a new filter, same name
  assert.match(cli(dir, "subs"), /^s-0123456789 \(release 4.2 deploy\): filter 'CHECKS'/m);
  cli(dir, "sub", "s-0123456789", "--filter", "CHECKS", "--label", "nightly e2e");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "subscriptions", "s-0123456789.json"), "utf8")).label, "nightly e2e");
  assert.throws(() => cli(dir, "sub", "s-0123456789", "--filter", "x", "--label", "a".repeat(61)), /60 characters at most/);
  assert.throws(() => cli(dir, "sub", "s-0123456789", "--filter", "x", "--label"), /--label needs text/);
  assert.throws(() => cli(dir, "sub", "s-0123456789", "--filter", "x", "--label", "red \u001b[31m"), /one line of plain text/);
  assert.throws(() => cli(dir, "sub", "s-0123456789", "--filter", "x", "--label", "a\u2028b"), /one line of plain text/);
  assert.throws(() => cli(dir, "wait", "s-0123456789", "--label", "only a label"), /needs --plan, --filter/);   // wait registers a label too, so says what is missing
});

test("hook stop: no subscription means no hold; with one it waits and blocks the stop with the burst; a long hold answers briefly", async (t) => {
  const dir = mk();
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  let r = await runHook(dir, "stop", { session_id: "nosub", cwd: dir }).done;
  assert.equal(r.code, 0); assert.equal(r.out, "");                                    // nothing subscribed: nothing held, nothing printed
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", probes: ["custom:x"], on: [{ match: "MERGED", do: "deploy it" }] }));
  cli(dir, "sub", "s-abc123def4", "--plan", "p", "--ttl", "10m");
  const h = runHook(dir, "stop", { session_id: "abc123def456", cwd: dir });
  await sleep(1500);
  assert.equal(h.child.exitCode, null, "the hook returned before any news");
  subs.deliver(inst.paths, "s-abc123def4", `${new Date().toISOString()} | custom:x | custom | MERGED a#1`);
  r = await h.done;
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /MERGED a#1\n\nINSTRUCTIONS\n- deploy it\n/);
  assert.ok(!j.reason.includes("took over"), "no chatter in the reason");
  // the hold limit: the hook answers with one short line so the session asks again
  r = await runHook(dir, "stop", { session_id: "abc123def456", cwd: dir }, ["--hold", "2"]).done;
  assert.equal(JSON.parse(r.out).reason, "watchhub: no news in 0 h; still subscribed to s-abc123def4");
});

test("queued and movedOn read the transcript lines Claude Code writes", () => {
  const { queued, movedOn } = require("../lib/waiter");
  const q = (op) => JSON.stringify({ type: "queue-operation", operation: op, timestamp: "t", sessionId: "s", ...(op === "enqueue" ? { content: "hi" } : {}) });
  assert.equal(queued([q("enqueue")].join("\n")), 1);
  assert.equal(queued([q("enqueue"), q("dequeue")].join("\n")), 0);
  assert.equal(queued([q("dequeue"), q("enqueue")].join("\n")), 1, "a window that starts after an enqueue does not go below zero");
  assert.equal(queued([q("enqueue"), q("enqueue"), q("remove")].join("\n")), 1);
  assert.equal(queued(JSON.stringify({ type: "user", message: { content: "\"type\":\"queue-operation\",\"operation\":\"enqueue\"" } })), 0, "only queue-operation lines count");
  // an enqueue never matched by a dequeue: the prompt it became resets the count, a tool result or a subagent's line does not
  const prompt = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "hi" } });
  const result = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
  const side = JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sub" } });
  assert.equal(queued([q("enqueue"), prompt].join("\n"), 0, true), 0);
  assert.equal(queued([q("enqueue"), prompt].join("\n")), 1, "without prompts only queue lines count (the hold's own polling)");
  assert.equal(queued([q("enqueue"), prompt, q("enqueue")].join("\n"), 0, true), 1, "queued after the prompt still counts");
  assert.equal(queued([q("enqueue"), result, side].join("\n"), 0, true), 1);
  assert.equal(movedOn(JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "next" } })), true);
  assert.equal(movedOn(JSON.stringify({ type: "assistant", isSidechain: true, message: {} })), false, "a subagent's line is not the session moving on");
  assert.equal(movedOn(JSON.stringify({ type: "attachment", attachment: { type: "hook_success", content: "\"type\":\"user\"" } })), false);
  assert.equal(movedOn('{"type":"user", half a line'), false);
});

test("harnessPid finds the nearest ancestor by name, this process included, and null when there is none", async () => {
  const { harnessPid } = require("../lib/util");
  // the walk keeps nothing alive by design (a hold that ends at once never waits for it), so with nothing else
  // running the event loop would drain before it answers and node:test would cancel everything after this test
  const keep = setInterval(() => {}, 1000);
  try {
    assert.equal(await harnessPid("no-such-harness-name"), null);
    assert.equal(await harnessPid(path.basename(process.execPath, ".exe")), process.pid);
  } finally { clearInterval(keep); }
});

test("the stop hook never keeps a session from its person: a queued message, a new turn or a gone parent ends the hold, and the lines wait for the next turn end", async (t) => {
  const dir = mk();
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  cli(dir, "sub", "s-abc123def4", "--filter", "MERGED", "--ttl", "10m");
  const tr = path.join(dir, "transcript.jsonl");
  const line = (o) => fs.appendFileSync(tr, JSON.stringify(o) + "\n");
  line({ type: "user", isSidechain: false, message: { role: "user", content: "earlier turn" } });   // before the hold: not a new turn
  line({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [] } });
  const hold = (opts = {}) => { let out = ""; const started = Date.now(); const p = hook.stop(inst, { session_id: "abc123def456", cwd: dir, transcript_path: tr }, { write: (s) => { out += s; } }, opts); return p.then((code) => ({ code, out, ms: Date.now() - started })); };
  const held = async (p, ms = 1500) => { const r = await Promise.race([p, sleep(ms).then(() => null)]); assert.equal(r, null, "the hook returned before anything happened"); };

  // a message queued while the hold runs
  let p = hold(); await held(p);
  line({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "s", content: "are you there?" });
  let r = await p;
  assert.equal(r.code, 0); assert.equal(r.out, "", "no block: the turn ends and the queued message runs");
  assert.ok(r.ms < 4000, `let go within a few seconds, took ${r.ms} ms`);

  // still queued at the next turn end (taken after the hold started, so not yet dequeued): let go at once
  r = await hold();
  assert.equal(r.out, ""); assert.ok(r.ms < 1500, `let go at once, took ${r.ms} ms`);
  line({ type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString(), sessionId: "s" });
  line({ type: "user", isSidechain: false, message: { role: "user", content: "are you there?" } });

  // an enqueue that was never dequeued but became a prompt does not hold the next hold open
  line({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "s", content: "lost dequeue" });
  line({ type: "user", isSidechain: false, message: { role: "user", content: "lost dequeue" } });
  line({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [] } });
  p = hold(); await held(p);
  // a transcript rewritten shorter: the hold carries on from its new end and still sees what comes next
  const kept = fs.readFileSync(tr, "utf8").split("\n").slice(-4).join("\n");
  fs.writeFileSync(tr, kept);
  await held(p, 1500);
  line({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "s", content: "after the rewrite" });
  r = await p;
  assert.equal(r.out, "");
  line({ type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString(), sessionId: "s" });

  // the session moved on without this hold (a restart): an orphaned hook lets go, a half-written line waits
  p = hold(); await held(p);
  fs.appendFileSync(tr, '{"type":"user","isSidechain":false,"mess');
  await held(p, 1500);
  fs.appendFileSync(tr, 'age":{"role":"user","content":"Try again"}}\n');
  r = await p;
  assert.equal(r.out, "");

  // the process that ran the hook has gone
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true });
  p = hold({ parentPid: child.pid }); await held(p);
  child.kill(); r = await p;
  assert.equal(r.out, "");

  // none of the releases acknowledged anything: a line delivered meanwhile bursts at the next turn end
  subs.deliver(inst.paths, "s-abc123def4", `${new Date().toISOString()} | custom:x | custom | MERGED a#2`);
  r = await hold();
  assert.match(JSON.parse(r.out).reason, /MERGED a#2/);
  // without a transcript_path the hook behaves as before
  p = (async () => { let out = ""; const code = await hook.stop(inst, { session_id: "abc123def456", cwd: dir }, { write: (s) => { out += s; } }); return { code, out }; })();
  await held(p);
  subs.deliver(inst.paths, "s-abc123def4", `${new Date().toISOString()} | custom:x | custom | MERGED a#3`);
  assert.match(JSON.parse((await p).out).reason, /MERGED a#3/);
});

test("hook install merges the snippet into .claude/settings.json without touching the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-proj-"));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["x"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }));
  hook.install(dir, 100);
  const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions, { allow: ["x"] });
  assert.equal(s.hooks.Stop.length, 2); assert.equal(s.hooks.Stop[1].hooks[0].command, "watchhub hook stop"); assert.equal(s.hooks.Stop[1].hooks[0].timeout, 100);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, "watchhub hook start");
  hook.install(dir, 100);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).hooks.Stop.length, 2);   // idempotent
});

test("hook install takes a leading ~ as the home directory, whatever the shell passed through", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    assert.equal(hook.install("~", 100), path.join(home, ".claude", "settings.json"));
    assert.equal(hook.install("~/proj", 100), path.join(home, "proj", ".claude", "settings.json"));
    if (process.platform === "win32") assert.equal(hook.install("~\\win", 100), path.join(home, "win", ".claude", "settings.json"));
    assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json")));
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("a session that stalls past its subscription: the ended lines go over once, a re-subscribe sets older ones aside with a pointer, a deliberate unsub sets them aside too", async () => {
  const dir = mk();
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
  const stopOut = async (session) => { let s = ""; await hook.stop(inst, { session_id: session, cwd: dir }, { write: (x) => { s += x; } }); return s; };
  // default ttl is a week: a stall of a few days still finds the inbox
  const s0 = subs.make(inst.paths, { inbox: "s-abc123def4", filter: "MERGED" });
  assert.ok(Math.abs(Date.parse(s0.expires) - Date.now() - 7 * 86400000) < 60000);
  subs.save(inst.paths, s0);
  // the engine expires it while no turn holds the inbox: the last hit and the expiry line wait unread
  subs.deliver(inst.paths, "s-abc123def4", `${at(90)} | custom:x | custom | MERGED a#1`);
  subs.deliver(inst.paths, "s-abc123def4", `${at(60)} | watchhub | all | SUBSCRIPTION s-abc123def4 expired (ttl)`);
  subs.remove(inst.paths, "s-abc123def4");
  const j = JSON.parse(await stopOut("abc123def456"));
  assert.equal(j.decision, "block");
  assert.match(j.reason, /MERGED a#1\n.*SUBSCRIPTION s-abc123def4 expired \(ttl\)\n\(subscription s-abc123def4 has ended: nothing more arrives until you subscribe again; everything the engine logged since, every probe and not only this subscription's: watchhub events --since 6[12]m\)$/);
  assert.equal(await stopOut("abc123def456"), "", "handed over once");
  // lines left unread when a new subscription starts: set aside, and a quiet notice says where
  subs.deliver(inst.paths, "s-abc123def4", `${at(30)} | custom:x | custom | MERGED a#2`);
  subs.deliver(inst.paths, "s-abc123def4", `${at(20)} | custom:x | custom | MERGED a#3`);
  subs.save(inst.paths, subs.make(inst.paths, { inbox: "s-abc123def4", filter: "MERGED" }));
  const u = subs.unacked(inst.paths, "s-abc123def4").text;
  const m = /^\S+ \| notice \| all \| 2 unread lines from before this subscription set aside: watchhub events --inbox s-abc123def4 --aside ([a-z0-9]+)$/.exec(u);
  assert.ok(m, u);
  // a deliberate unsub sets aside what is unread, so the next turn end is not handed it
  subs.deliver(inst.paths, "s-abc123def4", `${at(1)} | custom:x | custom | MERGED a#4`);
  assert.match(cli(dir, "unsub", "s-abc123def4"), /removed; 2 unread lines set aside \(watchhub events --inbox s-abc123def4 --aside [a-z0-9]+\)/);
  assert.equal(await stopOut("abc123def456"), "");
  // each pointer reads exactly its own batch, whatever was set aside after it
  assert.match(cli(dir, "events", "--inbox", "s-abc123def4", "--aside", m[1]), /^\S+ \| custom:x \| custom \| MERGED a#2\n\S+ \| custom:x \| custom \| MERGED a#3\n$/);
  assert.throws(() => cli(dir, "events", "--inbox", "s-abc123def4", "--aside", "nosuchid"), /no set-aside batch nosuchid/);
});

test("the stop hook hands an ended subscription over only on the engine's end line, once, and not while another waiter holds the inbox", async () => {
  const dir = mk();
  const subs = require("../lib/subs"), lease = require("../lib/lease"), inst = require("../lib/instance").resolve(dir);
  const stopOut = async () => { let s = ""; await hook.stop(inst, { session_id: "abc123def456", cwd: dir }, { write: (x) => { s += x; } }); return s; };
  const line = (t) => `${new Date().toISOString()} | ${t}`;
  // past its expiry but still on disk: the engine has not ended it yet; no turn now, one turn once it has
  const s = subs.make(inst.paths, { inbox: "s-abc123def4", filter: "MERGED" });
  subs.save(inst.paths, { ...s, expires: new Date(Date.now() - 1000).toISOString() });
  subs.deliver(inst.paths, "s-abc123def4", line("custom:x | custom | MERGED a#1"));
  assert.equal(await stopOut(), "");
  // removed with no end line (a --once burst, an unsub race): a stray line is not worth a turn
  subs.remove(inst.paths, "s-abc123def4");
  assert.equal(await stopOut(), "");
  // the end line arrives while another live process holds the inbox: that waiter hands it over, not this hook
  subs.deliver(inst.paths, "s-abc123def4", line("watchhub | all | SUBSCRIPTION s-abc123def4 expired (ttl)"));
  fs.mkdirSync(inst.paths.leases, { recursive: true });
  fs.writeFileSync(path.join(inst.paths.leases, "s-abc123def4.json"), JSON.stringify({ inbox: "s-abc123def4", pid: process.ppid }));
  assert.equal(await stopOut(), "");
  fs.rmSync(path.join(inst.paths.leases, "s-abc123def4.json"));
  assert.equal(lease.read(inst.paths, "s-abc123def4"), null);
  const j = JSON.parse(await stopOut());
  assert.match(j.reason, /MERGED a#1\n.*SUBSCRIPTION s-abc123def4 expired \(ttl\)\n\(subscription s-abc123def4 has ended/);
  assert.equal(await stopOut(), "");
});

test("a resumed session that re-subscribes from .watchhub.json is handed its ended lines at start, not set aside", async () => {
  const dir = mk();
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-proj-"));
  fs.writeFileSync(path.join(proj, ".watchhub.json"), JSON.stringify({ filter: "MERGED" }));
  const at = new Date(Date.now() - 30 * 60000).toISOString();
  subs.deliver(inst.paths, "s-abc123def4", `${at} | custom:x | custom | MERGED a#1`);
  subs.deliver(inst.paths, "s-abc123def4", `${at} | watchhub | all | SUBSCRIPTION s-abc123def4 expired (ttl)`);
  let out = "";
  hook.start(inst, { session_id: "abc123def456", cwd: proj }, { write: (x) => { out += x; } });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /MERGED a#1\n.*SUBSCRIPTION s-abc123def4 expired \(ttl\)\n\(subscription s-abc123def4 has ended[^\n]*\)\nwatchhub inbox s-abc123def4 subscribed \(filter MERGED, until /);
  assert.equal(subs.unacked(inst.paths, "s-abc123def4").text, "", "handed over, so nothing set aside and no notice");
  // a start while the subscription is still live leaves the inbox to its waiter
  subs.deliver(inst.paths, "s-abc123def4", `${new Date().toISOString()} | custom:x | custom | MERGED a#2`);
  out = "";
  hook.start(inst, { session_id: "abc123def456", cwd: proj }, { write: (x) => { out += x; } });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /^watchhub inbox s-abc123def4 subscribed/);
});

test("unsub while a live waiter holds the inbox leaves the unread lines for that waiter to hand over", () => {
  const dir = mk();
  const subs = require("../lib/subs"), inst = require("../lib/instance").resolve(dir);
  subs.save(inst.paths, subs.make(inst.paths, { inbox: "s-abc123def4", filter: "MERGED" }));
  subs.deliver(inst.paths, "s-abc123def4", `${new Date().toISOString()} | custom:x | custom | MERGED a#1`);
  fs.mkdirSync(inst.paths.leases, { recursive: true });
  fs.writeFileSync(path.join(inst.paths.leases, "s-abc123def4.json"), JSON.stringify({ inbox: "s-abc123def4", pid: process.pid }));
  assert.match(cli(dir, "unsub", "s-abc123def4"), new RegExp(`removed; its waiter \\(pid ${process.pid}\\) hands over what is unread`));
  assert.match(subs.unacked(inst.paths, "s-abc123def4").text, /MERGED a#1$/);
});

test("a burst that piled up prints its newest lines and points at the rest, set aside", () => {
  const { capLines, MAIN_MAX_LINES } = require("../lib/waiter");
  const dir = mk(), inst = require("../lib/instance").resolve(dir);
  const first = Date.now() - 125 * 60000;
  const lines = Array.from({ length: MAIN_MAX_LINES + 30 }, (_, i) => `${new Date(first + i * 60000).toISOString()} | custom:x | custom | MERGED a#${i}`);
  const out = capLines(inst.paths, lines, "s-x");
  assert.equal(out.length, MAIN_MAX_LINES + 1);
  const m = /^\(30 earlier lines not shown: watchhub events --inbox s-x --aside ([a-z0-9]+)\)$/.exec(out[0]);
  assert.ok(m, out[0]);
  assert.match(out[1], /MERGED a#30$/);
  capLines(inst.paths, lines.map((l) => l.replace("MERGED", "LATER")), "s-x");      // a later batch does not move this pointer
  const back = cli(dir, "events", "--inbox", "s-x", "--aside", m[1]).trim().split("\n");
  assert.equal(back.length, 30); assert.match(back[0], /MERGED a#0$/); assert.match(back[29], /MERGED a#29$/);
  assert.deepEqual(capLines(inst.paths, lines.slice(0, 3), "s-x"), lines.slice(0, 3));
  assert.throws(() => cli(dir, "events", "--aside"), /give --inbox too/);
});
