// __NAME__: a watchhub module. One file, one probe. The engine calls check() on its interval with the
// state it returned last time; return the events (lines) that are news and the state to keep.
// Switch it on and off with "probes": { "__NAME__": false } in instance.json. Restart the engine to load it.
module.exports = (api) => ({
  name: "__NAME__",
  intervalSec: 60,                       // seconds between polls (instance.json "intervals" can override)
  env: [],                               // variables it needs, e.g. ["MY_TOKEN"] or ["A|B?"] (either, optional)
  enabled: (cfg) => cfg.probes?.["__NAME__"] !== false,

  // state: what check() returned last time (undefined on the first run). cfg: instance.json. env: process.env.
  // api: fetchJson, fetchText, run (a CLI with a timeout), ghGet (GitHub with ETags), jiraSearch, tcpReach,
  //      detect (the change-detection layer: match / items / value), scopeOf, oneLine, pick, template.
  async check(state, cfg, env, api) {
    const payload = await api.fetchJson("https://example.com/api/status", {}, 20);
    // The simplest way to turn "what I saw" into "what changed": hand it to detect() with a spec.
    //   { value: "status" }                       -> "value status: ok -> down" when it changes
    //   { value: "cpu", above: 85, for: 3 }       -> once when past the bound for 3 polls, once when back
    //   { items: "runs", id: "id", changed: "state", text: "{id} {state}" } -> new or changed items
    //   { match: "ERROR" }                        -> when the text form matches (and the match changes)
    const r = api.detect({ value: "status" }, state, payload);
    // Or compute your own: events are strings (scope "all") or { scope, text }.
    return { events: r.events, state: r.state };
  },

  // optional: one line for `watchhub now`
  now: (state) => (state && state.value !== undefined ? `status ${state.value}` : "no data yet"),
});
