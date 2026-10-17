// __NAME__: a two-way watchhub module. It reads a place (a chat, an inbox) like any poll module, and can
// answer there: a line made with this.line(text, to) gets a handle on the event (` [reply r1a2b3c4]`), and
// `watchhub reply <handle> '<text>'` hands the text and `to` back to send(). Nothing is sent otherwise.
// Switch it on and off with "probes": { "__NAME__": false } in instance.json. Restart the engine to load it.
module.exports = (api) => {
  class Module extends api.TwoWay {
    constructor() {
      // env: variables it needs, e.g. ["CHAT_TOKEN"]; intervalSec: seconds between polls
      super({ name: "__NAME__", intervalSec: 60, env: ["CHAT_TOKEN"] });
    }

    // state: what check() returned last time (undefined on the first run). cfg: instance.json. env: process.env.
    async check(state, cfg, env) {
      const auth = { headers: { authorization: `Bearer ${env.CHAT_TOKEN}` } };
      const messages = await api.fetchJson("https://chat.example.com/api/messages", auth, 20);   // [{id, room, from, text}]
      const seen = new Set(state?.seen || []);
      const fresh = messages.filter((m) => !seen.has(m.id));
      // `to` is any small JSON object send() understands: here the room and the message to answer under.
      // The same `to` gives the same handle, so answering a thread keeps one handle for the conversation.
      const events = state ? fresh.map((m) => this.line(`CHAT ${m.room} ${m.from}: ${api.oneLine(m.text)}`, { room: m.room, under: m.id })) : [];
      return { events, state: { seen: messages.map((m) => m.id).slice(-500) } };   // the first run only learns what is there
    }

    // to: the `to` of the line answered; ctx: {cfg, env, api, log}. Throw to report a failure.
    async send(to, text, ctx) {
      await api.fetchJson(`https://chat.example.com/api/rooms/${encodeURIComponent(to.room)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.env.CHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ text, replyTo: to.under }),
      }, 20);
    }

    // optional: one line for `watchhub now`
    now(state) { return state ? `${state.seen.length} messages seen` : "no data yet"; }
  }
  return new Module();
};
