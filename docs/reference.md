# watchhub reference

The full detail behind the [README](../README.md): every command, kind, module, plan field and file, and the design notes. Read the README first.

One engine watches the outside world for a folder of sources; sessions (inboxes) subscribe once and block on their own inbox until something they care about happens. No shell loops, no child processes while anyone waits, nothing watched is hard-coded.

Built for agent sessions that are woken only when a background command exits: the waiter is that command. It costs no tokens to poll more often, so the engine polls freely and writes a line only when something changed that a subscriber would act on.

## Quick reference

```
watchhub init [folder]                  make an instance folder (instance.json, empty folders, a copy of example/)
watchhub doctor                         check node, bash, tokens, Jira, AWS, watches, plans, the engine; FAIL lines first
watchhub start | stop | status | now    the engine, and what it currently knows
watchhub service install                keep the engine alive across app restarts and reboots (Windows scheduled task)
watchhub watch add '<json>' | <file.json>   add a generic watch (see Kinds); picked up on the next tick, no restart. On Windows pass a file: JSON on the command line loses backslashes and quotes through watchhub.cmd
watchhub sub <inbox> --plan p | --filter re [--scope s] [--probes a,b] [--ttl 4h] [--settle 3] [--urgent re]
watchhub wait <inbox> [sub flags]        block until the inbox has a burst, print it, exit (run in a background shell)
watchhub plan add <file>                save a plan: which events, and what to do about each
watchhub add-job '<json>'               track one CI or deploy run until it ends
watchhub jira follow <KEY> [--ttl 30d]  the board watches a ticket outside its projects (unfollow, follows)
watchhub tail [n] | subs | leases       recent event lines, live subscriptions, live waiters
watchhub events --since 2h --grep X     query the log (or an inbox with --inbox; --aside for lines it handed over only as a count): did it fire?
watchhub stats [--since 24h]            wakes per inbox, events per probe, subscriptions, engine uptime
watchhub metrics [<regex>] [--probe p]  one line per metric: value, ok|warn|bad|PAST|stale|none, threshold, label
watchhub notice '<text>' [--wake]       a line to every inbox; watchhub restart --message '<why>' for planned restarts
watchhub at <HH:MM | ISO> [inbox ...] '<text>' [--sink a,b] [--scope s]   one line at that time, to those inboxes (yours when none is named), sinks, or every inbox taking the scope (Schedules below)
watchhub in <90s | 20m | 2h | 1d> [inbox ...] '<text>'   the same, that long from now; schedules [--json] lists what is pending, unschedule <id> cancels one
watchhub hook install ~                 the Claude Code hooks plus the agent skill, kept current by the engine (Hooks below)
watchhub skill [--out <dir>]            the agent skill: printed, or written to <dir> and kept current
(wakes.log in the instance: one line per wake, `<UTC> | <inbox> | <lines>`, for counting wakes per inbox per day)
```

The instance is `--instance <folder>`, `WATCHHUB_INSTANCE`, or the working directory.

## Fresh setup on a machine

1. Install: `npm install -g <path or package>` (node 20 or newer), then `watchhub init C:\watch` (or any folder). The folder gets `instance.json`, the empty folders and a copy of `example/`, and becomes the default instance in `~/.watchhub/config.json`, so every `watchhub` command works from any directory.
2. Credentials go in `~/.watchhub/env`, one `KEY=value` per line (`watchhub home` shows or creates the folder; `init` writes a commented template): `GITHUB_TOKEN` (or a `gh auth login`), `JIRA_API_TOKEN`, and any `${NAME}` a watch references; AWS keeps using the CLI's own profiles. A real environment variable with the same name wins over the file. The engine reads the file at start, so the scheduled task sees the tokens too. Keep the folder private to your user (it is, under a Windows profile or a 700 home).
3. `watchhub doctor` in the folder: it says what is set, what is reachable and what is wrong, one line each, and exits 1 on any FAIL.
4. `watchhub service install` so the engine survives application restarts and reboots; otherwise `watchhub start`.
5. Add watches (`watchhub watch add '<json>'`, or files in `watches/`), fill in the sections for the shipped modules you want (Shipped modules below); your own modules go in `modules/` (restart the engine to load one), add plans, then `sub` and `wait`.
6. For Claude Code, `watchhub hook install ~`: the hooks, and the agent skill that teaches every session watchhub and this instance (Hooks below). Put the team's rules for agents in `agentNotes`.

## How an inbox uses it

1. Once per piece of work: `watchhub sub my-inbox --label 'release 4.2 rollout' --plan release --ttl 8h` (or `--filter 'MERGED repo#42\b|CHECKS repo#42\b'`). Registering again with the same inbox name replaces the subscription and keeps its label unless a new `--label` is given. The label (one line, 60 characters at most) is for people: `watchhub subs` shows it beside the inbox, which matters when the inboxes are `s-<session id>` names.
2. Arm the wait in a background shell: `watchhub wait my-inbox`. Its output is the burst: the event lines, a blank line, `INSTRUCTIONS` from the plan, then the notify line. It exits, which is the wake.
3. Act, then arm again. Nothing is lost between arms: a burst the inbox never acknowledged is printed first on the next arm, and a burst printed more than three minutes before a re-arm is shown again under `PREVIOUS BURST`, in case that turn was lost.
4. `wait` can register in the same call (`watchhub wait my-inbox --plan release`), so an arm stays one line.

One waiter per inbox: a second `wait` for the same inbox takes over and the first exits with code 3 on its own. A subscription always has a TTL (default 7 days, so a session stalled for days by an outage or a spent credit still has its inbox when it wakes); when it expires the inbox is woken with `SUBSCRIPTION <inbox> expired (ttl)` so no wait hangs forever. A new subscription on an inbox that still holds unread lines sets them aside with a quiet notice saying how many and how to read exactly them (`watchhub events --inbox <inbox> --aside <id>`; the set-aside file starts afresh past 1 MB); `unsub` sets them aside the same way and says so, unless a live waiter holds the inbox: that waiter hands them over itself. A burst of more than 100 lines prints the newest 100 under one line pointing at the rest, set aside the same way.

Fewer wakes: a plan rule with `"quiet": true` records the event in the inbox without waking the inbox (it rides along with the next real burst); `--settle 60` holds a burst for a minute so a cluster lands as one wake; `--urgent '^MERGED'` names what bypasses the hold. A one-off wait is `--once`: the subscription removes itself after its first burst.

## Event lines

`events.log` holds every event, one line each, in a shape that never changes:

```
<UTC ISO> | <probe> | <scope> | <message>
2026-10-15T00:15:09.591Z | pr-checks | team | CHECKS webapp#41 9f8e7d6 all green
```

`probe` is the source's name (`custom:<name>` for a JSON watch); `scope` routes events to the inboxes that care (`all` reaches every scope). The engine's own lines use probe `watch`: `engine started ...`, `probe <name> failing: <why>` after two failures in a row, `probe <name> recovered`.

## The instance folder

```
instance.json      what the engine watches: scopes, repos, boards, hosts, intervals, probes on/off, engine limits
watches/*.json     generic watches (Kinds below); edit, add or remove at any time
modules/*.js       your helper sources (Modules below); loaded at engine start
plans/*.json       plans
sinks/*.json       sinks (Slack, Teams, a toast, any webhook; Sinks below)
subscriptions/     one file per inbox, written by `sub`
inbox/            <inbox>.log (delivered lines), <inbox>.ack (how far the inbox has read), <inbox>.last
leases/            which process is waiting for which inbox
events.log state.json jobs.json engine.log engine.lock       written at run time (state.json's _engine: pid, started, node, version)
metrics.json metrics/   the latest value and a day's history of every metric (Metrics below)
replies.json       where each reply handle answers (Two-way sources below); a week of them (at most 5000), written at run time
schedules.json     the pending one-off schedules (Schedules below), soonest first; written by `at` and `in`, and by the engine as each fires
agent-skills.json  the folders `hook install` and `skill --out` wrote the agent skill to, which the engine keeps current; machine-local
```

`instance.json` keys the engine reads: `probes` (`{"name": false}` switches a source off; `custom: false` switches every JSON watch off), `intervals` (`{"name": seconds}` overrides a source's interval, read live), `scopes` and `defaultScope` (routing rules: `prTitle`, `prBase`, `prBranch`, `repo`, `jiraProject`, `ticketKey`, `env`, each a regex, first rule with any match wins), `engine.memoryCapMb` (default 400), `engine.settleSec` (default 3), `engine.eventsLogMaxMb` (rotate events.log; off by default because old-style cursor readers lose their place), `webhook.host` and `webhook.port` (the loopback listener, 127.0.0.1:47831), `agentNotes` (a string or a list: the team's rules for agents, copied into the agent skill). Everything else is for your modules: `repos`, `prAuthors`, `jira`, `aws`, `vpn`, `stamps` are what the example modules read; `github`, `datadog` and `slack` are the shipped modules' sections (Builtins below).

## Kinds (generic watches)

A watch is a JSON file with a `name`, exactly one kind, and optionally `scope` (default `custom`), `intervalSec` (default 30, minimum 5), `sinks` and `reply` (Sinks below), `ttl` (seconds or an ISO time; on expiry the watch says `expired (ttl)` once and is removed), `once` (removed after its first event). Poll kinds run on their interval; stream kinds run all the time and are restarted with back-off when they end.

| kind | what it watches | example |
|---|---|---|
| `command` | a shell command's output | `{"name":"disk","command":"df -BG /c","match":"^LOW"}` |
| `http` | a URL's body (with `match`/`items`/`value`) or its status; ETag-aware | `{"name":"stamp","http":{"url":"https://api/version"},"value":"data.version"}` |
| `file` | a file's size/mtime, or new matching lines | `{"name":"run","file":{"path":"C:/temp/run.log","match":"FAILED"}}` |
| `github` | a REST path (ETag, free when unchanged) or GraphQL | `{"name":"runs","github":{"endpoint":"repos/o/r/actions/runs?per_page=10"}}` |
| `jira` | issues new to a JQL or whose `updated` moved | `{"name":"p1s","jira":{"jql":"project = X AND priority = Highest"}}` |
| `tcp` | whether host:port accepts a connection | `{"name":"db","tcp":{"host":"db.example.com","port":1521}}` |
| `aws` | an AWS CLI read (JSON) | `{"name":"build","aws":{"args":["codebuild","batch-get-builds","--ids","p:u"],"profile":"p","region":"r"},"items":"builds","changed":"buildStatus"}` |
| `exec` (stream) | each stdout line of a long-running command | `{"name":"q","exec":{"command":"my-queue-consumer --follow","match":"FAILED"}}` |
| `timer` | a schedule: `every` a duration from creation, or `at` HH:MM daily (one or a list); never a stale slot after a restart | `{"name":"sweep","timer":{"every":"6h"},"text":"BOARD SWEEP DUE"}` |
| `webhook` (stream) | POSTs to a path on the loopback listener | `{"name":"gh","webhook":{"path":"/gh","secretHeader":"x-hook-secret","secretEnv":"HOOK_SECRET","text":"{action} #{number}"}}` |

Change detection is the same for every poll kind. `match` (a regex over the text form) reports the matched text whenever it differs from the last one reported, including on the first run, because such a watch means "tell me when this is true" and it may already be. `items` (a path to an array in a JSON payload) with `id` (default `id`) reports new items, and with `changed` (a field path) items whose field moved; `text` templates the event from the item (`"{id} {status}"`). `value` (a path to one value) reports when that value changes (`value data.version: abc -> def`), with `expect` when it becomes that value, or with `above` / `below` (and `for` polls of hysteresis) when it crosses a bound and when it is back. With none of them, the trimmed text is compared with the last run (`output changed: ...`), after a first run that only records the baseline. `${NAME}` inside `http` urls, headers and bodies is read from the environment, so a secret never sits in a file. The `http` kind sends `If-None-Match` when the server gave an ETag and reuses the cached body on a 304, which keeps a GitLab, Azure DevOps or Bitbucket poll cheap against its rate limit; `example/watches/` has one of each.

Other git and DevOps providers need no code: GitLab (`PRIVATE-TOKEN` header, `id: "iid"`), Azure DevOps (`Basic` PAT, `items: "value"`), Bitbucket (`items: "values"`), or any REST API, through `http` with `items`, `id`, `changed` and `text`. A helper such as pr-merges for another provider is a module: copy `lib/builtin/github.js` into your `modules/` under a new name and change the endpoints.

Streams are the door to anything that pushes: a queue consumer, a database change feed, `docker events`, a log tail (`exec`), or any service that can POST (`webhook`, loopback only; a tunnel or a relay on the same machine is what makes it reachable from outside). A webhook watch reports one event per POST: `text` is a template over the parsed JSON body, `match` filters.

## Derived events: spikes and silences, no source and no LLM

A `derive` watch reads the event stream itself and says one thing per transition. `rate` turns a flood into one line and one when it is over; `silence` turns an absence into one line and one when the source speaks again:

```json
{ "name": "slack-storm",  "derive": { "probes": ["custom:slack-inbox"], "rate": { "window": "5m", "over": 20 } } }
{ "name": "stamps-quiet", "derive": { "probes": ["stamps"], "silence": { "for": "30m" } } }
{ "name": "p1-words",     "derive": { "match": "outage|down|P1", "rate": { "window": "10m", "over": 5 } } }
```

Lines read `SPIKE: 23 custom:slack-inbox lines in 5m (threshold 20)`, `SPIKE over: ...`, `SILENT: nothing from stamps for 30m (last at ...)`, `SILENT over: ...`, as `custom:<name>`; a plan rule with `priority: "urgent"` on `^SPIKE` is how an outage that makes a channel explode costs one wake. A rate rule re-arms once the count is under half the threshold; silence is measured from the last matching line and kept in state across restarts. Thresholds on numbers live in the change-detection layer instead: a `value` watch with `above` or `below` and `for` (polls) reports `value cpu above 85: 91 (3 polls)` once and `value cpu back, not above 85: 40` once, which is what a Datadog or CloudWatch query becomes.

## Metrics for displays

A number a source reads on every poll can be kept for a display (a tray, a dashboard), not only turned into event lines. A `command`, `http`, `aws` or `github` watch declares one with a `metric` block; the `datadog` module's `metrics` entries take `description`, `unit` and `display` too; a poll module returns `metrics` from its `check`. Streams and the other kinds have none.

```json
{ "name": "disk-free", "command": "df -BG /c | awk 'NR==2 {print $4\" free\"}'", "below": 15,
  "metric": { "description": "Free space left on the build disk, in gigabytes. When it fills up, builds start failing.", "value": "(\\d+)G free", "unit": "GB", "display": { "type": "gauge", "min": 0, "max": 250 } } }
```

- `description` (required): what the number is, in plain words, for someone who does not know the term; at most 400 characters. A display shows it beside the number. A metric without one is left out of metrics.json (logged once by the engine, a FAIL in `watchhub doctor`); the watch itself still loads and its event lines carry on. A poll module's own metrics need one too.
- `name` (default the watch's name): lowercase letters, digits and dashes.
- `value`: a regex with one capture group around the number, over the text form; the capture must be a plain number (`12`, `-3.5`). A watch with a `value` path needs no regex; when both are set the regex wins. A reading that is not a number keeps the last good value and moves no bound either way.
- `unit`: a short label, `GB`, `%`, `ms`.
- `display`: how the reader would like it drawn: `{type, min?, max?, warn?, bad?, lowIsBad?, label?}`. `type` is a name the reader knows (`dial`, `gauge`, `line`, `bar`, `number`...) or `custom:<name>` for a renderer of your own; the engine checks the shape and passes it on, it draws nothing. `bad` defaults to the watch's `above`, or to its `below` with `lowIsBad: true`.

A regex-only metric watch says nothing unless it has `above` or `below`: then it reports `disk-free below 15: 12` once and `disk-free back, not below 15: 40` once, like a `value` watch (`expect` needs a `value` path). With `match`, `items` or `value` the metric rides along and the events are unchanged; an `http` watch on its status keeps its `status a -> b` lines; a `github` watch with only a regex metric drops its default new-item lines unless it names `items`.

The engine writes two things into the instance folder:

- `metrics.json`, at most every 5 s: `{at, metrics: {"<probe>/<name>": {probe, name, scope, value, at, intervalSec, description, unit?, display?, past, inboxes, history}}}`. `at` is when the value was last read, so a reader can tell a stale one from `intervalSec`; `past` is whether the source's threshold or match is currently tripped; `inboxes` are the subscriptions whose filter or plan takes a `METRIC <name>` line from that probe and scope, so a display can show each agent its own. A probe gone from the engine, switched off or waiting on its environment drops out, and so does a name it stops reporting. A report with a bad name or display, or with no description, is logged once and left out; `doctor` checks watch metrics and the datadog entries.
  `watchhub metrics [<regex>] [--probe p]` prints it one line per metric, `<probe>/<name> <value> <state> <threshold> <label>`, where the state is `ok`, `warn` (at or past `display.warn`), `bad` (at or past `display.bad` while the threshold is not tripped, as before its `for` polls), `PAST` (the threshold is tripped), `stale` (no reading for three intervals) or `none` (never read); the regex matches the key or the label, ignoring case. It is the cheap way for an agent to read the numbers.
- `metrics/<file>.jsonl`: one `{at, v}` line a minute per metric, plus one whenever `past` flips, kept for 24 hours. The entry's `history` names the file; read it from there rather than building the name.

A module reports metrics by returning them with its events: `{events, state, metrics: [{name, value, description, unit?, display?, above?, below?, past?, scope?}]}`, one entry per number, every poll. `value: null` means no reading this time.

## Shipped modules

The engine ships the helpers most teams need; each switches on when its section is in `instance.json` (and off with `"probes": {"<name>": false}`), reports its state in `watchhub now`, is checked by `doctor`, and emits the lines below. `example/instance.json` has every section filled in.

| Section | Probe(s) | Lines |
|---|---|---|
| `github` {repos, authors, ignoreCommentAuthors} | `pr-merges`, `pr-checks` | `MERGED repo#1 sha7 title`, `CHECKS repo#1 sha7 all green / FAIL: names`, `MERGEABLE repo#1 CONFLICTING / ok`, `REVIEW repo#1 approved by who at HH:MMZ: text` |
| `jira` {base, email, me, tokenEnv, projects[{key, jql, quietMovesTo, quietComment}], ignoreActors} | `board` | `TICKET NEW key summary`, `TICKET MOVED key from -> to by who`, `TICKET COMMENT key by who: text`; `watchhub jira follow KEY [--ttl 30d]` joins a ticket from outside the projects (or their jql) to the same search, without its project's quiet filters, until its ttl (`unfollow KEY`, `follows`; kept in `jira-follow.json`); a key Jira does not know is refused at follow time, and one deleted later is dropped with `TICKET UNFOLLOWED key` so the search keeps working |
| `aws` {profiles[{profile, region, login?}], login?, loginEverySec?, loginTimeoutSec?} | `aws-auth` | `AWS profile ok / expired`; with `login: true` an expired profile is signed in again with `aws sso login` (it opens the browser and finishes on its own where the identity provider remembers you): a renewal that works makes no line, one that fails reads `AWS profile expired (sign-in failed: ...)`, once; a profile's own `login` overrides the section's; one attempt per profile per `loginEverySec` (default 1800), each given `loginTimeoutSec` (default 120); after a sign-in times out the other profiles wait (`sign-in not tried: ...`), and a sign-in that works re-reads every expired profile, since profiles often share one SSO session |
| `vpn` {port, noneAfterSec, <side>: host, ...} | `vpn` | `VPN office / cloud / both / none`; `noneAfterSec` holds none back until it has lasted that long, so a switch between sides makes one line (only once a side has been reported: none on a first run goes out at once) |
| `stamps` {scope, label, path, value, hosts{env: host}} | `stamps` | `STAMP env api version` (after two agreeing polls) |
| `datadog` {site, scope, monitors: true or {hosts, states, minGapMin}, monitorTags, metrics[{name, description, query, window, above/below, for, unit, display}], logs[{name, query, window, over}]} | `datadog` | `MONITOR name [host:x] Alert` and its recovery `OK` (only groups whose host, tags or name match `hosts`; only `states`, default Alert; one line per group per `minGapMin`, default 30), `METRIC name above 85: 91 (3 polls)` / `back` (the value is the newest non-empty point in `window`, so keep the window short: an older point counts as current), `LOGS name 23+ in 5m (threshold 10)` / `back` |
| `system` {scope, disks{"C:" or a mount path: {below, for, display}}, memory{above, for}, cpu{above, for}}; each check also takes `display` and `description` | `system` | `SYSTEM disk-c below 10: 8.2 (2 polls)` / `back, not below` (GB free), `SYSTEM memory above 90: 93` (% in use), `SYSTEM cpu above 90: 97` (% busy since the last poll, across every core; the first poll has no value); each check is also a metric, with a plain description built in (a check's own `description` replaces it). No token. Memory is total minus what the OS reports free; macOS counts inactive memory as used, so set `memory.above` higher there |
| `jenkins` {base, jobs[], scope, userEnv, tokenEnv} | `jenkins` | `BUILD folder/job #812 SUCCESS / FAILURE / UNSTABLE / ABORTED` when a build ends (folder and job names as Jenkins shows them, joined by `/`; a multibranch branch `feature/x` is the job `feature%2Fx`; the first poll only records); a job that cannot be read is said once (`JENKINS job failing: why`, later `JENKINS job works again`) and the others go on |
| `sonar` {base (default SonarCloud), scope, tokenEnv, projects["key" or {key, branches, pullRequests, scope}]} | `sonar` | `SONAR key@branch gate OK -> ERROR` when a branch's gate changes (the main branch unless `branches`), `SONAR key#7 gate ERROR: title` for a pull request's first verdict and each change (`pullRequests: true`); a project's first poll only records, and so does switching `pullRequests` on; an analysis still pending keeps the last verdict; a project that cannot be read is said once (`SONAR key failing: why`, later `works again`) and the others go on |
| `deploys` {profile, region, scope, pipelines["name" or {name, profile, region, scope}], amplify[{app, branch, name, profile, region, scope}]} | `deploys` | `DEPLOY pipeline 1a2b3c4d SUCCEEDED / FAILED / STOPPED / SUPERSEDED / CANCELLED` for a CodePipeline execution, `DEPLOY name job 42 SUCCEEDED / FAILED / CANCELLED` for an Amplify job, once each when it ends, through the `aws` CLI and its profiles; one that cannot be read is said once (`DEPLOY name failing: why`, later `works again`) and the others go on |
| `jobs.json` (always on) | `jobs` | `JOB label SUCCEEDED / FAILED ...` for queued CI and deploy runs |
| `slack` {read, scope, ignoreBots, ignoreSelf, match, sinks, replyText, tokenEnv} | `slack` | `SLACK DM <who>: <text>`, `SLACK group DM <who>: <text>`, `SLACK #channel <who>: <text>`, `SLACK self <who>: <text>` (the DM with yourself), each ending ` [reply r1a2b3c4]` (Two-way sources below) |
| (no section: the `slack` kind and sink) | `custom:<watch>` | `<who>: <text>`, `DM <who>: <text>`, `#channel <who>: <text>`, each with a reply handle |

Tokens come from the environment or `~/.watchhub/env`: `GITHUB_TOKEN` (else `gh auth token`), `JIRA_API_TOKEN`, `SLACK_USER_TOKEN`, `DD_PAT` (a Datadog personal access token; else `DD_API_KEY` and `DD_APP_KEY`), `JENKINS_USER` and `JENKINS_TOKEN` (an API token; both optional for a server anyone can read), `SONAR_TOKEN` (optional for public projects), AWS through its own profiles. A module in `modules/` with a builtin's name replaces it, which is how a team changes one without forking the engine.

## Modules (helpers in code)

`watchhub module new <name> [--stream | --two-way]` writes a working module into `modules/` from a template (a poll module with `check(state, cfg, env, api)` and a `now` line, a stream module with `start(ctx)`, or a two-way module that also answers, below), with the `env` declaration and the change-detection call in place to edit. `watchhub module list` shows every loaded source, shipped or own, its interval or stream mark, and whether it is on. `watchhub once` runs every poll source one time while the engine is stopped, which is the quick way to try a new module before restarting the engine.

A module is one file in `modules/` exporting a source object, or a function that takes the api and returns one:

```js
module.exports = (api) => ({
  name: "pr-merges",            // the probe column of its events
  intervalSec: 30,              // overridable live through instance.json intervals
  enabled: (cfg) => cfg.probes?.["pr-merges"] !== false,   // optional; this is the default
  onStart(slot, cfg) {},        // optional: adjust saved state when the engine starts (forget a value so it is announced again)
  async check(state, cfg, env, api) {
    // state: what the last run returned (undefined the first time). Return only events worth acting on.
    return { events: ["MERGED repo#1 abc1234 title", { scope: "nh", text: "..." }], state: { since: "..." } };
  },
  now: (state) => "merges reported up to ...",   // optional: one line for `watchhub now`
});
```

A stream module exports `{ name, stream: true, start(ctx) }` instead: `start` runs for the life of the stream, calls `ctx.emit(text | {scope, text})` per event, watches `ctx.signal` to stop, and resolves or rejects when it ends; the engine restarts it with back-off (5 s doubling to 5 min, reset after a minute of running). `ctx` also carries `cfg`, `env`, `api`, `log`, `state` and `setState`.

### Two-way sources

A source that reads a place people talk in (a chat, an inbox) can also answer there. A two-way module extends `api.TwoWay`, returns `this.line(text, to)` from `check` for each line that can be answered, and implements `send(to, text, ctx)`:

```js
module.exports = (api) => {
  class Chat extends api.TwoWay {
    constructor() { super({ name: "chat", intervalSec: 60, env: ["CHAT_TOKEN"] }); }
    async check(state, cfg, env) { /* read; return { events: [this.line("CHAT room who: text", { room, under: id })], state } */ }
    async send(to, text, ctx) { /* post text where `to` says; ctx: {cfg, env, api, log}; throw on failure */ }
  }
  return new Chat();
};
```

`to` is any small JSON object `send` understands. The engine gives each answerable line a handle and writes it on the line (`... [reply r1a2b3c4]`), recording where it answers in `replies.json` before the line reaches any inbox. `watchhub reply <handle> '<text>'` hands the text and `to` back to that source's `send`. A handle is the same for the same place (a thread, a DM), so it stays good for the whole conversation, and `replies.json` keeps a week of them (at most the newest 5000). A handle quoted inside a line's own text (someone pasting `[reply …]` into a message) is blanked to `[reply quoted]`, so the handle at the end is the only one that answers it. Nothing is ever sent except by that command; whether an agent may use it is the plan's call. Two-way is meant for conversations (Slack now; Teams or email the same way), not for trackers. The shipped `slack` module and the `slack` kind are two-way.

The engine owns scheduling, back-off (a 403 or 429 doubles the interval up to 16x until the next success), failure and recovery lines, state persistence and delivery, so a module is only the read and the diff. Throw on failure; the first failure is logged, the second writes `probe <name> failing`. A module that fails to load is skipped with a line in engine.log, never fatal.

The api (`require("watchhub")` in a package context, or the argument): `run`, `runJson` (a CLI with timeout: the one way a module starts a child process), `fetchJson`, `fetchText`, `fetchRaw`, `ghGet(path, cache, next, reduce, cfg)` (conditional GET; keep `reduce` small, its result is what is cached), `ghGraphql`, `ghLogin`, `ghToken`, `jiraHeaders`, `jiraSearch`, `tcpReach`, `detect(spec, state, payload, text)` (the change-detection layer), `scopeOf(cfg, facts, fallback)`, `prAuthors(cfg)`, `oneLine`, `pick`, `template`, `envSubst`, `readRange`, `parseDuration`. A module may `require` its own dependencies from a `node_modules` next to the instance folder.

The engine ships one built-in module, `jobs`: one-off CI or deploy runs queued with `watchhub add-job` (`gh-run` through REST with ETags; `codebuild`, `codepipeline`, `amplify` through the AWS CLI), each reported once with `JOB <label> <STATUS>` and dropped. A job is one terminal result: after a `gh run rerun` of the same run id, queue it again (`add-job` accepts the id once the earlier entry has been reported and dropped), or no line comes for the new attempt. A new id queued under a label that is still pending replaces that entry (a cancelled run and its retry are one job), and one label never produces two lines for one state. A malformed entry is dropped with a line; one that cannot be read is reported at the third failure and dropped at the fiftieth.

## Plans

A plan is which events an inbox takes plus what to do with each kind, so a woken inbox has its instructions in front of it:

```json
{
  "name": "release",
  "scope": "team",                       only this scope's events (plus scope "all"); omit for every scope
  "probes": ["pr-merges", "jobs", "custom:app-log"],   which sources feed it; omit for all
  "filter": "",                        regex over the whole line, applied last
  "notify": true,                      the waiter ends the burst with a notify line (default true)
  "on": [
    { "match": "^MERGED (frontend|webapp)#", "do": "deploy round: ..." },
    { "match": "^TICKET MOVED", "quiet": true }
  ],
  "default": "read and decide"
}
```

`match` is tested against the message and the whole line; the first matching rule's `do` is printed once per burst, `default` when nothing matches. Every rule (and the plan, for lines no rule matches) has a `priority`: `urgent` wakes the inbox at once with no settle, `normal` (the default) wakes after the settle, `low` never wakes on its own. `quiet: true` is the old spelling of `priority: "low"`.

## Fewer wakes, shorter wakes

Every wake is a full turn for the agent that reads it, so the waiter spends them carefully. A **cooldown** (`--cooldown` on the subscription, else `engine.cooldownSec`, default 60) holds normal lines for that long after a burst, so a check verdict and the job result that follows it thirty seconds later are one wake, not two; urgent lines never wait. The **instructions** block prints a rule's `do` text in full once per `engine.instructionsRepeatHours` (default 4) per inbox and then names the rule (`as before for /^MERGED/`), since the text is the same and `watchhub plan show <name>` has it. A re-arm long after the last burst gets a one-line pointer to it, not the burst again. `watchhub stats` shows wakes per inbox; an inbox with many wakes a few minutes apart wants a longer cooldown, an inbox with long bursts wants a plan with `low` rules.

## Plan codes: the instructions as a skill

A plan's `do` texts are the largest part of a wake. `watchhub plan skill <plan> [--out <dir>] [--as <skill-name>]` writes them once as a skill (`SKILL.md` with one section per rule, under `<instance>/skills/<skill-name>` or `--out`), sets the plan's `skill` field, and from then on every burst from that plan ends with `INSTRUCTIONS: MRG, R4, D (skill watchhub-plan-<plan>)` instead of the text. An agent loads the skill once per session and applies the codes, so `--out` belongs in the folder your agent reads skills from (`~/.claude/skills/<skill-name>` for Claude Code; a leading `~` works from any shell); `D` is the plan's `default`. Codes are a rule's own `code` (one to eight capitals or digits, starting with a letter) or, for rules without one, `K` plus three characters derived from the rule's match, which `plan skill` writes into the plan so they stay put when rules are inserted. The engine rewrites the skill whenever the plan changes, so codes and text never drift apart.

## Priorities and the ALSO block

Most lines are not worth a turn on their own. A low-priority line waits in the inbox and rides along with the next burst, printed under an `ALSO` heading grouped by probe with a count and the last couple of texts (`- custom:slack-inbox: 7 lines; last: Dev: can you look at #team | Dev: ping`), so an inbox reads "seven Slack messages since last time" as metadata rather than seven lines and spends no turn on them; the full lines stay readable with `watchhub events --inbox <inbox>`. A low backlog does wake the inbox once it reaches 50 lines, 4 hours of age or 256 KB, so nothing sits unread for a day. `urgent` is the other end: a wake the moment the line lands, before the settle window. Priority comes from the plan rule, else the plan, else the subscription (`watchhub sub <inbox> --filter '...' --priority low`); `--urgent <regex>` on a subscription makes matching lines urgent whatever the plan says; notices and probe-health lines about probes the inbox did not name are low. "Watch Slack: mentions and channel posts low, DMs to me urgent" is one plan with two rules.

## Subscriptions

`subscriptions/<inbox>.json`, written by `sub`: `{inbox, plan | filter | scope | probes, expires, settle?, urgent?, sinks?, session?}`. A filter whose every `|`-separated token is a probe this instance has (`vpn|aws-auth`, `custom:app-log`) selects those probes, their failing and recovered lines included; anything else is a regex over the whole event line, so a job label (`5513-green`) or a PR (`repo#42\b`) matches the lines that carry it. `sub` prints which reading it used.

## Sinks (Slack, Teams, a toast, any webhook)

A sink is somewhere a line goes besides an inbox, so a person sees it on a phone or a desktop without an agent in the loop. `sinks/<name>.json` is one of:

```json
{ "name": "slack", "http": { "url": "${SLACK_WEBHOOK_URL}", "body": { "text": "{text}" } } }
{ "name": "toast", "toast": { "title": "watchhub {probe}", "text": "{text}" } }
```

`http` posts the templated body to any webhook: a Slack Incoming Webhook, a Teams Workflows webhook (adaptive card body, see `example/sinks/teams.json`), Discord, a pager, your own endpoint. `method` and `headers` are optional; `${ENV}` in the URL and headers comes from the environment or `~/.watchhub/env`, so the secret never sits in the file. A body given as an object is sent as JSON, a string as text. `toast` shows a Windows notification (no module, no admin). Template fields: `{text}`, `{line}`, `{probe}`, `{scope}`, `{at}`, `{count}`, `{instance}`, and `{inbox}` and `{do}` (the plan rule's instruction) when the line came through a subscription.

A line reaches a sink three ways, and once however many name it:

- the watch that produced it: `"sinks": ["slack"]` on the watch, for "when this fires, ping me"
- a subscription: `watchhub sub <inbox> --plan p --sinks slack`, for "everything this inbox wakes on, I see too"
- a plan: `"sinks": [...]` on the plan, overridable per `on` rule (a rule's own `sinks`, `[]` to keep that rule off every sink); a `quiet` rule goes nowhere

A `slack` sink posts as you through the user token instead, to any channel, private channel or DM, so one token serves every target and no webhook is needed per channel: `{ "name": "team", "slack": { "channel": "#team" } }` (`@me` is the DM with yourself; `text` templates the message, default `{text}`). The Slack section below says how the token is made.

`watchhub sink list | add '<json>' | rm <name> | send <name> '<text>'`; `send` posts from the CLI, so a sink is proved before anything names it. Sends are serialised per sink and lines that arrive while one is in flight go out as one message (20 lines, then a count), so a burst never hammers the webhook. A batch that fails to send is kept and sent again after 1, 5 and then 15 minutes, whatever probes its lines came from, with the lines that arrive meanwhile; at most 200 lines are held per sink, beyond which the oldest are dropped with an `engine.log` line. A sink that fails three times in a row produces one `watch` line (`sink slack failing: ...`) and one when it works again. The held lines live in memory, so a restart during an outage loses them from that sink only; they are still in `events.log`. Sinks are notification only: nothing a sink does feeds back into the engine.

A line with a reply handle is answered with `watchhub reply <handle> '<text>'` (Two-way sources above). For a watch whose kind cannot answer by itself, a watch that reads a place a sink can also write to (a Slack channel, the DM with yourself) names that sink as its `reply`: `{"name": "notes", "slack": {"channel": "@me"}, "reply": "slack-me"}`. That is what marks it as a conversation rather than a feed, so a display can offer an answer box beside its lines and an agent can answer where the line came from: `watchhub reply <watch> '<text>'` sends the text through that sink as a line from `custom:<watch>` (so the sink's `{probe}` and `{scope}` are the watch's). `watch list` shows the pairing and `doctor` fails a `reply` that names no defined sink. A watch that reads your own messages (`ignoreSelf: false`, as the DM with yourself needs) must skip the replies: give the sink a prefix (`[wh] {text}`) and the watch a `match` that refuses it (`^(?!\[wh\])`), or every reply reads back as a new line. The `slack` kind can answer by itself without a sink: its `replyText` (`"[wh] {text}"`) wraps every answer, fixed when the line is read, and `validate` refuses one the watch's `match` would let back in. A slack watch with `ignoreSelf: false` and no `replyText` gives its lines no handle. Replies inside a thread are not read (only top-level messages are); one that mentions you arrives through `@mentions`.

## Slack both ways (and agents talking to other machines)

One Slack app, installed by you, gives a user token that acts as you: no bot, no admin. In the app (api.slack.com/apps) under OAuth & Permissions add the user token scopes `channels:history`, `channels:read`, `groups:history`, `im:history`, `im:write`, `chat:write`, `users:read`, `search:read`, install (or reinstall) it to the workspace, and put the User OAuth Token (`xoxp-...`) in `~/.watchhub/env` as `SLACK_USER_TOKEN`. `watchhub doctor` then reports who the token signs in as.

Outbound is the `slack` sink above. Inbound is the `slack` kind: `{"name": "team-feed", "slack": {"channel": "#watchhub", "match": "^\\[wh\\]"}}` turns every new message in the channel into an event line `custom:team-feed | custom | <poster>: <text>`. `channel` can also be a list, and `@dms` (every direct message to you, sender named) and `@mentions` (anything anywhere that mentions you, prefixed with its channel), both through Slack search (scope `search:read`), one call each however many conversations you have, make an inbox: `{"name": "inbox", "slack": {"channel": ["@dms", "@mentions"]}, "sinks": ["toast"]}` shows a toast whenever someone writes to you or tags you. The first run takes the newest message as the baseline; each later poll asks only for what came after it, one small call. Your own messages are skipped unless `"ignoreSelf": false`, so an agent that posts to the channel it reads does not wake itself; `match` keeps only the lines meant for agents, so a channel can carry people's chatter and agent lines side by side.

A Slack line can be answered when it ends with a reply handle (every line does, except from a watch that reads your own messages with no `replyText`): `watchhub reply <handle> '<text>'` posts the text as you where the message was: in its thread for a channel message (starting one if it had none), in the DM for a direct message (in its thread if it was in one). A watch reading more than one place names the place on each line (`#name`, or `self` for the DM with yourself). A watch that reads your own messages (`ignoreSelf: false`) reads your answers back too unless its `match` refuses them, as with the sink prefix above.

For your own Slack, the shipped `slack` module saves writing watches: an `instance.json` section `"slack": {"read": ["@dms", "@mentions", "#team"], "scope": "team", "ignoreBots": true, "sinks": ["toast"]}` reads those places every 30 seconds as one probe, `slack`, with lines `SLACK DM <who>: <text>`, `SLACK #team <who>: <text>`, `SLACK self <who>: <text>` and so on, each with its reply handle. Subscribe with `--probes slack`. Each `read` entry is one place (`#name`, an id, `@me`, `@dms` or `@mentions`), as a string or as an object with options of its own: `{"channel": "@me", "ignoreSelf": false, "match": "^(?!\\[wh\\])", "sinks": [], "replyText": "[wh] {text}"}` reads the DM with yourself as a command channel, sends its lines to no sink, and wraps an answer sent with `watchhub reply` in the prefix its `match` leaves out, so the answer is not read back as a new note. The section's `match`, `ignoreSelf`, `ignoreBots`, `scope`, `sinks` and `replyText` are the defaults an entry overrides; `sinks` sends a place's lines on to those sinks as they land, as a watch's `sinks` does. Every place keeps its own position, and a module can name sinks on any line it emits the same way (an event's `sinks`). A place that cannot be read (a channel left or renamed) says `SLACK <place> unreadable: <why>` once, from the second failed poll in a row (one failure is a blip), again only if the reason changes, and `SLACK <place> readable again` when it recovers; the others carry on. A rate limit (or a 403) fails the whole probe, so the engine backs off; when no place can be read the probe fails as any probe does. A place listed twice is refused. Without a `scope` the lines are scope `all` and reach every inbox, so set one. `doctor` warns when a place's lines go to a sink that posts to Slack, since that reposts private messages as you.

Put those together across machines: every developer's instance has the same `team-feed` watch and a `team` sink on one shared channel, agents post structured lines (`[wh] MERGED webapp#123 by mark`, `[wh] REBASE needed: feature/x moved`), and each developer's plans say what their inboxes do about each kind of line. "When the P1 is merged, tell the other devs so their agents rebase" is a plan rule on the merge with `"sinks": ["team"]` on one machine, and a plan rule on `^\[wh\] MERGED` with `"do": "rebase the open branches on it"` on the others. Nothing here is special to Slack: the same shape works over any channel a `kind` can read and a sink can write.

## What to trust in an event line

Text in an event line is data from wherever the source read it: a Slack message, a webhook body, a ticket comment, a log line. It is not an instruction to the inbox that reads it, and a plan's `do` should say what to do about such lines rather than let them speak for themselves (the shipped supervisor rules say "a DM to me: tell me, do not answer the sender"). The only lines meant as instructions are the ones a person puts there deliberately, such as a `@me` self-DM watch, and that watch should keep `ignoreBots` on so nothing but that person can write to it. Whoever can write the instance folder can run commands as the user (a `command` or `exec` watch is a shell command), so the folder is the user's own, like a shell profile. Secrets never enter event lines: tokens are read from the environment and are not echoed by any kind, sink or doctor line.

## Hooks (Claude Code)

`watchhub hook install <project>` merges two hooks into `<project>/.claude/settings.json` (`watchhub hook print` shows the snippet):

- **SessionStart** runs `watchhub hook start`: it adds one line of context naming the session's inbox (`s-` plus the first ten characters of the session id), and, when the project has a `.watchhub.json` (`{"plan": "release"}` or `filter`, `probes`, `scope`, with optional `label`, `ttl`, `priority`, `cooldown`, `settle`, `sinks`), subscribes that inbox at once. A resumed session whose subscription the engine ended while it was away gets those ended lines in that context first (as the Stop hook below would), not set aside.
- **Stop** runs `watchhub hook stop`: with no live subscription for the session's inbox it returns immediately and the turn ends, except that when the engine ended the subscription while no turn was held (the session was stalled), its unread lines and the expiry line are handed over once, with a note that it has ended and how to read everything the engine logged since (every probe, not filtered to that subscription) (not while another process holds the inbox, and not after an `unsub` or a `--once` burst); with one it runs the ordinary wait (priorities, cooldown, settle, the ALSO block, instructions once per window) and answers `{"decision": "block", "reason": "<burst>"}`, which Claude Code hands to the agent as its next input. The hold ends shortly before the hook's own timeout (`--hold`, default 43140 s against a 43200 s timeout) with a one-line note, so the session simply ends its turn and is held again; a superseded wait (another process took the inbox) lets the turn end. The hold never keeps a session from its person: Claude Code queues a message sent during a running turn (a person's, another session's, a finished background task's) and writes a `queue-operation` line to the session's transcript (`transcript_path` in the hook's input), so the hook watches that file and lets the turn end, with nothing acknowledged, as soon as a message is queued, when a new turn appears there (the session was restarted while the old hook process lived on) or when Claude Code itself (the hook's nearest ancestor process named `claude`) has gone; when it runs under another name that last check is skipped. A message that was queued and then became an ordinary prompt without being taken off the queue does not count. The queued message runs, and the unread lines burst at the next turn end.

`hook install` also writes the agent skill to `<project>/.claude/skills/watchhub/SKILL.md`: the package's `skills/watchhub/SKILL.md` followed by a `## This instance` section generated from the instance (the `agentNotes`, the sources switched on, the watches with their kinds and scopes, the scopes, the plans with their rule counts and code skills, the sinks). The folder is remembered in `agent-skills.json` with a hash of what was written, and the engine rewrites the file on start (so after an upgrade), when plans, watches or sinks change, and within a minute of an `instance.json` edit. A copy that was deleted, or changed by anyone else since (a person, or another instance writing the same folder), is forgotten with one `engine.log` line rather than fought over; `hook install` or `skill --out` takes it back. `watchhub skill --out <dir>` does the same for any other folder, and `watchhub skill` prints the text. The package's own `skills/watchhub` folder is never written. Without an instance, `hook install` still writes the hooks and says to run `watchhub init` first for the skill. The skill is generated per machine, so a project-level copy belongs in the project's `.gitignore` (`.claude/skills/watchhub/`), not in git.

A session that wants no watcher needs no opt-out: with nothing subscribed, nothing is held. The agent still subscribes itself (`watchhub sub <inbox> --plan <p>`), which keeps the choice of plan with the agent and lets a human change it with `sub` at any time.

## Schedules (at, in)

A schedule is one line the engine emits once, at a time someone asked for: `watchhub at 15:30 'stand-up notes'` or `watchhub in 20m 'check the deploy'`. The text is one line of plain text, 500 characters at most. Where it goes is the target: inbox names before the text (`watchhub in 20m s-abc123def4 ops 'look at the queue'`), `--sink <a,b>`, `--scope <s>` for an ordinary line to every inbox that takes the scope, or any mix. With no target named, the line goes to the caller's own inbox, found in this order: `WATCHHUB_INBOX` in the environment (any harness or person can set it), the `inbox` in the working directory's `.watchhub.json`, or the Claude Code session running the command (`CLAUDE_CODE_SESSION_ID`, which it sets). With none of those the command refuses and says what to pass. `--from <inbox>` records who asked, for the list.

The line is `<UTC> | schedule | all | SCHEDULED <id> <text>`, with the given scope in place of `all` for a scope target. An inbox target gets it directly, whatever its filter, as a notice does; sinks get it as any line; a scope target goes through the matchers, and an inbox named both ways is given it once. The waiter treats every `schedule` line as urgent, since a reminder someone asked for is a wake. An inbox with no subscription is given one that takes schedule lines only (label `schedules`, scope `schedules`, a marker no source uses, so it never receives a line scheduled for some other scope), removed again once the inbox's last pending schedule has fired, so the hold ends with the line and no expiry wakes the session a day later; an inbox that has a subscription of its own keeps it until at least a day past the schedule. So the Stop hook holds the session's turn for a pending schedule through the same path it holds for any subscription, and `watchhub subs` shows why.

Times are stored in UTC and compared with the clock every 5 seconds, so a schedule fires within 5 seconds of its time and sleep, hibernation or a clock change make it late, never lost. `HH:MM` is the next such local time, today or tomorrow, worked out once when the schedule is made, so daylight saving is handled by the calendar; an ISO time (`2026-10-20T09:00`) must be ahead and within a year. `in` takes `90s`, `20m`, `2h` or `1d`. A schedule missed while the engine was down fires once when it comes back, as `SCHEDULED <id> <text> (late, due 15:30)`; so does one more than two minutes late for any other reason. Anything that repeats is a timer watch, as before.

The engine fires at least once: the line is written and delivered first, then the entry is removed from `schedules.json`. A crash between the two fires it again after the restart, with the same id and marked late, so a repeat can be told from a new one. A removal that fails (a full disk, a locked file) is tried again on the next tick while an in-memory list of fired ids stops a repeat within the same engine. `schedules.json` is read again only when its size or modified time changed (one `stat` per tick); one that does not parse is set aside as `schedules.json.bad-<time>` with a `watch` line saying so, never written over, and the engine carries on from empty. The same strict reading covers `state.json` at start and `replies.json` on every handle. At most 1,000 schedules are pending at once; `at` and `in` refuse beyond that. Whoever can run the CLI on this machine can schedule, as with `notice`.

`watchhub schedules [--json]` lists what is pending, soonest first, with each one's id, time, targets and text; `watchhub unschedule <id>` cancels one. A fired schedule leaves the file: the line in `events.log` is the record.

## Notices and planned restarts

`watchhub notice '<text>'` writes a line to every inbox whatever its filter. A notice does not wake an inbox by itself: it is read first in the inbox's next burst, so an announcement costs no turns. `--wake` makes it wake every inbox now. A restart is silent by default: the engine logs its start and stop in `engine.log` and writes no event line, because a restart that loses nothing is nobody's wake. `watchhub restart --message '<why>'` (and `stop --message`) adds a notice when there is something to say. The engine comes back within a minute under the service and every source resumes from its saved state; a probe's first poll after a start never repeats a line the log already holds (a check verdict, an auth state), only a change.

## Keeping the engine alive

`watchhub start` runs the engine detached from the shell that asked, but on Windows an application that owns that shell can still take it down when it restarts. `watchhub service install` registers a scheduled task for the current user (at logon, no time limit, no window: it runs `wscript` on `engine-launch.js`, which install writes into the instance folder, so no console flashes; run `service install` again after upgrading from 1.7.1 or earlier to get the current launcher), and starts the engine under it, so it outlives any application and every reboot; `start`, `stop` and the waiter's auto-start go through the task from then on (except while the launcher pauses between reruns, below). The launcher runs the engine again whenever it crashes, after 5 s, doubling to 5 min while it keeps failing and back to 5 s once a run has lasted 10 minutes, and logs each rerun in `engine.log`. Exit 0 (a planned stop) ends it. Exit 3 means another engine already runs this instance (`start` brings one up directly while the launcher is pausing between reruns; an engine that finds another holding the lock leaves with 3 too): the launcher stands by, says so once, and tries again every minute, so it takes over when that engine ends. Task Scheduler's own restart-on-failure is no help here: it covers a task that fails to start, never a program that exits non-zero. `watchhub service uninstall` removes it. On Linux the same command writes a systemd user unit (`~/.config/systemd/user/`, Restart=always) and enables it; on macOS a launchd user agent (`~/Library/LaunchAgents/`, KeepAlive). Desktop notifications (`toast` sinks) use the WinRT toast on Windows, Notification Centre on macOS and notify-send on Linux.

The engine checks its own memory once an hour and logs it; above `engine.memoryCapMb` it exits with code 2, which the service runs again (or the next `wait` does). A bug in one source does not take the engine down: a bad line from a module is logged and dropped, a rejected promise is logged, and an uncaught exception is logged and survived, unless five come within ten minutes, when the engine exits with code 1 so the service starts it clean. Every list it keeps is capped, ETag caches hold only the paths used in the last run, `engine.log` rotates at 5 MB, an inbox is emptied once it is fully acknowledged and over 1 MB. Waiters are fresh processes per arm, so nothing accumulates there.

## When something looks wrong

- No wake for a long time: `watchhub status`. "not running" means arm again (the waiter starts the engine) or `service install`; a `FAILING x3` line names the source and the error; `events today: 0` on a busy day means the sources cannot reach anything (token, VPN, network).
- A wake you did not expect: the burst shows the probe and the line; narrow the subscription (plan `probes`, a tighter filter, a `quiet` rule).
- A wake you expected and did not get: `watchhub tail 50` shows whether the event was written at all; if it was, the subscription did not match it (check scope and the filter rules); if it was not, the source did not see it (`status`, then the source's own interval and `match`).
- `UNACKNOWLEDGED burst` in `watchhub subs`: a burst was written but no waiter has printed it; arm the wait.
- Two waiters for one inbox cannot both run; if an inbox seems deaf, `watchhub leases` shows which process holds it.
