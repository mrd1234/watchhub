// An instance is a folder with instance.json: everything the engine watches, the plans, the
// subscriptions and the files written at run time. Resolved from --instance, WATCHHUB_INSTANCE,
// the working directory when it holds an instance.json, else the default in ~/.watchhub/config.json.
const fs = require("fs");
const path = require("path");
const { readJson } = require("./util");
const userdir = require("./userdir");

function resolve(dirOpt) {
  const has = (d) => d && fs.existsSync(path.join(d, "instance.json"));
  let dir = dirOpt || process.env.WATCHHUB_INSTANCE;
  if (!dir) dir = has(process.cwd()) ? process.cwd() : userdir.config().instance || process.cwd();
  dir = path.resolve(dir);
  const cfgFile = path.join(dir, "instance.json");
  if (!fs.existsSync(cfgFile)) throw new Error(`no instance.json in ${dir} (pass --instance <folder>, set WATCHHUB_INSTANCE, or set "instance" in ${userdir.configFile()})`);
  const p = (...xs) => path.join(dir, ...xs);
  return {
    dir,
    config: () => readJson(cfgFile, {}),   // re-read on each call so edits apply without a restart
    paths: {
      config: cfgFile,
      events: p("events.log"),
      state: p("state.json"),
      jobs: p("jobs.json"),
      follows: p("jira-follow.json"),   // tickets the board follows outside its projects (`watchhub jira follow`)
      replies: p("replies.json"),   // reply handles -> the probe and place an answer goes to (twoway.js)
      schedules: p("schedules.json"),   // one-off schedules (`watchhub at` / `in`), soonest first (schedules.js)
      engineLog: p("engine.log"),
      lock: p("engine.lock"),
      stopRequest: p("engine.stop"),   // written by `watchhub stop`: on Windows a signal cannot reach the engine, a file can
      watches: p("watches"),
      modules: p("modules"),
      plans: p("plans"),
      sinks: p("sinks"),
      subs: p("subscriptions"),
      inbox: p("inbox"),
      leases: p("leases"),
      agentSkills: p("agent-skills.json"),   // where `hook install` / `skill --out` wrote the agent skill (agentskill.js): machine-local
    },
  };
}

module.exports = { resolve };
