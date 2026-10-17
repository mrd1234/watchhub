// slack: new messages as events, through the user token (lib/slack.js).
//   {"name": "team-feed", "slack": {"channel": "#watchhub", "match": "^\\[wh\\]"}}
//   {"name": "inbox", "slack": {"channel": ["@dms", "@mentions"]}, "sinks": ["toast"]}
//   {"name": "notes", "scope": "team", "slack": {"channel": "@me", "ignoreSelf": false, "ignoreBots": true, "match": "^(?!\\[wh\\])", "replyText": "[wh] {text}"}}
// The last one is the DM with oneself as a command channel: what the person types there (from a phone,
// say) wakes an inbox as an instruction; sink posts into the same DM are kept out by their [wh] prefix
// (ignoreBots drops webhook posts, which have no user).
// `channel` is one or a list of: #name, a channel id, @me (the DM with oneself), @dms (every direct
// message to you, from anyone), @mentions (every message anywhere that mentions you). @dms and @mentions
// go through Slack search (scope search:read): one call each, whatever the number of conversations. One
// event per message: `<poster>: <text>`, prefixed with the channel for @mentions and `DM` for @dms. The
// first run takes the newest message of each place as the baseline and says nothing; later runs ask only
// for what came after it, so a poll is one small call per place. Own messages are skipped by default (ignoreSelf), so an agent that posts to the channel it
// reads does not wake itself; `match` keeps only messages whose text matches, which is how a team channel
// carries people's chatter and the agent lines (`[wh] MERGED repo#1`) that plans act on side by side.
// A watch reading more than one place names the place on each line (#name, or `self` for @me).
// Every line can be answered: `watchhub reply <handle> '<text>'` posts as you in the same thread (a
// channel message gets a thread; a direct message, D… or found by @dms, is answered in the DM, or in its
// thread if it was in one). `replyText` wraps answers ("[wh] {text}"). A place read with ignoreSelf
// false gives handles only with a replyText its match refuses, since an answer would otherwise come
// back as a new line. Replies inside a thread are not read (history holds top-level messages); one that
// mentions you arrives through @mentions. More than 10 messages in one poll: the earliest are counted, not shown.
const slack = require("../slack");
const { oneLine } = require("../util");

const spec = (w) => (typeof w.slack === "string" ? { channel: w.slack } : w.slack);
const MAX = 10;
// where an answer to m goes: its channel, and the thread it is in (from thread_ts, or a search hit's
// permalink), else the thread it starts; a DM outside a thread is answered in the DM itself
function answerAt(m, id, dm) {
  if (!id) return null;
  const thread = m.thread_ts || (/[?&]thread_ts=([0-9.]+)/.exec(m.permalink || "") || [])[1] || (dm ? undefined : m.ts);
  return { channel: id, ...(thread ? { thread } : {}) };
}
const SKIP_SUBTYPES = (m) => m.subtype && !["bot_message", "thread_broadcast", "me_message", "file_share"].includes(m.subtype);

module.exports = {
  name: "slack",
  env: (w) => [spec(w)?.tokenEnv || "SLACK_USER_TOKEN"],
  validate(w) {
    const s = spec(w);
    const list = s && [].concat(s.channel);
    if (!s || !list.length || !list.every((c) => typeof c === "string" && c)) throw new Error("slack needs channel: #name, an id, @me, @dms or @mentions (or a list of them)");
    if (s.match !== undefined) new RegExp(s.match);
    if (s.tokenEnv !== undefined && !/^[A-Z0-9_]+$/i.test(s.tokenEnv)) throw new Error("slack.tokenEnv must be an environment variable name");
    if (s.replyText !== undefined && (typeof s.replyText !== "string" || !s.replyText.includes("{text}"))) throw new Error("slack.replyText must contain {text}");
    // reading your own messages, an answer must be one the match refuses, or it comes back as a new line
    if (s.ignoreSelf === false && s.replyText !== undefined && (!s.match || new RegExp(s.match).test(s.replyText.split("{text}").join("x")))) throw new Error("slack.replyText must make answers the match refuses (with ignoreSelf false they are read back otherwise)");
  },
  async poll(w, st, cfg, env) {
    const s = spec(w), tokenEnv = s.tokenEnv || "SLACK_USER_TOKEN";
    const state = { ...(st || {}), lasts: { ...(st?.lasts || {}) } };
    const wanted = [].concat(s.channel);
    const needSelf = s.ignoreSelf !== false || wanted.includes("@mentions");   // search results carry `username`, not always `user`
    const self = needSelf ? await slack.selfId(state, env, tokenEnv) : null;   // also records selfName
    const re = s.match ? new RegExp(s.match) : null;
    const answerable = s.ignoreSelf !== false || !!s.replyText;   // validate() made sure the match refuses a wrapped answer
    const events = [];
    const name = (m) => m.user ? slack.userName(m.user, state, env, tokenEnv) : m.username || m.bot_profile?.name || "bot";
    const take = async (m, prefix, to) => {
      if (SKIP_SUBTYPES(m)) return;
      if (s.ignoreSelf !== false && (m.user === self || (!m.user && state.selfName && m.username === state.selfName))) return;
      if (s.ignoreBots && (m.bot_id || m.subtype === "bot_message" || (!m.user && m.username))) return;
      const text = String(m.text || "");
      if (re && !re.test(text)) return;
      const line = `${prefix}${await name(m)}: ${oneLine(text, 300)}`;
      events.push(to && answerable ? { text: line, reply: s.replyText ? { ...to, wrap: s.replyText } : to } : line);
    };
    // one conversation: baseline on first sight, then only what came after
    const place = async (id, prefix) => {
      if (!state.lasts[id]) {
        const r = await slack.call("conversations.history", { channel: id, limit: 1 }, env, tokenEnv);
        state.lasts[id] = r.messages[0]?.ts || "0";
        return;
      }
      const r = await slack.call("conversations.history", { channel: id, oldest: state.lasts[id], limit: 50 }, env, tokenEnv);
      for (const m of [...r.messages].reverse()) { state.lasts[id] = m.ts; await take(m, prefix, answerAt(m, id, /^D/.test(id))); }
    };
    // a search: baseline on first sight, then only what came after; the channel name is the prefix
    const searched = async (key, query, prefix) => {
      const found = await slack.search(query, env, tokenEnv);
      if (!state.lasts[key]) { state.lasts[key] = found.at(-1)?.ts || "0"; return; }
      for (const m of found) {
        if (Number(m.ts) <= Number(state.lasts[key])) continue;
        state.lasts[key] = m.ts;
        const id = m.channel?.id, dm = /^D/.test(id || "") || !!m.channel?.is_im || !!m.channel?.is_mpim || /^mpdm-/.test(m.channel?.name || "");
        await take(m, prefix(m), answerAt(m, id, dm));
      }
    };
    for (const c of wanted) {
      if (c === "@dms") await searched("@dms", "to:me", (m) => (/^mpdm-/.test(m.channel?.name || "") ? "group DM " : "DM "));
      else if (c === "@mentions") await searched("@mentions", `<@${self}>`, (m) => `#${m.channel?.name || m.channel?.id || "?"} `);
      else {
        const id = await slack.channelId(c, state, env, tokenEnv);
        await place(id, wanted.length > 1 ? (c === "@me" ? "self " : `${c.startsWith("#") ? "" : "#"}${c} `) : "");
      }
    }
    // keep state small: the user cache is bounded by who posts; the channel map is dropped when large
    if (state.channels && Object.keys(state.channels).length > 200) delete state.channels;
    return { events: events.length > MAX ? [`${events.length - MAX} earlier messages not shown (more than ${MAX} in one poll)`, ...events.slice(-MAX)] : events, state };
  },
  // an answer, as you, where a line came from, wrapped as the place's replyText was when the line was read
  async send(w, to, text, ctx) {
    if (!to || typeof to.channel !== "string") throw new Error("no channel to answer in");
    const body = typeof to.wrap === "string" ? to.wrap.split("{text}").join(text) : text;
    await slack.post(to.channel, body, ctx.env, spec(w)?.tokenEnv || "SLACK_USER_TOKEN", to.thread ? { thread_ts: to.thread } : {});
  },
};
