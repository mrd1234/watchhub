// derive: events about the event stream itself, no source and no LLM. A rate rule turns a flood
// into one line ("SPIKE: 23 custom:slack-inbox lines in 5m, threshold 20") and one when it is over;
// a silence rule turns an absence into one line ("SILENT: nothing from stamps for 30m") and one when
// the source speaks again. One line per transition, never per message, so an outage that makes a
// channel explode costs an inbox one wake, and a feed that stopped is noticed without anyone polling.
//   {"name": "slack-storm", "derive": {"probes": ["custom:slack-inbox"], "rate": {"window": "5m", "over": 20}}}
//   {"name": "stamps-quiet", "derive": {"probes": ["stamps"], "silence": {"for": "30m"}}}
//   {"name": "p1-words", "derive": {"match": "outage|down|P1", "rate": {"window": "10m", "over": 5}}}
// `probes` (a name or a list) and `match` (a regex over the whole line) select what is counted; one
// of them is needed. A rate rule re-arms once the count falls under half the threshold. Silence is
// measured from the last matching line, kept in state across restarts, so a restart neither resets
// nor fakes it. Lines from this watch itself are never counted.
const { parseDuration } = require("../util");

const spec = (w) => w.derive;

module.exports = {
  name: "derive",
  stream: true,
  validate(w) {
    const d = spec(w);
    if (!d || typeof d !== "object") throw new Error("derive must be an object");
    if (d.probes !== undefined && ![].concat(d.probes).every((p) => typeof p === "string" && /^[a-z0-9:-]+$/.test(p))) throw new Error("derive.probes must be probe names");
    if (d.match !== undefined) new RegExp(d.match);
    if (d.probes === undefined && d.match === undefined) throw new Error("derive needs probes and/or match");
    if (!d.rate && !d.silence) throw new Error("derive needs rate {window, over} and/or silence {for}");
    if (d.rate) { if (!(parseDuration(d.rate.window) >= 10)) throw new Error("rate.window must be at least 10 s"); if (!(Number(d.rate.over) >= 1)) throw new Error("rate.over must be a count of 1 or more"); }
    if (d.silence && !(parseDuration(d.silence.for) >= 10)) throw new Error("silence.for must be at least 10 s");
  },
  start(w, ctx) {
    const d = spec(w), own = `custom:${w.name}`;
    const probes = d.probes !== undefined ? new Set([].concat(d.probes)) : null;
    const re = d.match ? new RegExp(d.match) : null;
    const what = probes ? [...probes].join(",") : `/${d.match}/`;
    const st = { ...(ctx.state || {}) };
    st.times = (st.times || []).filter((t) => typeof t === "number");
    if (d.silence && !st.lastSeen) st.lastSeen = Date.now();   // first sight: silence counts from now, not from the dawn of time
    const save = () => ctx.setState(st);
    const selects = (ev) => ev.probe !== own && (!probes || probes.has(ev.probe)) && (!re || re.test(ev.line));

    const windowMs = d.rate ? parseDuration(d.rate.window) * 1000 : 0;
    const onEvent = (ev) => {
      if (!selects(ev)) return;
      const now = Date.now();
      if (d.silence) { if (st.silent) { st.silent = false; ctx.emit(`SILENT over: ${what} spoke again after ${Math.round((now - st.lastSeen) / 60000)} min`); } st.lastSeen = now; }
      if (d.rate) {
        st.times.push(now);
        st.times = st.times.filter((t) => now - t <= windowMs).slice(-10000);
        const n = st.times.length;
        if (!st.spiking && n >= d.rate.over) { st.spiking = true; ctx.emit(`SPIKE: ${n} ${what} lines in ${d.rate.window} (threshold ${d.rate.over})`); }
      }
      save();
    };
    const tick = () => {
      const now = Date.now();
      if (d.rate && st.spiking) {
        st.times = st.times.filter((t) => now - t <= windowMs);
        if (st.times.length < d.rate.over / 2) { st.spiking = false; ctx.emit(`SPIKE over: ${what} back to ${st.times.length} lines in ${d.rate.window}`); save(); }
      }
      if (d.silence && !st.silent && now - st.lastSeen >= parseDuration(d.silence.for) * 1000) { st.silent = true; ctx.emit(`SILENT: nothing from ${what} for ${d.silence.for} (last at ${new Date(st.lastSeen).toISOString()})`); save(); }
    };
    const unsubscribe = ctx.subscribe(onEvent);
    const every = Math.max(1000, Math.min(15000, (d.silence ? parseDuration(d.silence.for) * 1000 : 15000) / 4));
    const timer = setInterval(tick, every);
    ctx.running();
    save();
    return new Promise((resolve) => ctx.signal.addEventListener("abort", () => { clearInterval(timer); unsubscribe(); resolve(); }));
  },
};
