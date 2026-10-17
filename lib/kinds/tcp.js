// tcp: whether a host:port accepts a connection. Reported only once two polls in a row agree, so
// a blip mid-change makes no event. The first agreed state is reported too (a reachability watch
// means "tell me which side I am on").
//   {"tcp": {"host": "db.example.com", "port": 1521, "timeoutMs": 5000}}
module.exports = {
  name: "tcp",
  validate(w) { if (!w.tcp || !w.tcp.host || !w.tcp.port) throw new Error("tcp needs host and port"); },
  async poll(w, st = {}, cfg, env, api) {
    const seen = (await api.tcpReach(w.tcp.host, Number(w.tcp.port), w.tcp.timeoutMs || 5000)) ? "reachable" : "unreachable";
    const agreed = seen === st.seen;
    const events = agreed && seen !== st.state ? [`${seen} ${w.tcp.host}:${w.tcp.port}`] : [];
    return { events, state: { state: agreed ? seen : st.state, seen } };
  },
};
