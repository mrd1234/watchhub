const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");

test("~/.watchhub/env: parsed, loaded for unset keys only, environment wins", () => {
  const userdir = require("../lib/userdir");
  const parsed = userdir.parseEnv('\uFEFF# comment\nA=1\nexport B="two words"\nC=\'x\'\nbad line\n\nD = spaced\n');
  assert.deepEqual(parsed, { A: "1", B: "two words", C: "x", D: "spaced" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-home-"));
  process.env.WATCHHUB_HOME = home;
  fs.writeFileSync(path.join(home, "env"), "LW_T1=file\nLW_T2=file\n");
  const env = { LW_T2: "env" };
  const loaded = userdir.loadEnv(env);
  assert.deepEqual(loaded, ["LW_T1"]);
  assert.equal(env.LW_T1, "file");
  assert.equal(env.LW_T2, "env");
  delete process.env.WATCHHUB_HOME;
});

test("init sets the default instance in ~/.watchhub/config.json and the CLI resolves it from elsewhere", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-home-"));
  const inst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-inst-")), "watch");
  const env = { ...process.env, WATCHHUB_HOME: home };
  delete env.WATCHHUB_INSTANCE;
  execFileSync(process.execPath, [BIN, "init", inst], { env, encoding: "utf8", windowsHide: true });
  assert.ok(fs.existsSync(path.join(home, "env")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).instance, inst);
  // from an unrelated directory, no --instance: the default instance is used
  const out = execFileSync(process.execPath, [BIN, "subs"], { env, cwd: os.tmpdir(), encoding: "utf8", windowsHide: true });
  assert.match(out, /no subscriptions/);
  const home2 = execFileSync(process.execPath, [BIN, "home"], { env, cwd: os.tmpdir(), encoding: "utf8", windowsHide: true });
  assert.match(home2, /env:/);
});
