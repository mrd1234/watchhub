const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("jobs: malformed entries are dropped with one line each, valid ones stay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-jobs-"));
  const api = require("../lib/api");
  api.paths = { jobs: path.join(dir, "jobs.json") };
  fs.writeFileSync(api.paths.jobs, JSON.stringify([
    { kind: "gh-checks", id: "1", label: "old-kind", key: "a" },
    { kind: "gh-run", repo: "o/r", id: "", label: "no-id", key: "b" },
    { kind: "codebuild", id: "p:u", profile: "p", region: "r", label: "fine", key: "c" },
  ]));
  const jobs = require("../lib/builtin/jobs")({ ...api, runJson: async () => { throw new Error("aws not here"); } });
  const r = await jobs.check(undefined, { scopes: [] }, {});
  assert.deepEqual(r.events.map((e) => e.text), ["JOB old-kind dropped: malformed entry (kind gh-checks)", "JOB no-id dropped: malformed entry (kind gh-run)"]);
  const left = JSON.parse(fs.readFileSync(api.paths.jobs, "utf8"));
  assert.deepEqual(left.map((j) => [j.label, j.errors]), [["fine", 1]]);
  assert.deepEqual(r.state.pending, ["fine"]);
});

test("one line per job and state: two entries with one label report once, and a re-queue by label replaces", async () => {
  const sources = require("../lib/sources"), api = require("../lib/api");
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-jobs2-"));
  api.paths = { jobs: path.join(dir, "jobs.json") };
  fs.writeFileSync(api.paths.jobs, JSON.stringify([{ kind: "gh-run", repo: "o/r", id: "1", label: "575-r2", key: "a" }, { kind: "gh-run", repo: "o/r", id: "2", label: "575-r2", key: "b" }]));
  const jobs = sources.builtins(() => {}).find((p) => p.name === "jobs");
  const orig = api.ghGet; api.ghGet = async () => ({ status: "completed", conclusion: "cancelled" });
  try {
    const r = await jobs.check({}, { probes: {} }, {}, api);
    assert.deepEqual(r.events.map((e) => e.text), ["JOB 575-r2 CANCELLED"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(api.paths.jobs, "utf8")), []);           // both entries are done
  } finally { api.ghGet = orig; }
  const { execFileSync } = require("child_process");
  const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
  fs.writeFileSync(path.join(dir, "instance.json"), "{}");
  const cli = (...a) => execFileSync(process.execPath, [BIN, ...a, "--instance", dir], { encoding: "utf8", windowsHide: true });
  assert.match(cli("add-job", JSON.stringify({ kind: "gh-run", repo: "o/r", id: "10", label: "575-r3" })), /queued 575-r3/);
  assert.match(cli("add-job", JSON.stringify({ kind: "gh-run", repo: "o/r", id: "11", label: "575-r3" })), /replaced 575-r3 \(new id 11\)/);
  assert.match(cli("add-job", JSON.stringify({ kind: "gh-run", repo: "o/r", id: "11", label: "575-r3" })), /already queued as 575-r3/);
  const q = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
  assert.equal(q.length, 1); assert.equal(q[0].id, "11");
});
