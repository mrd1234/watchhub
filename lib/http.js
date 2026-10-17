// HTTP and process helpers for sources. Everything here runs in-process except `run`, which is
// the one place a child program is started (aws, a command watch, `gh auth token` once).
const { execFile } = require("child_process");
const net = require("net");

function run(cmd, args, timeoutSec = 30, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const why = (stderr || err.message || "").trim().split(/\r?\n/).filter(Boolean).pop() || "exit " + err.code;
        const e = new Error(err.killed ? `${cmd} timed out` : why.slice(0, 160));
        e.stderr = stderr || "";
        return reject(e);
      }
      resolve(stdout);
    });
  });
}
const runJson = async (cmd, args, timeoutSec) => JSON.parse(await run(cmd, args, timeoutSec));

// fetch with a timeout; non-2xx throws an error carrying `status` so the engine can back off on 403/429.
async function fetchRaw(url, opts = {}, timeoutSec = 20) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutSec * 1000) });
  if (!r.ok && r.status !== 304) {
    const e = new Error(`HTTP ${r.status} ${new URL(url).host}`);
    e.status = r.status;
    throw e;
  }
  return r;
}
async function fetchJson(url, opts = {}, timeoutSec = 20) {
  const r = await fetchRaw(url, opts, timeoutSec);
  if (r.status === 304) return undefined;
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`${new URL(url).host} answered ${r.status} but not JSON: ${text.replace(/\s+/g, " ").slice(0, 80)}`); }   // a login page or an HTML error, named as such
}
async function fetchText(url, opts = {}, timeoutSec = 20) {
  const r = await fetchRaw(url, opts, timeoutSec);
  return { status: r.status, body: r.status === 304 ? "" : await r.text(), headers: r.headers };
}

// GitHub token: GITHUB_TOKEN or GH_TOKEN from the environment, else `gh auth token` once per
// process. Never logged, never written to a file.
let ghTokenValue, ghUserValue;
async function ghToken(env = process.env) {
  if (ghTokenValue) return ghTokenValue;
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return (ghTokenValue = env.GITHUB_TOKEN || env.GH_TOKEN);
  ghTokenValue = (await run("gh", ["auth", "token"], 20)).trim();
  if (!ghTokenValue) throw new Error("no GitHub token: set GITHUB_TOKEN or sign in with gh auth login");
  return ghTokenValue;
}
const ghApi = (cfg) => (cfg && cfg.github && cfg.github.api) || process.env.GITHUB_API_URL || "https://api.github.com";
async function ghHeaders(extra = {}) {
  return { Authorization: `Bearer ${await ghToken()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "watchhub", ...extra };
}

// Conditional GET on a REST path. `cache` maps path -> {etag, data} from the last run; `next`
// collects the entries used this run so stale paths drop out of state. A 304 costs nothing against
// the rate limit and returns the cached (reduced) data. Keep `reduce` small: its result is what
// gets cached in state.json.
async function ghGet(apiPath, cache = {}, next = {}, reduce = (x) => x, cfg) {
  const old = cache[apiPath];
  const url = /^https?:/.test(apiPath) ? apiPath : `${ghApi(cfg)}/${apiPath.replace(/^\//, "")}`;
  const r = await fetchRaw(url, { headers: await ghHeaders(old ? { "If-None-Match": old.etag } : {}) }, 30);
  if (r.status === 304 && old) { next[apiPath] = old; return old.data; }
  const data = reduce(await r.json());
  const etag = r.headers.get("etag");
  if (etag) next[apiPath] = { etag, data };
  return data;
}
async function ghGraphql(query, variables = {}, cfg) {
  const r = await fetchRaw(`${ghApi(cfg).replace(/\/api\/v3$/, "/api")}/graphql`, { method: "POST", headers: await ghHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ query, variables }) }, 30);
  const j = await r.json();
  if (j.errors) throw new Error(`graphql: ${j.errors.map((e) => e.message).join("; ").slice(0, 160)}`);
  return j.data;
}
async function ghLogin() {
  if (ghUserValue) return ghUserValue;
  const r = await fetchRaw(`${ghApi()}/user`, { headers: await ghHeaders() }, 20);
  return (ghUserValue = (await r.json()).login);
}

// Jira basic auth from instance config (jira.email) and JIRA_API_TOKEN.
function jiraHeaders(cfg, env = process.env) {
  const j = cfg.jira || {};
  const token = env[j.tokenEnv || "JIRA_API_TOKEN"];
  if (!token) throw new Error(`${j.tokenEnv || "JIRA_API_TOKEN"} not set`);
  return { Accept: "application/json", "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${j.email}:${token}`).toString("base64") };
}
const jiraSearch = (cfg, env, body) => fetchJson(`${cfg.jira.base}/search/jql`, { method: "POST", headers: jiraHeaders(cfg, env), body: JSON.stringify(body) });

// TCP reachability: true when a connect succeeds within timeoutMs.
const tcpReach = (host, port, timeoutMs = 5000) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(timeoutMs, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

module.exports = { run, runJson, fetchRaw, fetchJson, fetchText, ghToken, ghHeaders, ghGet, ghGraphql, ghLogin, jiraHeaders, jiraSearch, tcpReach };
