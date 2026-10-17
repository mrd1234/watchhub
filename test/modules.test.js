const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const sources = require("../lib/sources");
const api = require("../lib/api");

const by = (name) => sources.builtins(() => {}).find((p) => p.name === name);
const serve = (handler) => new Promise((resolve) => { const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(req, res, b)); }); srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })); });
const json = (res, o, headers = {}) => { res.writeHead(200, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(o)); };

test("builtins switch on by their config section; an instance module replaces a builtin of the same name", () => {
  const names = sources.builtins(() => {}).map((p) => p.name).sort();
  assert.deepEqual(names, ["aws-auth", "board", "datadog", "deploys", "jenkins", "jobs", "pr-checks", "pr-merges", "slack", "sonar", "stamps", "system", "vpn"]);
  const on = (cfg) => sources.builtins(() => {}).filter((p) => p.enabled(cfg)).map((p) => p.name).sort();
  assert.deepEqual(on({}), ["jobs"]);
  assert.deepEqual(on({ github: { repos: [{ repo: "a/b" }] }, probes: { "pr-checks": false } }), ["jobs", "pr-merges"]);
  assert.deepEqual(on({ repos: [{ repo: "a/b" }], jira: { projects: [{ key: "X" }] }, aws: { profiles: [{ profile: "p" }] }, vpn: { port: 1, office: "h" }, stamps: { hosts: { d: "h" } }, slack: { read: ["@dms"] } }), ["aws-auth", "board", "jobs", "pr-checks", "pr-merges", "slack", "stamps", "vpn"]);
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-mods-"));
  fs.writeFileSync(path.join(dir, "vpn.js"), "module.exports = { name: 'vpn', intervalSec: 5, check: async () => ({ events: ['mine'], state: {} }) };");
  fs.writeFileSync(path.join(dir, "two.js"), "module.exports = [{ name: 'one', check: async () => ({ events: [], state: {} }) }, { name: 'two', check: async () => ({ events: [], state: {} }) }];");
  const all = sources.allCode(dir, () => {});
  assert.deepEqual(all.map((p) => p.name).sort(), ["aws-auth", "board", "datadog", "deploys", "jenkins", "jobs", "one", "pr-checks", "pr-merges", "slack", "sonar", "stamps", "system", "two", "vpn"]);
  assert.equal(all.find((p) => p.name === "vpn").intervalSec, 5);   // the instance's vpn, not the shipped one
});

test("github module: merges since the mark and checks that settle, against a fake API", async (t) => {
  const prs = { closed: [], open: [] }, runs = {};
  const f = await serve((req, res) => {
    const u = req.url;
    if (u === "/user") return json(res, { login: "mark" });
    if (u === "/graphql") return json(res, { data: { repository: { pullRequests: { nodes: prs.open.map((p) => ({ number: p.number, mergeable: p.mergeable || "MERGEABLE" })) } } } });
    if (/\/pulls\?state=closed/.test(u)) return json(res, prs.closed, { etag: `"c${prs.closed.length}"` });
    if (/\/pulls\?state=open/.test(u)) return json(res, prs.open);
    const m = /\/commits\/(\w+)\/check-runs/.exec(u); if (m) return json(res, { check_runs: runs[m[1]] || [] });
    if (/\/commits\/\w+\/status/.test(u)) return json(res, { state: "success", total_count: 0, statuses: [] });
    if (/\/reviews/.test(u)) return json(res, [{ user: { login: "dev" }, state: "APPROVED", submitted_at: "2099-01-01T10:00:00Z", body: "lgtm" }]);
    if (/\/comments/.test(u)) return json(res, []);
    res.writeHead(404); res.end();
  });
  t.after(() => f.close());
  const cfg = { github: { repos: [{ repo: "org/app" }], authors: ["@me"], api: f.url }, scopes: [{ name: "team", prTitle: "^ABC-" }], defaultScope: "x" };
  const env = { GITHUB_TOKEN: "t" };
  process.env.GITHUB_TOKEN = "t"; process.env.GITHUB_API_URL = f.url;
  const merges = by("pr-merges"), checks = by("pr-checks");
  let m = await merges.check(undefined, cfg, env, api);
  assert.deepEqual(m.events, []); assert.ok(m.state.since);
  prs.closed.push({ number: 7, title: "ABC-1 fix", merged_at: "2099-01-01T00:00:00Z", merge_commit_sha: "abcdef1234", user: { login: "mark" }, base: { ref: "main" }, head: { ref: "f" } });
  prs.closed.push({ number: 8, title: "theirs", merged_at: "2099-01-01T00:00:01Z", merge_commit_sha: "9999999999", user: { login: "someone" }, base: { ref: "main" }, head: { ref: "g" } });
  m = await merges.check(m.state, cfg, env, api);
  assert.deepEqual(m.events, [{ scope: "team", text: "MERGED app#7 abcdef1 ABC-1 fix" }]);
  assert.equal(m.state.since, "2099-01-01T00:00:00Z");
  m = await merges.check(m.state, cfg, env, api);
  assert.deepEqual(m.events, []);                                          // reported once
  // checks: first run is a baseline; a head whose runs complete reports once; a review by someone else once
  prs.open.push({ number: 9, title: "ABC-2 wip", user: { login: "mark" }, head: { sha: "aaaaaaa1111" }, base: { ref: "main" }, updated_at: "2026-10-15T09:00:00Z" });
  runs.aaaaaaa1111 = [{ id: 1, name: "build", status: "in_progress", conclusion: null }];
  let c = await checks.check(undefined, cfg, env, api);
  assert.deepEqual(c.events, []);
  runs.aaaaaaa1111 = [{ id: 2, name: "build", status: "completed", conclusion: "failure" }, { id: 1, name: "build", status: "completed", conclusion: "success" }];
  c = await checks.check(c.state, cfg, env, api);
  assert.deepEqual(c.events.map((e) => e.text), ["CHECKS app#9 aaaaaaa FAIL: build"]);   // the newest run per name counts
  runs.aaaaaaa1111 = [{ id: 3, name: "build", status: "completed", conclusion: "success" }, { id: 2, name: "build", status: "completed", conclusion: "failure" }];   // a rerun of the same head goes green
  c = await checks.check(c.state, cfg, env, api);
  assert.deepEqual(c.events.map((e) => e.text), ["CHECKS app#9 aaaaaaa all green (rerun)"]);
  c = await checks.check(c.state, cfg, env, api);
  assert.deepEqual(c.events, []);                                            // the same verdict again: silent
  prs.open[0].updated_at = "2026-10-15T10:00:01Z";
  c = await checks.check(c.state, cfg, env, api);
  assert.deepEqual(c.events.map((e) => e.text), ["REVIEW app#9 approved by dev at 10:00Z: lgtm"]);
  c = await checks.check(c.state, cfg, env, api);
  assert.deepEqual(c.events, []);
  assert.match(checks.now(c.state), /1 open PR heads tracked/);
  delete process.env.GITHUB_API_URL;
});

test("jira module: new tickets, moves and comments by others, quiet ones filtered", async (t) => {
  let issues = [];
  const f = await serve((req, res) => json(res, req.url.startsWith("/search/jql") ? { issues } : { fields: { comment: { comments: [] } }, changelog: { histories: [] } }));
  t.after(() => f.close());
  const cfg = { jira: { base: f.url, email: "me@x", me: "Me", projects: [{ key: "ABC", quietMovesTo: ["Closed"], quietComment: "works as" }] }, defaultScope: "team" };
  const env = { JIRA_API_TOKEN: "t" };
  const board = by("board");
  let s = await board.check(undefined, cfg, env, api);
  assert.deepEqual(s.events, []);
  const later = new Date(Date.now() + 1000).toISOString();
  issues = [{ key: "ABC-1", fields: { summary: "new thing", created: later, reporter: { displayName: "Dev" }, comment: { total: 2, comments: [
    { author: { displayName: "Dev" }, created: later, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "please look" }] }] } },
    { author: { displayName: "Tester" }, created: later, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "works as expected" }] }] } },
  ] } }, changelog: { total: 2, histories: [
    { author: { displayName: "Dev" }, created: later, items: [{ field: "status", fromString: "Open", toString: "In Progress" }] },
    { author: { displayName: "Dev" }, created: later, items: [{ field: "status", fromString: "In Progress", toString: "Closed" }] },
  ] } }];
  s = await board.check(s.state, cfg, env, api);
  assert.deepEqual(s.events.map((e) => e.text), ["TICKET NEW ABC-1 new thing", "TICKET MOVED ABC-1 Open -> In Progress by Dev", "TICKET COMMENT ABC-1 by Dev: please look"]);
});

test("vpn and stamps modules against local listeners", async (t) => {
  const srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const vpn = by("vpn");
  const cfg = { vpn: { port, office: "127.0.0.1", cloud: "192.0.2.1" } };   // cloud: a TEST-NET address, never reachable
  const orig = api.tcpReach;
  api.tcpReach = (h, p) => (h === "127.0.0.1" ? orig(h, p) : Promise.resolve(false));
  t.after(() => { api.tcpReach = orig; });
  let v = await vpn.check({}, cfg, {}, api);
  assert.deepEqual(v.events, []); assert.equal(v.state.seen, "office");
  v = await vpn.check(v.state, cfg, {}, api);
  assert.deepEqual(v.events, ["VPN office"]); assert.equal(v.state.side, "office");
  assert.equal(vpn.now(v.state), "side office");
  // noneAfterSec: a drop that comes back makes no event; a switch makes one; none that lasts is reported
  const hcfg = { vpn: { ...cfg.vpn, noneAfterSec: 60 } };
  let reach = { "127.0.0.1": false, "192.0.2.1": false };
  api.tcpReach = (h) => Promise.resolve(reach[h]);
  v = await vpn.check(v.state, hcfg, {}, api);
  v = await vpn.check(v.state, hcfg, {}, api);
  assert.deepEqual(v.events, [], "none was reported before it had lasted"); assert.equal(v.state.side, "office");
  assert.match(vpn.now(v.state), /^side office \(polls see none since \d\d:\d\d:\d\dZ\)$/);
  reach = { "127.0.0.1": true, "192.0.2.1": false };
  v = await vpn.check(v.state, hcfg, {}, api);
  assert.deepEqual(v.events, []);
  v = await vpn.check(v.state, hcfg, {}, api);
  assert.deepEqual(v.events, [], "a drop back to the same side made an event"); assert.equal(vpn.now(v.state), "side office");
  reach = { "127.0.0.1": false, "192.0.2.1": false };
  v = await vpn.check(v.state, hcfg, {}, api);
  v = await vpn.check(v.state, hcfg, {}, api);
  reach = { "127.0.0.1": false, "192.0.2.1": true };
  v = await vpn.check(v.state, hcfg, {}, api);
  assert.deepEqual(v.events, []);                                           // one poll: not yet agreed
  v = await vpn.check(v.state, hcfg, {}, api);
  assert.deepEqual(v.events, ["VPN cloud"]); assert.equal(v.state.side, "cloud");   // the switch: one event, the new side
  // without the option, and from saved state written before `since` existed, none goes out on the second poll
  let o = await vpn.check({ side: "cloud", seen: "cloud" }, cfg, {}, api);
  reach = { "127.0.0.1": false, "192.0.2.1": false };
  o = await vpn.check(o.state, cfg, {}, api);
  o = await vpn.check(o.state, cfg, {}, api);
  assert.deepEqual(o.events, ["VPN none"]);
  reach = { "127.0.0.1": false, "192.0.2.1": false };
  v = await vpn.check(v.state, hcfg, {}, api);
  v = await vpn.check({ ...v.state, since: Date.now() - 61000 }, hcfg, {}, api);
  assert.deepEqual(v.events, ["VPN none"]);                                 // none that has lasted is reported
  assert.equal(by("vpn").enabled({ vpn: { port: 1, noneAfterSec: 5 } }), false, "options alone are not a side");
  const { doctor } = require("../lib/doctor"), fs = require("fs"), os = require("os"), path = require("path");
  const ddir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-vpn-"));
  fs.writeFileSync(path.join(ddir, "instance.json"), JSON.stringify({ probes: { jobs: false }, vpn: { port: 1, noneAfterSec: "2m", office: "h" } }));
  const d = await doctor(require("../lib/instance").resolve(ddir), {});
  assert.ok(d.includes("ok    vpn: sides office on port 1"), d.join("\n"));
  assert.ok(d.some((l) => /^FAIL {2}vpn noneAfterSec: "2m" is not a number of seconds/.test(l)), d.join("\n"));
  let version = "aaa1111";
  const f = await serve((req, res) => json(res, { data: { commit: { short: version } } }));
  t.after(() => f.close());
  const stamps = by("stamps");
  const scfg = { stamps: { scope: "team", path: "/api/version", hosts: { staging: f.url, down: "http://127.0.0.1:1" } } };
  let s = await stamps.check(undefined, scfg, {}, api);
  assert.deepEqual(s.events, []); assert.equal(s.state.staging.stamp, "aaa1111");
  version = "bbb2222";
  s = await stamps.check(s.state, scfg, {}, api);
  assert.deepEqual(s.events, []);                                          // one poll: not yet agreed
  s = await stamps.check(s.state, scfg, {}, api);
  assert.deepEqual(s.events, [{ scope: "team", text: "STAMP staging api bbb2222" }]);
  assert.match(stamps.now(s.state), /staging bbb2222/);
});

test("module new writes a working module the engine loads; module list shows shipped and own", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { execFileSync } = require("child_process");
  const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-modnew-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  const cli = (...a) => execFileSync(process.execPath, [BIN, ...a, "--instance", dir], { encoding: "utf8", windowsHide: true });
  assert.match(cli("module", "new", "my-source"), /modules.my-source\.js written: a poll module named my-source/);
  assert.match(cli("module", "new", "feed", "--stream"), /a stream module named feed/);
  assert.throws(() => cli("module", "new", "my-source"), /exists/);
  assert.throws(() => cli("module", "new", "Bad Name"), /lowercase/);
  const loaded = sources.loadCode(path.join(dir, "modules"), (m) => { throw new Error(m); });
  assert.deepEqual(loaded.map((p) => [p.name, !!p.stream]).sort(), [["feed", true], ["my-source", false]]);
  assert.equal(typeof loaded.find((p) => p.name === "my-source").check, "function");
  assert.deepEqual(loaded.find((p) => p.name === "my-source").env, []);
  const list = cli("module", "list");
  assert.match(list, /my-source: modules\/, every 60 s/); assert.match(list, /feed: modules\/, stream/); assert.match(list, /pr-merges: shipped/);
});
