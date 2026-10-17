// What a module gets: `module.exports = (api) => ({ name, intervalSec, check })` or a plain object
// whose check(state, cfg, env, api) receives the same api as its fourth argument. A module that also
// answers where it reads extends api.TwoWay (twoway.js).
const http = require("./http");
const util = require("./util");
const { detect, finished, perEntry } = require("./diff");
const events = require("./events");

// Which scope an event belongs to. facts: {repo, base, branch, title} for a PR, {project, key} for
// a ticket, {label} for a job or stamp. Rules in cfg.scopes are tried in order and the first rule
// with ANY matching field wins; fields that do not apply are ignored. Then the fallback, then cfg.defaultScope.
function scopeOf(cfg, facts, fallback) {
  const test = (re, v) => re && v != null && new RegExp(re).test(v);
  for (const r of cfg.scopes || []) {
    if (test(r.prTitle, facts.title) || test(r.prBase, facts.base) || test(r.prBranch, facts.branch) ||
        test(r.repo, facts.repo) || (r.jiraProject && r.jiraProject === facts.project) ||
        test(r.ticketKey, facts.key) || test(r.env, facts.label)) return r.name;
  }
  return fallback || cfg.defaultScope || "none";
}

// The authors whose PRs are watched: config prAuthors, "@me" meaning the signed-in user.
async function prAuthors(cfg) {
  const me = await http.ghLogin();
  return new Set((cfg.prAuthors || ["@me"]).map((a) => (a === "@me" ? me : a)));
}

module.exports = { ...http, ...util, detect, finished, perEntry, scopeOf, prAuthors, formatEvent: events.format, parseEvent: events.parse, TwoWay: require("./twoway").TwoWay };
