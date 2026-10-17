// http: fetch a URL on each poll. With match / items / value the body is inspected by the
// change-detection rules; without them the HTTP status is what is watched ("status 200 -> 503"), and
// a `metric` block on such a watch is read from the body with the status lines kept.
//   {"http": {"url": "https://...", "method": "GET", "headers": {"Authorization": "Bearer ${MY_TOKEN}"}, "body": "...", "timeoutSec": 20}}
// "${NAME}" in url, headers and body is read from the environment, so a secret never sits in a watch file.
// GETs send If-None-Match when the server gave an ETag: a 304 reuses the cached body (kept in state
// up to 256 KB), which is what keeps a GitLab, Azure DevOps or Bitbucket poll cheap against rate limits.
const spec = (w) => (typeof w.http === "string" ? { url: w.http } : w.http);
const CACHE_MAX = 256 * 1024;

module.exports = {
  name: "http",
  validate(w) {
    const h = spec(w);
    if (!h || !h.url) throw new Error("http needs url");
  },
  async poll(w, st, cfg, env, api) {
    const h = spec(w);
    const modes = w.match || w.items !== undefined || w.value !== undefined, inspect = modes || w.metric !== undefined;
    const headers = Object.fromEntries(Object.entries(h.headers || {}).map(([k, v]) => [k, api.envSubst(v, env)]));
    const method = (h.method || "GET").toUpperCase();
    const cached = inspect && method === "GET" && st?.etag ? st : null;
    if (cached) headers["If-None-Match"] = cached.etag;
    const r = await api.fetchText(api.envSubst(h.url, env), { method, headers, body: h.body ? api.envSubst(h.body, env) : undefined }, h.timeoutSec || 20);
    let body = r.body, etag = r.headers.get("etag");
    if (r.status === 304 && cached) { body = cached.body; etag = cached.etag; }
    if (inspect) {
      let payload = body;
      if (w.items !== undefined || w.value !== undefined) { try { payload = JSON.parse(body); } catch { throw new Error("body is not JSON (items and value need JSON)"); } }
      const d = api.detect(w, st, payload, body);
      const keep = etag && method === "GET" && body.length <= CACHE_MAX ? { etag, body } : {};
      if (modes) return { events: d.events, state: { ...d.state, ...keep }, metric: d.metric };
      const status = r.status === 304 && cached ? cached.status ?? 200 : r.status;   // a 304 answers for the response that set the ETag
      const moved = st && st.status !== undefined && st.status !== status ? [`status ${st.status} -> ${status}`] : [];
      return { events: [...moved, ...d.events], state: { ...d.state, ...keep, status }, metric: d.metric };
    }
    if (!st) return { events: [], state: { status: r.status } };
    return { events: st.status !== r.status ? [`status ${st.status} -> ${r.status}`] : [], state: { status: r.status } };
  },
};
