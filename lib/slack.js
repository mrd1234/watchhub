// Slack through a user token (the app's "User OAuth Token", xoxp-...; scopes channels:history,
// channels:read, groups:history, im:history, im:write, chat:write). Everything acts as the person
// who installed the app: posts show under their name, reads see what they can see. No bot, no
// workspace admin. The token comes from the environment (default SLACK_USER_TOKEN), never a file.
// Slack answers 200 with {ok:false, error} on failure, so `ok` is what is checked, not the status.
// Arguments go form-encoded: the read methods (search, users.info, conversations.*) ignore a JSON body.
const api = (env = process.env) => env.SLACK_API_URL || "https://slack.com/api";

async function call(method, body, env = process.env, tokenEnv = "SLACK_USER_TOKEN") {
  const token = env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} not set (the app's User OAuth Token; put it in ~/.watchhub/env)`);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body || {})) if (v !== undefined && v !== null) form.set(k, String(v));
  const r = await fetch(`${api(env)}/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(20000) });
  if (r.status === 429) { const e = new Error(`slack ${method}: HTTP 429 rate limited`); e.status = 429; throw e; }
  let j; try { j = await r.json(); } catch { throw new Error(`slack ${method}: HTTP ${r.status}, not JSON`); }
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}${j.needed ? ` (scope ${j.needed} needed; add it to the app's user scopes and reinstall)` : ""}`);
  return j;
}

// "#name" -> channel id through conversations.list (public and private the user can see); an id
// (C..., G..., D...) is returned as is; "@me" is the DM with oneself. `cache` is the watch's state.
async function channelId(name, cache, env, tokenEnv) {
  if (/^[CGD][A-Z0-9]{6,}$/.test(name)) return name;
  if (name === "@me") {
    if (cache.me) return cache.me;
    const me = await call("auth.test", {}, env, tokenEnv);
    return (cache.me = (await call("conversations.open", { users: me.user_id }, env, tokenEnv)).channel.id);
  }
  const want = name.replace(/^#/, "");
  if (cache.channels?.[want]) return cache.channels[want];
  const found = {};
  let cursor, types = "public_channel,private_channel";
  do {
    let r;
    try { r = await call("conversations.list", { types, limit: 1000, exclude_archived: true, cursor }, env, tokenEnv); }
    catch (e) { if (types.includes("private") && /missing_scope/.test(e.message)) { types = "public_channel"; continue; } throw e; }  // private channels need groups:read; without it, public ones still resolve
    for (const c of r.channels) found[c.name] = c.id;
    cursor = r.response_metadata?.next_cursor || "";
  } while (cursor);
  cache.channels = found;
  if (!found[want]) throw new Error(`no channel #${want} visible to this token`);
  return found[want];
}

// user id -> display name, cached in the watch's state (a workspace has few posters per channel)
async function userName(id, cache, env, tokenEnv) {
  if (!id) return "someone";
  cache.users ||= {};
  if (cache.users[id]) return cache.users[id];
  if (Object.keys(cache.users).length >= 500) cache.users = {};   // bounded: a workspace has few posters, but never unbounded
  try { const u = (await call("users.info", { user: id }, env, tokenEnv)).user; cache.users[id] = u.profile?.display_name || u.real_name || u.name || id; }
  catch { cache.users[id] = id; }
  return cache.users[id];
}

async function selfId(cache, env, tokenEnv) {
  if (cache.self) return cache.self;
  const me = await call("auth.test", {}, env, tokenEnv);
  cache.selfName = me.user;
  return (cache.self = me.user_id);
}

const post = (channel, text, env, tokenEnv, extra = {}) => call("chat.postMessage", { channel, text, ...extra }, env, tokenEnv);

// Slack search as the person: `to:me` is every direct message to them, `<@id>` every mention. Matches
// come newest first with ts, user, username, channel {id, name}; returned oldest first.
async function search(query, env, tokenEnv, count = 50) {
  const r = await call("search.messages", { query, sort: "timestamp", sort_dir: "desc", count }, env, tokenEnv);
  return (r.messages?.matches || []).filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
}

module.exports = { call, channelId, userName, selfId, post, search };
