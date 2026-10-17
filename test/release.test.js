const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const fails = (fn, re) => assert.throws(fn, (e) => { assert.match(String(e.stderr), re); return true; });

// a private repo with one commit, a bare public remote, and the deny list the script insists on
function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-release-"));
  const repo = path.join(dir, "repo"), pub = path.join(dir, "public.git");
  run(dir, "git", ["init", "-q", "--bare", "-b", "main", pub]);
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "release.js"), path.join(repo, "scripts", "release.js"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", version: "1.4.0", author: "Mark" }, null, 2) + "\n");
  run(repo, "git", ["init", "-q", "-b", "main"]);
  run(repo, "git", ["config", "user.name", "Mark Fullname"]);
  run(repo, "git", ["config", "user.email", "private@example.com"]);
  run(repo, "git", ["remote", "add", "public", pub]);
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-q", "-m", "private work with a ticket name"]);
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "info", "deny-words"), "\\b(acme|secretproject)\\b\n");
  const rel = (...a) => run(repo, process.execPath, ["scripts/release.js", ...a]);
  return { repo, pub, rel };
}

test("release: bumps the version, commits it here, and replaces the public main with one commit carrying the released tree", () => {
  const { repo, pub, rel } = setUp();
  const email = "123+mrd@users.noreply.github.com";
  assert.match(rel("--email", email, "--no-push"), /release 1\.4\.1: .*not pushed/);
  assert.match(rel("--email", email), /release 1\.4\.1: .*pushed to public\/main as its one commit$/, "an unpublished release is published as it is, not bumped again");
  assert.deepEqual(run(pub, "git", ["log", "--format=%s|%an|%ae", "main"]).split("\n"), ["initial|Mark|" + email], "one commit, from the package author and the public address, never the machine's git config");
  const first = run(pub, "git", ["rev-parse", "main"]);
  fs.writeFileSync(path.join(repo, "more.txt"), "x");
  run(repo, "git", ["add", "more.txt"]);
  run(repo, "git", ["commit", "-q", "-m", "more private work"]);
  assert.match(rel("minor", "--email", email), new RegExp(`release 1\\.5\\.0: .*pushed to public/main as its one commit \\(replacing ${first.slice(0, 7)}\\)`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version, "1.5.0");
  assert.deepEqual(run(pub, "git", ["log", "--format=%s", "main"]).split("\n"), ["initial"], "still one commit: the history is replaced, not extended");
  assert.equal(run(pub, "git", ["rev-parse", "main^{tree}"]), run(repo, "git", ["rev-parse", "HEAD^{tree}"]), "the snapshot is the released tree");
  assert.equal(run(pub, "git", ["rev-list", "--count", "main"]), "1");
  assert.match(run(repo, "git", ["log", "-1", "--format=%s", "main"]), /^release 1\.5\.0$/);
  // the gates
  fails(() => rel("--email", email), /nothing changed since public\/main but the version/);
  fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
  fails(() => rel("--email", email), /working tree has changes/);
  run(repo, "git", ["add", "dirty.txt"]); run(repo, "git", ["commit", "-q", "-m", "dirty"]);
  fails(() => rel("--email", "me@example.com"), /noreply address/);
  fails(() => rel(), /--gh-user <login> or --email/);
});

test("release: refuses a denied word in a file, a file name or the lock file, and a missing deny list", () => {
  const { repo, rel } = setUp();
  const email = "123+mrd@users.noreply.github.com";
  fs.writeFileSync(path.join(repo, "notes.md"), "the Acme deploy\n");
  run(repo, "git", ["add", "-A"]); run(repo, "git", ["commit", "-q", "-m", "notes"]);
  fails(() => rel("--email", email), /denied words in notes\.md/);
  run(repo, "git", ["rm", "-q", "notes.md"]); run(repo, "git", ["commit", "-q", "-m", "rm"]);
  fs.writeFileSync(path.join(repo, "secretproject.txt"), "clean\n");
  run(repo, "git", ["add", "-A"]); run(repo, "git", ["commit", "-q", "-m", "name"]);
  fails(() => rel("--email", email), /denied words in the names secretproject\.txt/);
  run(repo, "git", ["rm", "-q", "secretproject.txt"]); run(repo, "git", ["commit", "-q", "-m", "rm"]);
  // the lock file is checked line by line, its integrity hashes left out (they can match by chance)
  fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ name: "x", packages: { "node_modules/a": { resolved: "https://npm.acme.internal/a.tgz", integrity: "sha512-acme" } } }, null, 2));
  run(repo, "git", ["add", "-A"]); run(repo, "git", ["commit", "-q", "-m", "lock"]);
  fails(() => rel("--email", email), /denied words in package-lock\.json/);
  fs.rmSync(path.join(repo, ".git", "info", "deny-words"));
  fails(() => rel("--email", email), /no deny list at \.git\/info\/deny-words/);
});
