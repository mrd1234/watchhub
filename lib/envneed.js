// What a source or sink needs from the environment, declared rather than discovered by failing:
//   env: ["JIRA_API_TOKEN"]                       one variable
//   env: ["GITHUB_TOKEN|GH_TOKEN?"]               either of two, and optional (a fallback exists)
//   env: (cfg, env) => [...]                      computed from the config (a configurable tokenEnv)
// A spec is `A|B|C` (any one satisfies) with a trailing `?` for optional. `missing(specs, env)` returns
// the required specs nothing satisfies, in the words to show a person.
function specs(decl, cfg, env) {
  const list = typeof decl === "function" ? decl(cfg, env) : decl;
  return Array.isArray(list) ? list.filter((s) => typeof s === "string" && s) : [];
}
function missing(decl, cfg, env = process.env) {
  const out = [];
  for (const spec of specs(decl, cfg, env)) {
    const optional = spec.endsWith("?");
    const names = spec.replace(/\?$/, "").split("|");
    if (!optional && !names.some((n) => env[n])) out.push(names.join(" or "));
  }
  return out;
}
// Every spec with its state, for doctor: [{spec, names, optional, set: name|null}]
function report(decl, cfg, env = process.env) {
  return specs(decl, cfg, env).map((spec) => { const optional = spec.endsWith("?"); const names = spec.replace(/\?$/, "").split("|"); return { spec, names, optional, set: names.find((n) => env[n]) || null }; });
}
module.exports = { specs, missing, report };
