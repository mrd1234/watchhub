// slack: your Slack as one two-way probe, through the user token (lib/slack.js). Switched on by an
// instance.json `slack` section:
//   "slack": { "read": ["@dms", "@mentions", "#team",
//                       {"channel": "@me", "ignoreSelf": false, "match": "^(?!\\[wh\\])", "replyText": "[wh] {text}"}],
//              "scope": "team", "ignoreBots": true, "sinks": ["toast"], "tokenEnv": "SLACK_USER_TOKEN" }
// Each entry of `read` is one place (#name, an id, @me, @dms or @mentions), as a string or as an object
// with its own options; the section's match, ignoreSelf, ignoreBots, scope, sinks and replyText are the
// defaults an entry overrides. `sinks` sends that place's lines on to those sinks as they land;
// `replyText` wraps an answer sent with `watchhub reply` (the [wh] above keeps an answer posted into the
// self-DM from being read back as a new note). Every place is polled with the slack kind's reading rules
// (kinds/slack.js) and keeps its own position.
// Lines: SLACK DM <who>: <text> | SLACK group DM <who>: <text> | SLACK #channel <who>: <text> |
// SLACK self <who>: <text>, each with a reply handle; `watchhub reply <handle> '<text>'` answers as you
// in the same thread.
const kind = require("../kinds/slack");

const OPTIONS = ["match", "ignoreSelf", "ignoreBots", "scope", "sinks", "replyText"];

// the section's read list as one object per place, the section's options filled in
function reads(s) {
  const base = Object.fromEntries(OPTIONS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  return [].concat(s.read).map((r) => ({ ...base, ...(typeof r === "string" ? { channel: r } : r) }));
}

function check(r) {
  if (typeof r.channel !== "string" || !r.channel) throw new Error("slack.read entries need one channel each: #name, an id, @me, @dms or @mentions");
  if (r.sinks !== undefined && !(Array.isArray(r.sinks) && r.sinks.every((n) => typeof n === "string" && n))) throw new Error(`slack.read ${r.channel}: sinks must be a list of sink names`);
  if (r.replyText !== undefined && (typeof r.replyText !== "string" || !r.replyText.includes("{text}"))) throw new Error(`slack.read ${r.channel}: replyText must contain {text}`);
}

const label = (c) => (c === "@me" ? "self " : /^@(dms|mentions)$/.test(c) ? "" : `${c.startsWith("#") ? c : `#${c}`} `);

module.exports = (api) => {
  class Slack extends api.TwoWay {
    constructor() { super({ name: "slack", intervalSec: 30, env: (cfg) => [cfg.slack?.tokenEnv || "SLACK_USER_TOKEN"] }); }
    enabled(cfg) { return !![].concat(cfg.slack?.read || []).length && cfg.probes?.slack !== false; }
    spec(cfg, r) { return { name: "slack", slack: { channel: r.channel, match: r.match, ignoreSelf: r.ignoreSelf, ignoreBots: r.ignoreBots, replyText: r.replyText, tokenEnv: cfg.slack.tokenEnv } }; }
    async check(st, cfg, env) {
      const list = reads(cfg.slack), state = { reads: {}, errors: {} }, out = [];
      for (const r of list) { check(r); kind.validate(this.spec(cfg, r)); }
      const seen = new Set();
      for (const r of list) { if (seen.has(r.channel)) throw new Error(`slack.read lists ${r.channel} twice`); seen.add(r.channel); }
      // a place that cannot be read (left, renamed) says so once and the others carry on; a single failed poll stays
      // silent, as a probe's blip does, and a rate limit fails the probe so the engine backs off
      for (const r of list) {
        const scope = r.scope || "all", was = st?.errors?.[r.channel];
        let got;
        try { got = await kind.poll(this.spec(cfg, r), st?.reads?.[r.channel], cfg, env, api); } catch (e) {
          if (e?.status === 403 || e?.status === 429 || /\b(403|429)\b|rate ?limit/i.test(String(e?.message || e))) throw e;
          const msg = String(e.message || e), told = !!was;   // the second failure in a row is told
          state.reads[r.channel] = st?.reads?.[r.channel];
          state.errors[r.channel] = { msg, told };
          if (told && (!was.told || was.msg !== msg)) out.push({ scope, text: `SLACK ${r.channel} unreadable: ${msg}` });
          continue;
        }
        if (was?.told) out.push({ scope, text: `SLACK ${r.channel} readable again` });
        state.reads[r.channel] = got.state;
        for (const e of got.events) {
          const ev = typeof e === "string" ? { text: e } : e;
          out.push({ scope, text: `SLACK ${label(r.channel)}${ev.text}`, ...(ev.reply ? { reply: ev.reply } : {}), ...(r.sinks?.length ? { sinks: r.sinks } : {}) });
        }
      }
      // nothing readable at all (a bad token, say) is the probe failing, as for any probe
      if (list.length && Object.keys(state.errors).length === list.length) throw new Error(state.errors[list[0].channel].msg);
      if (!Object.keys(state.errors).length) delete state.errors;
      return { state, events: out };
    }
    // the answer's wrapping travels with the handle (kinds/slack.js), so a later config edit cannot change it;
    // a handle from 1.4.3 names its place instead, and takes that place's wrapping as configured now
    send(to, text, ctx) {
      const wrap = to?.wrap ?? (to?.read && ctx.cfg.slack?.read ? reads(ctx.cfg.slack).find((x) => x.channel === to.read)?.replyText : undefined);
      return kind.send({ slack: { tokenEnv: ctx.cfg.slack?.tokenEnv } }, wrap ? { ...to, wrap } : to, text, ctx);
    }
  }
  return new Slack();
};
