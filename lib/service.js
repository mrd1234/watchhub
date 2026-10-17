// Keep the engine alive across app restarts, logoffs and reboots: on Windows a scheduled task owned
// by the Task Scheduler service (at logon, no time limit, hidden, its launcher reruns a crashed engine);
// on Linux a systemd user unit (Restart=always, enabled, lingering not required while logged in); on
// macOS a launchd user agent (KeepAlive, RunAtLoad). In every case `watchhub start` then goes through
// the service, so the engine is never a child of a session's shell again.
const path = require("path");
const { execFileSync } = require("child_process");

// The task name carries a short hash of the folder, so two instances whose folders share a basename
// (C:\a\watch and D:\b\watch) get two tasks instead of the second install replacing the first.
const taskName = (inst) => `watchhub ${path.basename(inst.dir).slice(0, 64)} ${require("crypto").createHash("sha1").update(inst.dir.toLowerCase()).digest("hex").slice(0, 6)}`;
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const supported = () => ["win32", "linux", "darwin"].includes(process.platform);
const fs = require("fs");
const os = require("os");
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
// powershell -WindowStyle Hidden flashes a console before it hides, so the task runs wscript on a JScript
// launcher in the instance folder that starts the engine with no window (conhost --headless would hide it
// too). The launcher also brings a crashed engine back: the task's restart-on-failure covers only a task that
// fails to start, never a program that exits non-zero (tried: an `exit 1` task with RestartCount 3 ran once).
// wscript reads the file in the ANSI code page, so anything past ASCII is written as a \u escape; Run expands
// %VAR% in the command, so a folder with %name% in it is not supported.
const launcherFile = (inst) => path.join(inst.dir, "engine-launch.js");
const launcherText = (inst) => {
  const quote = (a) => `"${a}"`, js = (s) => JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const cmd = [quote(process.execPath), quote(path.join(__dirname, "..", "bin", "watchhub.js")), "engine", "--instance", quote(inst.dir)].join(" ");
  return [
    "// written by watchhub service install: runs the engine with no window, and again after a crash.",
    "// Exit 0 (a planned stop) ends the task. Exit 3 (another engine already runs this instance) stands by: said once,",
    "// tried again every minute, so this launcher takes over when that engine ends. Any other code runs the engine again",
    "// after a pause that doubles from 5 s to 5 min, back to 5 s once a run has lasted 10 min. Each rerun is logged.",
    `var cmd = ${js(cmd)}, log = ${js(path.join(inst.dir, "engine.log"))};`,
    'var sh = new ActiveXObject("WScript.Shell"), fso = new ActiveXObject("Scripting.FileSystemObject"), pause = 5000, standby = false;',
    'function p(n) { return (n < 10 ? "0" : "") + n; }',
    'function say(m) { try { var d = new Date(), f = fso.OpenTextFile(log, 8, true); f.WriteLine(d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + "Z " + m); f.Close(); } catch (e) {} }',
    "for (;;) {",
    "  var began = new Date().getTime(), code = sh.Run(cmd, 0, true);",
    "  if (code === 0) WScript.Quit(0);",
    '  if (code === 3) { if (!standby) say("launcher: another engine runs this instance; standing by, trying every minute"); standby = true; pause = 5000; WScript.Sleep(60000); continue; }',
    "  standby = false;",
    "  if (new Date().getTime() - began >= 600000) pause = 5000;",
    '  say("launcher: engine exited with code " + code + "; running it again in " + pause / 1000 + " s");',
    "  WScript.Sleep(pause);",
    "  pause = Math.min(pause * 2, 300000);",
    "}",
    "",
  ].join("\n");
};
const unitName = (inst) => taskName(inst).replace(/[^A-Za-z0-9._-]+/g, "-");
const unitFile = (inst) => path.join(os.homedir(), ".config", "systemd", "user", `${unitName(inst)}.service`);
const plistLabel = (inst) => `com.watchhub.${unitName(inst)}`;
const plistFile = (inst) => path.join(os.homedir(), "Library", "LaunchAgents", `${plistLabel(inst)}.plist`);
const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// The unit and plist text, exported so they can be checked without a service manager present.
function unitText(inst) {
  const bin = path.join(__dirname, "..", "bin", "watchhub.js");
  const q = (v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`;
  return ["[Unit]", `Description=watchhub engine for ${inst.dir}`, "After=network-online.target", "", "[Service]", `ExecStart=${q(process.execPath)} ${q(bin)} engine --instance ${q(inst.dir)}`, `WorkingDirectory=${inst.dir}`, "Restart=always", "RestartSec=60", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}
function plistText(inst) {
  const bin = path.join(__dirname, "..", "bin", "watchhub.js");
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xml(plistLabel(inst))}</string>`,
    `<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(bin)}</string><string>engine</string><string>--instance</string><string>${xml(inst.dir)}</string></array>`,
    `<key>WorkingDirectory</key><string>${xml(inst.dir)}</string>`, "<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><true/>", "<key>ThrottleInterval</key><integer>60</integer>",
    `<key>StandardOutPath</key><string>${xml(path.join(inst.dir, "engine.launchd.log"))}</string>`, `<key>StandardErrorPath</key><string>${xml(path.join(inst.dir, "engine.launchd.log"))}</string>`,
    "</dict></plist>", ""].join("\n");
}

function installed(inst) {
  if (process.platform === "linux") return fs.existsSync(unitFile(inst)) ? "installed" : null;
  if (process.platform === "darwin") return fs.existsSync(plistFile(inst)) ? "installed" : null;
  if (!supported()) return null;
  try { return ps(`(Get-ScheduledTask -TaskName ${q(taskName(inst))} -ErrorAction Stop).State`); } catch { return null; }
}

function install(inst) {
  if (process.platform === "linux") {
    fs.mkdirSync(path.dirname(unitFile(inst)), { recursive: true });
    fs.writeFileSync(unitFile(inst), unitText(inst));
    sh("systemctl", ["--user", "daemon-reload"]); sh("systemctl", ["--user", "enable", "--now", unitName(inst)]);
    return unitName(inst);
  }
  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(plistFile(inst)), { recursive: true });
    fs.writeFileSync(plistFile(inst), plistText(inst));
    try { sh("launchctl", ["bootout", `gui/${process.getuid()}`, plistFile(inst)]); } catch {}
    sh("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistFile(inst)]);
    return plistLabel(inst);
  }
  if (!supported()) throw Object.assign(new Error("service install needs Windows, Linux (systemd --user) or macOS (launchd)"), { code: 2 });
  fs.writeFileSync(launcherFile(inst), launcherText(inst));
  const script = [
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${q(`//B //Nologo //E:jscript "${launcherFile(inst)}"`)} -WorkingDirectory ${q(inst.dir)}`,
    `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName ${q(taskName(inst))} -Action $a -Trigger $t -Settings $s -Description ${q(`watchhub engine for ${inst.dir}`)} -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${q(taskName(inst))}`,
  ].join("; ");
  ps(script);
  return taskName(inst);
}

function uninstall(inst) {
  if (process.platform === "linux") { if (!fs.existsSync(unitFile(inst))) return false; try { sh("systemctl", ["--user", "disable", "--now", unitName(inst)]); } catch {} fs.rmSync(unitFile(inst), { force: true }); try { sh("systemctl", ["--user", "daemon-reload"]); } catch {} return true; }
  if (process.platform === "darwin") { if (!fs.existsSync(plistFile(inst))) return false; try { sh("launchctl", ["bootout", `gui/${process.getuid()}`, plistFile(inst)]); } catch {} fs.rmSync(plistFile(inst), { force: true }); return true; }
  if (!supported()) return false;
  fs.rmSync(launcherFile(inst), { force: true });
  try { ps(`Stop-ScheduledTask -TaskName ${q(taskName(inst))} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${q(taskName(inst))} -Confirm:$false -ErrorAction Stop`); return true; } catch { return false; }
}

const run = (inst) => process.platform === "linux" ? sh("systemctl", ["--user", "start", unitName(inst)]) : process.platform === "darwin" ? (() => { try { return sh("launchctl", ["kickstart", `gui/${process.getuid()}/${plistLabel(inst)}`]); } catch { return sh("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistFile(inst)]); } })() : ps(`Start-ScheduledTask -TaskName ${q(taskName(inst))}`);
// Ends the task instance (its wscript launcher); the node engine under it is stopped by pid by the caller,
// since Stop-ScheduledTask does not reliably end the child process.
// (on Linux and macOS the service manager would restart a stopped engine at once, so a planned stop
// disables the unit's restart for the moment: systemd through `stop`, launchd through `bootout`; `run` brings it back)
const stopTask = (inst) => { try { if (process.platform === "linux") sh("systemctl", ["--user", "stop", unitName(inst)]); else if (process.platform === "darwin") sh("launchctl", ["bootout", `gui/${process.getuid()}/${plistLabel(inst)}`]); else ps(`Stop-ScheduledTask -TaskName ${q(taskName(inst))} -ErrorAction SilentlyContinue`); } catch {} };

function info(inst) {
  if (process.platform === "linux") { if (!fs.existsSync(unitFile(inst))) return "service: not installed (watchhub service install registers a systemd user unit)"; let st = "unknown"; try { st = sh("systemctl", ["--user", "is-active", unitName(inst)]); } catch (e) { st = (e.stdout || "").trim() || "inactive"; } return `service: unit ${unitName(inst)} ${st}`; }
  if (process.platform === "darwin") { if (!fs.existsSync(plistFile(inst))) return "service: not installed (watchhub service install registers a launchd agent)"; let st = "loaded"; try { sh("launchctl", ["print", `gui/${process.getuid()}/${plistLabel(inst)}`]); } catch { st = "not loaded"; } return `service: agent ${plistLabel(inst)} ${st}`; }
  if (!supported()) return "service: not supported on this platform";
  try {
    return ps(`$i = Get-ScheduledTaskInfo -TaskName ${q(taskName(inst))} -ErrorAction Stop; $t = Get-ScheduledTask -TaskName ${q(taskName(inst))}; "service: task '${taskName(inst)}' $($t.State), last run $($i.LastRunTime) result $($i.LastTaskResult), next $($i.NextRunTime)"`);
  } catch { return "service: not installed (watchhub service install keeps the engine alive across app restarts and reboots)"; }
}

module.exports = { launcherText, taskName, installed, install, uninstall, run, stopTask, info, unitText, plistText, unitName, plistLabel };
