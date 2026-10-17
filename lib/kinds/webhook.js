// webhook: a STREAM. Events arrive as HTTP POSTs on a path of the instance's one loopback
// listener (instance.json "webhook": {"host": "127.0.0.1", "port": 47831}; the listener starts with
// the first webhook watch and binds to loopback only, so a tunnel or a relay on the same box is
// what makes it reachable from outside). The body (JSON or text) becomes one event: `text` is a
// template over the parsed body, `match` filters. A shared secret is checked when `secretEnv`
// names an environment variable and `secretHeader` the header that must carry its value.
//   {"webhook": {"path": "/gh", "secretHeader": "x-hook-secret", "secretEnv": "HOOK_SECRET", "text": "{action} {pull_request.number}"}}
const server = require("../webhook-server");
const crypto = require("crypto");
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = {
  name: "webhook",
  stream: true,
  validate(w) {
    if (!w.webhook || !w.webhook.path || !w.webhook.path.startsWith("/")) throw new Error("webhook needs path starting with /");
    if (w.webhook.match || w.match) new RegExp(w.webhook.match || w.match);
  },
  start(w, ctx) {
    const h = w.webhook, re = h.match || w.match ? new RegExp(h.match || w.match) : null;
    const expect = h.secretEnv ? ctx.env[h.secretEnv] : null;
    if (h.secretEnv && !expect) return Promise.reject(new Error(`${h.secretEnv} not set`));
    return new Promise((resolve, reject) => {
      let off;
      try {
        off = server.register(ctx.cfg.webhook || {}, h.path, (req, body) => {
          if (expect && !same(req.headers[(h.secretHeader || "x-watchhub-secret").toLowerCase()], expect)) return 403;
          let parsed = body; try { parsed = JSON.parse(body); } catch {}
          const text = h.text ? ctx.api.template(h.text, parsed) : ctx.api.oneLine(body, 300);
          if (!re || re.test(text)) ctx.emit(text);
          return 204;
        }, ctx.log, (e) => { ctx.signal.removeEventListener("abort", onAbort); reject(e); }, !!expect);
      } catch (e) { return reject(e); }
      const onAbort = () => { off(); resolve(); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};
