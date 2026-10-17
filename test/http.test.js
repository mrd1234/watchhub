const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { detect } = require("../lib/diff");
const api = require("../lib/api");
const httpKind = require("../lib/kinds/http");
const sources = require("../lib/sources");

test("detect: value path reports a change, expect reports once on arrival", () => {
  let r = detect({ value: "data.version" }, undefined, { data: { version: "a1" } });
  assert.deepEqual(r.events, []);
  r = detect({ value: "data.version" }, r.state, { data: { version: "a1" } });
  assert.deepEqual(r.events, []);
  r = detect({ value: "data.version" }, r.state, { data: { version: "b2" } });
  assert.deepEqual(r.events, ["value data.version: a1 -> b2"]);
  let e = detect({ value: "state", expect: "merged" }, undefined, { state: "open" });
  assert.deepEqual(e.events, []);
  e = detect({ value: "state", expect: "merged" }, e.state, { state: "merged" });
  assert.deepEqual(e.events, ["value state is merged"]);
  e = detect({ value: "state", expect: "merged" }, e.state, { state: "merged" });
  assert.deepEqual(e.events, []);
});

test("http kind: ETag makes the second poll a 304 that reuses the cached body; env in headers", async (t) => {
  let hits = 0, lastAuth = "", version = "v1";
  const srv = http.createServer((req, res) => {
    hits++; lastAuth = req.headers.authorization || "";
    const etag = `"${version}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { etag, "content-type": "application/json" });
    res.end(JSON.stringify({ data: { version } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/version`;
  const w = { name: "v", http: { url, headers: { Authorization: "Bearer ${LW_TEST_TOKEN}" } }, value: "data.version" };
  const env = { LW_TEST_TOKEN: "secret" };
  let r = await httpKind.poll(w, undefined, {}, env, api);
  assert.deepEqual(r.events, []);
  assert.equal(lastAuth, "Bearer secret");
  assert.equal(r.state.etag, '"v1"');
  r = await httpKind.poll(w, r.state, {}, env, api);
  assert.deepEqual(r.events, []);
  assert.equal(hits, 2);
  version = "v2";
  r = await httpKind.poll(w, r.state, {}, env, api);
  assert.deepEqual(r.events, ["value data.version: v1 -> v2"]);
  assert.equal(r.state.etag, '"v2"');
});

test("every example watch validates", () => {
  const dir = path.join(__dirname, "..", "example", "watches");
  for (const f of fs.readdirSync(dir)) sources.validate(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const plans = require("../lib/plans");
  plans.check(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "example", "plans", "release.json"), "utf8")));
});
