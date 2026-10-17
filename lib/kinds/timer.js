// timer: an event on a schedule, for digests and sweeps, instead of a command watch that echoes a
// phrase. `every` is a duration (30m, 6h, 2d) from the watch's creation; `at` is a local time of day
// (HH:MM) every day, or a list of them. The event text is `due <name>` (or `text`). A timer never
// fires for a slot that passed while the engine was down: the next slot is what counts, so a
// restart does not produce a burst of stale "due" lines.
//   {"name": "board-sweep", "scope": "team", "timer": {"every": "6h"}}
//   {"name": "morning-digest", "timer": {"at": ["09:00", "17:30"]}, "text": "DIGEST DUE"}
const { parseDuration } = require("../util");

function nextAt(times, from) {
  const cands = [];
  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    for (const dayOffset of [0, 1]) { const d = new Date(from); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); if (d > from) cands.push(d.getTime()); }
  }
  return Math.min(...cands);
}

module.exports = {
  name: "timer",
  validate(w) {
    const t = w.timer;
    if (!t || (t.every === undefined && t.at === undefined)) throw new Error("timer needs every (a duration) or at (HH:MM or a list)");
    if (t.every !== undefined && !(parseDuration(t.every) >= 60)) throw new Error("timer every must be at least 60 s");
    if (t.at !== undefined) for (const x of [].concat(t.at)) if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(x)) throw new Error(`timer at ${x} is not HH:MM`);
  },
  async poll(w, st, cfg, env, api) {
    const t = w.timer, now = Date.now();
    const next = () => (t.at !== undefined ? nextAt([].concat(t.at), new Date(now)) : now + parseDuration(t.every) * 1000);
    if (!st || !st.next) return { events: [], state: { next: t.at !== undefined ? next() : Date.parse(w.created || new Date().toISOString()) + parseDuration(t.every) * 1000 } };
    if (now < st.next) return { events: [], state: st };
    return { events: [w.text || `due ${w.name}`], state: { next: next() } };
  },
};
