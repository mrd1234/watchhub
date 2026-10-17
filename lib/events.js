// Event lines: `<UTC ISO> | <probe> | <scope> | <message>`. The shape is the contract every
// subscription, plan and old-style cursor reader relies on, so it never changes.
const RE = /^(\S+) \| ([^|]+?) \| ([^|]+?) \| (.*)$/;

// newlines and other control characters (an exec command's ANSI colour codes, say) become spaces
const format = (probe, scope, text, at = new Date()) => `${at.toISOString()} | ${probe} | ${scope} | ${String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ")}`;   // U+2028/9 too: `.` in the line regex stops at them

function parse(line) {
  const m = RE.exec(line);
  return m ? { at: m[1], probe: m[2], scope: m[3], text: m[4], line } : null;
}

// An event from a source is a string (scope "all") or {scope, text}.
const normalise = (ev, dfltScope = "all") => typeof ev === "string" ? { scope: dfltScope, text: ev } : { scope: ev.scope || dfltScope, text: ev.text };

module.exports = { format, parse, normalise };
