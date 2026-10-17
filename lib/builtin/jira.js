// jira: boards as one probe, `board`: new tickets, status moves and comments by others, with each
// project's quiet moves and quiet comments filtered at source. One search per poll covers every project.
//   TICKET NEW <key> <summary> | TICKET MOVED <key> <from> -> <to> by <who> | TICKET COMMENT <key> by <who>: <text>
//   TICKET UNFOLLOWED <key>: ...   a followed key Jira does not know any more, dropped so the search works
// Switched on by an instance.json `jira` section:
//   "jira": { "base": "https://x.atlassian.net/rest/api/3", "email": "me@x", "me": "My Name", "tokenEnv": "JIRA_API_TOKEN",
//             "projects": [{ "key": "ABC", "jql": "assignee = currentUser()", "quietMovesTo": ["Closed"], "quietComment": "works as" }],
//             "ignoreActors": ["My Name"] }
// (`board.ignoreActors` at the top level is the older spelling.) Token: JIRA_API_TOKEN (or jira.tokenEnv).
// Tickets outside those projects (or outside their jql) join the same search while followed:
// `watchhub jira follow KEY [--ttl 30d]` keeps them in <instance>/jira-follow.json; a followed ticket
// skips its project's quiet filters, and one past its ttl drops out.
const { readJson, writeAtomic, withFileLock } = require("../util");
const adf = (n) => !n ? "" : n.type === "text" ? n.text : n.type === "mention" ? (n.attrs || {}).text || "" : (n.content || []).map(adf).join(n.type === "paragraph" ? " " : "");

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
// The followed keys still within their ttl. The file is read again only when it changes: the engine
// asks enabled() often.
let cache = { file: null, mtime: -1, list: [] };
const followed = (file) => {
  if (!file) return [];
  let mtime = 0; try { const st = require("fs").statSync(file); mtime = `${st.mtimeMs}:${st.size}`; } catch {}
  if (cache.file !== file || cache.mtime !== mtime) cache = { file, mtime, list: readJson(file, []) };
  return cache.list.filter((f) => KEY.test(f.key) && (!f.until || Date.parse(f.until) > Date.now())).map((f) => f.key);
};
const unfollow = (file, keys) => withFileLock(file, () => writeAtomic(file, JSON.stringify(readJson(file, []).filter((f) => !keys.includes(f.key)), null, 1)));

module.exports = (api) => ({
  name: "board",
  env: (cfg) => [cfg.jira?.tokenEnv || "JIRA_API_TOKEN"],
  intervalSec: 60,
  enabled: (cfg) => !!(cfg.jira?.projects?.length || (cfg.jira && followed(api.paths?.follows).length)) && cfg.probes?.board !== false,
  async check(st, cfg, env) {
    const now = new Date().toISOString();
    let follows = followed(api.paths?.follows);
    if (!st) return { events: [], state: { since: now, following: follows.length } };
    const j = cfg.jira, H = api.jiraHeaders(cfg, env);
    const since = new Date(st.since);
    const ignore = new Set(j.ignoreActors || cfg.board?.ignoreActors || [j.me]);
    const proj = Object.fromEntries((j.projects || []).map((p) => [p.key, { quietTo: new Set((p.quietMovesTo || []).map((s) => s.toLowerCase())), quietComment: p.quietComment ? new RegExp(p.quietComment, "i") : null }]));
    const minutesBack = Math.ceil((Date.now() - since) / 60000) + 2;
    const search = (keys) => {
      const which = [...(j.projects || []).map((p) => `(project = ${p.key}${p.jql ? ` AND ${p.jql}` : ""})`), ...(keys.length ? [`key in (${keys.join(",")})`] : [])].join(" OR ");
      return which ? api.jiraSearch(cfg, env, { jql: `(${which}) AND updated >= "-${minutesBack}m" ORDER BY updated ASC`, maxResults: 100, fields: ["summary", "created", "comment", "reporter"], expand: "changelog" }) : { issues: [] };
    };
    const events = [];
    let found;
    try { found = await search(follows); } catch (e) {
      // one followed key Jira does not know (deleted, or never visible to you) fails the whole search:
      // each followed key is looked up, the unknown ones are unfollowed and said once, the search runs again
      if (e.status !== 400 || !follows.length) throw e;
      const gone = [];
      for (const k of follows) { try { await api.fetchJson(`${j.base}/issue/${k}?fields=summary`, { headers: H }, 20); } catch (x) { if (x.status !== 404) throw e; gone.push(k); } }
      if (!gone.length) throw e;
      unfollow(api.paths.follows, gone);
      for (const k of gone) events.push({ scope: api.scopeOf(cfg, { project: k.split("-")[0], key: k }), text: `TICKET UNFOLLOWED ${k}: Jira does not know it (deleted, or not visible to you)` });
      follows = follows.filter((k) => !gone.includes(k));
      found = await search(follows);
    }
    const { issues = [] } = found;
    for (const i of issues) {
      const project = i.key.split("-")[0], q = follows.includes(i.key) ? {} : proj[project] || {};
      const push = (text) => events.push({ scope: api.scopeOf(cfg, { project, key: i.key }), text });
      if (new Date(i.fields.created) >= since && !ignore.has(i.fields.reporter?.displayName)) push(`TICKET NEW ${i.key} ${api.oneLine(i.fields.summary, 90)}`);
      let d = i;
      const cl = i.changelog || {}, cm = i.fields.comment || {};
      if (!cl.histories || cl.total > cl.histories.length || cm.total > (cm.comments || []).length) d = await api.fetchJson(`${j.base}/issue/${i.key}?fields=comment&expand=changelog`, { headers: H });
      for (const h of d.changelog?.histories || []) {
        const who = h.author?.displayName || "-";
        if (new Date(h.created) < since || ignore.has(who)) continue;
        for (const it of h.items || []) if (it.field === "status" && !q.quietTo?.has(String(it.toString).toLowerCase())) push(`TICKET MOVED ${i.key} ${it.fromString} -> ${it.toString} by ${who}`);
      }
      for (const c of d.fields?.comment?.comments || []) {
        const who = c.author?.displayName || "-", text = api.oneLine(adf(c.body), 400);
        if (new Date(c.created) < since || ignore.has(who) || q.quietComment?.test(text)) continue;
        push(`TICKET COMMENT ${i.key} by ${who}: ${text.slice(0, 80)}`);
      }
    }
    return { events, state: { since: now, following: follows.length } };
  },
  now: (d) => `checked up to ${d.since}${d.following ? `, following ${d.following}` : ""}`,
});
module.exports.KEY = KEY;   // for `watchhub jira follow`
