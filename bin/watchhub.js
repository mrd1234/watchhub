#!/usr/bin/env node
// watchhub: one engine per instance folder; inboxes subscribe once and wait on their own inbox.
const USAGE = `usage: watchhub <command> [args] [--instance <folder>]
  init [folder]                      create an instance folder (default: here)
  start | stop | status | now        the engine (detached) and what it knows
  restart [--message '<why>']        stop then start; the message reaches every inbox first so it is not read as a crash
  notice '<text>' [--wake]           a line to every inbox (read with its next burst; --wake wakes them now)
  at <HH:MM | ISO time> [<inbox> ...] '<text>' [--sink a,b] [--scope s]   one line at that time, to the inbox (yours when none is named), a sink, or every inbox taking the scope
  in <90s | 20m | 2h | 1d> [<inbox> ...] '<text>'   the same, that long from now
  schedules [--json] | unschedule <id>   pending schedules, soonest first; cancel one
  once                               run every poll source one time (engine must be stopped)
  sub <inbox> [--label 'what it waits on'] --plan <p> | --filter <re> [--scope s] [--probes a,b] [--ttl 4h] [--settle 3] [--urgent <re>] [--priority low|urgent] [--cooldown 60] [--sinks slack] [--once] [--session id]
  unsub <inbox> | subs                drop or list subscriptions
  wait <inbox> [sub flags]            block until the inbox has a burst, print it, exit
  watch add|add-once '<json>' | add <file.json> | list | show <n> | rm <n> | kinds   (a file keeps backslashes and quotes intact on Windows)
  plan list | show <n> | add <file> | skill <n> [--out dir] | instructions <n>
  sink list | add '<json>' | rm <n> | send <n> '<text>'   notification targets: an http webhook (Slack, Teams, anything) or a desktop notification
  reply <handle> '<text>'            answer where a line marked [reply <handle>] came from (a Slack thread or DM), through its source
  reply <watch> '<text>'             answer where a watch reads, through the sink its "reply" names (a self-DM and its sink)
  module new <name> [--stream | --two-way] | list   a working module to start from (poll, stream, or one that answers), and what is loaded
  add-job '<json>' | tail [n] | leases
  jira follow <KEY> [--ttl 30d] | unfollow <KEY> | follows   tickets the board watches outside its projects (30 days unless --ttl)
  events [--since 2h] [--grep <re>] [--probe p] [--scope s] [--inbox l [--aside [id]]] [--limit n]   query the log (or an inbox, or the lines it handed over only as a count)
  stats [--since 24h]                wakes per inbox, events per probe, subscriptions, engine uptime
  metrics [<regex>] [--probe p]      one line per metric: value, ok|warn|bad|PAST|stale|none, threshold, label (cheaper than reading metrics.json)
  service install | uninstall | status   the engine as a scheduled task: survives app restarts and reboots
  doctor                             check node, bash, tokens, Jira, AWS, watches, plans, the engine
  hook start | stop | install [dir] | print   Claude Code hooks: the session learns its inbox at start and gets bursts when a turn ends, no wait command (install also writes the skill)
  skill [--out <dir>]                the agent skill: how watchhub works plus this instance's setup; printed, or written to <dir> and kept current
  home [--instance <folder>]         show or create ~/.watchhub (env file for tokens, config.json with the default instance)
instance: --instance, WATCHHUB_INSTANCE, the working directory, or "instance" in ~/.watchhub/config.json`;

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  require("../lib/userdir").loadEnv();   // ~/.watchhub/env first: tokens in one place, real environment variables win
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, a1, a2] = pos;
  if (!cmd || cmd === "help" || flags.help) { console.log(USAGE); return 0; }
  if (cmd === "version") { console.log(require("../package.json").version); return 0; }
  const ctl = require("../lib/ctl");
  if (cmd === "init") { ctl.init(require("path").resolve(a1 || flags.instance || process.cwd()), flags); return 0; }
  if (cmd === "home") { const u = require("../lib/userdir"); u.init(flags.instance ? require("path").resolve(flags.instance) : undefined); console.log(`${u.dir()}\n  env: ${u.envFile()} (${u.loadEnv({}).length} keys)\n  config: ${JSON.stringify(u.config())}`); return 0; }
  if (cmd === "hook" && a1 === "install") {
    // the hooks need no instance; the skill does, so without one the hooks still go in and init is named
    const dir = a2 || process.cwd();
    console.log(`hooks written to ${require("../lib/hook").install(dir, Number(flags.hold || 43200))}`);
    let inst;
    try { inst = require("../lib/instance").resolve(flags.instance); } catch (e) { console.log(`skill not written: ${e.message}. Run watchhub init <folder>, then watchhub hook install again`); return 0; }
    console.log(`skill written to ${require("../lib/agentskill").install(inst, require("path").join(require("../lib/util").expandHome(dir), ".claude", "skills", "watchhub"))} (the engine keeps it current with this instance)`);
    return 0;
  }
  const inst = require("../lib/instance").resolve(flags.instance);
  switch (cmd) {
    case "engine": { const { Engine } = require("../lib/engine"); await new Engine(inst).run(); return 0; }
    case "start": ctl.start(inst); return 0;
    case "stop": ctl.stop(inst, flags); return 0;
    case "restart": ctl.restart(inst, flags); return 0;
    case "notice": ctl.notice(inst, a1, flags); return 0;
    case "at": case "in": ctl.scheduleCmd(inst, cmd, pos.slice(1), flags); return 0;
    case "schedules": ctl.schedulesCmd(inst, flags); return 0;
    case "unschedule": ctl.unschedule(inst, a1); return 0;
    case "status": ctl.status(inst); return 0;
    case "now": ctl.now(inst); return 0;
    case "once": await ctl.once(inst); return 0;
    case "sub": ctl.sub(inst, a1, flags); return 0;
    case "unsub": ctl.unsub(inst, a1); return 0;
    case "subs": ctl.listSubs(inst); return 0;
    case "wait": return ctl.waitCmd(inst, a1, flags);
    case "watch": ctl.watch(inst, a1, a2); return 0;
    case "plan": ctl.plan(inst, a1, a2, flags); return 0;
    case "sink": await ctl.sink(inst, a1, a2, pos[3]); return 0;
    case "reply": await ctl.reply(inst, a1, a2); return 0;
    case "module": ctl.moduleCmd(inst, a1, a2, flags); return 0;
    case "add-job": ctl.addJob(inst, a1); return 0;
    case "jira": await ctl.jiraCmd(inst, a1, a2, flags); return 0;
    case "tail": ctl.tail(inst, a1); return 0;
    case "leases": ctl.leasesCmd(inst); return 0;
    case "events": ctl.eventsCmd(inst, flags); return 0;
    case "stats": ctl.stats(inst, flags); return 0;
    case "metrics": ctl.metricsCmd(inst, a1, flags); return 0;
    case "service": ctl.serviceCmd(inst, a1); return 0;
    case "skill": {
      const agentskill = require("../lib/agentskill");
      if (flags.out && flags.out !== true) console.log(`skill written to ${agentskill.install(inst, flags.out)} (the engine keeps it current with this instance)`);
      else process.stdout.write(agentskill.text(inst));
      return 0;
    }
    case "hook": {
      const hook = require("../lib/hook");
      if (a1 === "start") return hook.start(inst);
      if (a1 === "stop") return hook.stop(inst, undefined, process.stdout, { holdSec: Number(flags.hold || 43140) });
      if (a1 === "print") { console.log(JSON.stringify(hook.snippet(Number(flags.hold || 43200)), null, 2)); return 0; }
      console.error("usage: watchhub hook start | stop | install [dir] | print"); return 2;
    }
    case "doctor": { const lines = await require("../lib/doctor").doctor(inst); console.log(lines.join("\n")); return lines.some((l) => l.startsWith("FAIL")) ? 1 : 0; }
    default: console.error(`unknown command ${cmd}\n${USAGE}`); return 2;
  }
}

main().then((code) => { process.exitCode = code || 0; }, (e) => { console.error(e.message || e); process.exitCode = e.code || 1; });
