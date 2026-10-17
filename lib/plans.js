// Plans: <instance>/plans/<name>.json = { name, scope, probes, filter, notify, priority?, on: [{match, do, priority?}], default }.
// A rule's priority: urgent (wakes at once), normal (after the settle), low (rides in the next burst's
// ALSO block; `quiet: true` is the old spelling). The plan's own priority covers lines no rule matches.
// A plan is a saved selection of events plus what to do with each kind, so a woken inbox has its
// instructions in front of it instead of working them out again.
const fs = require("fs");
const path = require("path");

const LEVELS = ["urgent", "normal", "low"];
const CODE = /^[A-Z][A-Z0-9]{0,7}$/;

// Each rule's code: its own `code`, else R1, R2, ... by position (give rules codes before relying on
// them, since positions move when rules are inserted). The default instruction is D.
const codeOf = (p, i) => (p.on[i].code || `R${i + 1}`);
function codes(p) { const out = {}; (p.on || []).forEach((o, i) => { out[codeOf(p, i)] = o; }); return out; }

// The skill text for a plan: the code table an agent loads once and applies many times. Written by
// `watchhub plan skill <name>`; the plan's `skill` field then makes every burst print codes, not text.
function skillText(p, skillName) {
  const lines = ["---", `name: ${skillName}`, `description: Rule codes for the watchhub plan ${p.name}: a burst prints codes (${(p.on || []).map((o, i) => codeOf(p, i)).join(", ")}) and this table says what each means. Load once, apply to every burst.`, "---", "",
    `# ${skillName}`, "", `Rule codes for the watchhub plan \`${p.name}\`. A burst from this plan ends with \`INSTRUCTIONS: <codes>\`; each code is a rule below. Do what the rule says for the lines that matched it. If a code is not in this table the plan changed: run \`watchhub plan show ${p.name}\`.`, ""];
  (p.on || []).forEach((o, i) => { lines.push(`## ${codeOf(p, i)}`, "", `Matches: \`${o.match}\`${o.priority ? ` (${o.priority})` : o.quiet ? " (low)" : ""}`, "", o.do || "(low priority: no action, metadata only)", ""); });
  if (p.default) lines.push("## D", "", "A line no rule matched.", "", p.default, "");
  if (typeof p.notify === "string") lines.push("## Every burst", "", p.notify, "");
  else if (p.notify !== false) lines.push("## Every burst", "", `Tell ${p.notifyWho || "the user"} in one line what arrived and what you are doing.`, "");
  return lines.join("\n");
}

function check(p) {
  if (!p.name || !/^[a-z0-9-]+$/.test(p.name)) throw new Error("plan needs a name of lowercase letters, digits and dashes");
  if (p.probes !== undefined && !(Array.isArray(p.probes) && p.probes.every((n) => /^[a-z0-9:-]+$/.test(n))))
    throw new Error("probes must be a list of probe names, such as pr-merges or custom:my-watch");
  for (const r of [p.filter || "", ...(p.on || []).map((o) => o.match)]) new RegExp(r);
  if ((p.on || []).some((o) => !o.match || !(o.do || o.quiet || o.priority === "low"))) throw new Error("every 'on' entry needs match and do (or priority: low / quiet: true)");
  for (const v of [p.priority, ...(p.on || []).map((o) => o.priority)]) if (v !== undefined && !LEVELS.includes(v)) throw new Error(`priority must be one of ${LEVELS.join(", ")}`);
  const seen = new Set();
  for (const o of p.on || []) if (o.code !== undefined) { if (!CODE.test(o.code) || o.code === "D") throw new Error(`rule code ${o.code} must be 1 to 8 capitals or digits starting with a letter, not D`); if (seen.has(o.code)) throw new Error(`rule code ${o.code} used twice`); seen.add(o.code); }
  if (p.skill !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.skill)) throw new Error("skill must be a skill name: lowercase letters, digits and dashes");
  const sinks = require("./sinks");
  sinks.checkNames(p.sinks, "sinks");
  for (const o of p.on || []) sinks.checkNames(o.sinks, "on[].sinks");
  return p;
}

function load(dir, name) {
  const f = path.join(dir, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`no plan ${name} (${f})`);
  return check(JSON.parse(fs.readFileSync(f, "utf8")));
}

function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).map((f) => { try { return check(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch (e) { return { name: path.basename(f, ".json"), invalid: e.message }; } });
}

function save(dir, p) {
  check(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${p.name}.json`), JSON.stringify(p, null, 2) + "\n");
}

// Does a parsed event line belong to this plan? probes (default all) by probe column, scope
// (default every) by scope column plus "all"; a custom:<name> listed in probes passes whatever its
// scope; a listed probe's failing / recovered / runs-again lines pass; then the plan's filter regex.
function selects(p) {
  const names = p.probes && p.probes.length ? new Set(p.probes) : null;
  const filter = p.filter ? new RegExp(p.filter) : null;
  return (ev) => {
    if (names) {
      const meta = ev.probe === "watch" && /^probe (\S+) (failing|recovered|runs again)/.exec(ev.text);
      const ok = names.has(ev.probe) || (meta && names.has(meta[1]));
      if (!ok) return false;
      if (ev.probe.startsWith("custom:")) return !filter || filter.test(ev.line);
    }
    if (p.scope && ev.scope !== p.scope && ev.scope !== "all") return false;
    return !filter || filter.test(ev.line);
  };
}

// The first `on` rule a line matches (tested against the message and the whole line).
const compiled = new WeakMap();   // plan object -> its rules' regexes, built once
function rule(p, l) {
  const msg = l.split(" | ").slice(3).join(" | ");
  let res = compiled.get(p);
  if (!res) { res = (p.on || []).map((o) => new RegExp(o.match)); compiled.set(p, res); }
  const i = res.findIndex((re) => re.test(msg) || re.test(l));
  return i < 0 ? undefined : p.on[i];
}
// A quiet line is recorded but never wakes an inbox on its own; it rides along with the next burst.
const quiet = (p, l) => levelFor(p, l) === "low";
// The priority this plan gives a line: the matching rule's (quiet: true means low), else the plan's, else nothing.
function levelFor(p, l) {
  const r = rule(p, l);
  if (r) return r.priority || (r.quiet ? "low" : "normal");   // a matched rule with a `do` is normal unless it says otherwise
  return p.priority || null;
}
// The sinks a line goes to under this plan: the matching rule's `sinks` when it has one (an empty list
// keeps that rule off every sink), else the plan's; a quiet line goes nowhere. `extra.do` carries the rule.
function sinksFor(p, l) {
  const r = rule(p, l);
  if (r && (r.quiet || r.priority === "low")) return { sinks: [], extra: {} };
  return { sinks: (r && r.sinks) || p.sinks || [], extra: { do: (r && r.do) || p.default || "" } };
}

// The instruction block for a burst: each matching `do` once, `default` when nothing matches, then the notify line.
// With `seen` ({fresh(key), mark(key)}), a rule printed in full within the window is named by its match instead
// (the text is the same, and `watchhub plan show <name>` has it), which is where most of a wake's tokens went.
function instructions(p, lines, who, seen) {
  // a plan with a skill prints codes only: the agent loaded the table once (far fewer tokens per wake)
  if (p.skill) {
    const used = [];
    for (const l of lines) { const i = (p.on || []).indexOf(rule(p, l)); const c = i >= 0 ? codeOf(p, i) : (p.default ? "D" : null); if (c && !used.includes(c)) used.push(c); }
    return `\nINSTRUCTIONS: ${used.join(", ") || "none"} (skill ${p.skill})`;
  }
  const todo = [], named = [];
  for (const l of lines) {
    const hit = rule(p, l);
    const text = hit ? hit.do : p.default;
    if (!text) continue;
    const key = hit ? hit.match : "(default)";
    if (seen && seen.fresh(key)) { if (!named.includes(key)) named.push(key); continue; }
    if (!todo.includes(text)) { todo.push(text); if (seen) seen.mark(key); }
  }
  const out = ["", "INSTRUCTIONS", ...todo.map((t) => `- ${t}`)];
  if (named.length) out.push(`- as before for ${named.map((k) => `/${k}/`).join(", ")} (text: watchhub plan show ${p.name})`);
  // the notify line: a plan's own string, else "Tell <who> ..." with who from the plan, the instance (notifyWho) or "the user"
  if (typeof p.notify === "string") out.push(p.notify);
  else if (p.notify !== false) out.push(`Tell ${p.notifyWho || who || "the user"} in one line what arrived and what you are doing.`);
  return out.join("\n");
}

module.exports = { LEVELS, check, load, list, save, selects, instructions, rule, quiet, levelFor, sinksFor, codes, skillText };
