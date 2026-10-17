// `watchhub watch add` takes the JSON itself or the path of a file holding it. The file form exists for Windows,
// where JSON on the command line goes through watchhub.cmd and loses its backslashes and quotes, so a regex in
// a metric block arrives as `s*(d+)` and reads nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const mk = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-wf-")); fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } })); return dir; };
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

test("watch add reads a file, keeps its regex intact, and says what went wrong with a bad argument", () => {
  const dir = mk();
  const w = { name: "api-budget", github: { endpoint: "rate_limit" }, metric: { description: "GitHub requests left this hour.", value: "\"remaining\":\\s*(\\d+)", display: { type: "line" } } };
  const f = path.join(dir, "api-budget.json");
  fs.writeFileSync(f, JSON.stringify(w));
  assert.match(cli(dir, "watch", "add", f), /^watch api-budget added \(github\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "watches", "api-budget.json"), "utf8"));
  assert.equal(saved.metric.value, "\"remaining\":\\s*(\\d+)");
  assert.ok(saved.created);
  // inline JSON still works, and the kinds of mistake each get a plain reason
  assert.match(cli(dir, "watch", "add", JSON.stringify({ name: "t", timer: { every: "1h" } })), /^watch t added \(timer\)/);
  assert.throws(() => cli(dir, "watch", "add", path.join(dir, "missing.json")), (e) => { assert.match(String(e.stderr), /watch not saved: .*missing\.json is not a file here, and not JSON/); return true; });
  assert.throws(() => cli(dir, "watch", "add", "{\"name\":\"x\",\"metric\":{\"value\":\"(d+\"}"), (e) => { assert.match(String(e.stderr), /watch not saved: .*put it in a file and pass the path/); return true; });
});
