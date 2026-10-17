// exec: a STREAM. One long-running command whose stdout lines are events (optionally only the
// lines matching `match`). This is the generic door to anything that can tail, subscribe or
// listen from a CLI: a queue consumer, a database change feed (psql LISTEN, a CDC client),
// `docker events`, a log tail. When the command exits the engine restarts it with back-off.
//   {"exec": {"command": "aws sqs receive-message ... | jq -c .Messages[]", "shell": "bash", "match": "FAILED", "cwd": "..."}}
const { spawn, execFile } = require("child_process");
const readline = require("readline");

// Stop the command and everything it started: on Windows `child.kill()` ends only the shell, and the
// real consumer under it would keep running (and keep writing to a pipe nobody reads) after every
// engine restart.
function killTree(child) {
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} } }
}

const { bashPath } = require("../util");
const SHELLS = {
  bash: (c) => [bashPath(), ["-c", c]],
  cmd: (c) => ["cmd", ["/c", c]],
  pwsh: (c) => ["pwsh", ["-NoProfile", "-Command", c]],
  powershell: (c) => ["powershell", ["-NoProfile", "-Command", c]],
};

module.exports = {
  name: "exec",
  stream: true,
  validate(w) {
    if (!w.exec || typeof w.exec.command !== "string") throw new Error("exec needs {command, shell?, cwd?, match?}");
    if (w.exec.shell && !SHELLS[w.exec.shell]) throw new Error(`shell must be one of ${Object.keys(SHELLS).join(", ")}`);
    if (w.exec.match) new RegExp(w.exec.match);
  },
  // Resolves when the process ends; rejects when it fails to start or exits non-zero.
  start(w, ctx) {
    const e = w.exec, re = e.match || w.match ? new RegExp(e.match || w.match) : null;
    const [cmd, args] = SHELLS[e.shell || "bash"](e.command);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: e.cwd || undefined, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      const stop = () => killTree(child);
      ctx.signal.addEventListener("abort", stop, { once: true });
      readline.createInterface({ input: child.stdout }).on("line", (l) => { if (!re || re.test(l)) ctx.emit(`line: ${ctx.api.oneLine(l, 300)}`); });
      let err = "";
      readline.createInterface({ input: child.stderr }).on("line", (l) => { err = l; ctx.log(`stderr: ${l.slice(0, 200)}`); });
      child.on("error", (x) => reject(new Error(`${cmd}: ${x.message}`)));
      child.on("exit", (code, sig) => {
        ctx.signal.removeEventListener("abort", stop);
        if (ctx.signal.aborted || code === 0) resolve();
        else reject(new Error(`exited ${sig || code}${err ? ": " + err.slice(0, 120) : ""}`));
      });
    });
  },
};
