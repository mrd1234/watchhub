// The waiter: `watchhub wait <inbox>`. One process that blocks until the inbox grows,
// prints the burst (and the plan's instructions), acknowledges it and exits. Its exit is what
// wakes the session that runs it in a background shell. It spawns nothing: fs.watch on the inbox
// with an in-process size check every few seconds as the fallback.
//
// Every delivered line has a priority: urgent wakes at once (no settle), normal wakes after the
// settle, low never wakes on its own and rides along in the next burst, compressed per probe in an
// ALSO block, so an inbox reads "7 Slack messages since last time" as metadata rather than seven
// lines. A low backlog still wakes once it is old or large (LOW_MAX_LINES, LOW_MAX_AGE, 256 KB).
const fs = require("fs");
const path = require("path");
const subs = require("./subs");
const lease = require("./lease");
const plans = require("./plans");
const { enginePid } = require("./engine");
const { fileSize, readRange, isAlive } = require("./util");

const REPLAY_AFTER = 180;        // s: a re-arm this long after the last burst names it in one line, in case the wake was lost
const COOLDOWN_DEFAULT = 60;     // s: after a burst, normal lines wait this long before the next wake (urgent never waits)
const REPEAT_HOURS = 4;          // a plan rule's text is printed in full once per this window, then named
const LOW_MAX_LINES = 50;        // a low backlog wakes once it holds this many lines
const LOW_MAX_AGE = 4 * 3600;    // s: or once its oldest line is this old
const ALSO_LAST = 2;             // most recent texts shown per probe in the ALSO block
const MAIN_MAX_LINES = 100;      // a burst that piled up (a session stalled for days) shows its newest lines and points at the rest
const QUEUE_LOOK_BACK = 64 * 1024;   // bytes of the transcript read at the start of a hold, for a message queued just before it

// Messages waiting behind a hook's hold. Claude Code queues what the person (or a finished background
// task) sends while a turn runs, and writes {"type":"queue-operation","operation":"enqueue"} to the
// transcript; "dequeue" or "remove" when it is taken. A hold that keeps the turn open keeps them waiting,
// so the hold lets go the moment one is queued. Counting from 0 and never below it, a window that starts
// part-way through still reads right. Some enqueues are never matched by a dequeue (the message shows up
// as an ordinary prompt instead), so with `prompts` a person's prompt resets the count: a turn that
// started has taken what was queued before it.
function queued(text, n = 0, prompts = false) {
  for (const l of text.split("\n")) {
    if (prompts && isPrompt(l)) { n = 0; continue; }
    if (!l.includes('"queue-operation"')) continue;
    const op = /"operation":"([a-z_]+)"/.exec(l);
    if (!op) continue;
    if (op[1] === "enqueue") n++; else if (op[1] === "dequeue" || op[1] === "remove") n = Math.max(0, n - 1);
  }
  return n;
}

const mainLine = (l, re) => { if (!re.test(l)) return null; try { const j = JSON.parse(l); return j.isSidechain ? null : j; } catch { return null; } };
// A prompt on the main thread: a user line that is not a tool's result.
const isPrompt = (l) => { const j = mainLine(l, /"type":"user"/); return !!j && j.type === "user" && !(Array.isArray(j.message?.content) && j.message.content.some((c) => c && c.type === "tool_result")); };
// A new turn in the transcript (a person's or the model's message on the main thread): the session
// carried on without this hold, so it is an orphan of a restart.
const movedOn = (text) => text.split("\n").some((l) => { const j = mainLine(l, /"type":"(user|assistant)"/); return !!j && (j.type === "user" || j.type === "assistant"); });

// The lines a burst prints: all of them, or the newest MAIN_MAX_LINES under one line saying how to read
// the others (they are set aside, so the pointer reads exactly them).
function capLines(paths, lines, inbox) {
  if (lines.length <= MAIN_MAX_LINES) return lines;
  const hidden = lines.length - MAIN_MAX_LINES;
  return [`(${hidden} earlier line${hidden === 1 ? "" : "s"} not shown: ${subs.aside(paths, inbox, lines.slice(0, hidden))})`, ...lines.slice(hidden)];
}

// "urgent" | "normal" | "low" for one delivered line under this subscription.
function levelOf(paths, sub, plan, urgentRe, line) {
  if (/^\S+ \| schedule \| /.test(line)) return "urgent";   // a reminder someone asked for is a wake, whatever the plan says
  if (urgentRe && urgentRe.test(line)) return "urgent";   // what the inbox called urgent is urgent, notices and health lines included
  if (/^\S+ \| notice \| /.test(line)) return /\| notice \| all \| WAKE:/.test(line) ? "normal" : "low";
  if (subs.healthQuiet(paths, sub, plan, line)) return "low";
  if (plan) { const lv = plans.levelFor(plan, line); if (lv) return lv; }
  return sub.priority || "normal";
}

// The ALSO block: low lines grouped by probe, a count and the last few texts each.
function alsoBlock(lines, inbox) {
  const by = new Map();
  for (const l of lines) {
    const ev = require("./events").parse(l) || { probe: "?", text: l };
    const g = by.get(ev.probe) || { n: 0, last: [] };
    g.n++; g.last.push(ev.text); if (g.last.length > ALSO_LAST) g.last.shift();
    by.set(ev.probe, g);
  }
  const out = ["", `ALSO (low priority, ${lines.length} line${lines.length === 1 ? "" : "s"} since the last burst; full text: watchhub events --inbox ${inbox})`];
  for (const [p, g] of by) out.push(`- ${p}: ${g.n}${g.n > 1 ? " lines" : ""}; ${g.n > 1 ? "last: " : ""}${g.last.map((t) => t.length > 160 ? t.slice(0, 157) + "..." : t).join(" | ")}`);
  return out.join("\n");
}

function wait(inst, inbox, opts = {}) {
  const paths = inst.paths;
  const sub = subs.get(paths, inbox);
  if (!sub) throw Object.assign(new Error(`no subscription for inbox ${inbox}; register one: watchhub sub ${inbox} --plan <plan> | --filter <regex>`), { code: 2 });
  const settleMs = Number(opts.settle ?? sub.settle ?? inst.config().engine?.settleSec ?? 3) * 1000;
  const plan = sub.plan ? plans.load(paths.plans, sub.plan) : null;
  const urgent = sub.urgent ? new RegExp(sub.urgent) : null;
  const who = inst.config().notifyWho;
  const level = (l) => levelOf(paths, sub, plan, urgent, l);
  // cooldown: an inbox woken a moment ago is not woken again for normal lines until it has passed; the
  // measured pattern was two lines per wake with most wakes within five minutes of the previous one
  const cooldownMs = Number(opts.cooldown ?? sub.cooldown ?? inst.config().engine?.cooldownSec ?? COOLDOWN_DEFAULT) * 1000;
  const repeatMs = Number(inst.config().engine?.instructionsRepeatHours ?? REPEAT_HOURS) * 3600 * 1000;
  const split = (text) => { const main = [], low = []; for (const l of text.split("\n")) (level(l) === "low" ? low : main).push(l); return { main, low }; };
  const ageOf = (l) => (Date.now() - Date.parse(l.slice(0, 24))) / 1000;
  const lastBurstAt = () => { try { return Number(fs.readFileSync(path.join(paths.inbox, `${inbox}.last`), "utf8").split("\n")[0]) * 1000 || 0; } catch { return 0; } };
  const cooling = () => Math.max(0, lastBurstAt() + cooldownMs - Date.now());
  const worthWaking = (text) => {
    if (text.length > 256 * 1024) return true;
    const { main, low } = split(text);
    if (main.some((l) => level(l) === "urgent")) return true;
    if (main.length > 0) return cooling() === 0;
    return low.length >= LOW_MAX_LINES || (low.length > 0 && ageOf(low[0]) > LOW_MAX_AGE);
  };
  const out = opts.out || process.stdout, err = opts.err || process.stderr;   // the stop hook collects the text instead
  // no engine: start it, unless a planned restart is in progress (its marker is fresh), which brings its own
  const ensureEngine = () => { const ctl = require("./ctl"); if (!enginePid(paths) && !ctl.restarting(inst)) { err.write("engine not running; starting it\n"); try { ctl.start(inst, (m) => err.write(m + "\n")); } catch (e) { err.write(`${e.message}\n`); } } };
  ensureEngine();
  const { replaced } = lease.take(paths, inbox, { session: opts.session || sub.session || null, expires: sub.expires });
  if (replaced) out.write(`took over inbox ${inbox} from pid ${replaced.pid}; that waiter exits on its own\n`);
  const file = subs.ensureInbox(paths, inbox);
  const last = path.join(paths.inbox, `${inbox}.last`);

  return new Promise((resolve) => {
    let finished = false, watcher = null, timers = [], pending = null;
    const finish = (code, keepLease) => {
      if (finished) return; finished = true;
      clearTimeout(pending);
      if (watcher) watcher.close();
      for (const t of timers) clearInterval(t);
      if (!keepLease) lease.release(paths, inbox);
      resolve(code);
    };
    const print = (text) => {
      const { main, low } = split(text);
      // a burst with no normal line (a low backlog that reached its cap) prints the block alone, under one heading line
      if (main.length) out.write(capLines(paths, main, inbox).join("\n") + "\n"); else out.write(`LOW-PRIORITY BACKLOG for inbox ${inbox} (no urgent or normal line; printed because it reached ${LOW_MAX_LINES} lines, ${LOW_MAX_AGE / 3600} h or 256 KB, or because this wait is ending)\n`);
      if (plan && main.length) out.write(plans.instructions(plan, main, who, seenRules(repeatMs)) + "\n");
      if (low.length) out.write(alsoBlock(low, inbox) + "\n");
    };
    // which rules were printed in full to this inbox and when: a rule seen within the window is named, not repeated
    const rulesFile = path.join(paths.inbox, `${inbox}.rules.json`);
    const seenRules = (windowMs) => {
      let seen = {}; try { seen = JSON.parse(fs.readFileSync(rulesFile, "utf8")); } catch {}
      const now = Date.now();
      return { fresh: (key) => (seen[key] || 0) > now - windowMs, mark: (key) => { seen[key] = now; try { fs.writeFileSync(rulesFile, JSON.stringify(seen)); } catch {} } };
    };
    // Only the lease holder may print and acknowledge: a superseded waiter that read first would take
    // the burst into an output nobody reads.
    const burst = (force) => {
      if (finished) return false;
      if (!lease.mine(paths, inbox)) { superseded(); return false; }
      const u = subs.unacked(paths, inbox);
      if (!u.text || (!force && !worthWaking(u.text))) return false;
      print(u.text);
      subs.ack(paths, inbox, u.end);
      try { fs.writeFileSync(last, `${Math.floor(Date.now() / 1000)}\n${u.text}\n`); } catch {}
      // wakes.log: one line per wake (when, inbox, how many lines), so wakes per inbox per day can be counted
      try { const wl = path.join(inst.dir, "wakes.log"); if (fileSize(wl) > 5 * 1024 * 1024) fs.renameSync(wl, wl + ".1"); fs.appendFileSync(wl, `${new Date().toISOString()} | ${inbox} | ${u.text.split("\n").length}\n`); } catch {}
      if (sub.once) { subs.remove(paths, inbox); out.write(`(once: subscription ${inbox} removed)\n`); }
      finish(0);
      return true;
    };
    // on stdout, not stderr: a session reading the task's output must see why its wait ended
    const superseded = () => { const l = lease.read(paths, inbox); out.write(`SUPERSEDED: another waiter took inbox ${inbox}${l ? ` (pid ${l.pid}, started ${l.started})` : ""}; this one exits, nothing to re-arm here\n`); finish(3, true); };

    // A burst printed more than REPLAY_AFTER ago is shown again: the session may have lost that turn.
    try {
      const t = fs.readFileSync(last, "utf8"), at = Number(t.split("\n")[0]);
      if (at && Date.now() / 1000 - at > REPLAY_AFTER) {
        const n = t.split("\n").slice(1).filter(Boolean).length;
        out.write(`(previous burst: ${n} line${n === 1 ? "" : "s"} printed ${Math.round((Date.now() / 1000 - at) / 60)} min ago; if that turn was lost: watchhub events --inbox ${inbox} --since ${Math.ceil((Date.now() / 1000 - at) / 60) + 1}m)\n`);
      }
      fs.writeFileSync(last, `${at || 0}\n`);   // the time stays, for the cooldown; the text is not kept
    } catch {}

    // A hook's hold lets go (code 4: nothing acknowledged, the lines wait for the next turn end) when a
    // message is queued behind it, when the session has moved on without it (a restart writes a new
    // turn to the transcript while the old hook process lives on), or when the harness process that ran
    // the hook has gone (opts.parentPid: a pid, or a promise of one, null when it could not be found).
    // Claude Code waits on the hook, so a hold that misses any of these keeps the session stuck.
    if (opts.transcript) {
      let at = fileSize(opts.transcript), rest = "", n = 0, parent = null;
      Promise.resolve(opts.parentPid).then((p) => { parent = p || null; }, () => {});
      try { const from = Math.max(0, at - QUEUE_LOOK_BACK), back = readRange(opts.transcript, from, at); n = queued(from ? back.slice(back.indexOf("\n") + 1) : back, 0, true); } catch {}   // a message queued just before the hold
      const look = () => {
        if (finished) return;
        if (parent && !isAlive(parent)) return finish(4);
        const size = fileSize(opts.transcript);
        if (size < at) { at = size; rest = ""; }   // rewritten: carry on from its new end
        let text = "";
        if (size > at) { try { text = rest + readRange(opts.transcript, at, size); } catch { return; } at = size; }
        const cut = text.lastIndexOf("\n");   // a line half-written stays for the next look
        if (text) { rest = text.slice(cut + 1); if (rest.length > QUEUE_LOOK_BACK) rest = ""; }
        const lines = text.slice(0, cut + 1);
        n = queued(lines, n);
        if (n > 0 || movedOn(lines)) finish(4);
      };
      look();
      if (finished) return;
      timers.push(setInterval(look, 1000));
    }
    // a hook's hold ends before the hook's own timeout would: the hook answers with a short note and is run again
    if (opts.holdSec) timers.push(setInterval(() => { if (!finished) { out.write(`watchhub: no news in ${Math.round(opts.holdSec / 3600)} h; still subscribed to ${inbox}\n`); finish(0); } }, Number(opts.holdSec) * 1000));
    let known = fileSize(file);   // read before the first look, so a line landing in between still counts as a change
    if (burst()) return;
    if (finished) return;
    const changed = () => {
      if (finished) return;
      const size = fileSize(file);
      if (size === known && !(size > 0 && cooling() === 0 && pending === null && subs.unacked(paths, inbox).text)) return;   // or the cooldown just ended with lines waiting
      known = size;
      // an urgent line: no settle, what cannot wait does not
      if (subs.unacked(paths, inbox).text.split("\n").some((l) => l && level(l) === "urgent")) { clearTimeout(pending); pending = null; burst(); return; }
      if (pending) return;
      pending = setTimeout(() => { pending = null; if (!burst()) known = fileSize(file); }, settleMs); // settle: take in the rest of the burst
    };
    try { watcher = fs.watch(file, { persistent: true }, changed); } catch (e) { err.write(`fs.watch unavailable (${e.message}); polling the size every 3 s\n`); }
    timers.push(setInterval(changed, 3000));
    timers.push(setInterval(() => {
      if (finished) return;
      if (!lease.mine(paths, inbox)) return superseded();
      lease.touch(paths, inbox);
      const live = subs.get(paths, inbox);
      if (!live) { if (!burst(true)) { out.write(`SUBSCRIPTION ${inbox} removed\n`); finish(0); } return; }
      if (Date.parse(live.expires) + 120000 < Date.now()) { if (!burst(true)) { out.write(`WAIT ENDED: subscription ${inbox} expired and the engine wrote nothing (engine running: ${enginePid(paths) ? "yes" : "NO"})\n`); finish(0); } return; }
      ensureEngine();   // an engine that died mid-wait is brought back (through the task when installed)
    }, 5000));
  });
}

module.exports = { wait, queued, movedOn, levelOf, alsoBlock, capLines, MAIN_MAX_LINES, LOW_MAX_LINES, LOW_MAX_AGE, COOLDOWN_DEFAULT, REPEAT_HOURS };
