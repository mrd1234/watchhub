// The system, jenkins, sonar and deploys modules, and following tickets on the board.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sources = require("../lib/sources");
const api = require("../lib/api");

const by = (name) => sources.builtins(() => {}).find((p) => p.name === name);
const serve = (handler) => new Promise((resolve) => { const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(req, res, b)); }); srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })); });
const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const texts = (r) => r.events.map((e) => (typeof e === "string" ? e : e.text));

test("finished: a first poll records, later polls report runs that ended since", () => {
  let r = api.finished(undefined, [{ id: 3, done: false }, { id: 2, done: true }]);
  assert.deepEqual(r, { done: [], seen: ["2"] });
  r = api.finished(r.seen, [{ id: 4, done: true }, { id: 3, done: true }, { id: 2, done: true }]);
  assert.deepEqual(r.done.map((x) => x.id), [4, 3]);
  assert.deepEqual(api.finished(r.seen, [{ id: 4, done: true }]).done, []);
});

test("system module: disk, memory and cpu against their bounds, each a metric", async () => {
  const sys = by("system"), tmp = os.tmpdir();
  assert.equal(sys.enabled({}), false);
  const cfg = { system: { scope: "host", disks: { [tmp]: { below: 1e9 }, "/no/such/drive": { below: 5 } }, memory: { above: 101 }, cpu: { above: -1 } } };
  let s = await sys.check(undefined, cfg, {});
  const disk = s.metrics[0].name;
  assert.match(disk, /^disk-[a-z0-9-]+$/); assert.ok(disk.length <= 64);
  assert.deepEqual(s.events.map((e) => e.scope), ["host"]);
  assert.match(s.events[0].text, new RegExp(`^SYSTEM ${disk} below 1000000000: [\\d.]+$`));   // a tmp folder always has less than a billion GB free
  assert.deepEqual(s.metrics.map((m) => [m.name, m.value === null, m.unit]), [[disk, false, "GB"], ["disk-no-such-drive", true, "GB"], ["memory", false, "%"], ["cpu", true, "%"]]);   // cpu needs two polls
  assert.ok(s.metrics[1].description.startsWith("Free space left on /no/such/drive, in gigabytes"));
  assert.ok(s.metrics.every((m) => m.description.length > 20), "every system metric explains itself");
  for (const end = Date.now() + 200; Date.now() < end;);   // CPU time between the polls, past the counters' tick (coarse on Windows)
  s = await sys.check(s.state, cfg, {});
  assert.deepEqual(texts(s).map((t) => t.replace(/[\d.]+$/, "N")), ["SYSTEM cpu above -1: N"]);
  assert.ok(s.metrics.find((m) => m.name === "cpu").past);
  assert.match(sys.now(s.state), /disk-no-such-drive \?, memory \d+, cpu \d+ PAST/);
  await assert.rejects(sys.check(undefined, { system: { memory: {} } }, {}), /system memory needs above or below/);
});

test("jenkins module: finished builds since the last poll, oldest first, with basic auth", async (t) => {
  let builds = [{ number: 12, building: true, result: null }, { number: 11, building: false, result: "SUCCESS" }], seen = {};
  const f = await serve((req, res) => { seen = { url: req.url, auth: req.headers.authorization }; json(res, { builds }); });
  t.after(() => f.close());
  const jk = by("jenkins");
  const cfg = { jenkins: { base: f.url + "/", jobs: ["folder/app"], scope: "ci" } }, env = { JENKINS_USER: "u", JENKINS_TOKEN: "t" };
  assert.deepEqual(jk.env(cfg), ["JENKINS_USER?", "JENKINS_TOKEN?"]);
  let s = await jk.check(undefined, cfg, env);
  assert.deepEqual(s.events, []);
  assert.equal(seen.url, "/job/folder/job/app/api/json?tree=builds[number,result,building]{0,10}");
  assert.equal(seen.auth, "Basic " + Buffer.from("u:t").toString("base64"));
  builds = [{ number: 13, building: true, result: null }, { number: 12, building: false, result: "FAILURE" }, builds[1]];
  s = await jk.check(s.state, cfg, env);
  assert.deepEqual(s.events, [{ scope: "ci", text: "BUILD folder/app #12 FAILURE" }]);   // 12 was running on the first poll
  builds = [{ number: 14, building: false, result: "SUCCESS" }, { number: 13, building: false, result: "UNSTABLE" }, builds[1], builds[2]];
  s = await jk.check(s.state, cfg, env);
  assert.deepEqual(texts(s), ["BUILD folder/app #13 UNSTABLE", "BUILD folder/app #14 SUCCESS"]);
  s = await jk.check(s.state, cfg, {});
  assert.deepEqual(s.events, []); assert.equal(seen.auth, undefined);   // no token: an open server is read without auth
  assert.equal(jk.now(s.state), "folder/app #14 SUCCESS");
});

test("sonar module: branch gate changes, a pull request's first verdict and its changes", async (t) => {
  let main = "OK", prs = [{ key: "7", title: "add login", status: { qualityGateStatus: "OK" } }], auth;
  const f = await serve((req, res) => {
    auth = req.headers.authorization;
    if (req.url === "/api/project_branches/list?project=acme_api") return json(res, { branches: [{ name: "main", isMain: true, status: { qualityGateStatus: main } }, { name: "old", isMain: false, status: { qualityGateStatus: "ERROR" } }] });
    if (req.url === "/api/project_pull_requests/list?project=acme_api") return json(res, { pullRequests: prs });
    res.statusCode = 404; res.end("{}");
  });
  t.after(() => f.close());
  const sq = by("sonar");
  const cfg = { sonar: { base: f.url, scope: "quality", projects: [{ key: "acme_api", pullRequests: true }] } }, env = { SONAR_TOKEN: "s" };
  let s = await sq.check(undefined, cfg, env);
  assert.deepEqual(s.events, []); assert.equal(auth, "Bearer s");
  main = "ERROR"; prs = [...prs, { key: "8", branch: "fix-x" }];   // 8: an analysis not done yet
  s = await sq.check(s.state, cfg, env);
  assert.deepEqual(s.events, [{ scope: "quality", text: "SONAR acme_api@main gate OK -> ERROR" }]);
  prs = [{ key: "7", title: "add login", status: { qualityGateStatus: "ERROR" } }, { key: "8", branch: "fix-x", status: { qualityGateStatus: "OK" } }, { key: "9", title: "new", status: { qualityGateStatus: "ERROR" } }];
  s = await sq.check(s.state, cfg, env);
  assert.deepEqual(texts(s), ["SONAR acme_api#7 gate OK -> ERROR: add login", "SONAR acme_api#8 gate OK: fix-x", "SONAR acme_api#9 gate ERROR: new"]);
  s = await sq.check(s.state, cfg, env);
  assert.deepEqual(s.events, []);
  assert.match(sq.now(s.state), /^acme_api@main ERROR, acme_api#7 ERROR/);
  s = await sq.check({ projects: [], gates: { "acme_api@main": "OK" } }, cfg, env);   // a project added to the config since: its first poll only records
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.state.projects, ["acme_api", "acme_api#"]);
});

test("deploys module: finished pipeline executions and amplify jobs through the aws CLI", async () => {
  let pipe = [{ pipelineExecutionId: "aaaaaaaa-1111", status: "InProgress" }, { pipelineExecutionId: "bbbbbbbb-2222", status: "Succeeded" }];
  let jobs = [{ jobId: "41", status: "SUCCEED" }];
  const calls = [];
  const dep = require("../lib/builtin/deploys")({ ...api, runJson: async (cmd, args) => { calls.push(args); return args[0] === "codepipeline" ? { pipelineExecutionSummaries: pipe } : { jobSummaries: jobs }; } });
  const cfg = { deploys: { profile: "p", region: "r", scope: "release", pipelines: ["api-pipeline"], amplify: [{ app: "d1", branch: "main", name: "web", region: "r2" }] } };
  assert.equal(dep.enabled({ deploys: {} }), false);
  let s = await dep.check(undefined, cfg);
  assert.deepEqual(s.events, []);
  assert.deepEqual(calls[1].slice(-6), ["--profile", "p", "--region", "r2", "--output", "json"]);   // an entry's own region wins
  pipe = [{ pipelineExecutionId: "cccccccc-3333", status: "Failed" }, { pipelineExecutionId: "aaaaaaaa-1111", status: "Succeeded" }, pipe[1]];
  jobs = [{ jobId: "42", status: "RUNNING" }, ...jobs];
  s = await dep.check(s.state, cfg);
  assert.deepEqual(s.events, [{ scope: "release", text: "DEPLOY api-pipeline aaaaaaaa SUCCEEDED" }, { scope: "release", text: "DEPLOY api-pipeline cccccccc FAILED" }]);
  jobs = [{ jobId: "42", status: "SUCCEED" }, jobs[1]];
  s = await dep.check(s.state, cfg);
  assert.deepEqual(texts(s), ["DEPLOY web job 42 SUCCEEDED"]);
  assert.equal(dep.now(s.state), "api-pipeline cccccccc FAILED, d1/main job 42 SUCCEEDED");
  await assert.rejects(dep.check(undefined, { deploys: { pipelines: ["x"] } }), /deploys entry x needs a profile and a region/);
});

test("aws-auth login: an expired profile is signed in again quietly, a timed-out sign-in is reported once, retries wait", async () => {
  let session = "ok", login = "works";
  const calls = [];
  const run = async (cmd, args, timeout) => {
    calls.push(args.slice(0, 2).join(" ") + (args[0] === "sso" ? ` ${args[3]} ${timeout}` : ""));
    if (args[0] === "sso") { if (login === "timeout") throw new Error("aws timed out"); session = "ok"; return ""; }
    if (session !== "ok") throw new Error("Token has expired and refresh failed");
    return "{}";
  };
  const logins = () => calls.filter((c) => c.startsWith("sso login"));
  const aws = require("../lib/builtin/aws")({ ...api, run });
  const cfg = { aws: { login: true, loginTimeoutSec: 90, profiles: [{ profile: "a", region: "r" }, { profile: "b", region: "r" }] } };
  let s = await aws.check(undefined, cfg);
  assert.deepEqual(s.events, ["AWS a ok", "AWS b ok"]);
  session = "expired";
  calls.length = 0;
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, [], "a renewal that works makes no line");
  assert.deepEqual(logins(), ["sso login a 90"], "one sign-in renews both profiles' shared session, with loginTimeoutSec");
  assert.equal(aws.now(s.state), "a ok, b ok");
  session = "expired"; login = "timeout";
  calls.length = 0;
  s = await aws.check(s.state, cfg);
  assert.equal(logins().length, 1, "after a sign-in times out the others wait: one browser tab, not one per profile");
  assert.deepEqual(s.events, ["AWS a expired (sign-in failed: aws timed out)", "AWS b expired (sign-in not tried: the sign-in for a was not finished)"]);
  calls.length = 0;
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, []);
  assert.deepEqual(logins(), [], "a failed sign-in is not retried before loginEverySec");
  assert.equal(s.state._why.a, "sign-in failed: aws timed out", "the reason carries over while it waits");
  s.state._login = { ...s.state._login, b: Date.now() - 1801000 };   // a still waits, so b gets the turn and its own attempt fails
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, ["AWS b expired (sign-in failed: aws timed out)"], "a profile last shown as not tried says when its own attempt fails");
  s.state._login = { a: Date.now() - 1801000, b: Date.now() - 1801000 };
  login = "works";
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, ["AWS a ok", "AWS b ok"]);
  assert.deepEqual([s.state._login, s.state._why], [{}, {}]);
  session = "expired";
  calls.length = 0;
  s = await aws.check(s.state, { aws: { profiles: cfg.aws.profiles } });
  assert.deepEqual(s.events, ["AWS a expired", "AWS b expired"], "without login nothing signs in");
  assert.deepEqual(logins(), []);
});

test("aws-auth login: first run, per-profile login, one profile's failure, a sign-in that does not take, self-recovery", async () => {
  const expired = new Set(["a", "b", "c", "d"]), calls = [];
  let fixes = { a: ["a", "c"], b: [], d: ["d"] }, network = false, slowLogin = () => {};
  const run = async (cmd, args) => {
    const p = args[args.indexOf("--profile") + 1];
    if (args[0] === "sso") {
      calls.push(p); slowLogin();
      if (p === "d") throw new Error("Error when retrieving token from sso: no access to d");
      for (const q of fixes[p]) expired.delete(q);
      return "";
    }
    if (network && calls.length) throw new Error("Could not connect to the endpoint URL");
    if (expired.has(p)) throw new Error("Token has expired and refresh failed");
    return "{}";
  };
  const aws = require("../lib/builtin/aws")({ ...api, run });
  // c is off for sign-in but shares a's session; d fails on its own; b signs in but stays expired
  const cfg = { aws: { login: true, profiles: [{ profile: "d", region: "r" }, { profile: "a", region: "r" }, { profile: "b", region: "r" }, { profile: "c", region: "r", login: false }] } };
  let s = await aws.check(undefined, cfg);
  assert.deepEqual(calls, ["d", "a", "b"], "d's failure is its own: the others are still tried");
  assert.deepEqual(s.events, ["AWS d expired (sign-in failed: Error when retrieving token from sso: no access to d)", "AWS a ok", "AWS b expired (sign-in failed: signed in, but the profile still reads expired)", "AWS c ok"]);
  assert.deepEqual(Object.keys(s.state._login).sort(), ["b", "d"]);
  expired.delete("b");   // b's session renewed some other way
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, ["AWS b ok"]);
  assert.deepEqual([Object.keys(s.state._login), Object.keys(s.state._why)], [["d"], ["d"]], "a profile that reads ok again loses its stamp");
  expired.add("a"); expired.add("c"); network = true; calls.length = 0;
  s = await aws.check({ ...s.state, _login: {} }, cfg);
  assert.deepEqual(calls, ["d", "a"], "a network fault after a sign-in does not fail the poll");
  assert.deepEqual([s.events, Object.keys(s.state._login).sort()], [["AWS a expired", "AWS c expired"], ["a", "d"]], "and its stamps are kept");
  network = false;
  s = await aws.check(s.state, cfg);
  assert.deepEqual(s.events, ["AWS a ok", "AWS c ok"], "the next poll reads the renewed session");
  expired.add("a"); expired.add("b"); calls.length = 0;
  const slow = { aws: { ...cfg.aws, loginTimeoutSec: 250 } };   // two of these do not fit the 400 s a poll may spend signing in
  const realNow = Date.now;
  let spent = 0;
  Date.now = () => realNow() + spent;
  slowLogin = () => (spent += 250000);   // each sign-in runs to its timeout
  try { s = await aws.check({ ...s.state, _login: {} }, slow); } finally { Date.now = realNow; slowLogin = () => {}; }
  assert.deepEqual(calls, ["d"], "after the first sign-in, one that cannot finish in the time left waits for the next poll");
  assert.equal(s.state._why.a, "sign-in not tried: no time left this poll");
  assert.deepEqual(Object.keys(s.state._login), ["d"], "unstamped, so the next poll tries it");
});

test("jira follow: the CLI keeps follows with a ttl, and the board searches them without quiet filters", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-follow-"));
  fs.writeFileSync(path.join(dir, "instance.json"), "{}");
  const cli = (...a) => execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "watchhub.js"), ...a, "--instance", dir], { encoding: "utf8", windowsHide: true }).trim();
  assert.match(cli("jira", "follows"), /not following any tickets/);
  assert.match(cli("jira", "follow", "xyz-9"), /^following XYZ-9 until 20\d\d-/);
  assert.match(cli("jira", "follow", "ABC-1", "--ttl", "2h"), /^following ABC-1/);
  assert.match(cli("jira", "follow", "ABC-1"), /^still following ABC-1/);
  assert.throws(() => cli("jira", "follow", "not a key"), /usage: watchhub jira follow/);
  assert.throws(() => cli("jira", "follow", "ABC-2", "--ttl"), /--ttl needs a duration/);
  const file = path.join(dir, "jira-follow.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  list.push({ key: "OLD-1", until: "2020-01-01T00:00:00Z" }, { key: "HAND-1" });   // a hand-written entry with no ttl
  fs.writeFileSync(file, JSON.stringify(list));
  const shown = cli("jira", "follows").split("\n");
  assert.deepEqual(shown.map((l) => l.split(" ")[0]), ["XYZ-9", "ABC-1", "HAND-1"]);   // the expired one drops
  assert.equal(shown[2], "HAND-1");
  cli("jira", "unfollow", "HAND-1");
  assert.match(cli("jira", "unfollow", "xyz-9"), /^unfollowed XYZ-9/);
  assert.match(cli("jira", "unfollow", "XYZ-9"), /^not following XYZ-9/);

  let issues = [], jql = "";
  const f = await serve((req, res, body) => { if (req.url.startsWith("/search/jql")) { jql = JSON.parse(body).jql; return json(res, { issues }); } json(res, {}); });
  t.after(() => f.close());
  const saved = api.paths; api.paths = { follows: file }; t.after(() => { api.paths = saved; });
  const board = by("board");
  assert.equal(board.enabled({ jira: { base: f.url } }), true);   // follows alone switch the board on
  const cfg = { jira: { base: f.url, email: "me@x", me: "Me", projects: [{ key: "ABC", jql: "assignee = currentUser()", quietMovesTo: ["Closed"] }] } };
  let s = await board.check(undefined, cfg, { JIRA_API_TOKEN: "t" });
  const later = new Date(Date.now() + 1000).toISOString();
  issues = [{ key: "ABC-1", fields: { summary: "x", created: "2020-01-01T00:00:00Z", comment: { total: 0, comments: [] } }, changelog: { total: 1, histories: [{ author: { displayName: "Dev" }, created: later, items: [{ field: "status", fromString: "QA", toString: "Closed" }] }] } }];
  s = await board.check(s.state, cfg, { JIRA_API_TOKEN: "t" });
  assert.match(jql, /^\(\(project = ABC AND assignee = currentUser\(\)\) OR key in \(ABC-1\)\) AND updated >= /);
  assert.deepEqual(texts(s), ["TICKET MOVED ABC-1 QA -> Closed by Dev"]);   // a quiet move, reported because the ticket is followed
  assert.equal(board.now(s.state).replace(/up to [^,]+/, "up to T"), "checked up to T, following 1");
});

test("perEntry: one entry that fails is said once and keeps its state, the rest report; all failing throws", async () => {
  const kept = [];
  const run = (fail) => async () => { if (fail) throw Object.assign(new Error(`HTTP 404\n  gone`), { status: 404 }); };
  let r = await api.perEntry(undefined, [{ key: "a", run: run(false) }, { key: "b", run: run(true), keep: () => kept.push("b") }]);
  assert.deepEqual(r, { failing: { b: "HTTP 404 gone" }, notes: [{ key: "b", text: "b failing: HTTP 404 gone" }] });
  assert.deepEqual(kept, ["b"]);
  r = await api.perEntry(r.failing, [{ key: "a", run: run(false) }, { key: "b", run: run(true) }]);
  assert.deepEqual(r.notes, []);                                                     // still failing: not said again
  r = await api.perEntry(r.failing, [{ key: "a", run: run(false) }, { key: "b", run: run(false) }]);
  assert.deepEqual(r, { failing: {}, notes: [{ key: "b", text: "b works again" }] });
  await assert.rejects(api.perEntry({}, [{ key: "a", run: run(true) }, { key: "b", run: run(true) }]), /HTTP 404/);   // the probe itself is failing: the engine says so
  assert.deepEqual(await api.perEntry({}, []), { failing: {}, notes: [] });
});

test("jenkins: a multibranch job named feature%2Fx is addressed as Jenkins does (%252F), and one job that cannot be read does not stop the others", async (t) => {
  const urls = [];
  const f = await serve((req, res) => { urls.push(req.url); if (req.url.includes("gone")) { res.statusCode = 404; return res.end("{}"); } json(res, { builds: [{ number: 1, building: false, result: "SUCCESS" }] }); });
  t.after(() => f.close());
  const jk = by("jenkins"), cfg = { jenkins: { base: f.url, jobs: ["multi/feature%2Fx", "gone"], scope: "ci" } };
  let s = await jk.check(undefined, cfg, {});
  assert.ok(urls[0].startsWith("/job/multi/job/feature%252Fx/api/json"));
  assert.equal(s.events.length, 1); assert.match(texts(s)[0], /^JENKINS gone failing: .*404/);
  assert.deepEqual(Object.keys(s.state.jobs), ["multi/feature%2Fx"]);
  s = await jk.check(s.state, cfg, {});
  assert.deepEqual(s.events, []);                                                    // said once
  await assert.rejects(jk.check(s.state, { jenkins: { base: f.url, jobs: ["gone"] } }, {}), /404/);
});

test("sonar: a pending analysis keeps the last verdict, pull requests switched on later are recorded, one bad project does not stop the rest", async (t) => {
  let main = "OK", prs = [{ key: "7", title: "a", status: { qualityGateStatus: "ERROR" } }];
  const f = await serve((req, res) => {
    if (req.url === "/api/project_branches/list?project=good") return json(res, { branches: [{ name: "main", isMain: true, status: main ? { qualityGateStatus: main } : {} }] });
    if (req.url === "/api/project_pull_requests/list?project=good") return json(res, { pullRequests: prs });
    res.statusCode = 404; res.end("{}");
  });
  t.after(() => f.close());
  const sq = by("sonar");
  let cfg = { sonar: { base: f.url, scope: "q", projects: ["good", "bad"] } };
  let s = await sq.check(undefined, cfg, {});
  assert.equal(s.events.length, 1); assert.match(s.events[0].text, /^SONAR bad failing: /);
  main = null;                                                                       // analysis running: no status for a while
  s = await sq.check(s.state, cfg, {});
  assert.deepEqual(s.events, []); assert.equal(s.state.gates["good@main"], "OK");
  main = "OK";
  s = await sq.check(s.state, cfg, {});
  assert.deepEqual(s.events, [], "the same verdict after a pending spell is not news");
  cfg = { sonar: { ...cfg.sonar, projects: [{ key: "good", pullRequests: true }] } };
  s = await sq.check(s.state, cfg, {});
  assert.deepEqual(s.events, [], "open pull requests are recorded when pullRequests is switched on");
  prs = [{ key: "7", title: "a", status: { qualityGateStatus: "OK" } }, { key: "8", title: "b", status: { qualityGateStatus: "ERROR" } }];
  s = await sq.check(s.state, cfg, {});
  assert.deepEqual(texts(s), ["SONAR good#7 gate ERROR -> OK: a", "SONAR good#8 gate ERROR: b"]);
});

test("sonar: pull requests the token cannot read do not hide the branch gates, and notes carry the project's own scope", async (t) => {
  let main = "OK";
  const f = await serve((req, res) => {
    if (req.url === "/api/project_branches/list?project=web") return json(res, { branches: [{ name: "main", isMain: true, status: { qualityGateStatus: main } }] });
    res.statusCode = 403; res.end("{}");
  });
  t.after(() => f.close());
  const sq = by("sonar"), cfg = { sonar: { base: f.url, scope: "q", projects: [{ key: "web", pullRequests: true, scope: "web" }] } };
  let s = await sq.check(undefined, cfg, {});
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].scope, "web"); assert.match(s.events[0].text, /^SONAR web pull requests failing: .*403/);
  main = "ERROR";
  s = await sq.check(s.state, cfg, {});
  assert.deepEqual(s.events, [{ scope: "web", text: "SONAR web@main gate OK -> ERROR" }]);
});

test("deploys: one pipeline that cannot be read is said once, the others report, and it says when it works again", async () => {
  let broken = true;
  const dep = require("../lib/builtin/deploys")({ ...api, runJson: async (cmd, args) => { if (args.includes("old") && broken) throw new Error("PipelineNotFoundException"); return { pipelineExecutionSummaries: [{ pipelineExecutionId: "aaaaaaaa", status: "Succeeded" }] }; } });
  const cfg = { deploys: { profile: "p", region: "r", scope: "release", pipelines: ["api", "old"] } };
  let s = await dep.check(undefined, cfg);
  assert.deepEqual(s.events, [{ scope: "release", text: "DEPLOY old failing: PipelineNotFoundException" }]);
  s = await dep.check(s.state, cfg);
  assert.deepEqual(s.events, []);
  broken = false;
  s = await dep.check(s.state, cfg);
  assert.deepEqual(texts(s), ["DEPLOY old works again"]);
});

test("jira follow: a key Jira does not know is refused at follow time, and one that disappears later is unfollowed so the search keeps working", async (t) => {
  const known = new Set(["ABC-1", "OTH-5"]);
  let issues = [], jqls = [];
  const f = await serve((req, res, body) => {
    if (req.url.startsWith("/search/jql")) { const jql = JSON.parse(body).jql; jqls.push(jql); const bad = (jql.match(/key in \(([^)]*)\)/)?.[1] || "").split(",").filter((k) => k && !known.has(k)); if (bad.length) { res.statusCode = 400; return res.end(JSON.stringify({ errorMessages: [`An issue with key '${bad[0]}' does not exist`] })); } return json(res, { issues }); }
    const m = /^\/issue\/([A-Z0-9-]+)\?/.exec(req.url);
    if (m) { if (!known.has(m[1])) { res.statusCode = 404; return res.end("{}"); } return json(res, { key: m[1], fields: { summary: "s" } }); }
    json(res, {});
  });
  t.after(() => f.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-follow-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ jira: { base: f.url, email: "me@x", tokenEnv: "WATCHHUB_TEST_JIRA" } }));
  const run = (...a) => new Promise((resolve) => require("child_process").execFile(process.execPath, [path.join(__dirname, "..", "bin", "watchhub.js"), ...a, "--instance", dir], { encoding: "utf8", windowsHide: true, env: { ...process.env, WATCHHUB_TEST_JIRA: "t" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
  let r = await run("jira", "follow", "NOPE-1");
  assert.equal(r.code, 2); assert.match(r.out, /Jira has no ticket NOPE-1 that you can see/);
  r = await run("jira", "follow", "OTH-5");                                           // a ticket from a project the board does not watch
  assert.match(r.out, /^following OTH-5/);
  r = await run("jira", "follow", "ABC-1");
  assert.match(r.out, /^following ABC-1/);
  const file = path.join(dir, "jira-follow.json");
  const saved = api.paths; api.paths = { follows: file }; t.after(() => { api.paths = saved; });
  const board = by("board"), cfg = { jira: { base: f.url, email: "me@x", me: "Me" } }, env = { JIRA_API_TOKEN: "t" };
  let s = await board.check(undefined, cfg, env);
  known.delete("OTH-5");                                                              // deleted since
  s = await board.check(s.state, cfg, env);
  assert.deepEqual(texts(s), ["TICKET UNFOLLOWED OTH-5: Jira does not know it (deleted, or not visible to you)"]);
  assert.match(jqls[jqls.length - 1], /^\(key in \(ABC-1\)\) AND updated/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((x) => x.key), ["ABC-1"]);
  assert.equal(board.now(s.state).replace(/up to [^,]+/, "up to T"), "checked up to T, following 1");
  // an expired follow drops out of the search by itself
  fs.writeFileSync(file, JSON.stringify([{ key: "ABC-1", until: "2020-01-01T00:00:00Z" }]));
  assert.equal(board.enabled(cfg), false);
});
