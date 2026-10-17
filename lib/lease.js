// Leases: <instance>/leases/<inbox>.json says which waiter process holds an inbox. A new waiter for
// the same inbox replaces the file; the old waiter notices on its next check and exits on its own.
// So an inbox never has two waiters and nobody kills processes by pattern to get there. A waiter
// touches its lease every few seconds; a lease untouched for a while is stale whatever its pid says
// (Windows reuses pids).
const fs = require("fs");
const path = require("path");
const { readJson, writeAtomic, isAlive, nowIso } = require("./util");

const STALE_MS = 60000;
const file = (paths, inbox) => path.join(paths.leases, `${inbox}.json`);
const fresh = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs < STALE_MS; } catch { return false; } };

function take(paths, inbox, extra = {}) {
  fs.mkdirSync(paths.leases, { recursive: true });
  const prev = readJson(file(paths, inbox), null);
  const lease = { inbox, pid: process.pid, started: nowIso(), ...extra };
  const replaced = prev && prev.pid !== process.pid && isAlive(prev.pid) && fresh(file(paths, inbox)) ? prev : null;
  writeAtomic(file(paths, inbox), JSON.stringify(lease, null, 2) + "\n");
  return { lease, replaced };
}
const legacy = (l) => (l && l.lane && !l.inbox ? { ...l, inbox: l.lane } : l);   // files from before the rename say "lane"
const read = (paths, inbox) => legacy(readJson(file(paths, inbox), null));
const mine = (paths, inbox) => { const l = read(paths, inbox); return !!l && l.pid === process.pid; };
function touch(paths, inbox) { try { const t = new Date(); fs.utimesSync(file(paths, inbox), t, t); } catch {} }
function release(paths, inbox) { if (mine(paths, inbox)) fs.rmSync(file(paths, inbox), { force: true }); }
function list(paths) {
  if (!fs.existsSync(paths.leases)) return [];
  return fs.readdirSync(paths.leases).filter((x) => x.endsWith(".json")).map((f) => { const l = legacy(readJson(path.join(paths.leases, f), null)); return l && { ...l, alive: isAlive(l.pid) && fresh(path.join(paths.leases, f)) }; }).filter(Boolean);
}
// Drop lease files whose process is gone (a crash, a reboot). A lease that is merely silent is left
// alone: removing it would make a live waiter that stopped touching it exit as superseded.
function sweep(paths) { let n = 0; for (const l of list(paths)) if (!isAlive(l.pid)) { fs.rmSync(file(paths, l.inbox), { force: true }); n++; } return n; }

module.exports = { take, read, mine, touch, release, list, sweep };
