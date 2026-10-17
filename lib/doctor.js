// watchhub doctor: one line per thing that has to be right before the first wake, so a fresh
// setup fails here, in plain words, rather than hours later as silence.
const fs = require("fs");
const path = require("path");
const net = require("net");
const sources = require("./sources");
const subs = require("./subs");
const plans = require("./plans");
const service = require("./service");
const api = require("./api");
const { enginePid } = require("./engine");
const { bashPath } = require("./util");

async function doctor(inst, env = process.env) {
  const lines = [];
  const userdir = require("./userdir");
  const fromFile = new Set([...userdir.loadEnv(env), ...(env === process.env ? userdir.loadedKeys : [])]);   // names that came from ~/.watchhub/env (loaded at CLI start)
  const fileKeys = (() => { try { return Object.keys(userdir.parseEnv(fs.readFileSync(userdir.envFile(), "utf8"))); } catch { return null; } })();
  const where = (v) => (fileKeys && fileKeys.includes(v) && !fromFile.has(v) && env[v] !== undefined ? "set in the environment (also in ~/.watchhub/env; the environment wins)" : fileKeys && fileKeys.includes(v) ? "set from ~/.watchhub/env" : "set in the environment");
  const ok = (what, detail) => lines.push(`ok    ${what}${detail ? `: ${detail}` : ""}`);
  const bad = (what, detail) => lines.push(`FAIL  ${what}: ${detail}`);
  const warn = (what, detail) => lines.push(`warn  ${what}: ${detail}`);

  const major = Number(process.versions.node.split(".")[0]);
  (major >= 20 ? ok : bad)("node", `${process.version}${major < 20 ? " (20 or newer needed for fetch and fs.watch behaviour)" : ""}`);

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(inst.paths.config, "utf8")); ok("instance.json", inst.paths.config); } catch (e) { bad("instance.json", e.message); }
  (fileKeys ? ok : warn)("user folder", fileKeys ? `${userdir.dir()} (${fileKeys.length} keys in env, default instance ${userdir.config().instance || "not set"})` : `${userdir.dir()} has no env file (watchhub home creates it; tokens can live there instead of environment variables)`);

  const b = bashPath(env);
  (b !== "bash" || process.platform !== "win32" ? ok : warn)("bash for command and exec watches", b === "bash" ? "not found at the Git for Windows paths; a bare `bash` may be the WSL stub under the scheduled task (set WATCHHUB_BASH)" : b);

  // code sources and what they need
  const code = sources.allCode(inst.paths.modules, (m) => (/^module /.test(m) ? bad : warn)("module", m));
  const on = code.filter((p) => { try { return p.enabled(cfg); } catch { return false; } });
  ok("code sources", `${on.map((p) => p.name).join(", ") || "none on"}${code.length > on.length ? ` (off, no config or probes.<name> false: ${code.filter((p) => !on.includes(p)).map((p) => p.name).join(", ")})` : ""}`);
  const builtinNames = new Set(sources.builtins(() => {}).map((p) => p.name));
  const mine = sources.loadCode(inst.paths.modules, () => {}).map((p) => p.name).filter((n) => builtinNames.has(n));
  if (mine.length) warn("modules", `${mine.join(", ")} in modules/ replace the shipped builtin${mine.length > 1 ? "s" : ""} of the same name (remove the file to use the shipped one)`);
  const watches = sources.loadWatches(inst.paths.watches);
  for (const w of watches) if (w.invalid) bad(`watch ${w.name}`, w.invalid);
  for (const w of watches) if (!w.invalid && w.metric) { try { require("./metrics").checkDescription(w.metric.description); } catch (e) { bad(`watch ${w.name} metric`, `${e.message}; the watch still alerts, its number is left out of metrics.json until fixed`); } }
  ok("watches", `${watches.filter((w) => !w.invalid).length} valid`);
  for (const p of plans.list(inst.paths.plans)) if (p.invalid) bad(`plan ${p.name}`, p.invalid);
  for (const s of subs.list(inst.paths)) { try { subs.matcher(inst.paths, s); } catch (e) { bad(`subscription ${s.inbox}`, e.message); } }
  // sinks: defined, and every name a watch, plan or subscription uses exists
  const sk = require("./sinks").load(inst.paths.sinks);
  for (const [n, why] of Object.entries(sk.invalid)) bad(`sink ${n}`, why);
  const used = new Set();
  for (const w of watches) for (const n of [...(w.sinks || []), ...(w.reply ? [w.reply] : [])]) used.add(n);
  for (const p of plans.list(inst.paths.plans)) { for (const n of p.sinks || []) used.add(n); for (const o of p.on || []) for (const n of o.sinks || []) used.add(n); }
  for (const s of subs.list(inst.paths)) for (const n of s.sinks || []) used.add(n);
  const slackPlaces = cfg.slack?.read ? [cfg.slack, ...[].concat(cfg.slack.read)] : [];
  for (const r of slackPlaces) for (const n of (r && Array.isArray(r.sinks) && r.sinks) || []) used.add(n);
  for (const n of used) if (!sk.sinks[n]) bad(`sink ${n}`, `named by a watch, plan, subscription or the slack section but not defined (watchhub sink add ...)`);
  // a place's lines sent to a sink that posts to Slack repost what was read there (a DM into a channel), as you
  for (const r of slackPlaces.slice(1)) for (const n of (r && typeof r === "object" && Array.isArray(r.sinks) ? r.sinks : cfg.slack.sinks) || []) if (sk.sinks[n]?.slack) warn(`sink ${n}`, `posts to Slack as you, and slack.read ${typeof r === "string" ? r : r?.channel} sends its lines there`);
  if (Object.keys(sk.sinks).length) ok("sinks", Object.keys(sk.sinks).map((n) => `${n}${used.has(n) ? "" : " (unused)"}`).join(", "));
  if (process.platform === "linux") for (const [n, s] of Object.entries(sk.sinks)) if (s.toast) { try { require("child_process").execFileSync("notify-send", ["--version"], { stdio: "ignore", timeout: 5000 }); } catch { bad(`sink ${n}`, "toast sinks on Linux need notify-send (libnotify) on PATH"); } }

  // what each source declares it needs
  const envneed = require("./envneed");
  for (const p of on) {
    for (const r of envneed.report(p.env, cfg, env)) {
      if (r.set) ok(`env ${r.set}`, `${where(r.set)} (${p.name})`);
      else if (r.optional) lines.push(`info  env ${r.names.join(" or ")}: not set; ${p.name} has a fallback`);
      else bad(`env ${r.names.join(" or ")}`, `not set; ${p.name} is off until it is (put it in ~/.watchhub/env)`);
    }
  }
  // environment variables the watches reference
  const refs = new Set();
  for (const w of watches) for (const m of JSON.stringify(w).matchAll(/\$\{([A-Z0-9_]+)\}/gi)) refs.add(m[1]);
  for (const w of watches) if (w.webhook?.secretEnv) refs.add(w.webhook.secretEnv);
  for (const s of Object.values(sk.sinks)) for (const m of JSON.stringify(s).matchAll(/\$\{([A-Z0-9_]+)\}/gi)) refs.add(m[1]);
  for (const v of refs) (env[v] ? ok : bad)(`env ${v}`, env[v] ? where(v) : "not set (a watch or sink references it; put it in ~/.watchhub/env or the environment)");

  // GitHub, when anything uses it
  const usesGh = on.some((p) => /pr-|github|jobs/.test(p.name)) || watches.some((w) => w.github || w.gh);
  if (usesGh) {
    try { const login = await api.ghLogin(); ok("github", `token works, signed in as ${login}${env.GITHUB_TOKEN ? ` (GITHUB_TOKEN ${where("GITHUB_TOKEN")})` : env.GH_TOKEN ? ` (GH_TOKEN ${where("GH_TOKEN")})` : " (from gh auth token)"}`); }
    catch (e) { bad("github", `${e.message}; put GITHUB_TOKEN in ~/.watchhub/env or run gh auth login`); }
  }
  // Jira, when configured
  if (cfg.jira?.projects) {
    const tokenEnv = cfg.jira.tokenEnv || "JIRA_API_TOKEN";
    if (!env[tokenEnv]) bad("jira", `${tokenEnv} not set (put it in ~/.watchhub/env or the environment)`);
    else if (!cfg.jira.base || !cfg.jira.email) bad("jira", "instance.json jira needs base and email");
    else { try { const me = await api.fetchJson(`${cfg.jira.base}/myself`, { headers: api.jiraHeaders(cfg, env) }, 15); ok("jira", `${cfg.jira.base} as ${me.displayName || me.emailAddress} (${tokenEnv} ${where(tokenEnv)})`); } catch (e) { bad("jira", e.message); } }
  }
  // Slack user token, when a slack watch, sink or the slack section exists
  const slackEnvs = new Set([...watches.filter((w) => w.slack).map((w) => (typeof w.slack === "object" && w.slack.tokenEnv) || "SLACK_USER_TOKEN"), ...Object.values(sk.sinks).filter((s) => s.slack).map((s) => s.slack.tokenEnv || "SLACK_USER_TOKEN"),
    ...([].concat(cfg.slack?.read || []).length && cfg.probes?.slack !== false ? [cfg.slack.tokenEnv || "SLACK_USER_TOKEN"] : [])]);
  for (const v of slackEnvs) {
    if (!env[v]) { bad("slack", `${v} not set (the app's User OAuth Token, xoxp-...; put it in ~/.watchhub/env)`); continue; }
    try { const me = await require("./slack").call("auth.test", {}, env, v); ok("slack", `token works as ${me.user} in ${me.team} (${v} ${where(v)})`); } catch (e) { bad("slack", e.message); }
  }
  // VPN and stamps sections, when present
  if (cfg.vpn) {
    const options = require("./builtin/vpn")({}).options, sides = Object.keys(cfg.vpn).filter((k) => !options.includes(k));
    (sides.length ? ok : bad)("vpn", sides.length ? `sides ${sides.join(", ")} on port ${cfg.vpn.port || 443}` : `no side hosts (keys other than ${options.join(" and ")})`);
    if (cfg.vpn.noneAfterSec !== undefined && !(Number(cfg.vpn.noneAfterSec) >= 0)) bad("vpn noneAfterSec", `${JSON.stringify(cfg.vpn.noneAfterSec)} is not a number of seconds`);
  }
  if (cfg.stamps) (cfg.stamps.hosts && Object.keys(cfg.stamps.hosts).length ? ok : bad)("stamps", cfg.stamps.hosts ? `${Object.keys(cfg.stamps.hosts).join(", ")} at ${cfg.stamps.path || "/"}` : "needs hosts");
  // Datadog keys, when configured
  if (cfg.datadog) {
    const site = cfg.datadog.site || "datadoghq.com";
    if (!env.DD_PAT && !(env.DD_API_KEY && env.DD_APP_KEY)) bad("datadog", "DD_PAT (or DD_API_KEY and DD_APP_KEY) needed (put it in ~/.watchhub/env)");
    else { try { const H = require("./builtin/datadog")(api).headers(env); const r = await api.fetchJson(`https://api.${site}/api/v1/monitor?page_size=1`, { headers: H }, 15); (Array.isArray(r) ? ok : bad)("datadog", Array.isArray(r) ? `token works on ${site} (${env.DD_PAT ? `DD_PAT ${where("DD_PAT")}` : `DD_API_KEY ${where("DD_API_KEY")}`})` : "unexpected answer from the monitor list"); } catch (e) { bad("datadog", e.message); } }
  }
  for (const m of cfg.datadog?.metrics || []) { try { require("./metrics").checkDescription(m.description); require("./metrics").checkDef({ name: m.name, unit: m.unit, display: m.display }); } catch (e) { bad(`datadog metric ${m.name}`, `${e.message} (it is left out of metrics.json until fixed)`); } }
  // AWS CLI, when configured
  if (cfg.aws?.profiles?.length) {
    try { ok("aws cli", (await api.run("aws", ["--version"], 20)).trim()); } catch (e) { bad("aws cli", `${e.message} (profiles in instance.json need the AWS CLI on PATH)`); }
  }
  // webhook port, when any webhook watch exists
  if (watches.some((w) => w.webhook)) {
    const host = cfg.webhook?.host || "127.0.0.1", port = Number(cfg.webhook?.port || 47831);
    const free = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(port, host, () => s.close(() => res(true))); });
    (free || enginePid(inst.paths) ? ok : bad)("webhook listener", free ? `${host}:${port} free` : enginePid(inst.paths) ? `${host}:${port} in use (by the running engine)` : `${host}:${port} in use by something else`);
  }
  // engine and task
  const pid = enginePid(inst.paths);
  (pid > 0 ? ok : warn)("engine", pid > 0 ? `running (pid ${pid})` : "not running (a wait starts it; `watchhub service install` keeps it alive across restarts)");
  lines.push(`info  ${service.info(inst)}`);
  const unacked = subs.list(inst.paths).filter((s) => { try { return subs.unacked(inst.paths, s.inbox).text; } catch { return false; } });
  if (unacked.length) warn("unacknowledged bursts", unacked.map((s) => s.inbox).join(", ") + " (arm their waits)");
  return lines;
}

module.exports = { doctor };
