// Claude Code hooks: the agent never arms a wait. `watchhub hook start` runs on SessionStart and tells
// the session its inbox in one line (and subscribes it when the project has a .watchhub.json); `watchhub
// hook stop` runs when the agent is about to end its turn: with a live subscription it holds the turn
// open until a burst lands and hands the burst back as the agent's next input; without one it returns at
// once and the turn ends as usual. Everything the waiter does (priorities, cooldown, settle, the ALSO
// block, instructions once per window) applies unchanged; the only difference is where the text goes.
// Token economy: the stop hook's output is the burst and nothing else; the start context is one line.
const fs = require("fs");
const path = require("path");
const subs = require("./subs");
const { readJson, isAlive, expandHome, harnessPid } = require("./util");

// The inbox of a session: a stable name from its id, or the one .watchhub.json names.
const inboxFor = (sessionId, projectCfg) => projectCfg?.inbox || `s-${String(sessionId || "").replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase() || "unknown"}`;
const readStdin = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
const projectConfig = (cwd) => readJson(path.join(cwd || process.cwd(), ".watchhub.json"), null);

// SessionStart: say the inbox; subscribe when the project asks for it.
function start(inst, input = readStdin(), out = process.stdout) {
  const pc = projectConfig(input.cwd);
  const inbox = inboxFor(input.session_id, pc);
  let note = `watchhub inbox for this session: ${inbox}. Subscribe once (watchhub sub ${inbox} --label '<what you wait on>' --plan <plan> | --filter <regex>); bursts arrive by themselves when a turn ends, no wait command.`;
  if (pc && (pc.plan || pc.filter || pc.probes || pc.scope)) {
    // a resumed session whose subscription ended while it was away: the ended lines go over here,
    // before the new subscription would set them aside behind a one-line notice
    const ended = subs.get(inst.paths, inbox) ? "" : endedText(inst, inbox);
    try {
      const s = subs.make(inst.paths, { inbox, label: pc.label ?? subs.get(inst.paths, inbox)?.label, plan: pc.plan, filter: pc.filter, scope: pc.scope, probes: pc.probes, ttl: pc.ttl || "7d", priority: pc.priority, cooldown: pc.cooldown, settle: pc.settle, sinks: pc.sinks, session: input.session_id });
      subs.save(inst.paths, s);
      note = `watchhub inbox ${inbox} subscribed (${pc.plan ? `plan ${pc.plan}` : `filter ${pc.filter || pc.probes || pc.scope}`}, until ${s.expires}); bursts arrive by themselves when a turn ends, no wait command.`;
    } catch (e) { note = `watchhub: subscription for ${inbox} failed: ${e.message}`; }
    if (ended) note = `${ended}\n${note}`;
  }
  out.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }) + "\n");
  return 0;
}

// No subscription but the engine's expiry line still unread: it ran out while the session held no turn
// (stalled on an error or out of credit for days), so its last lines and that line were never handed
// over. They go over once, with where the lines since the end are: the engine no longer copies them to
// this inbox. Only on the engine's line: a sub removed by `unsub` or after a `--once` burst leaves
// nothing worth a turn, and a waiter that holds the inbox (another process) hands over its own lines.
function endedText(inst, inbox) {
  const u = subs.unacked(inst.paths, inbox);
  if (!u.text.includes(`| watchhub | all | SUBSCRIPTION ${inbox} expired`)) return "";
  const l = require("./lease").read(inst.paths, inbox);
  if (l && l.pid !== process.pid && isAlive(l.pid)) return "";
  subs.ack(inst.paths, inbox, u.end);
  const lines = u.text.split("\n").filter(Boolean), at = Date.parse(lines[lines.length - 1].slice(0, 24));
  const since = isNaN(at) ? "" : `; everything the engine logged since, every probe and not only this subscription's: watchhub events --since ${Math.ceil((Date.now() - at) / 60000) + 1}m`;
  const tail = `(subscription ${inbox} has ended: nothing more arrives until you subscribe again${since})`;
  return `${require("./waiter").capLines(inst.paths, lines, inbox).join("\n")}\n${tail}`;
}
function flushEnded(inst, inbox, out) {
  const reason = endedText(inst, inbox);
  if (reason) out.write(JSON.stringify({ decision: "block", reason }) + "\n");
  return 0;
}

// Stop: no subscription, no hold (an ended one's unread lines go over once). A sub past its expiry but
// still on disk is left alone: the engine writes its end line and removes it within seconds, and the
// next turn end hands that over, so the session gets one turn for it, not two. Otherwise wait, then
// block the stop with the burst as the reason. The hold never keeps the session from its person: a
// message queued behind it, a new turn in the transcript or the end of the process that ran the hook
// lets the turn end at once, and the lines wait for the next turn end.
async function stop(inst, input = readStdin(), out = process.stdout, opts = {}) {
  const pc = projectConfig(input.cwd);
  const inbox = inboxFor(input.session_id, pc);
  const sub = subs.get(inst.paths, inbox);
  if (!sub) return flushEnded(inst, inbox, out);
  if (subs.expired(sub)) return 0;
  let text = "";
  const sink = { write: (s) => { text += s; } };
  const code = await require("./waiter").wait(inst, inbox, { session: input.session_id, out: sink, err: sink, holdSec: opts.holdSec, transcript: input.transcript_path, parentPid: opts.parentPid ?? harnessPid() });
  if (code === 3 || code === 4) return 0;        // superseded, or let go for a queued message or a session that moved on: the turn ends
  const burst = text.trim();
  if (!burst) return 0;
  out.write(JSON.stringify({ decision: "block", reason: burst }) + "\n");
  return 0;
}

// The settings snippet, and a merge into <dir>/.claude/settings.json (a leading ~ is the home directory).
const snippet = (holdSec = 43200) => ({ hooks: {
  SessionStart: [{ hooks: [{ type: "command", command: "watchhub hook start", timeout: 10 }] }],
  Stop: [{ hooks: [{ type: "command", command: "watchhub hook stop", timeout: holdSec }] }],
} });
function install(dir, holdSec) {
  const f = path.join(path.resolve(expandHome(dir)), ".claude", "settings.json");
  const cur = readJson(f, {});
  const add = snippet(holdSec).hooks;
  cur.hooks = cur.hooks || {};
  for (const ev of Object.keys(add)) {
    const list = cur.hooks[ev] = cur.hooks[ev] || [];
    if (!list.some((g) => (g.hooks || []).some((h) => /^watchhub hook/.test(h.command || "")))) list.push(add[ev][0]);
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");
  return f;
}

module.exports = { inboxFor, start, stop, snippet, install };
