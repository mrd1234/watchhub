// command: run a shell command on each poll and report by the change-detection rules.
//   {"command": "df -h /c"}  or  {"command": {"command": "...", "shell": "bash|cmd|pwsh", "cwd": "...", "timeoutSec": 60}}
// Every poll is one child process, so this is the kind to reach for when nothing in-process fits.
const { bashPath } = require("../util");
const SHELLS = {
  bash: (c) => [bashPath(), ["-c", c]],
  cmd: (c) => ["cmd", ["/c", c]],
  pwsh: (c) => ["pwsh", ["-NoProfile", "-Command", c]],
  powershell: (c) => ["powershell", ["-NoProfile", "-Command", c]],
};
const spec = (w) => (typeof w.command === "string" ? { command: w.command } : w.command);

module.exports = {
  name: "command",
  validate(w) {
    const c = spec(w);
    if (!c || typeof c.command !== "string") throw new Error("command must be a string or {command, shell?, cwd?, timeoutSec?}");
    if (c.shell && !SHELLS[c.shell]) throw new Error(`shell must be one of ${Object.keys(SHELLS).join(", ")}`);
  },
  async poll(w, st, cfg, env, api) {
    const c = spec(w);
    const [cmd, args] = SHELLS[c.shell || "bash"](c.command);
    const out = (await api.run(cmd, args, c.timeoutSec || 60, c.cwd ? { cwd: c.cwd } : {})).trim();
    return api.detect(w, st, out, out);
  },
};
