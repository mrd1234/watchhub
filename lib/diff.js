// One change-detection layer for every generic kind. A watch says what counts as news with:
//   match    regex over the text form; the matched text is reported whenever it differs from the
//            last one reported (a match already present on the first run is reported: a watch with
//            `match` means "tell me when this is true", and it may already be)
//   items    path to an array in a JSON payload (default: the payload when it is an array); with
//            `id` (default "id") new items are reported, and with `changed` (a field path) an item
//            whose field moved is reported too; `text` templates the event (default: id + status-ish fields)
//   value    a path to one value in a JSON payload: reported when it changes ("value x.y: a -> b");
//            with `expect`, reported when it equals expect (once, until it moves away and back);
//            with `above` or `below` (a number) and optional `for` (polls, default 1), reported once
//            when the value has been past the bound for that many polls, and once when it is back; a
//            reading that is not a number (missing, blank, an error) changes nothing either way
//   (none)   the trimmed text form is compared with the last run: "output changed: ..."
// A `metric` read by regex on a watch with none of the above is quiet, or bounded by above/below.
// The first run records a baseline and says nothing, except under `match` or `expect`.
const { oneLine, pick, template } = require("./util");
const metrics = require("./metrics");

const MAX = 10; // events per run from one watch; more is a flood, not news

// A watch with a `metric` block also reports the number it read (see metrics.js), whatever its mode.
function detect(spec, st, payload, text) {
  text = text ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
  // a metric read by regex with nothing else to detect is quiet, unless it has a bound: then the bound
  // is tested on the number ("<metric> above 85: 91"), not on the raw text changing every poll
  if (spec.metric && spec.metric.value !== undefined && !spec.match && spec.items === undefined && spec.value === undefined) {
    const n = metrics.readValue(spec, payload, text), name = spec.metric.name || spec.name;
    const bounded = spec.above !== undefined || spec.below !== undefined;
    const r = bounded ? core({ ...spec, value: "v" }, st, { v: n }, text) : { events: [], state: { v: n } };
    r.events = r.events.map((e) => e.replace(/^value v /, `${name} `));
    r.metric = metrics.fromWatch(spec, payload, text, r.state);
    return r;
  }
  const r = core(spec, st, payload, text);
  if (spec.metric) r.metric = metrics.fromWatch(spec, payload, text, r.state);
  return r;
}

function core(spec, st, payload, text) {
  if (spec.match) {
    const re = new RegExp(spec.match, spec.flags || "");
    const hit = re.exec(text);
    const found = hit ? (spec.text ? template(spec.text, { match: hit, body: payload }) : hit[0]) : null;
    const last = st?.found ?? null;
    return { events: found && found !== last ? [`match: ${oneLine(found, 200)}`] : [], state: { found } };
  }
  if (spec.value !== undefined) {
    const v = pick(payload, spec.value), s = v === undefined ? "(missing)" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (spec.above !== undefined || spec.below !== undefined) {
      const n = metrics.toNumber(v), need = Math.max(1, Number(spec.for) || 1);
      if (n === null) return { events: [], state: { past: !!st?.past, run: st?.run || 0, value: s } };
      const past = ((spec.above !== undefined && n > Number(spec.above)) || (spec.below !== undefined && n < Number(spec.below)));
      const run = past ? (st?.run || 0) + 1 : 0, was = !!st?.past;
      const bound = spec.above !== undefined ? `above ${spec.above}` : `below ${spec.below}`;
      const events = [];
      if (past && !was && run >= need) events.push(`value ${spec.value} ${bound}: ${oneLine(s, 100)}${need > 1 ? ` (${run} polls)` : ""}`);
      if (!past && was) events.push(`value ${spec.value} back, not ${bound}: ${oneLine(s, 100)}`);
      return { events, state: { past: past ? (was || run >= need) : false, run, value: s } };
    }
    if (spec.expect !== undefined) {
      const hit = s === String(spec.expect), was = !!st?.hit;
      return { events: hit && !was ? [`value ${spec.value} is ${oneLine(s, 200)}`] : [], state: { hit, value: s } };
    }
    if (!st || st.value === undefined) return { events: [], state: { value: s } };
    return { events: st.value !== s ? [`value ${spec.value}: ${oneLine(st.value, 100)} -> ${oneLine(s, 100)}`] : [], state: { value: s } };
  }
  const arr = spec.items !== undefined ? pick(payload, spec.items) : Array.isArray(payload) ? payload : undefined;
  if (Array.isArray(arr)) {
    const idf = spec.id || "id";
    const label = (x) => spec.text ? template(spec.text, x) : oneLine([pick(x, idf), x.status, x.conclusion, x.state, x.title || x.name || x.display_title].filter((v) => v != null).join(" "), 160);
    const seen = st?.seen || null;
    const now = {};
    for (const x of arr) { const k = String(pick(x, idf)); now[k] = spec.changed ? String(pick(x, spec.changed) ?? "") : ""; }
    const events = [];
    if (seen) for (const x of arr) {
      const k = String(pick(x, idf));
      if (!(k in seen)) events.push(`new ${label(x)}`);
      else if (spec.changed && seen[k] !== now[k]) events.push(`changed ${label(x)}`);
    }
    const keys = Object.keys(now).slice(-500);
    return { events: events.slice(0, MAX), state: { seen: Object.fromEntries(keys.map((k) => [k, now[k]])) } };
  }
  const out = oneLine(text, 4000);
  if (st === undefined || st === null || st.out === undefined) return { events: [], state: { out } };
  return { events: st.out !== out ? [`output changed: ${oneLine(out, 150)}`] : [], state: { out } };
}

// Runs (builds, deploys) that finished since the last poll, from a list of the latest few. runs:
// [{id, done}], newest or oldest first; seen: the ids already finished last time (undefined on a
// first poll, which only records them, so a run still going then is reported when it ends).
// Returns the newly finished runs in list order and the ids to keep.
function finished(seen, runs) {
  const ids = runs.filter((r) => r.done).map((r) => String(r.id));
  if (!seen) return { done: [], seen: ids };
  const was = new Set(seen);
  return { done: runs.filter((r) => r.done && !was.has(String(r.id))), seen: ids };
}

// One probe over several entries (jobs, projects, pipelines): an entry that fails (a mistyped name, a
// pipeline gone) does not stop the rest. entries: [{key, run, keep}]; run() does the entry's work,
// keep() puts its old state back while it fails. Returns the keys failing now and the notes to say:
// `<key> failing: <why>` once when it starts, `<key> works again` once when it stops. Every entry
// failing is the probe failing: the first error is thrown, for the engine's own failing line and back-off.
async function perEntry(failingBefore, entries) {
  const was = failingBefore || {}, failing = {}, notes = [];
  let ok = 0, first;
  for (const e of entries) {
    try {
      await e.run();
      ok++;
      if (was[e.key]) notes.push({ key: e.key, text: `${e.key} works again` });
    } catch (err) {
      first = first || err;
      failing[e.key] = String(err.message || err).replace(/\s+/g, " ").slice(0, 160);
      if (!was[e.key]) notes.push({ key: e.key, text: `${e.key} failing: ${failing[e.key]}` });
      if (e.keep) e.keep();
    }
  }
  if (entries.length && !ok) throw first;
  return { failing, notes };
}

module.exports = { detect, finished, perEntry, MAX };
