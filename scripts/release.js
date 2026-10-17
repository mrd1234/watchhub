#!/usr/bin/env node
// npm run release -- [patch|minor|major] --gh-user <login> | --email <public noreply address> [--remote public] [--no-push]
// One step from a clean branch to a published release: bump package.json's version, commit that here, and
// replace the public remote's main with ONE commit, "initial", whose tree is this commit's tree. The public
// history holds nothing but the current release, so the private history never leaves and nothing older
// stays visible; a clone updates with `git fetch && git reset --hard origin/main` (README), since a plain
// pull cannot cross the rewrite. The push is forced with a lease on the commit fetched a moment before, so
// a release pushed from another machine in between is never written over unseen.
// --gh-user switches the gh login for the push and back, and takes the public email from that account
// (<id>+<login>@users.noreply.github.com); without it, --email says which noreply address the snapshot
// carries. Its name is package.json's author, never this machine's git config.
// It refuses when the tests fail, when nothing but the version changed since the last release, when the
// version would not be above the one published, and when a file matches the deny list: .git/info/deny-words,
// one regex of the words that must never be published, kept out of the repository (so a clone without it
// cannot release). Ctrl-C stops it at the next step, still putting the gh login and the files back.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const part = args.find((a) => ["patch", "minor", "major"].includes(a)) || "patch";
const ghUser = flag("--gh-user"), push = !args.includes("--no-push");
const root = path.join(__dirname, "..");
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
const run = (a, env) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }).trim();
const git = (a, env) => { if (stopped) throw new Error("stopped"); return run(a, env); };
const gh = (a) => execFileSync("gh", a, { encoding: "utf8" }).trim();
const fail = (m) => { console.error(`release: ${m}`); process.exit(1); };
const above = (a, b) => { const [p, q] = [a, b].map((v) => v.split(".").map(Number)); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] > q[i]; return false; };
// the public remote: --remote, else `public` where a private checkout has one, else `origin` (a clone of the public repo itself)
const remotes = git(["remote"]).split(/\r?\n/).filter(Boolean);
const remote = flag("--remote") || (remotes.includes("public") ? "public" : "origin");
if (!remotes.includes(remote)) fail(`no remote ${remote} (git remote add ${remote} <url>)`);

if (git(["rev-parse", "--abbrev-ref", "HEAD"]) === "HEAD") fail("run it on a branch, not a detached HEAD");
if (git(["status", "--porcelain"])) fail("the working tree has changes; commit or drop them first");
if (!ghUser && !flag("--email")) fail("say who the public commit is from: --gh-user <login> or --email <address>");
if (flag("--email") && !/@users\.noreply\.github\.com$/.test(flag("--email"))) fail("--email takes a GitHub noreply address (<id>+<login>@users.noreply.github.com), so no real address goes public");
// the deny list: one regex read by git grep (Perl's syntax) and by JavaScript, so it has to be one both take
const deny = (() => { try { return fs.readFileSync(path.join(root, git(["rev-parse", "--git-path", "info/deny-words"])), "utf8").split(/\r?\n/)[0].trim(); } catch { return ""; } })();
if (!deny) fail("no deny list at .git/info/deny-words (one regex of the words never to publish)");
const denied = (() => { try { return new RegExp(deny, "i"); } catch { return fail("the deny list is not a regex JavaScript reads; keep to what Perl's and JavaScript's share"); } })();
try { fail(`denied words in ${git(["grep", "-I", "-l", "-i", "-P", "-e", deny, "HEAD", "--", ".", ":(exclude)package-lock.json"]).replaceAll("HEAD:", "").split(/\r?\n/).join(", ")}`); }
catch (e) { if (e.status !== 1) fail(`cannot search the files: ${e.message}`); }
const named = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter((f) => denied.test(f));
if (named.length) fail(`denied words in the names ${named.join(", ")}`);
try { if (git(["show", "HEAD:package-lock.json"]).split("\n").some((l) => !l.includes('"integrity"') && denied.test(l))) fail("denied words in package-lock.json"); } catch (e) { if (!/exists on disk|does not exist|not in/.test(String(e.stderr || e.message))) throw e; }
// the tests, when the repo has any (the release test runs this script in a bare repo without them)
const tests = (() => { try { return fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f)); } catch { return []; } })();
// the timeout is per file here (each file is one test to the runner), and the engine files hold fixed waits of a minute and more
if (tests.length) { try { execFileSync(process.execPath, ["--test", "--test-timeout=180000", ...tests], { cwd: root, stdio: "inherit" }); } catch { fail("the tests fail"); } }

const prev = ghUser ? gh(["api", "user", "-q", ".login"]) : null;
try {
  if (ghUser && prev !== ghUser) gh(["auth", "switch", "--user", ghUser]);
  const email = flag("--email") || `${gh(["api", "user", "-q", ".id"])}+${ghUser}@users.noreply.github.com`;
  const author = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).author;
  const name = typeof author === "string" ? author : author?.name;
  if (!name) throw new Error("package.json has no author to put on the public commit");

  git(["fetch", "-q", remote]);
  const base = (() => { try { return git(["rev-parse", "-q", "--verify", `${remote}/main`]); } catch { return ""; } })();
  const pkgFile = path.join(root, "package.json"), pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  // a release committed here but never published (a failed push, --no-push) is published as it is, not bumped again
  const pending = git(["log", "-1", "--format=%s"]) === `release ${pkg.version}` && (!base || git(["rev-parse", `${base}^{tree}`]) !== git(["rev-parse", "HEAD^{tree}"]));
  if (!pending && base) {
    const bare = (rev) => { try { const j = JSON.parse(git(["show", `${rev}:package.json`])); delete j.version; return JSON.stringify(j); } catch { return null; } };
    let same = bare(base) === bare("HEAD");
    try { git(["diff", "--quiet", base, "HEAD", "--", ".", ":(exclude)package.json"]); } catch { same = false; }
    if (same) throw new Error(`nothing changed since ${remote}/main but the version`);
  }
  const v = pkg.version.split(".").map(Number), at = { major: 0, minor: 1, patch: 2 }[part];
  const next = pending ? pkg.version : v.map((n, i) => (i < at ? n : i === at ? n + 1 : 0)).join(".");
  const published = base ? (() => { try { return JSON.parse(git(["show", `${base}:package.json`])).version; } catch { return null; } })() : null;
  if (published && !above(next, published)) throw new Error(`${next} is not above ${published}, the version on ${remote}/main`);
  if (!pending) {
    try {
      pkg.version = next;
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
      git(["commit", "-q", "-m", `release ${pkg.version}`, "--", "package.json"]);
    } catch (e) { run(["checkout", "--", "package.json"]); throw e; }
  }
  // dated in UTC, so the commit does not carry this machine's time zone; no parent, so the history is this one commit
  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const snap = git(["commit-tree", "HEAD^{tree}", "-m", "initial"], who);
  // the lease: the remote's main must still be the commit fetched above (or still absent), or the push is refused
  if (push) git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "-q", `--force-with-lease=refs/heads/main:${base}`, remote, `${snap}:refs/heads/main`]);
  console.log(`release ${pkg.version}: committed here; snapshot ${snap.slice(0, 7)} ${push ? `pushed to ${remote}/main as its one commit${base ? ` (replacing ${base.slice(0, 7)})` : ""}` : "built, not pushed (--no-push)"}`);
} catch (e) {
  console.error(`release: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (ghUser && prev && prev !== ghUser) {
    try { gh(["auth", "switch", "--user", prev]); }
    catch { console.error(`release: gh may still be logged in as ${ghUser}; gh auth switch --user ${prev} puts it back`); process.exitCode = 1; }
  }
}
