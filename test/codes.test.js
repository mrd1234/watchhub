// Plan codes: a plan with a skill prints codes, the skill holds the text, the engine keeps them in step.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const plans = require("../lib/plans");

const BIN = path.join(__dirname, "..", "bin", "watchhub.js");
const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--instance", dir], { encoding: "utf8", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (t) => `${new Date().toISOString()} | custom:x | custom | ${t}`;

test("codes: explicit or by position, validated; instructions print codes when the plan has a skill", () => {
  const p = plans.check({ name: "p", default: "look", on: [{ match: "^MERGED", do: "deploy", code: "MRG" }, { match: "^DM ", do: "answer", priority: "urgent" }, { match: "noise", quiet: true }] });
  assert.deepEqual(Object.keys(plans.codes(p)), ["MRG", "R2", "R3"]);
  assert.throws(() => plans.check({ name: "p", on: [{ match: "a", do: "b", code: "d" }] }), /rule code d must be/);
  assert.throws(() => plans.check({ name: "p", on: [{ match: "a", do: "b", code: "D" }] }), /not D/);
  assert.throws(() => plans.check({ name: "p", on: [{ match: "a", do: "b", code: "X" }, { match: "c", do: "d", code: "X" }] }), /used twice/);
  assert.match(plans.instructions(p, [line("MERGED a#1"), line("other")]), /\n- deploy\n- look\n/);           // no skill: the text
  p.skill = "watchhub-plan-p";
  assert.equal(plans.instructions(p, [line("MERGED a#1"), line("other"), line("MERGED b#2"), line("DM x")]), "\nINSTRUCTIONS: MRG, D, R2 (skill watchhub-plan-p)");
  const skill = plans.skillText(p, "watchhub-plan-p");
  assert.match(skill, /^---\nname: watchhub-plan-p\ndescription: Rule codes for the watchhub plan p: a burst prints codes \(MRG, R2, R3\)/);
  assert.match(skill, /## MRG\n\nMatches: `\^MERGED`\n\ndeploy\n/);
  assert.match(skill, /## R2\n\nMatches: `\^DM ` \(urgent\)\n\nanswer\n/);
  assert.match(skill, /## R3\n\nMatches: `noise` \(low\)\n\n\(low priority: no action, metadata only\)\n/);
  assert.match(skill, /## D\n\nA line no rule matched\.\n\nlook\n/);
  assert.match(skill, /## Every burst\n\nTell the user in one line/);
});

test("plan skill writes the SKILL.md, marks the plan, and the engine rewrites it when the plan changes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-codes-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.mkdirSync(path.join(dir, "plans"));
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", on: [{ match: "^MERGED", do: "deploy", code: "MRG" }] }));
  const out = cli(dir, "plan", "skill", "p");
  assert.match(out, /skill watchhub-plan-p written to .*SKILL\.md; plan p now prints codes \(MRG\)/);
  const f = path.join(dir, "skills", "watchhub-plan-p", "SKILL.md");
  assert.match(fs.readFileSync(f, "utf8"), /## MRG\n\nMatches: `\^MERGED`\n\ndeploy\n/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plans", "p.json"), "utf8")).skill, "watchhub-plan-p");
  // the agent skill too: written before the start, a config edit since is picked up when the engine starts
  const agent = path.join(dir, "agent-skill");
  cli(dir, "skill", "--out", agent);
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false }, agentNotes: "added while stopped" }));
  cli(dir, "start");
  t.after(() => { try { cli(dir, "stop"); } catch {} });
  await sleep(1500);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "plans", "p.json"), "utf8"));
  p.on[0].do = "deploy it carefully";
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify(p));
  await sleep(2500);
  assert.match(fs.readFileSync(f, "utf8"), /deploy it carefully/);
  assert.match(fs.readFileSync(path.join(dir, "engine.log"), "utf8"), /skill watchhub-plan-p rewritten from plan p/);
  assert.match(fs.readFileSync(path.join(agent, "SKILL.md"), "utf8"), /- added while stopped\n/);
});

test("plan skill without --out goes back to the folder an earlier --out chose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-codes-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.mkdirSync(path.join(dir, "plans"));
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", on: [{ match: "^MERGED", do: "deploy", code: "MRG" }] }));
  const elsewhere = path.join(dir, "elsewhere", "watchhub-plan-p");
  cli(dir, "plan", "skill", "p", "--out", elsewhere);
  const out = cli(dir, "plan", "skill", "p");
  assert.ok(out.includes(path.join(elsewhere, "SKILL.md")), out);
  assert.ok(!fs.existsSync(path.join(dir, "skills")), "a stray copy was written to the instance's skills folder");
  // a rename without --out goes to the default folder, and the plan forgets the old one so the engine follows
  cli(dir, "plan", "skill", "p", "--as", "q");
  const renamed = path.join(dir, "skills", "q", "SKILL.md");
  assert.ok(fs.existsSync(renamed));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plans", "p.json"), "utf8")).skillDir, undefined);
  assert.ok(cli(dir, "plan", "skill", "p").includes(renamed));
});

test("plan skill --out takes a leading ~ as the home directory, so an agent's own skills folder works from any shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-codes-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-home-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ probes: { jobs: false } }));
  fs.mkdirSync(path.join(dir, "plans"));
  fs.writeFileSync(path.join(dir, "plans", "p.json"), JSON.stringify({ name: "p", on: [{ match: "^MERGED", do: "deploy", code: "MRG" }] }));
  execFileSync(process.execPath, [BIN, "plan", "skill", "p", "--out", "~/.claude/skills/watchhub-plan-p", "--instance", dir], { encoding: "utf8", windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
  const want = path.join(home, ".claude", "skills", "watchhub-plan-p");
  assert.ok(fs.existsSync(path.join(want, "SKILL.md")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plans", "p.json"), "utf8")).skillDir, want);
});
