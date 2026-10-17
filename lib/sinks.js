// Sinks: where a line goes besides an inbox. <instance>/sinks/<name>.json is one of
//   { "name": "slack", "http": { "url": "${SLACK_WEBHOOK_URL}", "body": { "text": "{text}" } } }
//   { "name": "toast", "toast": { "title": "watchhub" } }
//   { "name": "team", "slack": { "channel": "#team" } }
// An http sink posts a templated body (any webhook: Slack, Teams workflow, Discord, a pager, your
// own endpoint); a toast sink shows a Windows notification; a slack sink posts as the person through the
// user token (lib/slack.js) to any channel, private channel or DM, one file per target and no webhook each. Nothing a sink does feeds back into the
// engine: it is notification only. A line reaches a sink when the watch that produced it names the
// sink (`"sinks": [...]` on the watch), when a subscription it matched names it (`sub --sinks`), or
// when the plan of such a subscription names it (plan `sinks`, overridable per `on` rule).
// Sends are serialised per sink and a burst that arrives while one send is in flight goes out as a
// single message, so a sink is never hammered by a stream of lines.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { template, envSubst } = require("./util");

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS = ["http", "toast", "slack"];
const MAX_LINES = 20;        // lines in one batched message; the rest is counted
const MAX_HELD = 200;        // lines kept for a sink whose sends fail; past this the oldest go
const RETRY_MS = [60000, 300000, 900000];   // the pause before a failed batch is sent again: after the 1st, 2nd, and later failures in a row

function check(s) {
  if (!s || !NAME.test(s.name || "")) throw new Error("sink needs a name of lowercase letters, digits and dashes");
  const ks = KINDS.filter((k) => s[k] !== undefined);
  if (ks.length !== 1) throw new Error(`exactly one of ${KINDS.join(", ")} needed`);
  if (s.http) {
    if (typeof s.http.url !== "string" || !/^https?:\/\/|^\$\{/.test(s.http.url)) throw new Error("http.url must be an http(s) URL (it may be ${ENV})");
    if (s.http.method !== undefined && !/^[A-Z]+$/.test(s.http.method)) throw new Error("http.method must be uppercase, such as POST");
    if (s.http.headers !== undefined && (typeof s.http.headers !== "object" || Array.isArray(s.http.headers))) throw new Error("http.headers must be an object");
    if (s.http.body !== undefined && s.http.body !== null && typeof s.http.body !== "object" && typeof s.http.body !== "string") throw new Error("http.body must be an object (sent as JSON) or a string");
  }
  if (s.toast && s.toast.title !== undefined && typeof s.toast.title !== "string") throw new Error("toast.title must be a string");
  if (s.slack) {
    if (typeof s.slack.channel !== "string" || !s.slack.channel) throw new Error("slack.channel must be #name, an id, or @me");
    if (s.slack.tokenEnv !== undefined && !/^[A-Z0-9_]+$/i.test(s.slack.tokenEnv)) throw new Error("slack.tokenEnv must be an environment variable name");
  }
  return s;
}
const checkNames = (v, what) => { if (v !== undefined && !(Array.isArray(v) && v.every((n) => typeof n === "string" && NAME.test(n)))) throw new Error(`${what} must be a list of sink names`); };

const file = (dir, name) => path.join(dir, `${name}.json`);
function load(dir) {
  const out = { sinks: {}, invalid: {} };
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const name = path.basename(f, ".json");
    try { const s = check(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); if (s.name !== name) throw new Error(`name ${s.name} does not match the file name ${name}`); out.sinks[name] = s; }
    catch (e) { out.invalid[name] = e.message; }
  }
  return out;
}
function save(dir, s) { check(s); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(dir, s.name), JSON.stringify(s, null, 2) + "\n"); }
function remove(dir, name) { const f = file(dir, name); if (!fs.existsSync(f)) return false; fs.rmSync(f); return true; }

// The template context for one line or a batch: {text} the message(s), {line} the whole line(s),
// {probe} {scope} {at} from the first line, {count} lines in the batch, {instance} the folder name.
function context(lines, extra = {}) {
  const events = require("./events");
  const parsed = lines.map((l) => events.parse(l) || { at: "", probe: "", scope: "", text: l, line: l });
  const first = parsed[0];
  const more = lines.length > MAX_LINES ? `\n(+${lines.length - MAX_LINES} more)` : "";
  return { text: parsed.slice(0, MAX_LINES).map((p) => p.text).join("\n") + more, line: lines.slice(0, MAX_LINES).join("\n") + more,
    probe: first.probe, scope: first.scope, at: first.at, count: lines.length, ...extra };
}

// Walk a body template: every string is templated; objects and arrays are walked.
const fill = (v, ctx) => typeof v === "string" ? template(v, ctx) : Array.isArray(v) ? v.map((x) => fill(x, ctx)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ctx)])) : v;

// anything that came from the environment (a webhook URL path, a token header) is scrubbed from error text
const scrub = (text, s, env) => { let t = String(text); for (const m of JSON.stringify(s).matchAll(/\$\{([A-Z0-9_]+)\}/gi)) { const v = env[m[1]]; if (v && v.length >= 8) t = t.split(v).join("[" + m[1] + "]"); } return t; };
async function sendHttp(s, ctx, env = process.env) {
  const url = envSubst(s.http.url, env);
  if (!/^https?:\/\//.test(url)) throw new Error(`url is empty after substitution (is ${s.http.url} set?)`);
  const headers = Object.fromEntries(Object.entries(s.http.headers || {}).map(([k, v]) => [k, envSubst(String(v), env)]));
  const body = s.http.body === undefined ? { text: "{text}" } : s.http.body;
  const payload = typeof body === "string" ? template(body, ctx) : JSON.stringify(fill(body, ctx));
  if (typeof body !== "string" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method: s.http.method || "POST", headers, body: payload, signal: AbortSignal.timeout(20000) });
  const t = scrub((await r.text().catch(() => "")).slice(0, 200), s, env);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).host}${t ? `: ${t}` : ""}`);
  // APIs in the Slack style answer 200 with {"ok": false, "error": ...}: that is a failure too
  try { const j = JSON.parse(t); if (j && typeof j === "object" && j.ok === false) throw new Error(`${new URL(url).host} said ${j.error || "ok: false"}`); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
}

// chat.postMessage as the person; the channel map and self id are cached per process, not in a file
const slackCache = {};
async function sendSlack(s, ctx, env = process.env) {
  const slack = require("./slack"), tokenEnv = s.slack.tokenEnv || "SLACK_USER_TOKEN";
  const channel = await slack.channelId(s.slack.channel, slackCache, env, tokenEnv);
  await slack.post(channel, template(s.slack.text || "{text}", ctx), env, tokenEnv);
}

// A desktop notification: on Windows a toast through the WinRT notifier in Windows PowerShell (no
// module, no admin; title and text travel as environment variables, so no quoting of the message is
// ever needed), on macOS Notification Centre, on Linux notify-send.
const TOAST_PS = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $esc $env:WATCHHUB_TOAST_TITLE)</text><text>$(& $esc $env:WATCHHUB_TOAST_TEXT)</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;
function sendToast(s, ctx, env = process.env) {
  const title = template(s.toast?.title || "watchhub", ctx), text = template(s.toast?.text || "{text}", ctx).slice(0, 400);
  const done = (resolve, reject) => (err, _out, stderr) => err ? reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0].slice(0, 160))) : resolve();
  if (process.platform === "win32") {
    const ps = path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise((resolve, reject) => execFile(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_PS], { timeout: 20000, windowsHide: true, env: { ...env, WATCHHUB_TOAST_TITLE: title, WATCHHUB_TOAST_TEXT: text } }, done(resolve, reject)));
  }
  // macOS: Notification Centre through osascript; Linux: notify-send (libnotify) where a desktop runs
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (process.platform === "darwin") return new Promise((resolve, reject) => execFile("osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}"`], { timeout: 20000 }, done(resolve, reject)));
  return new Promise((resolve, reject) => execFile("notify-send", [title, text], { timeout: 20000 }, done(resolve, reject)));
}

const send = (s, ctx, env) => s.http ? sendHttp(s, ctx, env) : s.slack ? sendSlack(s, ctx, env) : sendToast(s, ctx, env);

// A Sender owns the per-sink queues: push(name, line) returns at once; lines queued while a send is
// in flight go out together. A batch that fails to send is kept and sent again after a pause that grows
// with the failures in a row (1, 5, then 15 minutes), up to MAX_HELD lines per sink; after three failures
// in a row the engine emits one line about it (and one when the sink works again), so a dead webhook is
// not silent for a week. The retries live in memory: a restart loses the held lines from that sink only.
class Sender {
  constructor(dir, log, emit, opts = {}) { this.dir = dir; this.log = log; this.emit = emit; this.retryMs = opts.retryMs || RETRY_MS; this.queues = new Map(); this.fails = new Map(); this.reload(); }
  reload() { const r = load(this.dir); this.sinks = r.sinks; for (const [n, why] of Object.entries(r.invalid)) if (this.invalid?.[n] !== why) this.log(`sink ${n} ignored: ${why}`); this.invalid = r.invalid; }
  names() { return Object.keys(this.sinks); }
  push(name, line, extra) {
    const s = this.sinks[name];
    if (!s) { if (!this.missing?.has(name)) { (this.missing ||= new Set()).add(name); this.log(`sink ${name} named but not defined in ${this.dir}`); } return; }
    let q = this.queues.get(name);
    if (!q) { q = { lines: [], extra, busy: false }; this.queues.set(name, q); }
    q.lines.push(line); q.extra = extra;
    if (!q.busy && !q.retry) this.drain(name);   // during a retry pause the line waits for the retry
  }
  async drain(name) {
    const q = this.queues.get(name), s = this.sinks[name];
    if (!q) return;
    if (!s || !q.lines.length) { q.busy = false; q.lines.length = 0; return; }   // a sink removed while lines waited: dropped, and the queue is not left "busy" for good
    q.busy = true;
    const lines = q.lines.splice(0), ctx = context(lines, { sink: name, instance: path.basename(path.dirname(this.dir)), ...(q.extra || {}) });
    try {
      await send(s, ctx);
      const n = this.fails.get(name) || 0;
      if (n >= 3) this.emit(`sink ${name} works again`);
      this.fails.set(name, 0);
    } catch (e) {
      const n = (this.fails.get(name) || 0) + 1;
      this.fails.set(name, n);
      // the batch goes back to the front of the queue; past MAX_HELD lines the oldest are dropped, so an
      // outage cannot grow the queue for good
      q.lines.unshift(...lines);
      const over = Math.max(0, q.lines.length - MAX_HELD);
      if (over) q.lines.splice(0, over);
      const wait = this.retryMs[Math.min(n, this.retryMs.length) - 1];
      this.log(`sink ${name}: ${e.message} (${lines.length} line${lines.length === 1 ? "" : "s"} kept, sent again in ${Math.round(wait / 1000)} s${over ? `; ${over} oldest dropped, over ${MAX_HELD} held` : ""})`);
      if (n === 3) this.emit(`sink ${name} failing: ${e.message}`);
      q.busy = false;
      q.retry = setTimeout(() => { q.retry = null; this.drain(name); }, wait);
      q.retry.unref();
      return;
    }
    q.busy = false;
    if (q.lines.length) setTimeout(() => this.drain(name), 1000); // a breath between messages: Slack and friends rate-limit bursts
  }
}

module.exports = { NAME, MAX_HELD, RETRY_MS, check, checkNames, load, save, remove, file, context, send, Sender };
