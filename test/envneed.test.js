const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const envneed = require("../lib/envneed");
const sources = require("../lib/sources");
const api = require("../lib/api");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, env, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("env declarations: alternatives, optional, computed; missing and report", () => {
  assert.deepEqual(envneed.missing(["A|B", "C?", "D"], {}, { B: "x" }), ["D"]);
  assert.deepEqual(envneed.missing((cfg) => [cfg.tokenEnv], { tokenEnv: "T" }, {}), ["T"]);
  assert.deepEqual(envneed.missing(undefined, {}, {}), []);
  const r = envneed.report(["GITHUB_TOKEN|GH_TOKEN?", "JIRA_API_TOKEN"], {}, { GH_TOKEN: "g" });
  assert.deepEqual(r.map((x) => [x.set, x.optional]), [["GH_TOKEN", true], [null, false]]);
  // the shipped modules declare theirs
  const by = (n) => sources.builtins(() => {}).find((p) => p.name === n);
  assert.deepEqual(envneed.missing(by("board").env, { jira: { tokenEnv: "MY_JIRA" } }, {}), ["MY_JIRA"]);
  assert.deepEqual(envneed.missing(by("datadog").env, {}, { DD_PAT: "p" }), []);
  assert.deepEqual(envneed.missing(by("datadog").env, {}, { DD_API_KEY: "k" }), []);   // DD_APP_KEY is optional in the declaration; the module itself says when it is needed
  assert.deepEqual(envneed.missing(by("pr-merges").env, {}, {}), []);                  // gh auth token is the fallback
  // a JSON watch carries its kind's needs plus every ${VAR} it references
  const w = sources.toProbe(sources.validate({ name: "s", slack: { channel: "#x", tokenEnv: "SLK" }, sinks: [] }));
  assert.deepEqual(envneed.missing(w.env, {}, {}), ["SLK"]);
  const h = sources.toProbe(sources.validate({ name: "h", http: { url: "https://x/${EPOCH-60}", headers: { Authorization: "Bearer ${API_TOKEN}" } }, value: "a" }));
  assert.deepEqual(envneed.missing(h.env, {}, {}), ["API_TOKEN"]);
});

test("a probe whose variable is missing is off with one line; doctor names it; it runs once the variable is set", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-env-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, jira: { base: "https://x.atlassian.net/rest/api/3", email: "me@x", me: "Me", projects: [{ key: "ABC" }] } }));
  const env = { JIRA_API_TOKEN: "" };
  let d; try { d = cli(dir, env, "doctor"); } catch (e) { d = e.stdout; }   // doctor exits 1 on a FAIL line, by design
  assert.match(d, /FAIL {2}env JIRA_API_TOKEN: not set; board is off until it is/);
  cli(dir, env, "start");
  t.after(() => { try { cli(dir, env, "stop"); } catch {} });
  await sleep(2500);
  const log = fs.readFileSync(path.join(dir, "engine.log"), "utf8");
  assert.equal((log.match(/board off: JIRA_API_TOKEN not set/g) || []).length, 1);
  assert.doesNotMatch(log, /board failed/);
  assert.doesNotMatch(cli(dir, env, "events"), /probe board failing/);
});

test("vpn sides: a tcp host, an http url and a command, each its own check", async (t) => {
  const srv = http.createServer((req, res) => { res.statusCode = req.url === "/ok" ? 200 : 503; res.end(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const vpn = sources.builtins(() => {}).find((p) => p.name === "vpn");
  const cfg = { vpn: { office: { tcp: `127.0.0.1:${port}` }, cloud: { http: `http://127.0.0.1:${port}/ok` }, lab: { http: `http://127.0.0.1:${port}/down` }, bench: { command: "exit 0" }, far: { command: "exit 3" } } };
  let r = await vpn.check({}, cfg, {}, api);
  assert.equal(r.state.seen, "office+cloud+bench");
  r = await vpn.check(r.state, cfg, {}, api);
  assert.deepEqual(r.events, ["VPN office+cloud+bench"]);
});
