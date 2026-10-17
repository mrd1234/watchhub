// __NAME__: a watchhub stream module. start(ctx) runs for as long as the source lasts (a socket, a
// queue consumer, a change feed, a process); emit a line for each thing that happens; return (or throw)
// when it ends and the engine restarts it with back-off. ctx.signal aborts it on stop or reload.
module.exports = (api) => ({
  name: "__NAME__",
  stream: true,
  env: [],                               // e.g. ["QUEUE_URL"]
  enabled: (cfg) => cfg.probes?.["__NAME__"] !== false,

  // ctx: { signal, cfg, env, api, log(msg), state, setState(s), emit(line | {scope, text}), running(), subscribe(fn) }
  // running() says the stream is up (clears a failing line); subscribe(fn) feeds every engine event to fn.
  async start(ctx) {
    ctx.running();
    let n = 0;
    const timer = setInterval(() => { n++; ctx.emit(`tick ${n}`); ctx.setState({ n }); }, 60000);
    await new Promise((resolve) => ctx.signal.addEventListener("abort", () => { clearInterval(timer); resolve(); }));
  },
});
