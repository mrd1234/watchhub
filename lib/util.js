// Small helpers shared by the engine, the kinds and the CLI.
const fs = require("fs");
const os = require("os");

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };

// For a file this process reads and then rewrites (state.json, schedules.json, replies.json): readJson's
// "unreadable means empty" would let the next write replace it, losing everything in it. A missing file
// is dflt. A file that does not parse is read again twice (a write in place may be landing) and then
// renamed to <name>.bad-<time>, onBad told, and dflt returned. A file that cannot be read or set aside
// throws, so nothing is written over it.
function readJsonOrSetAside(f, dflt, onBad = () => {}) {
  for (let i = 0; i < 3; i++) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return dflt; if (i === 2) throw e; }
    if (text !== undefined) { try { return JSON.parse(text); } catch {} }
    if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const bad = `${f}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(f, bad);
  onBad(`${require("path").basename(f)} could not be read as JSON; set aside as ${require("path").basename(bad)} and started empty`);
  return dflt;
}

// Write via a temp file and rename. On Windows the rename fails with EPERM/EBUSY while another
// process has the target open, so retry for up to a second, then write in place rather than crash.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 20; i++) {
    try { return fs.renameSync(tmp, file); } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) { fs.rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  fs.writeFileSync(file, text);
  fs.rmSync(tmp, { force: true });
}

const oneLine = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// Is a pid alive? EPERM means it exists but is not ours.
const isAlive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };

// Is this pid a watchhub engine? Windows reuses pids within minutes, so before anything is stopped
// by a pid read from a stale lock, its command line is checked (PowerShell on Windows, /proc elsewhere).
function isEnginePid(pid) {
  if (!isAlive(pid)) return false;
  try {
    const cmd = process.platform === "win32"
      ? require("child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] })
      : require("child_process").execFileSync("ps", ["-o", "command=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });   // macOS has no /proc
    return /watchhub(\.js)?["' ]+engine\b/.test(cmd);
  } catch { return false; }
}

// The pid of the nearest ancestor of this process named claude (Claude Code's own binary), or null.
// A hook's parent is a shell, and on Windows Git's sh.exe outlives Claude Code, so a hold watches this
// pid instead. Async (a PowerShell or ps walk up the tree), so the hold never waits for it; the walk
// keeps nothing alive, so the answer arrives only while something else (the hold's timers) does.
function harnessPid(name = "claude") {
  const cp = require("child_process");
  const run = (file, args) => new Promise((resolve) => {
    const c = cp.execFile(file, args, { encoding: "utf8", windowsHide: true }, (e, out) => { clearTimeout(t); resolve(e ? "" : String(out).trim()); });
    const t = setTimeout(() => c.kill(), 15000);   // not execFile's timeout: its timer is ref'd
    for (const h of [t, c, c.stdin, c.stdout, c.stderr]) h?.unref?.();   // a hold that ends at once never waits for the walk
  });
  if (process.platform === "win32") {
    const ps = `$p=${process.pid}; for($i=0;$i -lt 12;$i++){ $w=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $w){break}; if($w.Name -ieq '${name}.exe'){ $w.ProcessId; break }; $p=$w.ParentProcessId }`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]).then((s) => Number(s) || null);
  }
  return (async () => {
    let pid = process.pid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]));
      if (!m) return null;
      if (m[2].trim().split("/").pop() === name) return pid;
      pid = Number(m[1]);
    }
    return null;
  })();
}

// "90" | "90s" | "15m" | "4h" | "2d" -> seconds; an ISO time -> seconds from now. Throws on nonsense.
function parseDuration(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(s);
  if (m) return Math.round(Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]);
  const t = Date.parse(s);
  if (!isNaN(t)) return Math.max(0, Math.round((t - Date.now()) / 1000));
  throw new Error(`not a duration: ${v} (use 90, 90s, 15m, 4h, 2d or an ISO time)`);
}

// pick(obj, "a.b[0].c") — dot and bracket path; undefined when any step is missing.
function pick(obj, p) {
  if (p === undefined || p === null || p === "" || p === "$") return obj;
  const parts = String(p).replace(/^\$\.?/, "").replace(/\[(-?\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const k of parts) { if (cur === null || cur === undefined) return undefined; cur = Array.isArray(cur) && /^-\d+$/.test(k) ? cur[cur.length + Number(k)] : cur[k]; }   // [-1] is the last element
  return cur;
}

// template("MERGED {repo}#{number}", obj) — {path} substituted with pick(obj, path); missing -> "".
const template = (str, obj) => String(str).replace(/\{([^{}]+)\}/g, (_, p) => { const v = pick(obj, p.trim()); return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); });

// "${NAME}" in a string -> process.env.NAME (for headers and URLs in JSON watches; secrets stay out of files).
const envSubst = (s, env = process.env) => String(s).replace(/\$\{EPOCH([+-]\d+)?\}/g, (_, d) => String(Math.floor(Date.now() / 1000) + Number(d || 0))).replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => env[k] ?? "");   // ${EPOCH-300}: seconds, for time-windowed queries

// Append one line to a file (created if missing), creating the folder.
function appendLine(file, line) {
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}

const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// Run fn while holding <file>.lock (created with wx, so one holder at a time across processes); a
// lock older than 30 s is a crashed holder's and is taken over. Waits up to 10 s, then runs anyway
// rather than losing the write.
function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(require("path").dirname(file), { recursive: true });   // with no folder the lock can never be made: a 10 s spin
  const deadline = Date.now() + 10000;
  let held = false;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); held = true; break; } catch {}
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { return fn(); } finally { if (held) fs.rmSync(lock, { force: true }); }
}

// Which `bash` to run: on Windows a bare `bash` can resolve to the WSL stub in System32 (it does
// under a scheduled task, where Git's folder is not first on PATH), which fails with execvpe
// errors. WATCHHUB_BASH wins, then Git for Windows' bash where it is normally installed, then PATH.
function bashPath(env = process.env) {
  if (env.WATCHHUB_BASH) return env.WATCHHUB_BASH;
  if (process.platform === "win32") {
    for (const c of [`${env.ProgramFiles || "C:\\Program Files"}\\Git\\bin\\bash.exe`, `${env.LOCALAPPDATA || ""}\\Programs\\Git\\bin\\bash.exe`]) if (fs.existsSync(c)) return c;
  }
  return "bash";
}

// Read a byte range of a file as utf8.
function readRange(f, from, to) {
  if (to <= from) return "";
  const fd = fs.openSync(f, "r");
  try { const buf = Buffer.alloc(to - from); const n = fs.readSync(fd, buf, 0, buf.length, from); return buf.toString("utf8", 0, n); } finally { fs.closeSync(fd); }
}

// A leading ~ is the home directory on every shell (cmd and PowerShell pass it through unexpanded).
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());

module.exports = { expandHome, readJson, readJsonOrSetAside, writeAtomic, oneLine, sleep, nowIso, isAlive, isEnginePid, harnessPid, parseDuration, pick, template, envSubst, appendLine, fileSize, readRange, bashPath, withFileLock };
