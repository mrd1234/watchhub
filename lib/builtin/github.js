// github: pull requests by the watched authors, as two probes.
//   pr-merges   MERGED <repo>#<n> <sha7> <title>                      one conditional REST call per repo (the 100 most
//               recently updated closed PRs: a merge older than those after a long outage is the one case missed)
//   pr-checks   CHECKS <repo>#<n> <sha7> all green | FAIL: <names>     when the checks on a head settle, and again
//               ... (rerun)                                            when a rerun changes that head's verdict
//               MERGEABLE <repo>#<n> CONFLICTING | ok                  one GraphQL query per repo
//               REVIEW <repo>#<n> approved|changes requested|comment by <who> at HH:MMZ: <text>
// Switched on by an instance.json `github` section (or the older top-level `repos` / `prAuthors`):
//   "github": { "repos": [{"repo": "owner/name", "scopeHint": "team"}], "authors": ["@me"], "ignoreCommentAuthors": [] }
// Token: GITHUB_TOKEN / GH_TOKEN, else `gh auth token`. Every REST call is conditional (ETag), so a
// poll where nothing changed is all 304s and costs nothing against the rate limit.
const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);
const section = (cfg) => cfg.github || (cfg.repos ? { repos: cfg.repos, authors: cfg.prAuthors, ignoreCommentAuthors: cfg.ignoreCommentAuthors } : null);
const enabled = (name) => (cfg) => !!section(cfg)?.repos?.length && cfg.probes?.[name] !== false;
const withAuthors = (cfg) => ({ ...cfg, prAuthors: section(cfg).authors || cfg.prAuthors });

// undefined when no check has reported, null while any is still running, else "all green" / "FAIL: <names>".
function settle(runs, status) {
  if (!runs.length && !status.total) return undefined;
  if (runs.some((r) => r.status !== "completed") || (status.total && status.state === "pending")) return null;
  const fails = [...runs.filter((r) => BAD.has(r.conclusion)).map((r) => r.name), ...status.statuses.filter((s) => BAD.has(s.state)).map((s) => s.context)];
  const names = [...new Set(fails)];
  return names.length ? `FAIL: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4} more` : ""}` : "all green";
}

module.exports = (api) => {
  const keepMerged = (prs) => prs.filter((p) => p.merged_at).map((p) => ({ number: p.number, title: p.title, merged_at: p.merged_at, sha: p.merge_commit_sha, login: p.user?.login, base: p.base?.ref, branch: p.head?.ref }));
  const merges = {
    name: "pr-merges",
    env: ["GITHUB_TOKEN|GH_TOKEN?"],   // optional: `gh auth token` is the fallback
    intervalSec: 30,
    enabled: enabled("pr-merges"),
    async check(st, cfg) {
      const g = section(cfg);
      if (!st) st = { since: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
      const authors = await api.prAuthors(withAuthors(cfg));
      const etags = {}, found = [];
      await Promise.all(g.repos.map(async ({ repo, scopeHint }) => {
        const prs = await api.ghGet(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, st.etags || {}, etags, keepMerged, cfg);
        for (const p of prs) if (authors.has(p.login) && p.merged_at > st.since) found.push({ repo, scopeHint, ...p });
      }));
      found.sort((a, b) => a.merged_at.localeCompare(b.merged_at));
      const events = found.map((p) => ({ scope: api.scopeOf(cfg, { repo: p.repo, base: p.base, branch: p.branch, title: p.title }, p.scopeHint), text: `MERGED ${p.repo.split("/")[1]}#${p.number} ${(p.sha || "").slice(0, 7)} ${api.oneLine(p.title, 100)}` }));
      return { events, state: { since: found.length ? found[found.length - 1].merged_at : st.since, etags } };
    },
    now: (d) => `merges reported up to ${d.since}`,
  };

  const said = (body) => api.oneLine(String(body || "").replace(/<!--[\s\S]*?-->/g, ""), 80);
  const R = {
    pulls: (a) => a.map((p) => ({ number: p.number, sha: p.head.sha, login: p.user?.login, updated: p.updated_at, title: p.title, base: p.base?.ref, branch: p.head?.ref })),
    // one run per name, the newest: a run cancelled by a concurrency group and replaced is not a failure
    runs: (j) => { const seen = new Set(); return [...j.check_runs].sort((x, y) => y.id - x.id).filter((r) => !seen.has(r.name) && seen.add(r.name)).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })); },
    status: (j) => ({ state: j.state, total: j.total_count, statuses: j.statuses.map((s) => ({ context: s.context, state: s.state })) }),
    reviews: (a) => a.map((r) => ({ login: r.user?.login, state: r.state, at: r.submitted_at, body: said(r.body) })),
    comments: (a) => a.map((c) => ({ login: c.user?.login, at: c.created_at, body: said(c.body) })),
  };
  async function mergeability(repo, cfg) {
    const [o, n] = repo.split("/");
    const j = await api.ghGraphql("query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN,first:100){nodes{number mergeable}}}}", { o, n }, cfg);
    return Object.fromEntries(j.repository.pullRequests.nodes.map((x) => [x.number, x.mergeable]));
  }
  const checks = {
    name: "pr-checks",
    env: ["GITHUB_TOKEN|GH_TOKEN?"],
    intervalSec: 60,
    enabled: enabled("pr-checks"),
    async check(st, cfg) {
      const g = section(cfg);
      const me = await api.ghLogin(), authors = await api.prAuthors(withAuthors(cfg));
      const first = !st || !st.prs;
      if (first) st = { base: new Date().toISOString().replace(/\.\d+Z$/, "Z"), prs: {}, etags: {} };
      const ignore = new Set([me, ...authors, ...(g.ignoreCommentAuthors || [])]);
      const events = [], prs = {}, etags = {};
      const get = (p, reduce) => api.ghGet(p, st.etags, etags, reduce, cfg);
      for (const { repo, scopeHint } of g.repos) {
        const short = repo.split("/")[1];
        const mergeable = await mergeability(repo, cfg);
        for (const p of (await get(`repos/${repo}/pulls?state=open&per_page=100`, R.pulls)).filter((x) => authors.has(x.login))) {
          const key = `${short}#${p.number}`;
          const scope = api.scopeOf(cfg, { repo, base: p.base, branch: p.branch, title: p.title }, scopeHint);
          const push = (text) => events.push({ scope, text });
          const pr = prs[key] = { ...(st.prs[key] || { since: st.base }) };
          const m = mergeable[p.number];
          if (m === "CONFLICTING" && pr.conflicting !== true) { pr.conflicting = true; push(`MERGEABLE ${key} CONFLICTING`); }
          else if (m === "MERGEABLE" && pr.conflicting !== false) { if (pr.conflicting) push(`MERGEABLE ${key} ok`); pr.conflicting = false; }
          // the head's checks: reported when they first settle, and again whenever the settled verdict changes
          // (a rerun that turns FAIL into all green, or shrinks the failing set); the calls are conditional, so a
          // head nobody re-ran costs two 304s
          const verdict = settle(await get(`repos/${repo}/commits/${p.sha}/check-runs?per_page=100`, R.runs), await get(`repos/${repo}/commits/${p.sha}/status`, R.status));
          if (pr.head !== p.sha) {
            if (pr.seenHead !== p.sha) { pr.seenHead = p.sha; pr.seenAt = Date.now(); }
            if (verdict) { pr.head = p.sha; pr.verdict = verdict; if (!first) push(`CHECKS ${key} ${p.sha.slice(0, 7)} ${verdict}`); }
            else if (verdict === undefined && Date.now() - pr.seenAt > 15 * 60000) pr.head = p.sha; // no CI on this repo: stop asking
          } else if (verdict && pr.verdict && verdict !== pr.verdict) { pr.verdict = verdict; push(`CHECKS ${key} ${p.sha.slice(0, 7)} ${verdict} (rerun)`); }
          if (first || pr.updated === p.updated) { pr.updated = p.updated; continue; }
          pr.updated = p.updated;
          const fresh = (x) => x.at && x.at > pr.since && !ignore.has(x.login) && !(x.login || "").endsWith("[bot]");
          const reviews = (await get(`repos/${repo}/pulls/${p.number}/reviews?per_page=100`, R.reviews)).filter(fresh);
          const comments = (await get(`repos/${repo}/issues/${p.number}/comments?since=${pr.since}&per_page=100`, R.comments)).filter(fresh);
          for (const r of reviews) {
            if (r.state === "PENDING" || r.state === "DISMISSED" || (r.state === "COMMENTED" && !r.body)) continue;
            push(`REVIEW ${key} ${r.state.toLowerCase().replace(/_/g, " ")} by ${r.login} at ${String(r.at).slice(11, 16)}Z${r.body ? ": " + r.body : ""}`);  // the time tells two approvals apart
          }
          for (const c of comments) if (c.body) push(`REVIEW ${key} comment by ${c.login}: ${c.body}`);
          for (const x of [...reviews, ...comments]) if (x.at > pr.since) pr.since = x.at;
        }
      }
      return { events, state: { base: st.base, prs, etags } };
    },
    now: (d) => `${Object.keys(d.prs || {}).length} open PR heads tracked since ${d.base}`,
  };
  return [merges, checks];
};
module.exports.section = section;
