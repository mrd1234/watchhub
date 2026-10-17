// Metrics: numbers a source reads on every poll, kept for displays. A watch declares one with a
// `metric` block; the datadog module reports its metric queries; a poll module returns `metrics` from
// its check. The engine keeps:
//   metrics.json          the latest value of every metric, whatever the probe:
//                         {at, metrics: {"<probe>/<name>": {probe, name, scope, value, at, intervalSec,
//                         description, unit?, display?, past, inboxes, history}}}
//   metrics/<file>.jsonl  one {at, v} line a minute per metric (and one whenever `past` flips), 24 h kept;
//                         the entry's `history` names the file, so a reader never derives it
// `display` is for whoever draws the metric: {type, min?, max?, warn?, bad?, lowIsBad?, label?}. The
// engine checks its shape and passes it on; it knows nothing about how a type is drawn. Every metric
// carries a `description`: what the number is, in plain words, for someone who does not know the term.
const fs = require("fs");
const path = require("path");
const { readJson, writeAtomic, readRange, fileSize } = require("./util");

const WRITE_EVERY = 5000;           // ms: metrics.json is written at most this often
const HISTORY_EVERY = 60000;        // ms: one history line a minute per metric
const HISTORY_KEEP = 24 * 3600000;  // ms of history kept
const PRUNE_EVERY = 3600000;        // ms between history prunes
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPE = /^(custom:)?[a-z][a-z0-9-]{0,39}$/;

// Throws unless a metric has its description. Kept apart from checkDef: a watch whose metric lacks one
// still loads and alerts, only its number stays off metrics.json (Store.record) until it has one.
function checkDescription(d) {
  if (typeof d !== "string" || !d.trim() || d.length > 400) throw new Error("metric needs a description: what the number is, in plain words (at most 400 characters)");
}

// Throws with a plain reason when a metric block is not usable. `needValue`: the watch has no
// `value` path, so the block must say where the number is (a regex with one capture group).
function checkDef(m, needValue = false) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("metric must be an object: {description, name?, value?, unit?, display?}");
  if (m.name !== undefined && !NAME.test(m.name)) throw new Error("metric name must be lowercase letters, digits and dashes");
  if (m.value !== undefined) {
    if (typeof m.value !== "string") throw new Error("metric value must be a regex with one capture group");
    const re = new RegExp(m.value);
    if (new RegExp(re.source + "|").exec("").length < 2) throw new Error("metric value regex needs a capture group around the number");
  } else if (needValue) throw new Error("metric needs value (a regex with one capture group) when the watch has no value path");
  if (m.unit !== undefined && (typeof m.unit !== "string" || m.unit.length > 16)) throw new Error("metric unit must be a short string");
  const d = m.display;
  if (d === undefined) return m;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("metric display must be an object: {type, min?, max?, warn?, bad?, lowIsBad?, label?}");
  if (!TYPE.test(d.type || "")) throw new Error("display type must be a lowercase name (dial, gauge, line...) or custom:<name>");
  for (const k of ["min", "max", "warn", "bad"]) if (d[k] !== undefined && !Number.isFinite(d[k])) throw new Error(`display ${k} must be a number`);
  if (d.lowIsBad !== undefined && typeof d.lowIsBad !== "boolean") throw new Error("display lowIsBad must be true or false");
  if (d.label !== undefined && typeof d.label !== "string") throw new Error("display label must be a string");
  return m;
}

// The display a reader gets: as declared, with `bad` and lowIsBad from the source's threshold when unset.
function displayOf(d, above, below) {
  if (!d) return undefined;
  const out = { ...d };
  if (out.bad === undefined && (above ?? below) !== undefined) out.bad = Number(above ?? below);
  if (out.lowIsBad === undefined && above === undefined && below !== undefined) out.lowIsBad = true;
  return out;
}

// A reading as a finite number, or null: a number, or a string holding one. Missing, blank, true/false
// and anything else are no reading (Number() would make null, "" and false a 0).
function toNumber(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

// The number a watch read this poll, or null: its `value` path when it has one, else the block's
// regex capture over the text form. A value that is not a finite number is null.
function readValue(w, payload, text) {
  let raw;
  if (w.metric.value !== undefined) { const m = new RegExp(w.metric.value).exec(text ?? ""); raw = m ? m[1] : undefined; }
  else raw = require("./util").pick(payload, w.value);
  return toNumber(raw);
}

// The report a watch's poll hands the engine for its metric.
function fromWatch(w, payload, text, state) {
  return { name: w.metric.name || w.name, value: readValue(w, payload, text), description: w.metric.description, unit: w.metric.unit, display: w.metric.display,
    above: w.above, below: w.below, past: !!(state && (state.past || state.hit || (state.found !== undefined && state.found !== null))) };
}

// one file per probe and name, and no two keys share one: a character outside a-z0-9- is written as _<hex>_
// (so "_" itself is "_5f_"), and the metric name never holds a dot
const historyName = (probe, name) => `${probe.replace(/[^a-z0-9-]/g, (c) => `_${c.codePointAt(0).toString(16)}_`)}.${name}.jsonl`;

class Store {
  // dir: the instance folder; hooks: {inboxes(probe, scope, name) -> [inbox], live(probe) -> bool, log(msg)}
  constructor(dir, hooks) {
    this.file = path.join(dir, "metrics.json");
    this.histDir = path.join(dir, "metrics");
    this.hooks = hooks;
    this.latest = readJson(this.file, {}).metrics || {};   // shown at once after a restart; stale until polled
    for (const e of Object.values(this.latest)) {   // a history file under an older name moves to the current one
      const now = `metrics/${historyName(e.probe, e.name)}`;
      if (e.history === now) continue;
      try { const from = path.join(dir, e.history || ""), to = path.join(dir, now); if (/^metrics\/[^/\\]+\.jsonl$/.test(e.history || "") && fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } catch { /* the old history is pruned in a day */ }
      e.history = now;
    }
    this.lastHist = {};
    this.rejected = {};   // key -> {probe, msg}: the reason last logged, so a bad report is said once
    this.prunedAt = 0;
    this.timer = null;
  }

  // One probe's reports from one poll. A report with value null keeps the last good value (and its time,
  // so a reader sees it go stale); names the probe no longer reports are dropped, so an empty list clears
  // the probe's entries. A report that fails the metric checks is logged once and skipped, not fatal.
  record(probe, scope, intervalSec, reports) {
    const now = Date.now(), at = new Date(now).toISOString(), seen = new Set(), named = new Set();
    let changed = false;
    for (const r of reports) {
      if (!r) continue;
      const key = `${probe}/${r.name}`, prev = this.latest[key];
      named.add(key);
      try {
        if (!NAME.test(r.name || "")) throw new Error("metric name must be lowercase letters, digits and dashes");
        checkDescription(r.description);
        checkDef({ name: r.name, unit: r.unit, display: r.display });
        delete this.rejected[key];
      } catch (err) {
        if (this.rejected[key]?.msg !== err.message) { this.rejected[key] = { probe, msg: err.message }; this.hooks.log(`metric ${key} skipped: ${err.message}`); }
        continue;
      }
      seen.add(key); changed = true;
      const e = { probe, name: r.name, scope: r.scope || scope, value: prev ? prev.value : null, at: prev ? prev.at : null, intervalSec, description: r.description,
        ...(r.unit ? { unit: r.unit } : {}), ...(r.display ? { display: displayOf(r.display, r.above, r.below) } : {}),
        past: !!r.past, inboxes: prev ? prev.inboxes : [], history: `metrics/${historyName(probe, r.name)}` };
      if (r.value !== null && r.value !== undefined && Number.isFinite(Number(r.value))) { e.value = Number(r.value); e.at = at; }
      const flipped = prev && !!prev.past !== e.past;
      if (e.at === at && (flipped || !(this.lastHist[key] > now - HISTORY_EVERY))) this.append(e, at);
      this.latest[key] = e;
    }
    for (const k of Object.keys(this.latest)) if (this.latest[k].probe === probe && !seen.has(k)) { delete this.latest[k]; delete this.lastHist[k]; changed = true; }
    for (const k of Object.keys(this.rejected)) if (this.rejected[k].probe === probe && !named.has(k)) delete this.rejected[k];   // a name no longer reported is forgotten
    if (changed) this.schedule();
  }

  append(e, at) {
    try {
      fs.mkdirSync(this.histDir, { recursive: true });
      fs.appendFileSync(path.join(path.dirname(this.file), e.history), JSON.stringify({ at, v: e.value }) + "\n");
      this.lastHist[`${e.probe}/${e.name}`] = Date.parse(at);
    } catch (err) { this.hooks.log(`metric history not written: ${err.message}`); }
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, WRITE_EVERY);
    this.timer.unref?.();
  }

  // metrics.json now: probes gone from the engine are dropped, every entry's inboxes are worked out
  // afresh (subscriptions change), and the history is pruned once an hour.
  flush() {
    clearTimeout(this.timer); this.timer = null;
    for (const [k, e] of Object.entries(this.latest)) {
      if (!this.hooks.live(e.probe)) { delete this.latest[k]; delete this.lastHist[k]; continue; }
      e.inboxes = this.hooks.inboxes(e.probe, e.scope, e.name);
    }
    for (const k of Object.keys(this.rejected)) if (!this.hooks.live(this.rejected[k].probe)) delete this.rejected[k];
    try { writeAtomic(this.file, JSON.stringify({ at: new Date().toISOString(), metrics: this.latest }, null, 1)); } catch (err) { this.hooks.log(`metrics.json not written: ${err.message}`); }
    if (Date.now() - this.prunedAt > PRUNE_EVERY) { this.prunedAt = Date.now(); this.prune(); }
  }

  // History older than a day goes; a file nobody has written to for a day goes with it.
  prune(now = Date.now()) {
    let files = [];
    try { files = fs.readdirSync(this.histDir).filter((f) => f.endsWith(".jsonl")); } catch { return; }
    for (const f of files) {
      const p = path.join(this.histDir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > HISTORY_KEEP) { fs.rmSync(p); continue; }
        const lines = readRange(p, 0, fileSize(p)).split("\n").filter(Boolean);
        const keep = lines.filter((l) => { try { return now - Date.parse(JSON.parse(l).at) <= HISTORY_KEEP; } catch { return false; } });
        if (keep.length !== lines.length) writeAtomic(p, keep.length ? keep.join("\n") + "\n" : "");
      } catch (err) { this.hooks.log(`metric history ${f} not pruned: ${err.message}`); }
    }
  }
}

module.exports = { checkDescription, checkDef, displayOf, toNumber, readValue, fromWatch, Store };
