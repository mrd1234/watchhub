// Two-way sources: a module or kind that reads a place (a chat, an inbox) and can answer in it. Its
// lines carry where an answer goes; the engine gives each one a short handle and writes it on the line
// (` [reply r1a2b3c4]`), and `watchhub reply <handle> '<text>'` hands the text back to the source's send().
// Nothing is sent except by that command. A handle is the same for the same place (a thread, a DM), so it
// stays valid while the conversation lasts, and replies.json keeps the last week of them (at most the
// newest 5000). A handle quoted inside a line's own text is blanked, so only the one the engine adds counts.
const crypto = require("crypto");
const { readJson, readJsonOrSetAside, writeAtomic } = require("./util");

const KEEP_MS = 7 * 24 * 3600000, KEEP_MAX = 5000;
const HANDLE = /^r[0-9a-f]{6}(?:[0-9a-f]{2})?$/;   // six hex digits before 1.4.4, eight since

// The base class for a two-way module. A subclass sets name (and intervalSec, env as any module),
// implements check() as any poll module and returns this.line(text, to) for lines an agent can answer,
// and implements send(to, text, ctx) to answer there. `to` is any small JSON object send() understands.
class TwoWay {
  constructor({ name, intervalSec = 60, env = [] } = {}) {
    this.name = name;
    this.intervalSec = intervalSec;
    this.env = env;
  }
  enabled(cfg) { return cfg.probes?.[this.name] !== false; }
  line(text, to, scope) { return { ...(scope ? { scope } : {}), text, reply: to }; }
  // ctx: {cfg, env, api, log}
  async send() { throw new Error(`${this.name} reads but does not answer: it has no send()`); }
}

const handleOf = (probe, to, n = 0) => "r" + crypto.createHash("sha1").update(`${probe}\n${JSON.stringify(to)}${n ? `\n${n}` : ""}`).digest("hex").slice(0, 8);

// The handle for a line from `probe` answerable at `to`, recorded before the line is delivered (an
// agent can answer the moment it reads it). Older than a week, or past the newest 5000, goes. A handle
// another place already holds is never taken over: the next free one is used instead. The file is read
// strictly: one that does not parse is set aside (onBad told) rather than written over with this one handle.
function remember(file, probe, to, now = Date.now(), onBad = () => {}) {
  let all = readJsonOrSetAside(file, {}, onBad);
  if (!all || typeof all !== "object" || Array.isArray(all)) all = {};
  const same = (r) => r.probe === probe && JSON.stringify(r.to) === JSON.stringify(to);
  let h, n = 0;
  do h = handleOf(probe, to, n++); while (all[h] && !same(all[h]));
  all[h] = { probe, to, at: new Date(now).toISOString() };
  const kept = Object.entries(all).filter(([, r]) => now - Date.parse(r.at) <= KEEP_MS).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, KEEP_MAX);
  writeAtomic(file, JSON.stringify(Object.fromEntries(kept), null, 1));
  return h;
}

const lookup = (file, h) => (HANDLE.test(h || "") ? readJson(file, {})[h] || null : null);
const tag = (h) => ` [reply ${h}]`;
// a handle quoted in text from outside (a message, a comment) cannot answer that line
const unquote = (text) => String(text).replace(/\[reply r[0-9a-f]{6,8}\]/g, "[reply quoted]");

module.exports = { TwoWay, handleOf, remember, lookup, tag, unquote, HANDLE };
