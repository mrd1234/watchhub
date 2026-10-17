// The one HTTP listener shared by every webhook watch in an engine. Started on the first register,
// closed when the last route goes. Loopback by default; a route on a non-loopback host must carry
// a secret, since whatever is POSTed lands in an agent's context as an event line. Bodies are
// capped at 1 MB (413 beyond). A failed bind fails every registered route, so the watches show as
// failing instead of looking healthy while every POST is refused.
const http = require("http");

let srv = null, routes = new Map(), bound = null;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function register(cfg, path, handler, log = () => {}, onError = () => {}, hasSecret = false) {
  const host = cfg.host || "127.0.0.1", port = Number(cfg.port || 47831);
  if (!LOOPBACK.has(host) && !hasSecret) throw new Error(`webhook on ${host} needs a secret (secretEnv and secretHeader): it is reachable from outside`);
  if (routes.has(path)) throw new Error(`webhook path ${path} already registered`);
  routes.set(path, { handler, onError });
  if (!srv) {
    srv = http.createServer((req, res) => {
      const r = routes.get(req.url.split("?")[0]);
      if (!r || req.method !== "POST") { res.writeHead(r ? 405 : 404); return res.end(); }
      const chunks = []; let size = 0, over = false;
      // a sender that hangs up mid-request is its own problem: an unheard error here would end the engine
      req.on("error", (e) => log(`webhook ${req.url}: request: ${e.message}`));
      res.on("error", (e) => log(`webhook ${req.url}: response: ${e.message}`));
      req.on("data", (c) => { if (over) return; size += c.length; if (size > 1 << 20) { over = true; res.writeHead(413); res.end(); req.destroy(); return; } chunks.push(c); });
      req.on("end", () => {
        if (over) return;
        let code = 204;
        try { code = r.handler(req, Buffer.concat(chunks).toString("utf8")) || 204; } catch (e) { log(`webhook ${req.url}: ${e.message}`); code = 500; }
        res.writeHead(code); res.end();
      });
    });
    srv.on("error", (e) => {
      log(`webhook listener ${host}:${port}: ${e.message}`);
      const failed = [...routes.values()];
      routes.clear(); srv = null; bound = null;
      for (const r of failed) r.onError(new Error(`listener ${host}:${port}: ${e.message}`));
    });
    srv.listen(port, host, () => { bound = `${host}:${port}`; log(`webhook listener on ${bound}`); });
  }
  return () => {
    routes.delete(path);
    if (!routes.size && srv) { srv.close(); srv = null; bound = null; }
  };
}

module.exports = { register, address: () => bound };
