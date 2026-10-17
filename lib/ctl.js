// CLI commands over an instance. Each takes the resolved instance and the parsed arguments and
// prints plain lines; exit codes: 0 ok, 2 usage or missing thing, 3 engine state refused.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sources = require("./sources");
const subs = require("./subs");
const plans = require("./plans");
const lease = require("./lease");
const { Engine, enginePid } = require("./engine");
const service = require("./service");
const { readJson, writeAtomic, isAlive, isEnginePid, sleep, fileSize, expandHome } = require("./util");

const hhmm = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) + "Z" : "never");
const fail = (msg, code = 2) => { throw Object.assign(new Error(msg), { code }); };
const engineEntry = path.join(__dirname, "..", "bin", "watchhub.js");

// A planned restart leaves a marker for its gap; a waiter that finds no engine while the marker is
// fresh waits for the restart instead of starting an engine of its own (and racing it).
const restartMarker = (inst) => path.join(inst.dir, "engine.restarting");
const restarting = (inst) => { try { return Date.now() - fs.statSync(restartMarker(inst)).mtimeMs < 90000; } catch { return false; } };

// Start the engine. With the scheduled task installed it starts under the Task Scheduler (and so
// outlives the app that asked); otherwise detached from here: own process group, no console
// window, output to engine.log.
function start(inst, say = console.log) {
  const pid = enginePid(inst.paths);
  if (pid) { say(pid < 0 ? "an engine is starting this instant" : `already running (pid ${pid})`); return pid; }
  // the restart marker stays until the engine is up: cleared here first, a waiter's 5 s check in the gap found
  // no engine and no marker and started one of its own (the env inbox saw exactly that at the 07:00Z restart)
  const clearMarker = () => { try { fs.rmSync(restartMarker(inst), { force: true }); } catch {} };
  // the lock is not cleared here: two inboxes starting at once would each clear the other's fresh lock
  // and two engines would run; takeLock in the engine decides what is stale
  // a task still Running with no engine is its launcher pausing before a rerun: the task would ignore a second
  // start, and ending it could orphan the engine it is bringing up this instant, so the engine starts directly
  // below and the launcher stands by behind it (exit 3) until it ends
  const task = service.installed(inst);
  if (task && task !== "Running") {
    service.run(inst);
    for (let i = 0; i < 40; i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); if (enginePid(inst.paths)) break; }
    const now = enginePid(inst.paths);
    clearMarker();
    if (!now) fail(`the scheduled task did not bring the engine up; see ${inst.paths.engineLog}`, 3);
    say(`started under the scheduled task (pid ${now})`);
    return now;
  }
  const fd = fs.openSync(inst.paths.engineLog, "a");
  const child = spawn(process.execPath, [engineEntry, "engine", "--instance", inst.dir], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, cwd: inst.dir });
  child.unref();
  fs.closeSync(fd);
  for (let i = 0; i < 40; i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); if (enginePid(inst.paths)) break; }
  const now = enginePid(inst.paths);
  clearMarker();
  if (!now) fail(`failed to start; see ${inst.paths.engineLog}`, 3);
  say(`started (pid ${now})`);
  return now;
}

// A notice to every inbox. `--wake` makes it wake them; otherwise it is read with the next burst.
function notice(inst, text, flags = {}) {
  if (!text) fail("usage: watchhub notice '<text>' [--wake]");
  const who = flags.from || process.env.USERNAME || process.env.USER || "";
  const inboxes = subs.broadcast(inst.paths, `${flags.wake ? "WAKE: " : ""}${text}${who ? ` (${who})` : ""}`);
  console.log(inboxes.length ? `notice sent to ${inboxes.length} inbox${inboxes.length === 1 ? "" : "es"}: ${inboxes.join(", ")}` : "no subscriptions to notify");
}

// stop [--message text]: the message reaches every inbox before the engine goes down, so a planned
// stop or restart is not read as a crash. restart = stop then start, with the same option.
function stop(inst, flags = {}) {
  let pid = enginePid(inst.paths);
  if (pid < 0) fail("an engine is starting this instant; try again in a moment", 3);
  // a lock whose heartbeat is stale but whose pid is alive (the box slept) is still an engine: stop it,
  // never clear its lock, or the next start runs a second engine beside it
  const lockPid = Number((() => { try { return fs.readFileSync(inst.paths.lock, "utf8").trim(); } catch { return 0; } })()) || 0;
  if (!pid && lockPid && isEnginePid(lockPid)) pid = lockPid;   // alive AND an engine: a reused pid is never killed
  if (!pid) { console.log("not running"); fs.rmSync(inst.paths.lock, { force: true }); return; }
  if (flags.message) notice(inst, `ENGINE ${flags.restart ? "RESTARTING" : "STOPPING"}: ${flags.message}${flags.restart ? "; back within a minute, every source resumes from its saved state, nothing is lost" : ""}`, flags);
  if (flags.restart) fs.writeFileSync(restartMarker(inst), new Date().toISOString());
  if (service.installed(inst)) service.stopTask(inst); // a plain kill would look like a failure and the task would restart it
  // ask first (the engine ends its streams and flushes state), kill only an engine that does not answer in 6 s
  try { fs.writeFileSync(inst.paths.stopRequest, String(pid)); } catch {}
  for (let i = 0; i < 24 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  if (isAlive(pid)) { try { process.kill(pid); } catch (e) { if (isAlive(pid)) fail(`could not stop pid ${pid}: ${e.message}`, 3); } }
  for (let i = 0; i < 40 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  try { fs.rmSync(inst.paths.stopRequest, { force: true }); } catch {}
  if (isAlive(pid)) fail(`pid ${pid} still alive after 16 s; its lock is left in place`, 3);
  // only the stopped engine's own lock is cleared: a start that slipped in during the wait owns the file now
  try { if (Number(fs.readFileSync(inst.paths.lock, "utf8").trim()) === pid) fs.rmSync(inst.paths.lock, { force: true }); } catch {}
  console.log(`stopped (pid ${pid})`);
}

function status(inst) {
  const pid = enginePid(inst.paths), state = readJson(inst.paths.state, {});
  console.log(pid ? `running (pid ${pid})` : "not running");
  console.log(service.info(inst));
  for (const [name, s] of Object.entries(state)) {
    if (name.startsWith("_")) continue;
    const extra = (s.fails ? ` | FAILING x${s.fails}: ${s.lastError}` : "") + (s.backoff > 1 ? ` | backed off x${s.backoff}` : "");
    console.log(`${name}: last run ${hhmm(s.lastRun)}, last ok ${hhmm(s.lastOk)}${extra}`);
  }
  const live = subs.list(inst.paths), leases = lease.list(inst.paths);
  const nowInbox = (l) => { try { return subs.unacked(inst.paths, l).text ? " UNACKNOWLEDGED" : ""; } catch { return ""; } };
  console.log(`subscriptions: ${live.length ? live.map((s) => `${s.inbox}${s.label ? ` (${s.label})` : ""}${leases.some((l) => l.inbox === s.inbox && l.alive) ? " (waiting)" : ""}${nowInbox(s.inbox)}`).join(", ") : "none"}`);
  const stale = leases.filter((l) => !l.alive);
  if (stale.length) console.log(`stale leases: ${stale.map((l) => l.inbox).join(", ")} (swept)`), lease.sweep(inst.paths);
  const today = new Date().toISOString().slice(0, 10);
  // only the tail of events.log is read: the file is never rotated by default and grows for weeks
  const size = fileSize(inst.paths.events), tailText = size ? require("./util").readRange(inst.paths.events, Math.max(0, size - 512 * 1024), size) : "";
  const n = tailText.split("\n").filter((l) => l.startsWith(today)).length;
  console.log(`events today: ${n}${size > 512 * 1024 && tailText.split("\n")[0].startsWith(today) ? "+" : ""}`);
}

// Present state, one line per probe: a module's `now(data)` renders it; otherwise a JSON glimpse.
function now(inst) {
  const state = readJson(inst.paths.state, {});
  require("./api").paths = inst.paths;
  const code = sources.allCode(inst.paths.modules, () => {});
  for (const [name, s] of Object.entries(state)) {
    if (name.startsWith("_")) continue;
    const m = code.find((p) => p.name === name);
    const render = m && m.now ? m.now : (d) => JSON.stringify(d).slice(0, 120);
    const extra = (s.fails ? ` | FAILING x${s.fails}: ${s.lastError}` : "") + (s.backoff > 1 ? ` | backed off x${s.backoff}` : "");
    console.log(`${name}: ${s.data === undefined ? "no data yet" : render(s.data)}${extra}`);
  }
}

async function once(inst) {
  const before = fileSize(inst.paths.events);
  await new Engine(inst).once();
  const after = fileSize(inst.paths.events);
  if (after > before) process.stdout.write(require("./util").readRange(inst.paths.events, before, after));
}

function sub(inst, inbox, flags) {
  if (!inbox) fail("usage: watchhub sub <inbox> [--label <what it waits on>] [--plan <name>] [--filter <regex>] [--scope <s>] [--probes a,b] [--ttl 4h] [--settle 3] [--urgent <regex>] [--priority low|normal|urgent] [--cooldown 60] [--sinks slack,toast] [--session <id>] [--note <text>]");
  if (flags.label === true) fail("--label needs text: what this inbox waits on, in a few words");
  // subscribing again keeps the label unless a new one is given: an agent changing its filter keeps its name
  const label = flags.label !== undefined ? String(flags.label) : subs.INBOX.test(inbox) ? subs.get(inst.paths, inbox)?.label : undefined;
  const s = subs.make(inst.paths, { inbox, label, plan: flags.plan, filter: flags.filter, scope: flags.scope, probes: flags.probes ? String(flags.probes).split(",") : undefined, ttl: flags.ttl, settle: flags.settle, cooldown: flags.cooldown, urgent: flags.urgent, priority: flags.priority, sinks: flags.sinks ? String(flags.sinks).split(",").filter(Boolean) : undefined, session: flags.session, note: flags.note, once: !!flags.once });
  if (!s.plan && !s.filter && !s.scope && !s.probes) fail("a subscription needs --plan, --filter, --scope or --probes (otherwise it would match every event)");
  const existed = subs.save(inst.paths, s);
  // say how the filter was read: the one thing subscribers most often get wrong
  const how = s.filter ? (subs.filterMode(inst.paths, s.filter).mode === "probes" ? `; filter names probes: ${s.filter.split("|").join(", ")}` : "; filter is a regex over the whole event line") : "";
  console.log(`subscription ${inbox}${s.label ? ` (${s.label})` : ""} ${existed ? "replaced (a running waiter keeps going on the new terms)" : "added"}, expires ${s.expires}${how}${s.once ? "; once: removed after its first burst" : ""}${s.sinks ? `; every hit also goes to ${s.sinks.join(", ")}` : ""}${s.priority === "low" ? "; low priority: lines ride along in the next burst (or wake once 50 lines / 4 h old)" : s.priority === "urgent" ? "; urgent: wakes at once, no settle" : ""}; wait on it with: watchhub wait ${inbox}${s.label ? "" : "; no label: run it again with --label '<what it waits on>' so people can tell this inbox from the others"}`);
  return s;
}
// A deliberate unsub sets aside what is unread, so the session's next turn end is not handed it as an ended subscription's lines.
// A live waiter on the inbox is left its lines: it sees the subscription gone and hands them over itself.
function unsub(inst, inbox) {
  if (!inbox) fail("usage: watchhub unsub <inbox>");
  if (!subs.remove(inst.paths, inbox)) return console.log(`no subscription ${inbox}`);
  const l = lease.read(inst.paths, inbox);
  if (l && l.pid !== process.pid && isAlive(l.pid)) return console.log(`subscription ${inbox} removed; its waiter (pid ${l.pid}) hands over what is unread`);
  const u = subs.unacked(inst.paths, inbox), lines = u.text.split("\n").filter(Boolean);
  let where = "";
  if (lines.length) { where = subs.aside(inst.paths, inbox, lines); subs.ack(inst.paths, inbox, u.end); }
  console.log(`subscription ${inbox} removed${lines.length ? `; ${lines.length} unread line${lines.length === 1 ? "" : "s"} set aside (${where})` : ""}`);
}
function listSubs(inst) {
  const leases = lease.list(inst.paths);
  const all = subs.list(inst.paths);
  if (!all.length) return console.log("no subscriptions");
  for (const s of all) {
    const l = leases.find((x) => x.inbox === s.inbox);
    const what = [s.plan && `plan ${s.plan}`, s.filter && `filter '${s.filter}'`, s.scope && `scope ${s.scope}`, s.probes && `probes ${s.probes.join(",")}`, s.sinks && `sinks ${s.sinks.join(",")}`, s.priority && `priority ${s.priority}`, s.settle !== undefined && `settle ${s.settle}s`, s.cooldown !== undefined && `cooldown ${s.cooldown}s`].filter(Boolean).join(", ");
    console.log(`${s.inbox}${s.label ? ` (${s.label})` : ""}: ${what}; expires ${s.expires}${l ? (l.alive ? `; waiting (pid ${l.pid})` : "; lease stale") : "; no waiter"}${subs.unacked(inst.paths, s.inbox).text ? "; UNACKNOWLEDGED burst" : ""}`);
  }
}

async function waitCmd(inst, inbox, flags) {
  if (!inbox) fail("usage: watchhub wait <inbox> [--plan|--filter|... to register in the same call] [--settle 3]");
  if (flags.plan || flags.filter || flags.scope || flags.probes || flags.sinks || flags.priority || flags.cooldown || flags.label !== undefined) sub(inst, inbox, flags);
  return require("./waiter").wait(inst, inbox, { session: flags.session, settle: flags.settle, cooldown: flags.cooldown });
}

function watch(inst, sub2, arg) {
  const file = (n) => path.join(inst.paths.watches, `${n}.json`);
  if (sub2 === "add" || sub2 === "add-once") {
    // the JSON itself, or the path of a file holding it: on Windows, JSON given on the command line goes
    // through watchhub.cmd, which eats backslashes and quotes, so a regex in it arrives broken; a file does not
    let text = arg;
    if (arg && !/^\s*\{/.test(arg) && fs.existsSync(arg)) { try { text = fs.readFileSync(arg, "utf8"); } catch (e) { fail(`watch not saved: ${arg} could not be read: ${e.message}`); } }
    let w;
    try { w = sources.validate(JSON.parse(text)); } catch (e) { fail(`watch not saved: ${e.message}${e instanceof SyntaxError && !/^\s*\{/.test(arg || "") ? ` (${arg} is not a file here, and not JSON)` : e instanceof SyntaxError ? ". JSON on the command line can lose its backslashes and quotes on Windows (watchhub.cmd re-reads it); put it in a file and pass the path: watchhub watch add <file.json>" : ""}`); }
    if (sub2 === "add-once") w.once = true;
    w.created = new Date().toISOString();
    fs.mkdirSync(inst.paths.watches, { recursive: true });
    const existed = fs.existsSync(file(w.name));
    writeAtomic(file(w.name), JSON.stringify(w, null, 2) + "\n");
    console.log(`watch ${w.name} ${existed ? "replaced" : "added"} (${sources.kindOf(w)[0]}); events arrive as custom:${w.name}`);
  } else if (sub2 === "list") {
    const list = sources.loadWatches(inst.paths.watches), state = readJson(inst.paths.state, {});
    if (!list.length) console.log("no watches");
    for (const w of list) {
      if (w.invalid) { console.log(`${w.name}: INVALID, ignored: ${w.invalid}`); continue; }
      const s = state[`custom:${w.name}`] || {};
      const extra = [w.once && "once", w.ttl !== undefined && `ttl ${w.ttl}`, w.sinks && `sinks ${w.sinks.join(",")}`, w.reply && `reply ${w.reply}`].filter(Boolean).join(", ");
      console.log(`${w.name}: ${sources.kindOf(w)[0]}, every ${w.intervalSec || 30} s, scope ${w.scope || "custom"}${extra ? ", " + extra : ""}; last run ${hhmm(s.lastRun)}${s.fails ? `, FAILING: ${s.lastError}` : ""}`);
    }
  } else if (sub2 === "rm") {
    if (!arg || !fs.existsSync(file(arg))) fail(`no watch ${arg}`);
    fs.rmSync(file(arg)); console.log(`watch ${arg} removed`);
  } else if (sub2 === "show") {
    if (!arg || !fs.existsSync(file(arg))) fail(`no watch ${arg}`);
    console.log(fs.readFileSync(file(arg), "utf8").trim());
    console.log("state:", JSON.stringify(readJson(inst.paths.state, {})[`custom:${arg}`] || {}).slice(0, 400));
  } else if (sub2 === "kinds") {
    for (const k of Object.values(sources.KINDS)) console.log(`${k.name}${k.stream ? " (stream)" : ""}`);
  } else fail("usage: watchhub watch add '<json>' | add <file.json> | add-once '<json>' | list | show <name> | rm <name> | kinds");
}

function plan(inst, sub2, arg, flags) {
  if (sub2 === "list") { const l = plans.list(inst.paths.plans); if (!l.length) console.log("no plans"); for (const p of l) console.log(p.invalid ? `${p.name}: INVALID: ${p.invalid}` : `${p.name}: scope ${p.scope || "(every)"}, probes ${p.probes ? p.probes.join(",") : "(all)"}, filter ${p.filter ? `'${p.filter}'` : "(all events)"}, ${(p.on || []).length} rules`); }
  else if (sub2 === "show") console.log(JSON.stringify(plans.load(inst.paths.plans, arg || fail("plan name required")), null, 2));
  else if (sub2 === "add") { let p; try { p = plans.check(JSON.parse(fs.readFileSync(arg, "utf8"))); } catch (e) { fail(`plan not saved: ${e.message}`); } plans.save(inst.paths.plans, p); console.log(`plan ${p.name} saved; subscribe with: watchhub sub <inbox> --plan ${p.name}`); }
  else if (sub2 === "skill") {
    const p = plans.load(inst.paths.plans, arg || fail("plan name required"));
    const flags = arguments[3] || {};
    const skillName = flags.as || p.skill || `watchhub-plan-${p.name}`;
    // rules without a code get one derived from their match (K plus three characters), so inserting a rule later moves nothing
    let coded = false;
    const taken = new Set((p.on || []).map((o) => o.code).filter(Boolean));
    for (const o of p.on || []) if (!o.code) { let h = require("crypto").createHash("sha1").update(o.match).digest("hex").toUpperCase().replace(/[^A-Z0-9]/g, ""); let c = "K" + h.slice(0, 3); for (let i = 3; taken.has(c); i++) c = "K" + h.slice(i, i + 3); taken.add(c); o.code = c; coded = true; }
    if (coded) plans.save(inst.paths.plans, p);
    // a re-run without --out goes where the last --out put it, as the engine's rewrites do
    const dir = path.resolve(flags.out ? expandHome(flags.out) : (p.skillDir && skillName === p.skill ? p.skillDir : path.join(inst.dir, "skills", skillName)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), plans.skillText(p, skillName));
    if (p.skill !== skillName || (flags.out && p.skillDir !== dir)) { p.skill = skillName; if (flags.out) p.skillDir = dir; else delete p.skillDir; plans.save(inst.paths.plans, p); }
    console.log(`skill ${skillName} written to ${path.join(dir, "SKILL.md")}; plan ${p.name} now prints codes (${Object.keys(plans.codes(p)).join(", ")}${p.default ? ", D" : ""}). Load the skill once per session; re-run this after editing the plan.`);
  }
  else if (sub2 === "instructions") { const p = plans.load(inst.paths.plans, arg); console.log(plans.instructions(p, fs.readFileSync(0, "utf8").split("\n").filter(Boolean), inst.config().notifyWho)); }
  else fail("usage: watchhub plan list | show <name> | add <file> | skill <name> [--out <dir>] [--as <skill-name>] | instructions <name> (lines on stdin)");
}

// sink list | add '<json>' | rm <name> | send <name> '<text>': notification targets (an http webhook such as a
// Slack or Teams one, or a Windows toast). `send` posts from here, not through the engine, so it also proves a sink
// before any watch names it.
async function sink(inst, sub2, arg, arg2) {
  const sk = require("./sinks");
  if (sub2 === "list" || !sub2) {
    const r = sk.load(inst.paths.sinks);
    const names = Object.keys(r.sinks), bad = Object.keys(r.invalid);
    if (!names.length && !bad.length) return console.log(`no sinks (add one: watchhub sink add '{"name":"slack","http":{"url":"\${SLACK_WEBHOOK_URL}"}}')`);
    for (const n of names) { const s = r.sinks[n]; console.log(`${n}: ${s.http ? `http ${s.http.method || "POST"} ${s.http.url}` : s.slack ? `slack ${s.slack.channel} (as the ${s.slack.tokenEnv || "SLACK_USER_TOKEN"} user)` : `toast "${s.toast.title || "watchhub"}"`}`); }
    for (const n of bad) console.log(`${n}: INVALID, ignored: ${r.invalid[n]}`);
  } else if (sub2 === "add") {
    let s; try { s = sk.check(JSON.parse(arg)); } catch (e) { fail(`sink not saved: ${e.message}`); }
    const existed = fs.existsSync(sk.file(inst.paths.sinks, s.name));
    sk.save(inst.paths.sinks, s);
    console.log(`sink ${s.name} ${existed ? "replaced" : "added"}; try it: watchhub sink send ${s.name} 'hello'; use it: a watch's "sinks": ["${s.name}"], sub --sinks ${s.name}, or a plan's "sinks"`);
  } else if (sub2 === "rm") {
    if (!arg) fail("usage: watchhub sink rm <name>");
    console.log(sk.remove(inst.paths.sinks, arg) ? `sink ${arg} removed` : `no sink ${arg}`);
  } else if (sub2 === "send") {
    const s = sk.load(inst.paths.sinks).sinks[arg || ""];
    if (!s) fail(`no sink ${arg} (watchhub sink list)`);
    const line = require("./events").format("watchhub", "all", arg2 || `test from ${process.env.USERNAME || process.env.USER || "watchhub"}`);
    try { await sk.send(s, sk.context([line], { sink: arg, instance: path.basename(inst.dir) })); console.log(`sent to ${arg}`); } catch (e) { fail(`sink ${arg}: ${e.message}`, 3); }
  } else fail("usage: watchhub sink list | add '<json>' | rm <name> | send <name> '<text>'");
}

// reply <handle> '<text>': answer where a two-way line came from (its ` [reply r1a2b3c4]`), through the
// send() of the source that wrote it (lib/twoway.js). reply <watch> '<text>': answer in the place a watch
// reads, through the sink its `reply` names (a self-DM watch and the sink that posts into that DM, say);
// the text goes as one line from custom:<watch>, so the sink's template sees the watch's {probe} and {scope}.
async function reply(inst, name, text) {
  if (!name || !text) fail("usage: watchhub reply <handle> '<text>' | reply <watch> '<text>'");
  const twoway = require("./twoway");
  const watched = () => sources.loadWatches(inst.paths.watches).some((x) => !x.invalid && x.name === name);
  if (twoway.HANDLE.test(name) && (twoway.lookup(inst.paths.replies, name) || !watched())) {   // a watch may be named like a handle
    const rec = twoway.lookup(inst.paths.replies, name);
    if (!rec) fail(`no reply handle ${name} (handles last a week; answer from a newer line)`);
    const api = require("./api"); api.paths = inst.paths;
    const p = [...sources.allCode(inst.paths.modules, () => {}), ...sources.loadWatches(inst.paths.watches).filter((w) => !w.invalid).map(sources.toProbe)].find((x) => x.name === rec.probe);
    if (!p) fail(`${rec.probe}, which wrote ${name}, is gone`);
    if (typeof p.send !== "function") fail(`${rec.probe} reads but does not answer: it has no send()`);
    try { await p.send(rec.to, text, { cfg: inst.config(), env: process.env, api, log: (m) => console.error(m) }); console.log(`sent through ${rec.probe}`); } catch (e) { fail(`${rec.probe}: ${e.message}`, 3); }
    return;
  }
  const w = sources.loadWatches(inst.paths.watches).find((x) => x.name === name.replace(/^custom:/, ""));
  if (!w || w.invalid) fail(`no watch ${name} (watchhub watch list)`);
  if (!w.reply) fail(`watch ${w.name} has no reply sink (add "reply": "<sink>" to it)`);
  const sk = require("./sinks"), s = sk.load(inst.paths.sinks).sinks[w.reply];
  if (!s) fail(`watch ${w.name} replies through sink ${w.reply}, which is not defined (watchhub sink list)`);
  const line = require("./events").format(`custom:${w.name}`, w.scope || "custom", text);
  try { await sk.send(s, sk.context([line], { sink: w.reply, instance: path.basename(inst.dir) })); console.log(`replied in ${w.name} through ${w.reply}`); } catch (e) { fail(`sink ${w.reply}: ${e.message}`, 3); }
}

// module new <name> [--stream | --two-way] | list: a working module file to start from, in <instance>/modules.
function moduleCmd(inst, sub2, arg, flags = {}) {
  if (sub2 === "new") {
    const usage = "usage: watchhub module new <name> [--stream | --two-way]  (lowercase letters, digits and dashes)";
    if (!arg || !/^[a-z][a-z0-9-]*$/.test(arg)) fail(usage);
    if (flags.stream && flags["two-way"]) fail(usage);
    const kind = flags.stream ? "stream" : flags["two-way"] ? "two-way" : "poll";
    const file = path.join(inst.paths.modules, `${arg}.js`);
    if (fs.existsSync(file)) fail(`${file} exists`);
    const tpl = fs.readFileSync(path.join(__dirname, "templates", { stream: "stream.js", "two-way": "twoway.js", poll: "module.js" }[kind]), "utf8").replace(/__NAME__/g, arg);
    fs.mkdirSync(inst.paths.modules, { recursive: true });
    fs.writeFileSync(file, tpl);
    console.log(`${file} written: a ${kind} module named ${arg}.\nEdit check()${{ stream: " / start()", "two-way": " and send()", poll: "" }[kind]}, then: watchhub once (runs every poll source one time while the engine is stopped) or watchhub restart; subscribe with --probes ${arg}.`);
  } else if (sub2 === "list" || !sub2) {
    const all = sources.allCode(inst.paths.modules, (m) => console.log(m)), mine = new Set(sources.loadCode(inst.paths.modules, () => {}).map((p) => p.name));
    for (const p of all) console.log(`${p.name}: ${mine.has(p.name) ? "modules/" : "shipped"}${p.stream ? ", stream" : `, every ${p.intervalSec || 30} s`}${p.enabled(inst.config()) ? "" : " (off)"}`);
  } else fail("usage: watchhub module new <name> [--stream | --two-way] | list");
}

function addJob(inst, arg) {
  const job = JSON.parse(arg || fail("job json required"));
  if (!job.kind) fail("job needs a kind: gh-run | codebuild | codepipeline | amplify");
  job.key = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // the queue is read-modify-write from several inboxes and the engine: serialised by the jobs lock
  const msg = require("./util").withFileLock(inst.paths.jobs, () => {
    const jobs = readJson(inst.paths.jobs, []);
    const dup = jobs.find((j) => j.kind === job.kind && String(j.id || j.ids) === String(job.id || job.ids));
    if (dup) return `already queued as ${dup.label || dup.key}`;
    // the same label with a new id is the same job re-run (a cancelled run and its retry): one entry, the newest
    const i = job.label ? jobs.findIndex((j) => j.label === job.label) : -1;
    if (i >= 0) { jobs[i] = job; writeAtomic(inst.paths.jobs, JSON.stringify(jobs, null, 1)); return `replaced ${job.label} (new id ${job.id || (job.ids || []).join(",")})`; }
    jobs.push(job);
    writeAtomic(inst.paths.jobs, JSON.stringify(jobs, null, 1));
    return `queued ${job.label || job.key}`;
  });
  console.log(msg);
}

// jira follow KEY [--ttl 30d] | unfollow KEY | follows: tickets the board watches outside its projects.
// A follow lasts 30 days unless --ttl says otherwise, so a forgotten one ends by itself.
async function jiraCmd(inst, sub2, arg, flags = {}) {
  const { KEY } = require("./builtin/jira"), util = require("./util"), file = inst.paths.follows;
  const key = String(arg || "").toUpperCase();
  if (!["follow", "unfollow", "follows"].includes(sub2)) fail("usage: watchhub jira follow <KEY-123> [--ttl 30d] | unfollow <KEY-123> | follows");
  if ((sub2 === "follow" || sub2 === "unfollow") && !KEY.test(key)) fail(`usage: watchhub jira ${sub2} <KEY-123>${sub2 === "follow" ? " [--ttl 30d]" : ""}`);
  // a key Jira does not know would fail the board's whole search: refused here when Jira can be asked
  const cfg = inst.config();
  if (sub2 === "follow" && cfg.jira?.base) {
    const http = require("./http");
    try { await http.fetchJson(`${cfg.jira.base}/issue/${key}?fields=summary`, { headers: http.jiraHeaders(cfg, process.env) }, 15); }
    catch (e) { if (e.status === 404) fail(`Jira has no ticket ${key} that you can see`); console.error(`could not check ${key} with Jira (${e.message}); following it anyway`); }
  }
  const msg = util.withFileLock(file, () => {
    const live = readJson(file, []).filter((f) => !f.until || Date.parse(f.until) > Date.now());   // expired follows drop here
    let out;
    if (sub2 === "follow") {
      if (flags.ttl === true) fail("--ttl needs a duration (30d, 12h)");
      const until = new Date(Date.now() + util.parseDuration(flags.ttl || "30d") * 1000).toISOString();
      const i = live.findIndex((f) => f.key === key);
      if (i >= 0) live[i].until = until; else live.push({ key, since: new Date().toISOString(), until });
      out = `${i >= 0 ? "still following" : "following"} ${key} until ${until.slice(0, 16)}Z`;
    } else if (sub2 === "unfollow") {
      const i = live.findIndex((f) => f.key === key);
      if (i >= 0) live.splice(i, 1);
      out = i >= 0 ? `unfollowed ${key}` : `not following ${key}`;
    } else out = live.length ? live.map((f) => `${f.key}${f.until ? ` until ${String(f.until).slice(0, 16)}Z` : ""}`).join("\n") : "not following any tickets";
    if (live.length || fs.existsSync(file)) writeAtomic(file, JSON.stringify(live, null, 1));
    return out;
  });
  console.log(msg);
}

// events [--since 2h] [--grep <re>] [--probe p] [--scope s] [--inbox <inbox> [--aside [<id>]]] [--limit n]: a query over
// events.log (or an inbox with --inbox, or the lines it handed over only as a count with --aside, one
// batch with its id), newest last, so an inbox can answer "did it fire" without reading the whole log.
function eventsCmd(inst, flags = {}) {
  if (flags.aside && !flags.inbox) fail("--aside reads an inbox's set-aside lines: give --inbox too");
  const file = flags.inbox ? (flags.aside ? path.join(inst.paths.inbox, `${flags.inbox}.aside.log`) : subs.inboxFile(inst.paths, flags.inbox)) : inst.paths.events;
  const size = fileSize(file);
  let text = size ? require("./util").readRange(file, Math.max(0, size - 8 * 1024 * 1024), size) : "";
  if (typeof flags.aside === "string") {
    const all = text.split("\n"), at = all.findIndex((l) => l.startsWith(`# set aside ${flags.aside} `));
    if (at < 0) fail(`no set-aside batch ${flags.aside} in inbox ${flags.inbox} (the file starts afresh past 1 MB)`, 1);
    text = all.slice(at + 1, at + 1 + Number(all[at].split(" ").pop())).join("\n");
  }
  const since = flags.since ? Date.now() - require("./util").parseDuration(flags.since) * 1000 : 0;
  const re = flags.grep ? new RegExp(flags.grep) : null;
  const out = [];
  for (const l of text.split("\n")) {
    const ev = require("./events").parse(l);
    if (!ev) continue;
    if (since && Date.parse(ev.at) < since) continue;
    if (flags.probe && ev.probe !== flags.probe) continue;
    if (flags.scope && ev.scope !== flags.scope && ev.scope !== "all") continue;
    if (re && !re.test(l)) continue;
    out.push(l);
  }
  const limit = Number(flags.limit) || (typeof flags.aside === "string" ? Infinity : 200);   // a batch reads whole
  process.stdout.write((out.length ? out.slice(-limit).join("\n") : `no events${flags.since ? ` in the last ${flags.since}` : ""}${re ? ` matching ${flags.grep}` : ""}`) + "\n");
}

// stats [--since 24h]: wakes per inbox (wakes.log), events per probe (events.log), subscriptions and waiters.
// metrics [<regex>] [--probe p]: one line per metric from metrics.json, the cheapest way to see what is
// recorded: <probe>/<name> <value><unit> <ok|warn|bad|PAST|stale|none> <bound> <label>. The regex is tried on
// the key and the label; `stale` is a value older than three of its intervals.
function metricsCmd(inst, re, flags = {}) {
  if (flags.probe === true) throw new Error("usage: watchhub metrics [<regex>] [--probe <probe>]");
  const all = require("./util").readJson(path.join(inst.dir, "metrics.json"), {}).metrics || {};
  const want = re ? new RegExp(re, "i") : null, now = Date.now();
  const num = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : String(Number(v.toFixed(2))));
  const rows = Object.entries(all).filter(([k, m]) => (!flags.probe || m.probe === flags.probe) && (!want || want.test(k) || want.test(m.display?.label || "")));
  for (const [k, m] of rows.sort(([a], [b]) => a.localeCompare(b))) {
    const d = m.display || {}, low = !!d.lowIsBad, v = m.value;
    const beyond = (t) => t !== undefined && (low ? v <= t : v >= t);   // past `bad` before the watch's `for` holds is "bad", not "ok"
    const state = v == null ? "none" : now - Date.parse(m.at) > 3 * (m.intervalSec || 60) * 1000 ? "stale" : m.past ? "PAST"
      : beyond(d.bad) ? "bad" : beyond(d.warn) ? "warn" : "ok";
    const unit = m.unit ? (m.unit === "%" ? "%" : ` ${m.unit}`) : "";
    console.log(`${k} ${v == null ? "-" : num(v) + unit} ${state}${d.bad !== undefined ? ` ${low ? "<" : ">"}${d.bad}` : ""}${d.label ? ` ${d.label}` : ""}`);
  }
  if (!rows.length) console.log(re || flags.probe ? "no metric matches" : "no metrics recorded");
}

function stats(inst, flags = {}) {
  const u = require("./util");
  const since = Date.now() - u.parseDuration(flags.since || "24h") * 1000;
  const count = (file, keyOf) => {
    const size = fileSize(file), text = size ? u.readRange(file, Math.max(0, size - 8 * 1024 * 1024), size) : "";
    const m = new Map();
    for (const l of text.split("\n")) { const at = Date.parse(l.slice(0, 24)); if (!at || at < since) continue; const k = keyOf(l); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const wakes = count(path.join(inst.dir, "wakes.log"), (l) => l.split(" | ")[1]);
  const probes = count(inst.paths.events, (l) => { const ev = require("./events").parse(l); return ev && ev.probe; });
  console.log(`since ${new Date(since).toISOString()}`);
  console.log(`wakes: ${wakes.reduce((a, [, n]) => a + n, 0)}${wakes.length ? " (" + wakes.map(([l, n]) => `${l} ${n}`).join(", ") + ")" : ""}`);
  console.log(`events: ${probes.reduce((a, [, n]) => a + n, 0)}${probes.length ? " (" + probes.map(([p, n]) => `${p} ${n}`).join(", ") + ")" : ""}`);
  const live = subs.list(inst.paths), leases = lease.list(inst.paths).filter((l) => l.alive);
  console.log(`subscriptions: ${live.length}, waiting now: ${leases.length}${leases.length ? " (" + leases.map((l) => l.inbox).join(", ") + ")" : ""}`);
  const pid = enginePid(inst.paths), eng = readJson(inst.paths.state, {})._engine;
  console.log(pid > 0 ? `engine: pid ${pid}${eng && eng.pid === pid ? `, up since ${eng.started}` : ""}` : "engine: not running");
}

function tail(inst, n) {
  const size = fileSize(inst.paths.events);
  const t = size ? require("./util").readRange(inst.paths.events, Math.max(0, size - 256 * 1024), size) : "";
  process.stdout.write(t.split("\n").filter(Boolean).slice(-(Number(n) || 20)).join("\n") + "\n");
}
function leasesCmd(inst) { const l = lease.list(inst.paths); if (!l.length) return console.log("no leases"); for (const x of l) console.log(`${x.inbox}: pid ${x.pid} ${x.alive ? "alive" : "GONE"}, since ${x.started}${x.session ? `, session ${x.session}` : ""}`); }

// ---- schedules: at, in, schedules, unschedule ----
const schedules = require("./schedules");

// The inbox a schedule goes to when the command names none: WATCHHUB_INBOX (any harness or person can set
// it), the `inbox` in the working directory's .watchhub.json, or the Claude Code session running this
// command (CLAUDE_CODE_SESSION_ID, which it sets; checked for, never assumed). Null with none of them.
function ownInbox(env = process.env, cwd = process.cwd()) {
  if (env.WATCHHUB_INBOX) return String(env.WATCHHUB_INBOX);
  const pc = readJson(path.join(cwd, ".watchhub.json"), null);
  if (pc && typeof pc.inbox === "string" && pc.inbox) return pc.inbox;
  if (env.CLAUDE_CODE_SESSION_ID) return require("./hook").inboxFor(env.CLAUDE_CODE_SESSION_ID);
  return null;
}
const untilText = (due, now = Date.now()) => {
  let s = Math.round((due - now) / 1000);
  if (s < 0) return "due; fires when the engine next runs";
  const parts = [];
  for (const [n, u] of [[86400, "d"], [3600, "h"], [60, "m"]]) if (s >= n) { parts.push(`${Math.floor(s / n)}${u}`); s %= n; }
  if (!parts.length) parts.push(`${s}s`);
  return `in ${parts.slice(0, 2).join(" ")}`;
};
const targetsText = (e) => { const t = e.targets || {}; return [t.inboxes?.length && `inbox ${t.inboxes.join(", ")}`, t.sinks?.length && `sink ${t.sinks.join(", ")}`, t.scope && `scope ${t.scope}`].filter(Boolean).join("; "); };

// `at <when> [<inbox> ...] '<text>'` and `in <duration> [<inbox> ...] '<text>'`: the last positional is the
// text, the ones between are inbox names; --sink a,b and --scope <s> are the other targets; --from names
// the inbox that asked.
function scheduleCmd(inst, kind, pos, flags = {}) {
  const usage = `usage: watchhub ${kind} ${kind === "at" ? "<HH:MM | 2026-10-20T09:00>" : "<90s | 20m | 2h | 1d>"} [<inbox> ...] '<text>' [--sink a,b] [--scope <s>] [--from <inbox>]`;
  const [when, ...rest] = pos;
  if (!when || !rest.length) fail(usage);
  const text = rest[rest.length - 1], inboxes = rest.slice(0, -1);
  for (const i of inboxes) if (!subs.INBOX.test(i)) fail(`${i} is not an inbox name (lowercase letters, digits and dashes); the text goes last, in quotes\n${usage}`);
  if (flags.sink === true) fail("--sink needs a sink name (watchhub sink list)");
  const sinkNames = flags.sink ? String(flags.sink).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (sinkNames.length) { const sk = require("./sinks"); sk.checkNames(sinkNames, "--sink"); const have = sk.load(inst.paths.sinks).sinks; for (const n of sinkNames) if (!have[n]) fail(`no sink ${n} in ${inst.paths.sinks} (watchhub sink list)`); }
  if (flags.scope === true) fail("--scope needs a scope name");
  const scope = flags.scope ? String(flags.scope) : undefined;
  if (flags.from !== undefined && !(typeof flags.from === "string" && subs.INBOX.test(flags.from))) fail("--from takes an inbox name");
  if (!inboxes.length && !sinkNames.length && !scope) {
    const own = ownInbox();
    if (!own) fail(`say where the line goes: an inbox name before the text, --sink <name> or --scope <scope> (or set WATCHHUB_INBOX, or "inbox" in .watchhub.json)\n${usage}`);
    // checked before anything is written: a default that fails the rule would otherwise be saved in the schedule
    // and only refused when the hold is arranged, leaving a line nobody is held for
    if (!subs.INBOX.test(own)) fail(`${own} (from WATCHHUB_INBOX, .watchhub.json or the session id) is not an inbox name: lowercase letters, digits and dashes, 64 at most`);
    inboxes.push(own);
  }
  const due = kind === "at" ? schedules.parseWhen(when) : schedules.afterDuration(when);
  const onBad = (m) => console.error(`watchhub: ${m}`);
  const e = schedules.add(inst.paths, { due, inboxes, sinks: sinkNames, scope, text, by: flags.from }, onBad);
  console.log(`scheduled ${e.id} for ${schedules.describe(e.due)} (${untilText(due)}) -> ${targetsText(e)}: ${e.text}; cancel with watchhub unschedule ${e.id}`);
  // the schedule is saved by now, so a hold that cannot be arranged says so rather than looking like a refusal
  // (a retry would schedule it twice)
  for (const inbox of inboxes) {
    try { holdFor(inst, inbox, due); }
    catch (err) { console.error(`watchhub: schedule ${e.id} is saved, but inbox ${inbox} could not be held for it (${err.message}); the line still arrives there, with no turn held`); process.exitCode = 1; }
  }
  return e;
}
// An inbox a schedule goes to is held for it: its subscription lasts at least a day past the due time, and
// an inbox with none gets one that takes schedule lines only (schedules.HOLD), which the engine removes once
// the inbox's last schedule has fired, so the hold ends with the line and no expiry wakes the session later.
function holdFor(inst, inbox, due) {
  const keepUntil = due.getTime() + 86400000;
  const cur = subs.get(inst.paths, inbox);
  if (cur) { if (Date.parse(cur.expires) < keepUntil) { cur.expires = new Date(keepUntil).toISOString(); subs.save(inst.paths, cur); } return cur; }
  const s = subs.make(inst.paths, { inbox, ...schedules.HOLD, ttl: String(Math.ceil((keepUntil - Date.now()) / 1000)) });
  subs.save(inst.paths, s);
  return s;
}
function schedulesCmd(inst, flags = {}) {
  const list = schedules.read(inst.paths).slice().sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (flags.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log("no schedules pending");
  for (const e of list) console.log(`${e.id}  ${schedules.describe(e.due)} (${untilText(Date.parse(e.due))})  ${targetsText(e)}: ${e.text}${e.by ? ` (from ${e.by})` : ""}`);
}
function unschedule(inst, id) {
  if (!id) fail("usage: watchhub unschedule <id>");
  const e = schedules.remove(inst.paths, String(id), (m) => console.error(`watchhub: ${m}`));
  if (!e) fail(`no schedule ${id} (watchhub schedules lists the pending ones)`);
  console.log(`schedule ${e.id} cancelled (was ${schedules.describe(e.due)}: ${e.text})`);
}

// A new instance folder: instance.json with the engine section and empty folders.
function init(dir, flags = {}) {
  const f = path.join(dir, "instance.json");
  if (fs.existsSync(f)) fail(`${f} exists`);
  // ~/.watchhub gets its env template, and this instance becomes the default unless one is set already
  const userdir = require("./userdir");
  userdir.init(flags.default || !userdir.config().instance ? dir : undefined);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ["watches", "plans", "modules", "sinks", "subscriptions", "inbox", "leases"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ probes: { jobs: true }, intervals: {}, scopes: [], defaultScope: "all", notifyWho: "the user", engine: { memoryCapMb: 400, settleSec: 3 }, webhook: { host: "127.0.0.1", port: 47831 } }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "jobs.json"), "[]\n");
  // the worked example travels with the package: a full instance.json and the helper modules to copy from
  const ex = path.join(__dirname, "..", "example");
  if (fs.existsSync(ex)) fs.cpSync(ex, path.join(dir, "example"), { recursive: true });
  console.log(`instance created in ${dir}; see example/ there for a full instance.json, helper modules and a plan.\ntokens go in ${userdir.envFile()} (KEY=value lines); default instance: ${userdir.config().instance}; then: watchhub doctor`);
}

// service install | uninstall | status: the engine as a scheduled task that survives app restarts and reboots.
function serviceCmd(inst, sub2) {
  if (sub2 === "install") {
    const pid = enginePid(inst.paths);
    if (pid > 0) { try { fs.writeFileSync(inst.paths.stopRequest, String(pid)); } catch {} for (let i = 0; i < 24 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); if (isAlive(pid)) { try { process.kill(pid); } catch {} } for (let i = 0; i < 20 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); try { fs.rmSync(inst.paths.stopRequest, { force: true }); } catch {} fs.rmSync(inst.paths.lock, { force: true }); }
    const name = service.install(inst);
    for (let i = 0; i < 40; i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); if (enginePid(inst.paths)) break; }
    console.log(`task '${name}' registered (at logon; a crashed engine runs again within seconds) and started${enginePid(inst.paths) ? ` (pid ${enginePid(inst.paths)})` : "; engine not up yet, see engine.log"}`);
  } else if (sub2 === "uninstall") {
    // Stop-ScheduledTask ends the task's launcher, not always the node engine under it: stop the engine by its pid too
    const pid = enginePid(inst.paths) || Number((()=>{try{return fs.readFileSync(inst.paths.lock,"utf8").trim()}catch{return 0}})()) || 0;
    console.log(service.uninstall(inst) ? "task removed; the engine now runs only while started by hand" : "no task installed");
    if (pid > 0 && isAlive(pid)) { try { fs.writeFileSync(inst.paths.stopRequest, String(pid)); } catch {} for (let i = 0; i < 24 && isAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); if (isAlive(pid)) { try { process.kill(pid); } catch {} } try { fs.rmSync(inst.paths.stopRequest, { force: true }); } catch {} }
    fs.rmSync(inst.paths.lock, { force: true });
  } else if (sub2 === "status" || !sub2) console.log(service.info(inst));
  else fail("usage: watchhub service install | uninstall | status");
}

function restart(inst, flags = {}) { stop(inst, { ...flags, restart: true }); start(inst); }

module.exports = { start, stop, restart, restarting, notice, status, now, once, sub, unsub, listSubs, waitCmd, scheduleCmd, schedulesCmd, unschedule, ownInbox, holdFor, watch, plan, sink, reply, moduleCmd, addJob, jiraCmd, tail, leasesCmd, init, serviceCmd, eventsCmd, stats, metricsCmd };
