// One-off schedules: `watchhub at` / `watchhub in`. Each is a line the engine emits once at its time,
// to inboxes directly (whatever their filter), to sinks, and/or as an ordinary line in a scope.
// <instance>/schedules.json holds the pending ones, soonest first:
//   [{id, due, targets: {inboxes, sinks, scope}, text, created, by?}]
// Every change is made under the file's lock, reading it strictly: a file that does not parse is set
// aside, never written over. The engine emits a due line first and removes the entry after, so a crash
// in between fires it again (same id, marked late) rather than losing it.
const crypto = require("crypto");
const { readJson, readJsonOrSetAside, writeAtomic, withFileLock, parseDuration, nowIso } = require("./util");

const MAX = 1000, TEXT_MAX = 500, LATE_MS = 120000, MAX_AHEAD_S = 366 * 86400;
const SCOPE = /^[\w:.-]{1,64}$/;

// A read for looking only (lists, holds): the file as it is, [] when missing or unreadable.
function read(paths) { const l = paths.schedules ? readJson(paths.schedules, []) : []; return Array.isArray(l) ? l : []; }

// The engine's read: strict (a file that does not parse is set aside, onBad told), soonest first, and an
// entry with no id or no due time is left out with one note rather than fired at once or never.
function readStrict(paths, onBad = () => {}) {
  const list = readJsonOrSetAside(paths.schedules, [], onBad);
  if (!Array.isArray(list)) { onBad("schedules.json does not hold a list; no schedule fires until it does"); return []; }
  const ok = list.filter((e) => e && typeof e.id === "string" && !isNaN(Date.parse(e.due)));
  if (ok.length !== list.length) onBad(`${list.length - ok.length} schedule entr${list.length - ok.length === 1 ? "y" : "ies"} without an id or a due time left out`);
  return ok.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

// fn(list) changes the list in place and returns what the caller wants back; the list is written after.
function update(paths, fn, onBad) {
  return withFileLock(paths.schedules, () => {
    let list = readJsonOrSetAside(paths.schedules, [], onBad);
    if (!Array.isArray(list)) list = [];
    const r = fn(list);
    list.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    writeAtomic(paths.schedules, JSON.stringify(list, null, 1) + "\n");
    return r;
  });
}

// "15:30" -> the next 15:30 local time; an ISO date and time -> that moment, which must be ahead.
function parseWhen(s, now = new Date()) {
  const str = String(s ?? "").trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (hm) {
    const h = Number(hm[1]), m = Number(hm[2]);
    if (h > 23 || m > 59) throw new Error(`not a time of day: ${str}`);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);   // the calendar step keeps 15:30 at 15:30 across a daylight-saving change
    return d;
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str) || isNaN(Date.parse(str))) throw new Error(`not a time: ${str} (use HH:MM, or an ISO date and time such as 2026-10-20T09:00)`);
  const d = new Date(Date.parse(str));
  if (d <= now) throw new Error(`${str} has already passed`);
  if (d - now > MAX_AHEAD_S * 1000) throw new Error(`${str} is more than a year ahead`);
  return d;
}

// "90s" | "20m" | "2h" | "1d" -> that long from now. parseDuration also takes ISO times; `in` does not.
function afterDuration(s, now = new Date()) {
  const str = String(s ?? "").trim();
  if (!/^\d+(\.\d+)?\s*[smhd]?$/i.test(str)) throw new Error(`not a duration: ${str} (use 90s, 20m, 2h, 1d)`);
  const sec = parseDuration(str);
  if (!(sec > 0)) throw new Error("the duration must be more than zero");
  if (sec > MAX_AHEAD_S) throw new Error("the duration must be a year or less");
  return new Date(now.getTime() + sec * 1000);
}

// o: {due: Date, inboxes, sinks, scope, text, by} -> the saved entry. Targets are checked by the caller.
function add(paths, o, onBad) {
  const text = String(o.text ?? "").trim();
  if (!text) throw new Error("the text is empty");
  if (text.length > TEXT_MAX || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) throw new Error(`the text must be one line of plain text, ${TEXT_MAX} characters at most`);
  const targets = { inboxes: o.inboxes || [], sinks: o.sinks || [], ...(o.scope ? { scope: o.scope } : {}) };
  if (!targets.inboxes.length && !targets.sinks.length && !targets.scope) throw new Error("a schedule needs a target: an inbox, --sink or --scope");
  if (targets.scope && !SCOPE.test(targets.scope)) throw new Error("scope must be letters, digits and . _ : - (max 64)");
  return update(paths, (list) => {
    if (list.length >= MAX) throw new Error(`${MAX} schedules are already pending; cancel some first (watchhub schedules)`);
    let id;
    do id = crypto.randomBytes(3).toString("hex"); while (list.some((e) => e.id === id));
    const entry = { id, due: o.due.toISOString(), targets, text, created: nowIso(), ...(o.by ? { by: o.by } : {}) };
    list.push(entry);
    return entry;
  }, onBad);
}

// The removed entry, or null when there is no such id.
function remove(paths, id, onBad) {
  return update(paths, (list) => { const i = list.findIndex((e) => e.id === id); return i < 0 ? null : list.splice(i, 1)[0]; }, onBad);
}

const inboxesOf = (e) => (e && e.targets && Array.isArray(e.targets.inboxes) ? e.targets.inboxes : []);
// The subscription `at` / `in` make for an inbox that has none: it takes schedule lines only. Its scope is the
// marker `schedules`, which no source uses, so the matchers never hand it a line scheduled for some other
// scope; the engine delivers the inbox's own schedules to it directly. isHold tells one from a real subscription,
// so the engine can let it go once the inbox's last schedule has fired.
const HOLD = { label: "schedules", probes: ["schedule"], scope: "schedules" };
const isHold = (s) => !!s && s.scope === HOLD.scope && Array.isArray(s.probes) && s.probes.length === 1 && s.probes[0] === "schedule" && !s.plan && !s.filter;
// Pending schedules that reach an inbox; `except` holds ids already handed over (a burst being printed).
const pendingFor = (paths, inbox, except = new Set()) => read(paths).filter((e) => inboxesOf(e).includes(inbox) && !except.has(e.id));
// When an inbox's last pending schedule is due, in ms (0 for none): a subscription lasts at least a day past it.
const lastDueFor = (paths, inbox) => pendingFor(paths, inbox).reduce((m, e) => Math.max(m, Date.parse(e.due) || 0), 0);

// The ids of schedule lines in a block of event lines.
const idsIn = (text) => new Set([...String(text).matchAll(/^\S+ \| schedule \| [^|]+ \| SCHEDULED ([0-9a-f]{6}) /gm)].map((m) => m[1]));

// Local "15:30" today, else "2026-10-20 15:30".
function describe(iso, now = new Date()) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

// The line a due entry fires as.
const lineText = (e, now = Date.now()) => `SCHEDULED ${e.id} ${e.text}${now - Date.parse(e.due) > LATE_MS ? ` (late, due ${describe(e.due, new Date(now))})` : ""}`;

module.exports = { MAX, TEXT_MAX, LATE_MS, HOLD, isHold, read, readStrict, update, parseWhen, afterDuration, add, remove, pendingFor, lastDueFor, idsIn, describe, lineText, inboxesOf };
