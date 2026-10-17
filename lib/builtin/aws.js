// aws: the SSO session per profile, as the probe `aws-auth`: one event when a profile flips between
// ok and expired (`AWS <profile> ok|expired`); the first run reports the current state of every profile.
// Switched on by an instance.json `aws` section: "aws": { "profiles": [{ "profile": "p", "region": "r" }] }
// One `aws sts get-caller-identity` per profile per poll; the AWS CLI must be on PATH.
// `"login": true` (on the section, or per profile, where a profile's own `login` wins) signs an expired
// profile in again itself with `aws sso login`, which opens the browser and finishes on its own where the
// identity provider remembers you: a renewal that works makes no line, one that fails reads
// `AWS <profile> expired (sign-in failed: ...)`. One attempt per profile per `loginEverySec` (default 1800),
// so a sign-in nobody finishes does not open a browser tab every poll; each sign-in gets `loginTimeoutSec`
// (default 120). After a sign-in times out (nobody at the browser) the other profiles wait their turn too
// (`sign-in not tried: ...`); a sign-in that works re-reads every expired profile, since profiles often
// share one SSO session.
const BUDGET_MS = 400000;   // sign-ins per poll stop short of the engine's bound on one check (600 s at 60 s)
const oneLine = (e) => String(e?.message || e).replace(/\s+/g, " ").slice(0, 120);
module.exports = (api) => ({
  name: "aws-auth",
  intervalSec: 60,
  enabled: (cfg) => !!cfg.aws?.profiles?.length && cfg.probes?.["aws-auth"] !== false,
  async check(st = {}, cfg) {
    const profiles = cfg.aws.profiles, next = {}, tried = { ...(st._login || {}) }, why = {};
    const identity = async ({ profile, region }) => {
      try { await api.run("aws", ["sts", "get-caller-identity", "--profile", profile, "--region", region], 20); return "ok"; }
      catch (e) {
        // a network fault says nothing about the token: a probe failure, not "expired"
        if (/could not connect|timed out|name resolution|ENOENT/i.test(e.message)) throw new Error(`${profile}: ${e.message}`);
        return "expired";
      }
    };
    // mid-poll a network fault keeps the last reading, so the sign-in stamps below are still saved
    const reread = async (p) => { try { next[p.profile] = await identity(p); return true; } catch { return false; } };
    await Promise.all(profiles.map(async (p) => { next[p.profile] = await identity(p); }));
    // one at a time: each sign-in opens a browser, and the first may renew the others' shared session
    const every = (Number(cfg.aws.loginEverySec) || 1800) * 1000, timeoutSec = Math.min(Math.max(1, Number(cfg.aws.loginTimeoutSec) || 120), BUDGET_MS / 1000);
    const end = Date.now() + BUDGET_MS;
    let held, began = false;   // a sign-in that timed out: nobody is at the browser, so the rest wait for their next turn
    for (const p of profiles) {
      if (next[p.profile] !== "expired" || !(p.login ?? cfg.aws.login)) continue;
      if (Date.now() - (tried[p.profile] || 0) < every) { why[p.profile] = st._why?.[p.profile]; continue; }
      if (!held && began && Date.now() + timeoutSec * 1000 > end) { why[p.profile] = "sign-in not tried: no time left this poll"; continue; }   // unstamped: next poll
      tried[p.profile] = Date.now();
      if (held) { why[p.profile] = held; continue; }
      began = true;
      try { await api.run("aws", ["sso", "login", "--profile", p.profile], timeoutSec); }
      catch (e) {
        why[p.profile] = `sign-in failed: ${oneLine(e)}`;
        if (/ timed out$/.test(e.message)) held = `sign-in not tried: the sign-in for ${p.profile} was not finished`;
        continue;
      }
      if (!(await reread(p))) continue;   // the next poll's reading tells
      if (next[p.profile] === "ok") await Promise.all(profiles.filter((q) => next[q.profile] === "expired").map(reread));
      else why[p.profile] = "sign-in failed: signed in, but the profile still reads expired";
    }
    for (const { profile } of profiles) if (next[profile] === "ok") { delete tried[profile]; delete why[profile]; }
    // a profile last reported as not tried gets one more line when its own attempt fails
    const told = ({ profile }) => st[profile] !== next[profile] || (/^sign-in not tried/.test(st._why?.[profile]) && /^sign-in failed/.test(why[profile]));
    const events = profiles.filter(told)
      .map(({ profile }) => `AWS ${profile} ${next[profile]}${why[profile] ? ` (${why[profile]})` : ""}`);
    return { events, state: { ...next, _login: tried, _why: why } };
  },
  now: (d) => Object.entries(d).filter(([p]) => !p.startsWith("_")).map(([p, s]) => `${p} ${s}`).join(", "),
});
