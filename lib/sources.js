// Sources: where events come from. Three origins, one shape for the engine.
//   kinds      generic, in the engine (lib/kinds/*.js), driven by a JSON watch in <instance>/watches
//   builtins   helpers shipped with the engine (lib/builtin/*.js), switched on by instance.json "probes"
//   modules    the instance's own helpers in <instance>/modules/*.js
// A probe handed to the engine is { name, intervalSec, enabled(cfg), check(state, cfg, env, api) }
// for a poll source, or { name, stream: true, enabled(cfg), start(ctx) } for a stream. A module may
// export the object directly, a function (api) => object, or an array of them (one module, several
// probes, as the shipped github module is). An instance module with a builtin's name replaces it.
const fs = require("fs");
const path = require("path");
const api = require("./api");
const { readJson } = require("./util");

const KINDS = {};
for (const f of fs.readdirSync(path.join(__dirname, "kinds")).filter((x) => x.endsWith(".js"))) {
  const k = require(path.join(__dirname, "kinds", f));
  KINDS[k.name] = k;
}
const ALIASES = { gh: "github" };
// the kinds whose poll goes through the change-detection layer, which reads a watch's metric
const METRIC_KINDS = new Set(["command", "http", "aws", "github"]);
const kindOf = (w) => Object.keys(KINDS).filter((k) => w[k] !== undefined || Object.entries(ALIASES).some(([a, t]) => t === k && w[a] !== undefined));

// Throws with a plain reason when a watch is not usable.
function validate(w) {
  if (!w || !/^[a-z0-9-]+$/.test(w.name || "")) throw new Error("name must be lowercase letters, digits and dashes");
  const ks = kindOf(w);
  if (ks.length !== 1) throw new Error(`exactly one kind needed (${Object.keys(KINDS).join(", ")}), got ${ks.length ? ks.join(", ") : "none"}`);
  if (w.intervalSec !== undefined && !(w.intervalSec >= 5)) throw new Error("intervalSec must be 5 or more");
  if (w.ttl !== undefined && !(typeof w.ttl === "number" ? w.ttl > 0 : !isNaN(Date.parse(w.ttl)))) throw new Error("ttl must be seconds or an ISO time");
  for (const re of [w.match, w.file?.match]) if (re !== undefined) new RegExp(re);
  if (w.scope !== undefined && !/^[a-z0-9-]+$/.test(w.scope)) throw new Error("scope must be lowercase letters, digits and dashes");
  require("./sinks").checkNames(w.sinks, "sinks");
  if (w.reply !== undefined && !(typeof w.reply === "string" && require("./sinks").NAME.test(w.reply))) throw new Error("reply must be the name of the sink that writes back to where this watch reads");
  if (w.metric !== undefined) {
    if (!METRIC_KINDS.has(ks[0])) throw new Error(`metric works on ${[...METRIC_KINDS].join(", ")} watches (the ones read on each poll), not ${ks[0]}`);
    require("./metrics").checkDef(w.metric, w.value === undefined);
    if (w.expect !== undefined && w.value === undefined) throw new Error("expect needs a value path; a metric read by regex takes above or below");
  }
  KINDS[ks[0]].validate(w);
  return w;
}

function loadWatches(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    // the watch's own path is kept as `_path`: `file` is a kind name and must stay the watch's field
    const file = path.join(dir, f);
    try {
      const w = validate(JSON.parse(fs.readFileSync(file, "utf8")));
      out.push({ ...w, _path: file, created: w.created || fs.statSync(file).mtime.toISOString() });
    } catch (e) { out.push({ invalid: e.message, _path: file, name: path.basename(f, ".json") }); }
  }
  return out;
}

function expired(w, now = Date.now()) {
  if (w.ttl === undefined) return false;
  const end = typeof w.ttl === "number" ? Date.parse(w.created) + w.ttl * 1000 : Date.parse(w.ttl);
  return now >= end;
}

// A JSON watch as a probe. Events from a watch carry the watch's scope (default "custom"). A kind that can
// answer where it reads returns {text, reply} for answerable lines and has send(w, to, text, ctx).
function toProbe(w) {
  const kind = KINDS[kindOf(w)[0]];
  const scope = w.scope || "custom", ev = (e) => (typeof e === "string" ? { scope, text: e } : { ...e, scope });
  const base = { name: `custom:${w.name}`, intervalSec: w.intervalSec || 30, enabled: (cfg) => cfg.probes?.custom !== false, watch: w,
    ...(kind.send ? { send: (to, text, ctx) => kind.send(w, to, text, ctx) } : {}),
    env: (cfg, env) => [...(kind.env ? kind.env(w, cfg, env) : []), ...[...JSON.stringify(w).matchAll(/\$\{([A-Z0-9_]+)\}/gi)].map((m) => m[1]).filter((n) => !/^EPOCH/.test(n))] };
  if (kind.stream) return { ...base, stream: true, start: (ctx) => kind.start(w, { ...ctx, emit: (e) => ctx.emit(ev(e)) }) };
  return { ...base, async check(st, cfg, env) { const r = await kind.poll(w, st, cfg, env, api); return { state: r.state, events: r.events.map(ev), metrics: r.metric ? [r.metric] : [] }; } };   // [] clears a metric block taken out
}

// Code sources: a folder of *.js, each a probe object or a factory taking the api. A broken file is
// reported and skipped, never fatal: one bad module must not take the engine down.
function loadCode(dir, log) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    try {
      let m = require(path.join(dir, f));
      if (typeof m === "function") m = m(api);
      for (const p of [].concat(m)) {
        if (!p || !p.name || !(p.check || p.start)) throw new Error("export must be {name, check} or {name, stream, start}, or a list of them");
        if (p.start && !p.stream) p.stream = true;
        if (!p.enabled) p.enabled = (cfg) => cfg.probes?.[p.name] !== false;
        out.push(p);
      }
    } catch (e) { log(`module ${f} skipped: ${e.message}`); }
  }
  return out;
}

const builtins = (log) => loadCode(path.join(__dirname, "builtin"), log);
// Every code source: the shipped builtins, then the instance's modules, which replace a builtin of the same name.
function allCode(modulesDir, log) {
  const mine = loadCode(modulesDir, log), names = new Set(mine.map((p) => p.name));
  return [...builtins(log).filter((p) => !names.has(p.name)), ...mine];
}

module.exports = { KINDS, kindOf, validate, loadWatches, expired, toProbe, loadCode, builtins, allCode, readJson };
