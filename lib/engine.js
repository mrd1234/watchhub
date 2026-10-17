// The engine: one process per instance folder. It runs every source on its own timer (polls) or
// keeps it running (streams), appends one event line per change to events.log, and delivers each
// line to the inbox of every subscription it matches. Nothing here knows what is being watched.
const fs = require("fs");
const path = require("path");
const api = require("./api");
const sources = require("./sources");
const subs = require("./subs");
const plans = require("./plans");
const sinks = require("./sinks");
const events = require("./events");
const twoway = require("./twoway");
const agentskill = require("./agentskill");
const schedules = require("./schedules");
const { readJsonOrSetAside, writeAtomic, isAlive, isEnginePid, fileSize, nowIso } = require("./util");

const LOG_MAX = 5 * 1024 * 1024;

class Engine {
  constructor(inst) {
    this.inst = inst;
    this.paths = inst.paths;
    api.paths = inst.paths; api.instanceDir = inst.dir; // modules reach instance files (jobs.json, their own state files) through the api
    // state.json is read strictly: one that does not parse is set aside and reported once the engine runs,
    // never written over by the first save
    this.startNotes = [];
    this.state = readJsonOrSetAside(this.paths.state, {}, (m) => this.startNotes.push(m));
    if (!this.state || typeof this.state !== "object" || Array.isArray(this.state)) { this.startNotes.push("state.json did not hold an object; started empty"); this.state = {}; }
    this.probes = new Map();      // name -> probe
    this.timers = new Map();      // name -> timeout
    this.aborts = new Map();      // name -> AbortController (streams)
    this.busy = new Set();
    this.watchFiles = {};         // custom name -> watch json (for once / ttl)
    this.matchers = [];           // [{sub, test}]
    this.listeners = new Set();   // stream sources that read the event stream itself (derive watches, modules)
    this.sender = new sinks.Sender(this.paths.sinks, (m) => this.log(m), (t) => this.emit("watch", t));
    this.stopping = false;
    this.fired = new Set();       // schedule ids whose line is out but whose entry could not be removed yet
    // metrics.json and metrics/: the latest value and a day of history of every metric a poll reports;
    // an entry's inboxes are the subscriptions that would take a METRIC line for it
    this.metrics = new (require("./metrics").Store)(inst.dir, {
      live: (probe) => { const p = this.probes.get(probe); try { return !!p && p.enabled(this.cfg()) && !this.state[probe]?.envOff; } catch { return false; } },
      inboxes: (probe, scope, name) => { const ev = events.parse(events.format(probe, scope, `METRIC ${name}`)); return this.matchers.filter((m) => { try { return m.test(ev); } catch { return false; } }).map((m) => m.sub.inbox); },
      log: (m) => this.log(m),
    });
  }

  // instance.json re-read on each use so edits apply live; a file that fails to parse keeps the last good
  // config and is reported once, rather than silently switching every rule and interval off.
  cfg() {
    if (this.lastCfg && Date.now() - (this.cfgAt || 0) < 1000) return this.lastCfg;   // one parse a second at most: a spike is hundreds of events
    this.cfgAt = Date.now();
    let c;
    try { c = JSON.parse(fs.readFileSync(this.paths.config, "utf8")); this.badConfig = false; } catch (e) {
      if (!this.badConfig) { this.badConfig = true; this.log(`instance.json unreadable (${e.message}); keeping the last good config`); }
      return this.lastCfg || {};
    }
    return (this.lastCfg = c);
  }

  log(msg) {
    try {
      if (fileSize(this.paths.engineLog) > LOG_MAX) fs.renameSync(this.paths.engineLog, this.paths.engineLog + ".1");
      fs.appendFileSync(this.paths.engineLog, `${nowIso()} ${msg}\n`);
    } catch {}
  }

  // state.json is written at most once a second however many probes finish in that second.
  saveState() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushState(); }, 1000);
    this.saveTimer.unref();
  }
  flushState() { try { writeAtomic(this.paths.state, JSON.stringify(this.state, null, 1)); } catch (e) { this.log(`state not saved: ${e.message}`); } }

  // The last lines of events.log per probe, read once at start: a probe's first poll after a start
  // may re-derive a state the log already holds (a check verdict, an auth state), and that is not news.
  loadRecent() {
    this.recent = new Map();
    try {
      const size = fileSize(this.paths.events), text = size ? require("./util").readRange(this.paths.events, Math.max(0, size - 512 * 1024), size) : "";
      for (const l of text.split("\n")) { const ev = events.parse(l); if (!ev) continue; let set = this.recent.get(ev.probe); if (!set) this.recent.set(ev.probe, (set = new Set())); set.add(`${ev.scope} | ${ev.text}`); }
    } catch {}
  }

  // One event: to events.log, then to every inbox whose subscription matches. A line that cannot be
  // emitted (a module handed over something odd) is logged and dropped, never thrown into its source.
  emit(probe, ev) {
    try { this.emitOne(probe, ev); } catch (e) { this.log(`${probe}: line not emitted: ${e.stack || e}`); }
  }
  emitOne(probe, ev) {
    let { scope, text } = events.normalise(ev);
    text = twoway.unquote(text);   // only the handle added below can answer this line
    // a line an agent can answer carries its handle; the handle is recorded before anyone can read the line
    if (ev && ev.reply) { try { text += twoway.tag(twoway.remember(this.paths.replies, probe, ev.reply, Date.now(), (m) => setImmediate(() => this.emit("watch", m)))); } catch (e) { this.log(`${probe}: reply handle not recorded: ${e.message}`); } }
    const s = this.state[probe];
    if (s && !s.firstDone && this.recent?.get(probe)?.has(`${scope} | ${text}`)) { this.log(`${probe}: first poll repeated a known line, not emitted: ${text.slice(0, 120)}`); return; }
    const line = this.appendEvent(events.format(probe, scope, text));
    const parsed = events.parse(line);
    const delivered = [];   // the inboxes the line reached, for a caller that delivers to others directly
    const to = new Map();   // sink name -> extra template fields; one send per sink however many routes name it
    const p = this.probes.get(probe);
    for (const n of (p && p.watch && p.watch.sinks) || []) to.set(n, {});
    for (const n of (ev && Array.isArray(ev.sinks) && ev.sinks) || []) if (typeof n === "string") to.set(n, {});   // a module routes a line itself
    for (const m of this.matchers) {
      try {
        if (!m.test(parsed)) continue;
        subs.deliver(this.paths, m.sub.inbox, line, true);
        delivered.push(m.sub.inbox);
        for (const n of m.sub.sinks || []) to.set(n, { inbox: m.sub.inbox });
        if (m.plan) { const r = plans.sinksFor(m.plan, line); for (const n of r.sinks) to.set(n, { inbox: m.sub.inbox, ...r.extra }); }
      } catch (e) { this.log(`deliver ${m.sub.inbox}: ${e.message}`); }
    }
    for (const [n, extra] of to) this.sender.push(n, line, extra);
    for (const fn of this.listeners) { try { fn(parsed); } catch (e) { this.log(`listener: ${e.message}`); } }
    return { line, inboxes: delivered };
  }
  // events.log, rotated past engine.eventsLogMaxMb (default 100; 0 switches rotation off). A transient
  // EBUSY/EPERM (antivirus, a tool holding the file) or a full disk is logged, never fatal.
  appendEvent(line) {
    const max = Number(this.cfg().engine?.eventsLogMaxMb ?? 100);
    if (max && fileSize(this.paths.events) > max * 1024 * 1024) { try { fs.renameSync(this.paths.events, this.paths.events + ".1"); } catch {} }
    try { fs.appendFileSync(this.paths.events, line + "\n"); } catch (e) { this.log(`events.log not written: ${e.message} | ${line}`); }
    return line;
  }

  // ---- schedules ----
  // schedules.json is read again only when its size or modified time has changed (one stat per tick, every
  // 5 s), so a schedule fires within 5 s of its time. A due entry's line goes out first and the entry is
  // removed after: a crash between the two fires it again after the restart (same id, marked late). An id
  // whose removal failed is kept in memory so this process does not fire it twice, and removed again next tick.
  tickSchedules() {
    const f = this.paths.schedules;
    let st = null;
    try { st = fs.statSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const key = st ? `${st.size}:${st.mtimeMs}` : "";
    if (key !== this.schedulesKey) { this.schedulesKey = key; this.schedulesList = st ? schedules.readStrict(this.paths, (m) => this.emit("watch", m)) : []; }
    const now = Date.now();
    for (const e of this.schedulesList) {
      if (Date.parse(e.due) > now) break;   // soonest first
      if (!this.fired.has(e.id)) { this.fireSchedule(e, now); this.fired.add(e.id); }
      try { schedules.remove(this.paths, e.id, (m) => this.emit("watch", m)); this.fired.delete(e.id); } catch (err) { this.log(`schedule ${e.id} not removed from schedules.json: ${err.message}; tried again next tick`); }
    }
  }
  // One line per schedule. A scope target is an ordinary line, delivered by the matchers; inbox and sink
  // targets get the same line directly, whatever their filters, and an inbox the matchers reached is not
  // given it twice.
  fireSchedule(e, now = Date.now()) {
    const text = schedules.lineText(e, now), t = e.targets || {};
    const inboxes = schedules.inboxesOf(e), sinks = Array.isArray(t.sinks) ? t.sinks : [];
    let line, reached = new Set();
    if (t.scope) { const r = this.emitOne("schedule", { scope: t.scope, text }) || {}; line = r.line; reached = new Set(r.inboxes || []); }
    if (!line) line = this.appendEvent(events.format("schedule", "all", text));
    for (const inbox of inboxes) if (!reached.has(inbox)) { try { subs.deliver(this.paths, inbox, line, true); } catch (err) { this.log(`schedule ${e.id}: inbox ${inbox}: ${err.message}`); } }
    for (const n of sinks) this.sender.push(n, line, { schedule: e.id });
    this.log(`schedule ${e.id} fired: ${text.slice(0, 120)}`);
    // an inbox held only for its schedules is let go once the last one has fired: the waiter hands this line
    // over and ends, the next turn end is not held, and no expiry line wakes the session a day later for nothing
    for (const inbox of inboxes) {
      try {
        if (!schedules.isHold(subs.get(this.paths, inbox)) || schedules.pendingFor(this.paths, inbox, new Set([e.id])).length) continue;
        subs.remove(this.paths, inbox);
        this.log(`subscription ${inbox} removed: it was held for its schedules and none is pending`);
      } catch (err) { this.log(`schedule ${e.id}: hold on ${inbox} not released: ${err.message}`); }
    }
  }

  // ---- subscriptions ----
  loadSubs() {
    const list = subs.list(this.paths), next = [];
    for (const s of list) {
      if (subs.expired(s)) { this.endSub(s, "expired (ttl)"); continue; }
      try { next.push({ sub: s, test: subs.matcher(this.paths, s), plan: s.plan ? plans.load(this.paths.plans, s.plan) : null }); } catch (e) {
        // the inbox is told, otherwise it sits deaf until its TTL
        if (this.ignoredSubs?.[s.inbox] !== e.message) { subs.deliver(this.paths, s.inbox, events.format("watchhub", "all", `SUBSCRIPTION ${s.inbox} ignored: ${e.message}`)); this.log(`subscription ${s.inbox} ignored: ${e.message}`); }
        (this.ignoredSubs ||= {})[s.inbox] = e.message;
      }
    }
    this.matchers = next;
  }
  endSub(s, why) {
    subs.deliver(this.paths, s.inbox, events.format("watchhub", "all", `SUBSCRIPTION ${s.inbox} ${why}`));
    subs.remove(this.paths, s.inbox);
    this.log(`subscription ${s.inbox} ${why}`);
  }

  // ---- probes ----
  slot(name) { return this.state[name] || (this.state[name] = { fails: 0, failingReported: false, firstDone: false, data: undefined }); }

  // declared environment needs: unmet means the probe is off, said once, until it is met
  envOff(p, cfg) {
    const need = require("./envneed").missing(p.env, cfg, process.env);
    const s = this.slot(p.name);
    if (!need.length) { if (s.envOff) { delete s.envOff; this.log(`${p.name}: environment now set, running`); } return false; }
    const why = need.join(", ");
    if (s.envOff !== why) { s.envOff = why; this.log(`${p.name} off: ${why} not set (put it in ~/.watchhub/env)`); }
    return true;
  }

  async runPoll(p) {
    const cfg = this.cfg();
    if (!p.enabled(cfg) || this.envOff(p, cfg)) return;
    const s = this.slot(p.name);
    try {
      // a check that never settles would park its probe for good (busy stays set): bound it
      const limit = Math.min(3600, Math.max(300, 10 * (p.intervalSec || 30))) * 1000;
      let timer;
      const { events: evs = [], state: data, metrics: reported } = await Promise.race([
        p.check(s.data, cfg, process.env, api),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`check timed out after ${limit / 1000} s`)), limit); }),
      ]).finally(() => clearTimeout(timer));
      s.data = data;
      for (const e of evs) this.emit(p.name, e);
      // `once` registers no probes, so its metrics would only be wiped at the next write: it records none
      if (Array.isArray(reported) && !this.oneShot) this.metrics.record(p.name, p.watch ? p.watch.scope || "custom" : "all", (cfg.intervals || {})[p.name] || p.intervalSec || 30, reported);
      s.firstDone = true;   // from now on every line is news, repeats included (a flip back is a change)
      s.lastEvents = evs.length;
      // "recovered" is about the probe running again, never about what it watches: a custom watch
      // with a `match` says so, because its match has not fired (a fired match is its own line).
      if (s.failingReported) this.emit("watch", p.name.startsWith("custom:") ? `probe ${p.name} runs again (its match has not fired; a hit is its own line)` : `probe ${p.name} recovered`);
      s.fails = 0; s.failingReported = false; s.backoff = 1; s.lastOk = nowIso(); delete s.lastError; delete s.firstFail; // a cleared error no longer shows in `watch show` and `status`
    } catch (err) {
      this.fail(p, s, err);
    }
    s.lastRun = nowIso();
    this.saveState();
  }

  fail(p, s, err) {
    s.fails++;
    s.lastError = String(err && err.message || err).replace(/\s+/g, " ").slice(0, 160);
    this.log(`${p.name} failed: ${s.lastError}${err && err.stderr ? " | " + String(err.stderr).trim().slice(-500).replace(/\s+/g, " ") : ""}`);
    // rate limited: double this probe's interval (up to 16x) until it next succeeds
    if (/\b(403|429)\b|rate ?limit/i.test(s.lastError) || err?.status === 403 || err?.status === 429) s.backoff = Math.min((s.backoff || 1) * 2, 16);
    // a network blip (a VPN switch, DNS for a minute) fails every poll source twice in a row: reported only
    // when the failure has lasted three polls, or two polls spread over two minutes, so a 40 s blip is not
    // a failing line and a recovered line on every inbox that named the probe
    if (s.fails === 1) s.firstFail = Date.now();
    if (!s.failingReported && (s.fails >= 3 || (s.fails >= 2 && Date.now() - (s.firstFail || 0) > 120000))) { this.emit("watch", `probe ${p.name} failing: ${s.lastError}`); s.failingReported = true; }
  }

  schedule(p) {
    // only the probe object currently registered under this name is rescheduled: a watch edited while
    // its poll was in flight has been replaced, and the old spec must not keep its own timer chain
    if (this.stopping || this.probes.get(p.name) !== p) return;
    const intervals = this.cfg().intervals || {};
    const every = (intervals[p.name] || p.intervalSec || 30) * (this.state[p.name]?.backoff || 1) * 1000;
    clearTimeout(this.timers.get(p.name));
    this.timers.set(p.name, setTimeout(() => this.tick(p), every));
  }
  async tick(p) {
    this.timers.delete(p.name);
    if (this.busy.has(p.name) || this.probes.get(p.name) !== p) return;
    this.busy.add(p.name);
    try {
      if (p.watch && sources.expired(p.watch)) { this.emit(p.name, { scope: p.watch.scope || "custom", text: "expired (ttl)" }); this.dropWatch(p); return; }
      await this.runPoll(p);
      if (p.watch?.once && this.state[p.name]?.lastEvents > 0) this.dropWatch(p);
    } catch (e) { this.log(`${p.name} tick: ${e.message}`); }
    finally { this.busy.delete(p.name); this.schedule(p); }
  }

  // A stream runs until it ends or fails; then it is restarted with back-off (5 s doubling to 5 min,
  // reset once it has run for a minute). Failing / recovered lines follow the poll rules.
  async runStream(p) {
    const s = this.slot(p.name);
    // a throw here would end this stream's timer chain for good: it is logged and tried again in a minute
    let off;
    try { off = !p.enabled(this.cfg()) || this.envOff(p, this.cfg()); } catch (e) { this.log(`${p.name}: not started: ${e.message}`); off = true; }
    if (off) { this.timers.set(p.name, setTimeout(() => this.runStream(p), 60000)); return; }
    const ac = new AbortController();
    this.aborts.set(p.name, ac);
    const started = Date.now();
    s.lastRun = nowIso();
    const ctx = { signal: ac.signal, cfg: this.cfg(), env: process.env, api, log: (m) => this.log(`${p.name}: ${m}`),
      state: s.data, setState: (d) => { s.data = d; this.saveState(); },
      emit: (ev) => { if (ac.signal.aborted) return; s.lastEvents = (s.lastEvents || 0) + 1; this.emit(p.name, ev); if (p.watch?.once) this.dropWatch(p); },
      running: () => { s.firstDone = true; if (s.failingReported) { this.emit("watch", `probe ${p.name} recovered`); } s.fails = 0; s.failingReported = false; s.lastOk = nowIso(); this.saveState(); },
      // the event stream itself, for sources that derive from it; dropped with the stream's abort
      subscribe: (fn) => { this.listeners.add(fn); ac.signal.addEventListener("abort", () => this.listeners.delete(fn)); return () => this.listeners.delete(fn); } };
    let err = null;
    try { await p.start(ctx); } catch (e) { err = e; }
    this.aborts.delete(p.name);
    if (ac.signal.aborted || this.stopping || !this.probes.has(p.name)) return;
    if (Date.now() - started > 60000) { s.fails = 0; if (s.failingReported) { this.emit("watch", `probe ${p.name} recovered`); s.failingReported = false; } }
    if (err) this.fail(p, s, err); else this.log(`${p.name} ended; restarting`);
    this.saveState();
    const wait = Math.min(5000 * 2 ** Math.max(0, s.fails - 1), 300000);
    this.timers.set(p.name, setTimeout(() => this.runStream(p), wait));
  }

  add(p) {
    if (this.probes.has(p.name)) return;
    this.probes.set(p.name, p);
    if (p.stream) this.runStream(p); else this.timers.set(p.name, setTimeout(() => this.tick(p), 50));
  }
  removeProbe(name) {
    this.probes.delete(name);
    this.metrics.schedule();   // its metrics leave metrics.json at the next write
    clearTimeout(this.timers.get(name)); this.timers.delete(name);
    const ac = this.aborts.get(name); if (ac) ac.abort();
  }
  dropWatch(p) {
    const w = p.watch;
    if (w?._path) fs.rmSync(w._path, { force: true });
    this.removeProbe(p.name);
    delete this.state[p.name];
  }

  // JSON watches are re-read whenever the folder changes (and once a minute regardless): a new file
  // starts, a removed one stops, a changed one restarts. An invalid file is reported once.
  refreshWatches() {
    subs.resetKnown(); // a new watch is a new probe name for filters; matchers are rebuilt by loadSubs
    const list = sources.loadWatches(this.paths.watches), seen = new Set();
    for (const w of list) {
      const name = `custom:${w.name}`;
      if (w.invalid) { if (this.watchFiles[w.name]?.invalid !== w.invalid) this.log(`watch ${w.name} ignored: ${w.invalid}`); this.watchFiles[w.name] = w; continue; }
      seen.add(name);
      const prev = this.watchFiles[w.name];
      // `created` is part of the comparison: re-adding a watch sets it afresh, which is how a TTL is extended
      const changed = !prev || JSON.stringify({ ...prev, _path: 0 }) !== JSON.stringify({ ...w, _path: 0 });
      this.watchFiles[w.name] = w;
      if (changed && this.probes.has(name)) { this.removeProbe(name); delete this.state[name]; }
      if (!this.probes.has(name)) {
        if (sources.expired(w)) { this.emit(name, { scope: w.scope || "custom", text: "expired (ttl)" }); fs.rmSync(w._path, { force: true }); delete this.watchFiles[w.name]; continue; }
        this.add(sources.toProbe(w));
      }
    }
    for (const name of [...this.probes.keys()]) if (name.startsWith("custom:") && !seen.has(name)) { this.removeProbe(name); delete this.state[name]; }
    for (const k of Object.keys(this.state)) if (k.startsWith("custom:") && !seen.has(k)) delete this.state[k];
    for (const n of Object.keys(this.watchFiles)) if (!list.some((w) => w.name === n)) delete this.watchFiles[n]; // removed files, valid or not
  }

  // ---- lifecycle ----
  // Whether this process may write state.json: the lock is its own, or gone (a stop for a dead pid cleared it).
  // Another pid in the lock means a live engine took over, and this one's state is stale.
  lockIsMine() { const raw = readLockPid(this.paths.lock); return raw === "" || raw === String(process.pid); }

  // engine.lock holds the pid and is touched every 30 s. A lock counts as live only when its pid is
  // alive AND it was touched recently: Windows reuses pids, so a dead engine's pid can belong to
  // some other process within minutes, and a pid check alone would call that engine "running".
  takeLock() {
    for (let i = 0; i < 4; i++) {
      try { fs.writeFileSync(this.paths.lock, String(process.pid), { flag: "wx" }); return; } catch {}
      const raw = readLockPid(this.paths.lock);
      // an empty lock is one another engine is writing this instant: wait for it rather than clearing it
      if (!raw) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); continue; }
      const owner = enginePid(this.paths);
      if (owner) { const e = new Error(`already running (pid ${owner})`); e.code = 3; throw e; }
      fs.rmSync(this.paths.lock, { force: true });
    }
    const owner = enginePid(this.paths);
    const e = new Error(owner ? `already running (pid ${owner})` : "could not take engine.lock"); e.code = owner ? 3 : 4; throw e;
  }

  watchDir(dir, fn) {
    fs.mkdirSync(dir, { recursive: true });
    let t = null;
    try { fs.watch(dir, { persistent: false }, () => { clearTimeout(t); t = setTimeout(fn, 400); }); } catch (e) { this.log(`fs.watch ${dir}: ${e.message} (rescan every 60 s covers it)`); }
  }

  async run() {
    this.takeLock();
    // Under the scheduled task there is no console: anything written to stderr lands in engine.log instead.
    console.error = (...a) => this.log(a.map((x) => (x && x.stack) || String(x)).join(" "));
    for (const d of [this.paths.watches, this.paths.subs, this.paths.inbox, this.paths.leases, this.paths.plans, this.paths.modules, this.paths.sinks]) fs.mkdirSync(d, { recursive: true });
    const drop = () => { try { if (Number(readLockPid(this.paths.lock)) === process.pid) fs.rmSync(this.paths.lock); } catch {} };
    // the last state lands, pending write or not, unless another engine holds the lock by now: this one is the
    // duplicate, and its state would write over the live engine's
    process.on("exit", (code) => { clearTimeout(this.saveTimer); if (this.lockIsMine()) this.flushState(); else this.log(`state not written on exit: engine.lock is held by pid ${readLockPid(this.paths.lock)}`); if (this.metrics.timer) this.metrics.flush(); this.log(`engine exit (code ${code})`); drop(); });
    // the heartbeat also checks the lock is still ours: a lock that vanished is written again, a lock
    // another live engine holds means this one is the duplicate (a stale heartbeat after a long sleep
    // let it start) and it leaves, so two engines never write state.json and events.log together; it leaves
    // with 3, as a start that finds the lock held does, so a launcher behind it stands by instead of ending
    setInterval(() => {
      const raw = readLockPid(this.paths.lock);
      if (raw === String(process.pid)) { try { const t = new Date(); fs.utimesSync(this.paths.lock, t, t); } catch {} return; }
      const other = Number(raw);
      if (other && other !== process.pid && isEnginePid(other)) { this.log(`engine.lock is held by live engine pid ${other}; this engine (pid ${process.pid}) leaves to it`); this.shutdown(3); return; }
      try { fs.writeFileSync(this.paths.lock, String(process.pid)); this.log("engine.lock was missing or stale; written again"); } catch {}
    }, LOCK_TOUCH_MS).unref();
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { this.log("engine stopping (signal)"); this.shutdown(0); });
    // `watchhub stop` asks through a file: Windows has no signal an engine can catch, and a plain kill
    // would skip the stream kills and the state flush. The request names the pid it is for.
    try { fs.rmSync(this.paths.stopRequest, { force: true }); } catch {}
    setInterval(() => {
      let want; try { want = fs.readFileSync(this.paths.stopRequest, "utf8").trim(); } catch { return; }
      if (want && want !== String(process.pid)) { if (!isAlive(Number(want))) { try { fs.rmSync(this.paths.stopRequest, { force: true }); } catch {} } return; }   // for another engine: cleared once that one is gone
      try { fs.rmSync(this.paths.stopRequest, { force: true }); } catch {}
      if (!want) return;
      this.log("engine stopping (requested)"); this.shutdown(0);
    }, 1000).unref();
    // an uncaught exception is almost always one module's callback (a stream without an error listener, a throw
    // in its own timer): the other sources are untouched, so the engine logs it and keeps running. Five inside
    // ten minutes means something is wrong at the core: exit 1 and let the service start it clean.
    const uncaught = [];
    process.on("uncaughtException", (e) => {
      const now = Date.now();
      uncaught.push(now); while (uncaught[0] < now - 600000) uncaught.shift();
      if (uncaught.length < 5 && !this.stopping) { this.log(`uncaught exception (kept running, ${uncaught.length} in 10 min): ${e.stack || e}`); return; }
      this.log(`fatal: ${e.stack || e}`); this.shutdown(1);
    });
    process.on("unhandledRejection", (e) => { this.log(`unhandled rejection: ${(e && e.stack) || e}`); });   // logged, not fatal: one source's bug must not take the engine down

    this.loadRecent();
    for (const k of Object.keys(this.state)) if (!k.startsWith("_") && this.state[k]) this.state[k].firstDone = false;
    const code = sources.allCode(this.paths.modules, (m) => this.log(m));
    this.code = code;   // the agent skill lists the enabled ones without loading the modules again
    for (const p of code) if (p.onStart) { try { p.onStart(this.slot(p.name), this.cfg()); } catch (e) { this.log(`${p.name} onStart: ${e.message}`); } }
    this.loadSubs();
    for (const m of this.startNotes) this.emit("watch", m);   // a state.json set aside at start is said once, as a health line
    this.startNotes = [];
    this.state._engine = { pid: process.pid, started: nowIso(), node: process.version, version: require("../package.json").version }; // for stats; keys starting with _ are not probes
    const names = new Set(code.map((p) => p.name));
    for (const k of Object.keys(this.state)) if (!k.startsWith("_") && !k.startsWith("custom:") && !names.has(k)) { delete this.state[k]; this.log(`state of ${k} dropped: no such source any more`); }
    this.log(`engine started (pid ${process.pid}, ${code.length} code sources, node ${process.version})`);   // log only: a restart that loses nothing is nobody's wake
    for (const p of code) this.add(p);
    this.refreshWatches();
    this.refreshSkills();

    const guard = (fn, what) => () => { try { fn(); } catch (e) { this.log(`${what}: ${e.message}`); } };
    this.watchDir(this.paths.watches, guard(() => { this.refreshWatches(); this.refreshAgentSkill(); }, "watches reload"));
    this.watchDir(this.paths.subs, guard(() => this.loadSubs(), "subscriptions reload"));
    this.watchDir(this.paths.plans, guard(() => { this.loadSubs(); this.refreshSkills(); }, "plans reload"));   // a plan's rules and sinks are held by its matchers
    this.watchDir(this.paths.sinks, guard(() => { this.sender.reload(); this.refreshAgentSkill(); }, "sinks reload"));
    // the rescan also catches instance.json edits (agentNotes, scopes, probes) for the agent skill
    setInterval(guard(() => { this.refreshWatches(); this.loadSubs(); this.sender.reload(); this.refreshAgentSkill(); }, "rescan"), 60000).unref();
    this.watchDir(this.paths.watches, guard(() => this.loadSubs(), "subscriptions after watches"));
    guard(() => this.tickSchedules(), "schedules")();   // one missed while the engine was down fires now, marked late
    setInterval(guard(() => this.tickSchedules(), "schedules"), 5000).unref();
    // Memory: one check an hour; above the cap the engine exits once and the service (or the next `wait`) revives it.
    setInterval(() => {
      const mb = Math.round(process.memoryUsage().rss / 1048576), cap = Number(this.cfg().engine?.memoryCapMb || 400);
      this.log(`rss ${mb} MB, ${this.probes.size} probes, ${this.matchers.length} subscriptions`);
      // exit code 2 is "restart me": the service runs a non-zero exit again; without the service the next wait does it
      if (mb > cap) { this.log(`engine stopping: rss ${mb} MB over the ${cap} MB cap; the service runs it again (or the next wait)`); this.shutdown(2); }
    }, 3600000).unref();
    await new Promise(() => {}); // run until a signal
  }

  // A plan that names a skill keeps that skill's SKILL.md current under <instance>/skills/<name> (or where
  // `plan skill --out` put it, remembered in the plan as skillDir), so codes and text never drift apart.
  // The agent skill lists the plans, so it is rewritten here too (and on start, after an upgrade).
  refreshSkills() {
    this.refreshAgentSkill();
    for (const p of plans.list(this.paths.plans)) {
      if (p.invalid || !p.skill) continue;
      try {
        const dir = p.skillDir || path.join(this.inst.dir, "skills", p.skill), f = path.join(dir, "SKILL.md"), text = plans.skillText(p, p.skill);
        if (fs.existsSync(f) && fs.readFileSync(f, "utf8") === text) continue;
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, text); this.log(`skill ${p.skill} rewritten from plan ${p.name}`);
      } catch (e) { this.log(`skill for plan ${p.name}: ${e.message}`); }
    }
  }

  // The agent skill (agentskill.js): never fatal, a bad agent-skills.json or folder is one log line.
  refreshAgentSkill() { try { agentskill.refresh(this.inst, (m) => this.log(m), this.code); } catch (e) { this.log(`agent skill: ${e.message}`); } }

  // Stop everything and exit: streams are aborted (an exec watch's taskkill needs a moment to be spawned,
  // or the child it was ending outlives the engine), timers cleared, state flushed by the exit handler.
  shutdown(code) {
    if (this.stopping) return;
    this.stopping = true;
    for (const ac of this.aborts.values()) { try { ac.abort(); } catch {} }
    for (const t of this.timers.values()) clearTimeout(t);
    setTimeout(() => process.exit(code), this.aborts.size ? 700 : 0);
    setTimeout(() => process.exit(code), 3000).unref();   // whatever a stream does on abort, the engine does not hang
  }

  // Run every enabled poll source once (streams are skipped) and return. Refuses while an engine runs.
  async once() {
    const owner = enginePid(this.paths);
    if (owner) { const e = new Error(`engine running (pid ${owner}); stop it first (both would write state.json)`); e.code = 3; throw e; }
    this.oneShot = true;
    this.loadSubs();
    const all = [...sources.allCode(this.paths.modules, (m) => this.log(m)), ...sources.loadWatches(this.paths.watches).filter((w) => !w.invalid).map(sources.toProbe)];
    await Promise.all(all.filter((p) => !p.stream).map((p) => this.runPoll(p)));
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flushState();
  }
}

const LOCK_TOUCH_MS = 30000, LOCK_STALE_MS = 150000;
function readLockPid(f) { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } }
// The running engine's pid, or 0: pid alive and the lock touched within LOCK_STALE_MS (see takeLock).
// An empty lock (being written right now) counts as running for the moment, so a second starter waits.
const enginePid = (paths) => {
  const raw = readLockPid(paths.lock);
  if (raw === "" && fs.existsSync(paths.lock)) { try { return Date.now() - fs.statSync(paths.lock).mtimeMs < 5000 ? -1 : 0; } catch { return 0; } }
  const pid = Number(raw);
  if (!pid || !isAlive(pid)) return 0;
  try { return Date.now() - fs.statSync(paths.lock).mtimeMs < LOCK_STALE_MS ? pid : 0; } catch { return 0; }
};

module.exports = { Engine, enginePid };
