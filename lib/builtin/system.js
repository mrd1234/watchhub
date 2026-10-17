// system: this machine's free disk, memory and CPU, as the probe `system`, each kept as a metric too.
//   SYSTEM disk-c below 10: 8.2 (2 polls) / back       a drive's free GB past its bound
//   SYSTEM memory above 90: 93 / back                 memory in use, %
//   SYSTEM cpu above 90: 97 (3 polls) / back          CPU busy since the last poll, %, across every core
// Switched on by an instance.json `system` section; leave out what you do not want:
//   "system": { "scope": "host",
//               "disks": { "C:": { "below": 10 }, "/data": { "below": 50, "for": 2 } },   (GB free; a drive letter or a mount path)
//               "memory": { "above": 90 },
//               "cpu": { "above": 90, "for": 3 } }
// Any entry may carry `display` for the metric (see metrics.js). No tokens, no child programs.
const fs = require("fs");
const os = require("os");
const { detect } = require("../diff");

const metricName = (d) => `disk-${String(d).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-59) || "root"}`;   // metric names stop at 64
const diskPath = (d) => (/^[a-z]:$/i.test(d) ? `${d}\\` : d);
const cpuTimes = () => os.cpus().reduce((t, c) => { const all = Object.values(c.times).reduce((a, b) => a + b, 0); return { idle: t.idle + c.times.idle, all: t.all + all }; }, { idle: 0, all: 0 });

module.exports = () => ({
  name: "system",
  intervalSec: 60,
  enabled: (cfg) => !!cfg.system && cfg.probes?.system !== false,
  async check(st, cfg) {
    const s = cfg.system, scope = s.scope, events = [], metrics = [];
    const state = { checks: {}, ...(st || {}) }, checks = {};
    const read = (name, spec, value, unit, description, display) => {
      if (spec.above === undefined && spec.below === undefined) throw new Error(`system ${name} needs above or below`);
      const out = detect({ value: "v", above: spec.above, below: spec.below, for: spec.for }, state.checks[name], { v: value });
      checks[name] = out.state;
      for (const e of out.events) events.push(scope ? { scope, text: `SYSTEM ${e.replace(/^value v /, `${name} `)}` } : `SYSTEM ${e.replace(/^value v /, `${name} `)}`);
      metrics.push({ name, scope, value, description: spec.description || description, unit, display: spec.display || display, above: spec.above, below: spec.below, past: !!out.state.past });
    };
    for (const [d, spec] of Object.entries(s.disks || {})) {
      let free = null;
      try { const f = fs.statfsSync(diskPath(d)); free = Math.round((f.bavail * f.bsize) / 1e8) / 10; } catch { /* a drive that is gone reads as no value, not an error */ }
      read(metricName(d), spec, free, "GB", `Free space left on ${d}, in gigabytes. When a drive fills up, programs that write to it start failing.`);
    }
    if (s.memory) read("memory", s.memory, Math.round((1 - os.freemem() / os.totalmem()) * 100), "%", "How much of this computer's memory (RAM) is in use. Near 100%, it slows down as it swaps to disk.", { type: "dial", min: 0, max: 100 });
    let cpu;
    if (s.cpu) {
      // busy share since the last poll; the first poll has nothing to compare with and reads as no value
      cpu = cpuTimes();
      const prev = state.cpu, span = prev ? cpu.all - prev.all : 0;
      read("cpu", s.cpu, span > 0 ? Math.round((1 - (cpu.idle - prev.idle) / span) * 100) : null, "%", "How busy the processor was since the last poll, across every core. Held near 100%, everything on the computer slows down.", { type: "dial", min: 0, max: 100 });
    }
    return { events, state: { checks, ...(cpu ? { cpu } : {}) }, metrics };
  },
  now: (d) => Object.entries(d.checks || {}).map(([n, c]) => `${n} ${[undefined, "null", "(missing)"].includes(c.value) ? "?" : c.value}${c.past ? " PAST" : ""}`).join(", ") || "nothing configured",
});
