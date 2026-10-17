---
name: watchhub
description: "How an agent waits on things with watchhub (PR merges and checks, CI and deploy jobs, tickets, auth and VPN state, any command, URL, file or stream) instead of a polling loop: subscribe an inbox once and end the turn; the Claude Code Stop hook hands the burst back as the next input. Covers subscriptions and filters, the fallback `watchhub wait`, plans and plan codes, watches and jobs, priorities and fewer wakes, derived events, sinks, and what to check when no wake comes."
tags:
  - agent
  - ops
---

# watchhub

One engine per instance folder polls every source and writes a line to `events.log` only when something changed that an agent would act on. An agent subscribes its inbox once and ends its turn; matching lines collect in that inbox's outbox and come back as a burst, which is the wake. Polling costs no tokens and every wake costs a turn, so keep subscriptions selective. The repo's `README.md` is the overview and `docs/reference.md` the full reference (kinds, modules, plans, the service).

## Quick reference

Run from the instance folder, or pass `--instance <folder>` (also `WATCHHUB_INSTANCE`, or `instance` in `~/.watchhub/config.json`).

| Need | Command |
|---|---|
| Running? What is failing? | `watchhub status` |
| Present state, no wake | `watchhub now` |
| Subscribe | `watchhub sub <inbox> --label '<what it waits on>' --plan <p>` or `--filter '<regex>'` |
| Wait | subscribe, then end the turn (Stop hook) |
| Wait with no hook | `watchhub wait <inbox>` in a background shell, as its own call |
| Wake yourself later | `watchhub in 20m 'check the deploy'` or `watchhub at 15:30 '<text>'` (your inbox is the default); `watchhub schedules`, `unschedule <id>` |
| Subscriptions and waiters | `watchhub subs`, `watchhub leases` |
| One-off condition | `watchhub watch add-once '<json>'`, then `--probes custom:<name>` |
| Saved watch | `watchhub watch add '<json>'` or `add <file.json>` (on Windows always the file: the command line eats backslashes and quotes) / `list` / `show` / `rm` / `kinds` |
| Queue a CI or deploy job | `watchhub add-job '<json>'` |
| Plans | `watchhub plan list` / `show <p>` / `add <file>` / `skill <p> --out <dir>` |
| Recent lines | `watchhub tail 20`, `watchhub events --since 2h --grep <re>` |
| Sinks | `watchhub sink list` / `add '<json>'` / `send <name> '<text>'` |
| This skill, regenerated | `watchhub skill` (or `--out <dir>` for another agent's skills folder) |

## Inboxes and subscriptions

Use one inbox per session, and keep it for the whole session. Subscribing the same inbox again replaces its subscription, so changing what you wait for takes one `sub`, not a new name. Give it a `--label`: a few words on what this session waits for (`'PR 42: checks and merge'`). People see inboxes as `s-<session id>` names in `watchhub subs` and anything else that lists inboxes, and the label is how they tell them apart; subscribing again keeps it. A subscription is `--plan <p>` (the plan's probes, scope, filter and rules) or `--filter`, `--scope` and `--probes`, plus `--priority`, `--urgent`, `--settle`, `--cooldown`, `--sinks` and `--once`.

Every subscription has a TTL, 7 days unless `--ttl`. When it expires the inbox is woken with `SUBSCRIPTION <inbox> expired (ttl)`. Leave `--ttl` off unless the work has a real end. A short TTL is how a stalled session loses what happened while it was stalled.

There are two kinds of filter:
- **Probe filter:** every `|`-separated token names a probe this instance has (`vpn|aws-auth`, `custom:app-log`). It passes those probes' lines, their `failing` and `recovered` lines included.
- **Regex:** anything else is a regex over the whole line.

A bare number matches far too much, so anchor it: `owner-repo#42\b`, or `JOB <label>` for a job.

## Waiting: the Stop hook

`watchhub hook install <dir>` adds two Claude Code hooks to `<dir>/.claude/settings.json`, and writes this skill (with the instance section at the end) to `<dir>/.claude/skills/watchhub`. Install into `~` to cover every project.
- **SessionStart:** tells the session its inbox in one line (`watchhub inbox for this session: s-...`).
- **Stop:** holds the turn until a burst lands, then returns it as your next input.

So the loop is: subscribe once, then end the turn. After a long quiet stretch the hook wakes you with `watchhub: no news in N h; still subscribed to <inbox>`. Just end the turn again.

The inbox is the `inbox` in the project's `.watchhub.json`, otherwise `s-` followed by the first 10 letters and digits of the session id, lowercased. A session that was running before the hooks were installed never saw the start line, and was not subscribed from `.watchhub.json`. It works the name out itself and runs `watchhub sub`.

If no wake comes, check three things in turn:
1. **The hook is installed:** `grep -l "watchhub hook" ~/.claude/settings.json .claude/settings.json`. If it isn't, use the fallback wait below.
2. **The subscription is on this session's inbox:** `watchhub subs` shows it.
3. **Nothing else owns the inbox:** of two waits on one inbox, the newer one wins and the other exits. A second copy of the hooks with different command text, say a project copy beside the home one, can run as a second waiter.

## Waking yourself later: at and in

When the next step is "look again in twenty minutes" and nothing the engine watches will say when, ask it for a line at that time: `watchhub in 20m 'check the staging deploy'` or `watchhub at 15:30 'send the stand-up notes'`. It arrives in your inbox as `SCHEDULED <id> <text>`, urgent, so it wakes you as soon as it lands; end the turn after scheduling, as for any wait. The engine holds your turn for it whether or not you have subscribed to anything else: a schedule to an inbox with no subscription makes one that takes schedule lines only and goes away once the last schedule has fired; a subscription you already have is kept until at least a day past the time. So a reminder needs nothing arranged first, and nothing to clean up after.

With no target named the line goes to your own inbox, read from `WATCHHUB_INBOX`, the project's `.watchhub.json`, or the Claude Code session id. Another inbox goes before the text (`watchhub in 1h ops 'look at the queue'`), a person goes through a sink (`--sink slack`), and `--scope <s>` reaches every inbox taking that scope. `in` takes `90s`, `20m`, `2h` or `1d`; `at` takes `HH:MM` (the next such local time) or an ISO time within a year. The text is one line, at most 500 characters.

A schedule the engine missed while it was down still fires when it comes back, marked `(late, due 15:30)`, and a crash at the wrong moment can fire one twice with the same id; treat a repeat as the same reminder. Anything that repeats belongs in a timer watch, not a chain of schedules. `watchhub schedules` lists what is pending and `watchhub unschedule <id>` cancels one; the id is in the line and in what `at` and `in` print.

## Waiting without the hook (fallback)

Run `watchhub wait <inbox>` in a background shell as its own call: no `&`, nothing chained before or after it. The output is:
1. the event lines;
2. `INSTRUCTIONS` from the plan;
3. the notify line;
4. `ALSO`, the low-priority lines, if any.

It then acknowledges the burst and exits. Act on it, then start the wait again.

Nothing is lost between waits:
- A burst nobody acknowledged prints first on the next wait.
- A wait started more than three minutes after the last burst gets a one-line pointer to it (`previous burst: N lines printed M min ago; ...`), not the burst again.
- A second wait on the same inbox takes over. The first prints `SUPERSEDED` and exits with code 3, so duplicates end themselves and nothing needs killing.
- A waiter starts the engine if it is not running.

## Plans, watches, jobs, event lines

Event lines are `<UTC> | <probe> | <scope> | <message>`.
- Built-in sources: `MERGED`, `CHECKS` (`(rerun)` when a rerun changes the head's verdict), `MERGEABLE`, `REVIEW`, `TICKET`, `JOB`, `VPN`, `AWS`, `STAMP`.
- Any probe: `failing` / `recovered` lines.
- Scopes come from rules in `instance.json` that match a line's repo, PR, ticket, project or label.

**Plans** live in `plans/<name>.json`: `scope`, `probes`, `filter`, and `on` rules with `match` and `do` (plus `priority`, `quiet`, `sinks`), `default`, `notify`. A rule's `do` text is printed in full once per 4 hours per inbox. After that the burst names the rule (`- as before for /^MERGED/ (text: watchhub plan show <p>)`), and the text itself is unchanged.

**Plan codes:** a plan with a `"skill": "<name>"` field ends its bursts with `INSTRUCTIONS: K7D9, R2 (skill <name>)` instead of the rule text. A rule's code is its `code`, else `R1`, `R2` and so on.
- Load that skill once per session. Each code is a section holding the rule's text, and `D` is the plan's default.
- The engine rewrites the skill when the plan changes, so an unknown code means you need to re-read it.
- An agent finds the skill by name only where it reads skills. `watchhub plan skill <p> --out <dir>` writes it there and remembers the folder as the plan's `skillDir`; for Claude Code that is `--out ~/.claude/skills/<name>`. Without `--out` it goes to `<instance>/skills/<name>/SKILL.md`, which you then read as a file.

**Watches** are JSON files in `watches/`.
- Poll kinds include `command`, `http`, `file`, `github` (ETag, in-process; use `items` and `id` rather than jq), `jira`, `tcp`, `aws`, `slack` and `timer`; `watchhub watch kinds` lists them all.
- Streams: `exec` (lines from a long-running command) and `webhook` (POSTs to the loopback listener).
- Change detection is the same for every kind: `match`; or `items` with `id` and `changed`; otherwise any change in the whole text.
- `"once": true` drops the watch after its first event.

**Jobs:** `watchhub add-job '{"kind":"gh-run","repo":"owner/name","id":"<run id>","label":"run <id>"}'`, then subscribe with a filter that matches `JOB run <id>`.
- Other kinds: `codebuild`, `codepipeline`, `amplify`.
- A job leaves the queue when it finishes, so a rerun of the same run needs `add-job` again.
- A malformed job is dropped with a line. A job that can't be read is reported at the third failure and dropped at the fiftieth.

## Fewer wakes

A wake is a full turn, so the engine rations them.

| Priority | When it wakes you |
|---|---|
| `urgent` | As soon as the line lands. |
| `normal` | After `--settle` (a hold that turns a cluster of lines into one wake), and after the cooldown since the last burst (`--cooldown`, else `engine.cooldownSec`, default 60 s). A check verdict and the job result that follows it become one wake. |
| `low` | Never on its own. Low lines ride along in your next burst under `ALSO`, grouped by probe with a count and the last two texts. A low backlog still wakes you at 50 lines or 4 hours. The full text: `watchhub events --inbox <inbox>`. |

Where a line's priority comes from:
- the plan rule (`"priority"`, or `"quiet": true` for low);
- else the plan's `priority`;
- else the subscription's `--priority`.

`--urgent <regex>` makes matching lines urgent whatever the plan says. Subscribe to chatty sources (chat channels, ticket comments) as low unless a line really needs you now.

## Restarts and derived events

**Restarts are silent:** they write nothing to `events.log`. A probe's first poll after a start never repeats a line the log already holds. `watchhub restart --message '<why>'` tells every inbox first, so the gap isn't read as a crash.

**Derived events:** a `derive` watch reads the event stream and emits one line per transition.
- Rate: `{"name":"storm","derive":{"probes":["custom:chat"],"rate":{"window":"5m","over":20}}}` gives `SPIKE: ...` once, then `SPIKE over` once.
- Silence: `"silence":{"for":"30m"}` gives `SILENT: nothing from <probes> for 30m`, then `SILENT over`.
- `match` instead of `probes` counts lines by regex.
- Numbers: any `value` watch takes `above` / `below` with `for` polls, which is how a metrics query becomes a wake.

## Sinks

A sink sends a line somewhere besides the outbox, such as a chat webhook, a desktop notification or any HTTP endpoint. A person sees it there without anyone spending a turn. A line reaches a sink when the watch, the subscription (`--sinks <name>`) or the plan (or one of its rules) names that sink; `quiet` rules go nowhere. Each line is sent as it lands; lines that arrive while a send is going out go together as one message, so a sink is never flooded. Nothing a sink does feeds back into the engine.

`watchhub sink add '<json>'` adds a target, and `watchhub sink send <name> '<text>'` proves it works. A sink that posts where other people read speaks for its owner, so ask before adding one.

## When it looks wrong

Start with `watchhub status`:
- `not running`: end the turn, because a waiter starts the engine.
- `FAILING xN`: names the source and its error.
- `UNACKNOWLEDGED` in `watchhub subs`: a burst nobody printed. End the turn and the hook prints it.

Then `watchhub tail 50` or `watchhub events --grep <re>`:
- The line was written but no wake came: the subscription didn't match (check scope, filter mode, priority).
- The line was never written: the source didn't see the change. Check the watch with `watchhub watch show <name>`.

`watchhub doctor` checks tokens, watches, plans and the engine in one pass.
