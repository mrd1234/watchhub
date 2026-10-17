// github: a REST path read with If-None-Match (a 304 is free against the rate limit) or a GraphQL
// query, inspected by the change-detection rules. Default: new items by `id` in the payload's
// array (or its items / workflow_runs / check_runs list). A `metric` read by regex on a watch with no
// match, items or value makes it a metric watch: quiet, or bounded by above/below (add items to keep
// the new-item lines as well).
//   {"github": {"endpoint": "repos/o/r/actions/runs?per_page=10"}}
//   {"github": {"endpoint": "repos/o/r/pulls/42"}, "match": "\"merged\":true"}
//   {"github": {"graphql": "query($o:String!){...}", "variables": {"o": "owner"}}, "items": "repository.pullRequests.nodes", "id": "number", "changed": "mergeable"}
// What the ETag cache keeps in state.json: for a value path only that value; for item lists only the id, the `changed` field and the
// fields the `text` template names, not whole run or PR objects, which would be rewritten on every tick
function slim(w, j) {
  const arr = w.items !== undefined ? api_pick(j, w.items) : j;
  if (!Array.isArray(arr)) return j;
  const keep = new Set([w.id || "id", "status", "conclusion", "state", "title", "name", "display_title", ...(w.changed ? [w.changed] : []), ...[...String(w.text || "").matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].trim())]);
  const small = arr.map((x) => { const o = {}; for (const k of keep) { const top = k.split(/[.[]/)[0]; if (x && x[top] !== undefined) o[top] = x[top]; } return o; });
  if (w.items === undefined) return small;
  const out = {}; let cur = out; const parts = String(w.items).replace(/^\$\.?/, "").split(".");
  parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = small; else cur = cur[p] = {}; });
  return out;
}
const api_pick = (o, p) => require("../util").pick(o, p);
const listOf = (j) => (Array.isArray(j) ? j : j.items || j.workflow_runs || j.check_runs || j.artifacts || j.variables || j.jobs || [j]);

module.exports = {
  name: "github",
  validate(w) {
    const g = w.github || w.gh;
    if (!g || !(g.endpoint || g.graphql)) throw new Error("github needs endpoint or graphql");
    if (g.jq) throw new Error("jq is not run in-process: say which array with items (a path) and which field with id");
    if (g.idField && w.id === undefined) w.id = g.idField; // the older gh shape
  },
  async poll(w, st, cfg, env, api) {
    const g = w.github || w.gh;
    // what the payload is cut down to: all of it for a regex, the one value for a value path, else the slim list
    const shape = w.match || w.metric?.value !== undefined ? "full" : w.value !== undefined ? "value" : "slim";
    const reduce = { full: (j) => j, value: (j) => ({ v: api_pick(j, w.value) }), slim: (j) => slim(w, w.items !== undefined ? j : listOf(j)) }[shape];
    let payload;
    const next = {};
    if (g.graphql) { payload = await api.ghGraphql(g.graphql, g.variables || {}, cfg); if (shape === "value") payload = reduce(payload); }
    else payload = await api.ghGet(g.endpoint, st?.shape === shape ? st.etags || {} : {}, next, reduce, cfg);   // a cache cut to another shape is not reused
    const spec = shape === "value" ? { ...w, value: "v" } : w.match || w.items !== undefined || shape === "full" ? w : { ...w, items: "$" };
    const r = api.detect(spec, st, payload);
    const events = shape === "value" ? r.events.map((e) => e.replace(/^value v\b/, `value ${w.value}`)) : r.events;
    return { events, state: { ...r.state, etags: next, shape }, metric: r.metric };
  },
};
