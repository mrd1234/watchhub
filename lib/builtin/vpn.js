// vpn: which network side you are on, as the probe `vpn`: `VPN <side>` where side is one of the
// configured names, "both" (several answer) or "none". Each side is a check that only succeeds from
// that side: a TCP connect, an HTTP URL that must answer, or a command that must exit 0. A side is
// reported only once two polls agree, so a blip mid-switch makes no event; the saved side survives a
// restart. Switched on by an instance.json `vpn` section:
//   "vpn": { "office": { "tcp": "intranet.example.com:443" },
//            "cloud":  { "http": "https://internal.example.net/health" },
//            "lab":    { "command": "ping -n 1 10.0.0.1" } }
// (`"side": "host"` with a top-level `port` is the short form for a TCP check.) A switch between sides
// passes through a short spell of none; `"noneAfterSec": 120` holds none back until it has lasted that
// long, so a switch makes one event (the new side) and a drop that comes back to the same side makes none.
const OPTIONS = ["port", "noneAfterSec"];
module.exports = (api) => ({
  options: OPTIONS,
  name: "vpn",
  intervalSec: 15,
  enabled: (cfg) => !!cfg.vpn && Object.keys(cfg.vpn).some((k) => !OPTIONS.includes(k)) && cfg.probes?.vpn !== false,
  async check(st = {}, cfg) {
    const { port = 443, noneAfterSec = 0, ...sides } = cfg.vpn;
    const names = Object.keys(sides);
    const probe = async (spec) => {
      if (typeof spec === "string") return api.tcpReach(spec, port);
      if (spec.tcp) { const [h, p] = String(spec.tcp).split(":"); return api.tcpReach(h, Number(p || port), spec.timeoutMs || 5000); }
      if (spec.http) { try { const r = await api.fetchRaw(spec.http, {}, (spec.timeoutMs || 5000) / 1000); return r.ok; } catch { return false; } }
      if (spec.command) { try { await api.run(api.bashPath(), ["-c", spec.command], (spec.timeoutMs || 5000) / 1000); return true; } catch { return false; } }
      throw new Error(`vpn side needs tcp, http or command`);
    };
    const up = await Promise.all(names.map((n) => probe(sides[n])));
    const on = names.filter((_, i) => up[i]);
    const seen = on.length === 0 ? "none" : on.length === names.length && names.length > 1 ? "both" : on.join("+");
    const agreed = seen === st.seen;
    const since = agreed && st.since ? st.since : Date.now();   // when the polls first saw this side
    const held = seen === "none" && st.side && Date.now() - since < (Number(noneAfterSec) || 0) * 1000;
    const report = agreed && seen !== st.side && !held;
    return { events: report ? [`VPN ${seen}`] : [], state: { side: report ? seen : st.side, seen, since } };
  },
  now: (d) => `side ${d.side || "not settled"}${d.seen && d.seen !== d.side ? ` (polls see ${d.seen}${d.since ? ` since ${new Date(d.since).toISOString().slice(11, 19)}Z` : ""})` : ""}`,
});
