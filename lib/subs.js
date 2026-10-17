// Subscriptions and inboxes. An inbox registers once (<instance>/subscriptions/<inbox>.json); the
// engine tests every new event against every live subscription and appends hits to the inbox's
// inbox (<instance>/inbox/<inbox>.log). The waiter reads from the acknowledged offset
// (<inbox>.ack) and moves it after printing, so a burst nobody read is delivered again.
const fs = require("fs");
const path = require("path");
const plans = require("./plans");
const { readJson, writeAtomic, parseDuration, appendLine, fileSize, readRange, nowIso, withFileLock } = require("./util");

const INBOX = /^[a-z0-9][a-z0-9-]{0,63}$/;

// {inbox, filter?, scope?, probes?, plan?, ttl, session?} -> a saved subscription.
function make(paths, o) {
  if (!INBOX.test(o.inbox || "")) throw new Error("inbox must be lowercase letters, digits and dashes (max 64)");
  const ttl = parseDuration(o.ttl || "7d");   // long: a session stalled for days (an outage, no credit) still has its inbox when it wakes
  if (o.plan) plans.load(paths.plans, o.plan);
  if (o.filter) new RegExp(o.filter);
  if (o.urgent) new RegExp(o.urgent);
  if (o.settle !== undefined && !(Number(o.settle) >= 0)) throw new Error("settle must be seconds");
  if (o.priority !== undefined && !plans.LEVELS.includes(o.priority)) throw new Error(`priority must be one of ${plans.LEVELS.join(", ")}`);
  if (o.cooldown !== undefined && !(Number(o.cooldown) >= 0)) throw new Error("cooldown must be seconds");
  if (o.probes && !(Array.isArray(o.probes) && o.probes.every((n) => /^[a-z0-9:-]+$/.test(n)))) throw new Error("probes must be probe names");
  if (o.sinks) { const sk = require("./sinks"); sk.checkNames(o.sinks, "sinks"); const have = sk.load(paths.sinks).sinks; for (const n of o.sinks) if (!have[n]) throw new Error(`no sink ${n} in ${paths.sinks} (watchhub sink list)`); }
  // a label says what the inbox waits on, for people reading a list of s-<id> inboxes (subs, status, anything
  // that lists them); control characters and line separators are refused, as they would reach a terminal as is
  if (o.label !== undefined && !(typeof o.label === "string" && o.label.trim().length <= 60 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(o.label))) throw new Error("label must be one line of plain text, 60 characters at most");
  if (typeof o.label === "string") o = { ...o, label: o.label.trim() };
  const sub = { inbox: o.inbox, created: nowIso(), expires: new Date(Date.now() + ttl * 1000).toISOString() };
  for (const k of ["label", "plan", "filter", "scope", "probes", "session", "note", "urgent", "sinks", "priority"]) if (o[k] !== undefined && o[k] !== "" && !(Array.isArray(o[k]) && !o[k].length)) sub[k] = o[k];
  if (o.settle !== undefined) sub.settle = Number(o.settle);
  if (o.cooldown !== undefined) sub.cooldown = Number(o.cooldown);
  if (o.once) sub.once = true;   // removed by the waiter after its first burst: a one-off wait
  return sub;
}

function file(paths, inbox) { return path.join(paths.subs, `${inbox}.json`); }
function save(paths, sub) {
  fs.mkdirSync(paths.subs, { recursive: true });
  const existed = fs.existsSync(file(paths, sub.inbox));
  // a fresh subscription starts clean: lines left in the inbox by an earlier, different subscription
  // (an old filter's hits, its expiry line) would otherwise wake the inbox at once for nothing. They are
  // set aside, not dropped unseen: a quiet notice says how many and where, and rides with the next burst.
  if (!existed) {
    const f = inboxFile(paths, sub.inbox);
    if (fs.existsSync(f)) {
      const lines = unacked(paths, sub.inbox).text.split("\n").filter(Boolean);
      ack(paths, sub.inbox, fileSize(f));
      if (lines.length) deliver(paths, sub.inbox, require("./events").format("notice", "all", `${lines.length} unread line${lines.length === 1 ? "" : "s"} from before this subscription set aside: ${aside(paths, sub.inbox, lines)}`));
    }
  }
  writeAtomic(file(paths, sub.inbox), JSON.stringify(sub, null, 2) + "\n");
  return existed;
}
const legacy = (s) => (s && s.lane && !s.inbox ? { ...s, inbox: s.lane } : s);   // files from before the rename say "lane"
const get = (paths, inbox) => legacy(readJson(file(paths, inbox), null));
function remove(paths, inbox) { const f = file(paths, inbox); if (!fs.existsSync(f)) return false; fs.rmSync(f); return true; }
function list(paths) {
  if (!fs.existsSync(paths.subs)) return [];
  return fs.readdirSync(paths.subs).filter((x) => x.endsWith(".json")).map((f) => legacy(readJson(path.join(paths.subs, f), null))).filter(Boolean);
}
const expired = (sub, now = Date.now()) => Date.parse(sub.expires) <= now;

// The probe names an instance can emit: the built-ins, its modules, custom:<watch> for each watch
// file, and the engine's own `watch` and `watchhub` lines. Read once per process.
let knownCache = null, knownAt = 0;
function knownProbes(paths) {
  if (knownCache && Date.now() - knownAt < 60000) return knownCache;
  knownAt = Date.now();
  const sources = require("./sources");
  const names = new Set(["watch", "watchhub", "notice", "schedule"]);
  try { for (const p of sources.allCode(paths.modules, () => {})) names.add(p.name); } catch { for (const p of sources.builtins(() => {})) names.add(p.name); }
  try { for (const w of sources.loadWatches(paths.watches)) names.add(`custom:${w.name}`); } catch {}
  return (knownCache = names);
}
const resetKnown = () => { knownCache = null; };

// How a filter is read. Every `|`-separated token naming a probe this instance has (`vpn|aws-auth`,
// `custom:app-log`) makes it a probe filter, which also passes those probes' failing / recovered
// lines. Anything else is a regex over the whole line. The old rule ("only letters, digits, colons
// and dashes" meant probe names) silently turned a job label such as `5513-green` into a probe
// name that nothing ever emitted, and the inbox waited for a wake that could not come.
function filterMode(paths, filter) {
  const tokens = filter.split("|");
  const known = knownProbes(paths);
  if (tokens.length && tokens.every((t) => known.has(t))) return { mode: "probes", probes: tokens };
  return { mode: "regex", unknown: tokens.filter((t) => /^[a-z0-9:-]+$/.test(t) && /^[a-z]/.test(t) && t.includes("-") === false && !known.has(t)) };
}

// A matcher over parsed event lines. A plan supplies probes, scope and filter; explicit fields add to it.
function matcher(paths, sub) {
  const tests = [];
  if (sub.plan) tests.push(plans.selects(plans.load(paths.plans, sub.plan)));
  if (sub.scope) tests.push((ev) => ev.scope === sub.scope || ev.scope === "all");
  const byProbes = (list) => { const n = new Set(list); return (ev) => n.has(ev.probe) || (ev.probe === "watch" && [...n].some((p) => ev.text.startsWith(`probe ${p} `))); };
  if (sub.probes && sub.probes.length) tests.push(byProbes(sub.probes));
  if (sub.filter) {
    const fm = filterMode(paths, sub.filter);
    if (fm.mode === "probes") tests.push(byProbes(fm.probes));
    else { const re = new RegExp(sub.filter); tests.push((ev) => re.test(ev.line)); }
  }
  return (ev) => tests.every((t) => t(ev));
}

// Inbox files.
const inboxFile = (paths, inbox) => path.join(paths.inbox, `${inbox}.log`);
const ackFile = (paths, inbox) => path.join(paths.inbox, `${inbox}.ack`);
const acked = (paths, inbox) => Number(fs.readFileSync(ackFile(paths, inbox), "utf8").trim()) || 0;
function ackedSafe(paths, inbox) { try { return acked(paths, inbox); } catch { return 0; } }

// Append a line; when everything so far is acknowledged and the file is large, start it afresh
// Only the engine (`fromEngine`) truncates: a notice from the CLI runs in another process, and a
// truncation there could land between the engine's size check and its append.
function deliver(paths, inbox, line, fromEngine = false) {
  const f = inboxFile(paths, inbox);
  if (fromEngine && fileSize(f) > 1 << 20) {
    // the size is read again under the lock: a notice from another process appends under the same lock
    withFileLock(f, () => { const size = fileSize(f); if (ackedSafe(paths, inbox) >= size) { fs.writeFileSync(f, ""); fs.writeFileSync(ackFile(paths, inbox), "0\n"); } appendLine(f, line); });
    return;
  }
  if (fromEngine) appendLine(f, line); else withFileLock(f, () => appendLine(f, line));
}
// A notice to every inbox: `<UTC> | notice | all | <text>` into each subscription's inbox, whatever
// its filter. Notices do not wake an inbox by themselves (the waiter treats them as quiet) unless the
// text starts with WAKE:, so a planned restart is read first in the next burst instead of looking
// like a crash, and an announcement costs no turns.
function broadcast(paths, text) {
  const line = require("./events").format("notice", "all", text);
  const inboxes = list(paths).map((s) => s.inbox);
  for (const l of inboxes) deliver(paths, l, line);
  return inboxes;
}

// The probes a subscription names outright: its probes list, a probe-mode filter, its plan's probes.
function namedProbes(paths, sub, plan) {
  const n = new Set(sub.probes || []);
  if (sub.filter) { const fm = filterMode(paths, sub.filter); if (fm.mode === "probes") for (const p of fm.probes) n.add(p); }
  for (const p of (plan && plan.probes) || []) n.add(p);
  return n;
}
// A probe-health line (`watch | all | probe X failing / recovered / runs again`) is quiet for an inbox that
// did not name X: a scope-wide plan takes every source by omission, and one source's bad hour must not
// wake every inbox (the supervisor was woken by a Slack probe's 429). An inbox that named X is woken.
const HEALTH = /^\S+ \| watch \| all \| (probe|sink) (\S+) (failing|recovered|runs again|works again)/;
function healthQuiet(paths, sub, plan, line) {
  const m = HEALTH.exec(line);
  return !!m && (m[1] === "sink" || !namedProbes(paths, sub, plan).has(m[2]));   // a sink's health is nobody's wake; it rides along
}

function unacked(paths, inbox) {
  const f = inboxFile(paths, inbox), size = fileSize(f);
  let off = ackedSafe(paths, inbox);
  if (off > size) off = 0;
  const text = readRange(f, off, size);
  const nl = text.lastIndexOf("\n");             // only whole lines; a line still being written waits for the next read
  return { offset: off, end: nl < 0 ? off : off + Buffer.byteLength(text.slice(0, nl + 1)), text: nl < 0 ? "" : text.slice(0, nl) };
}
// Lines handed over only as a count (set aside by a new subscription or an unsub, cut from a burst too
// long to print) are copied to <inbox>.aside.log under a `# set aside <id> <n>` line, so the pointer
// reads exactly that batch: the inbox itself may have been started afresh since, a time window would
// take in other lines, and a later batch would move a "last N". The file starts afresh past 1 MB.
// Returns the command that reads them back.
let asideSeq = 0;
function aside(paths, inbox, lines) {
  const f = path.join(paths.inbox, `${inbox}.aside.log`);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const id = `${Date.now().toString(36)}${process.pid.toString(36)}${(asideSeq++).toString(36)}`;
  withFileLock(f, () => {
    if (fileSize(f) > 1 << 20) fs.writeFileSync(f, "");
    fs.appendFileSync(f, [`# set aside ${id} ${lines.length}`, ...lines].map((l) => l + "\n").join(""));
  });
  return `watchhub events --inbox ${inbox} --aside ${id}`;
}
function ack(paths, inbox, offset) { fs.mkdirSync(paths.inbox, { recursive: true }); fs.writeFileSync(ackFile(paths, inbox), `${offset}\n`); }
function ensureInbox(paths, inbox) { fs.mkdirSync(paths.inbox, { recursive: true }); const f = inboxFile(paths, inbox); fs.closeSync(fs.openSync(f, "a")); return f; } // append-open: never truncates a line the engine just wrote

module.exports = { INBOX, healthQuiet, namedProbes, make, save, get, remove, list, expired, matcher, filterMode, knownProbes, resetKnown, deliver, broadcast, unacked, ack, aside, ensureInbox, inboxFile, ackFile };
