# Schedules, actions and tasks (design)

Draft of 17 Oct 2026, reviewed the same day (Mark); the decisions at the end record what was settled. None of this is built yet. It grows the engine from "watch and tell" into a small task engine in three layers, each released and useful on its own: schedules, then actions, then tasks.

## Why

- A timer watch recurs (`every`, `at`), but there is no quick way to say "wake me (or that session) at 15:30 about X". An agent that cannot run background commands without an approval prompt still has its Stop hook, so a schedule the engine owns reaches it anyway.
- Sinks only notify. Nothing happens on a line until an agent spends a turn on it, even when the response is always the same command.
- Routines with people and agents in them ("at 02:00 run the sweep; if it fails, wake the session that owns it; if nobody answers in an hour, tell me") have no home. Cron and Task Scheduler run commands but cannot wait for a person or an agent; the engine already reaches both.

## Principles

- **Everything is a line.** A schedule fires a line, an action reports a line, a task reports a line per step. Inboxes, plans, priorities, sinks, `derive` and `events.log` work on them unchanged.
- **Files in the instance folder, one machine, no server.** Definitions are JSON files a person can read and edit; run state is written after every change, so a restart resumes rather than repeats.
- **Event text stays data** (What to trust in an event line). Commands come only from files a person wrote. Event fields reach a command only as whole, separate arguments or environment variables, never through a shell, and each can be held to a pattern.
- **No model inside the engine.** Agents are reached only by waking their inbox; the engine never decides anything an agent or a person should.

## Layer 1: schedules

```
watchhub at <when> <target> '<text>'      when: HH:MM (next occurrence, local time) or an ISO time
watchhub in <duration> <target> '<text>'  duration: 90s, 20m, 2h, 1d
watchhub schedules [--json]               pending schedules, soonest first
watchhub unschedule <id>
```

- **Target:** an inbox name (`s-<session id>` or any other), `--sink <name>`, or `--scope <scope>` (an ordinary line for whichever inboxes take that scope). Several may be given. With none given, the target is the caller's own inbox, found in this order: `WATCHHUB_INBOX` in the environment (any harness or person can set it), the `inbox` in the working directory's `.watchhub.json`, or `s-<session id>` from `CLAUDE_CODE_SESSION_ID` when Claude Code set it (checked for, never assumed). With none of those, the command refuses and asks for a target.
- **The line:** `SCHEDULED <id> <text>`, probe `schedule`, scope `all` for an inbox or sink target (delivery is direct) and the given scope otherwise. The text is one line, at most 500 characters. The line is always `urgent`, since a reminder someone asked for is a wake.
- **Delivery to an inbox is direct,** like `notice`: it reaches that inbox whatever its subscription's filter, and the waiter treats a `schedule` line as urgent whatever the plan says. A schedule for an inbox with no subscription makes one (probe `schedule` only, label `schedules`), and a subscription's expiry is moved to at least a day past the inbox's last pending schedule; so the Stop hook holds that session's turn through the paths that hold it today, and `watchhub subs` shows why.
- **Missed while the engine was down:** a one-off schedule fires once when the engine comes back, as `SCHEDULED <id> <text> (late, due 15:30)`. Recurring timer watches keep today's rule (the next slot counts, no catch-up burst).
- **Recurring schedules stay timer watches.** `at` and `in` are one-off; anything that repeats is a watch, as now.
- **Storage:** `schedules.json`, `[{id, due, targets: {inboxes, sinks, scope}, text, created, by, run?}]`, where `by` is the inbox that asked when the caller gives `--from <inbox>`, and `run` (layer 2) names an action to start. A fired entry leaves the file once its line is out (Performance, reliability and fault tolerance); the line is the record.
- **Trust:** whoever can run the CLI on this machine can schedule, the same as `notice` today.

## Layer 2: actions

An action is a named command the engine runs when something asks for it, reporting the result as a line.

```json
{
  "name": "rerun-checks",
  "command": ["gh", "workflow", "run", "ci.yml", "--ref", "{branch}"],
  "cwd": "C:/work/webapp",
  "env": { "PR_NUMBER": "{pr}" },
  "on": { "probes": ["pr-checks"], "match": "^CHECKS (?<repo>\\S+)#(?<pr>\\d+) \\S+ failed on (?<branch>\\S+)" },
  "fields": { "pr": "^\\d+$", "branch": "^[\\w./-]{1,100}$" },
  "timeoutSec": 300,
  "cooldownSec": 600,
  "maxPerHour": 6
}
```

- **What starts one:** its own `on` (probes, scope and/or a regex over the line, like a plan rule), a schedule (`watchhub at 02:00 --run sweep`, which needs no other target), a task step, or a person (`watchhub run <action> [field=value ...]`). Plans never start actions: plans are what an agent reads, and an action should not depend on some inbox being subscribed.
- **Fields:** `{text}`, `{probe}`, `{scope}`, `{at}`, plus the named groups of the `on.match` that fired it (or `field=value` from `run`, or a task's values). Each `command` item is filled in and passed as exactly one argument, whatever it contains. Nothing goes through a shell. A filled-in argument may not begin with `-`: the command would read it as an option, so such a run is refused with a line naming the field, and a field that may start with a dash goes inside an argument (`--ref={branch}`). `{text}` and `{line}` may be used in `env` only, never in `command`.
- **Field patterns:** every field used in `command` or `env` that comes from a line must match its pattern in `fields`, or the run is refused with a line saying which field failed. `doctor` fails an action that uses a line field with no pattern.
- **Windows:** a `.cmd` or `.bat` file re-parses its arguments through cmd.exe, so an action whose command is one may not use line fields. Use an `.exe`, `node script.js` or `powershell -File script.ps1`.
- **Limits:**
  - one run at a time per action, with at most one queued (more are counted and reported with the next result);
  - `cooldownSec` (default 60) between runs started by lines;
  - `maxPerHour` (default 20), after which the action switches itself off with one line until a person runs `watchhub action enable <name>`;
  - `timeoutSec` (default 300, at most 3600) stops the whole process tree, as an `exec` watch does today.
- **Result lines** (probe `action`, scope of the line that started it):
  - `ACTION <name> <run id> ok (12s)`
  - `ACTION <name> <run id> failed, exit 2 (12s): <last line of stderr>`
  - `ACTION <name> <run id> timed out after 300s`
  - `ACTION <name> refused: field pr does not match ^\d+$`
  - `ACTION <name> off: 20 runs in the last hour`
- **No loops:** lines from probe `action` never start an action through `on`. Tasks chain on results deliberately, below.
- **Output:** each run's stdout and stderr go to `actions/runs/<name>/<run id>.log` (1 MB cap, newest 20 kept per action). `watchhub action log <run id>` prints one.
- **Storage:** `actions/<name>.json`, which carries `off: {why, at}` while the engine or a person has switched it off; run history in `actions/runs/<name>/index.json` as `[{id, started, ended, trigger, fields, exit, status, task?: {name, run}}]`, newest 100, where `task` names the task run that started it.
- **CLI:** `watchhub action list [--json] | add '<json>' | rm <name> | enable <name> | log <run id>`, and `watchhub run <action> [field=value ...]`.
- **Trust:** an action file is a command the person agreed to run unattended later, which is more than a one-off shell command. `action add` therefore writes the file switched off (`"enabled": false`) when it has an `on` trigger, and only a person switches it on: in the tray, or with `watchhub action enable <name>` in a terminal, which shows the command and its trigger and asks for the action's name to be typed back (with no terminal attached, as under an agent's shell tool, it refuses and says to ask the person). This guards against mistakes rather than against a hostile agent, which could edit the file itself; the instance folder is the trust boundary, as for `command` watches, and the agent skill says to ask. Actions run only by `run`, a schedule or a task step are on from the start.

## Layer 3: tasks

A task is a named routine: a trigger, then steps in order, with a failure path.

```json
{
  "name": "nightly-sweep",
  "trigger": { "at": "02:00" },
  "overlap": "skip",
  "steps": [
    { "run": "sweep", "retry": { "times": 2, "after": "5m" } },
    { "wait": "^DEPLOY sweep-job \\S+ (?<result>SUCCEEDED|FAILED)", "timeout": "45m" },
    { "if": "{result} == 'FAILED' or {failStreak} >= 2", "ask": { "inbox": "ops", "text": "sweep deploy failed; look at it" }, "timeout": "1h" }
  ],
  "onFail": [
    { "notify": { "sinks": ["me"], "text": "nightly-sweep stopped at step {step}: {why}" } }
  ]
}
```

- **Triggers:** `at` (HH:MM or a list), `every` (a duration), `on` (a line, as an action's `on`, its named groups becoming the task's fields), or none (only `watchhub task run <name> [field=value ...]`).
- **Steps:**

| step | does | succeeds when |
|---|---|---|
| `run` | starts an action with the task's fields | the action exits 0 |
| `wait` | waits for a line matching a regex (a field in it matches its value literally: the value is escaped, never read as a pattern) | a line matches; its named groups join the fields |
| `ask` (inbox) | wakes an inbox with the text and a run handle | the agent answers `watchhub task reply <run id> ok '<text>'` (or `fail`) |
| `ask` (person) | shows the question to a person (the tray, `task list`, and any sinks named) and waits | the person answers with `task reply`, in the tray, or in a two-way source's conversation when one is named; the answer matches `expect` |
| `notify` | sends a line to inboxes and/or sinks | at once |
| `delay` | waits | the duration has passed |

- **Every step** may have `timeout` (a duration; `wait` and `ask` require one), `retry` (`{times, after}`), `id` (a short name its outcome is known by), and `if` (a condition, below; a step whose `if` is false is skipped). A step that fails after its retries ends the run as failed and runs `onFail` with `{step}` and `{why}` set. v1 has no parallel steps and no loops; a routine that needs them is two tasks.
- **Conditions:** a small expression language of its own, parsed by the engine and never run as code.
  - **Values:** fields (`{result}`), quoted strings (`'FAILED'`), numbers (`2`, `0.5`).
  - **Comparisons:** `==`, `!=`; `<`, `<=`, `>`, `>=` (both sides must read as numbers, otherwise the comparison is false); `~` and `!~` (a regex match, with the regex a quoted literal, never a field, so text from outside never becomes a pattern).
  - **Logic:** `and`, `or`, `not`, parentheses.
  - **Fields beyond the task's own:** `{steps.<id>.status}` (`ok`, `failed`, `skipped`) and `{steps.<id>.exit}` for an earlier step with an `id`; `{attempts}` of the step about to run; `{failStreak}`, the failed runs of this task in a row before this one; `{lastStatus}`, the previous run's status.
  - **Missing fields** read as empty text, so `{x} == ''` asks whether one was set.
  - **Limits:** at most 300 characters. Every condition is parsed when the task is loaded, and `doctor` fails one that does not parse or names a field nothing sets, so a typo shows up before the run that needs it.
- **Run state:** `tasks/runs/<name>/<run id>.json`, written after every step change: `{id, task, trigger, started, ended?, status: running|ok|failed|cancelled|interrupted, fields, why?, steps: [{index, type, status, started, ended, attempts, deadline?, detail, ask?: {text, to, at}, answer?: {ok, text, by, at}}], onFail?: [the same, per on-fail step]}`. These shapes are what a display reads, so they are fixed here: `why` says what failed the run, an `ask` step keeps its question and where it went and the answer with who gave it, every waiting step carries its `deadline`, and the on-fail steps record what they did. After a restart a run resumes at its current step. A `run` step whose process died with the engine is marked `interrupted` and retried if retries remain, so an action used by a task must be safe to run twice.
- **Overlap:** `skip` (default: a trigger while a run is going is reported and dropped) or `queue` (one waiting run at most).
- **Lines** (probe `task`):
  - `TASK <name> <run id> started (<trigger>)`
  - `TASK <name> <run id> step 2/3 wait ok`
  - `TASK <name> <run id> done (14m)`
  - `TASK <name> <run id> failed at step 3: no answer in 1h`
  - `TASK <name> <run id> cancelled`
- **CLI:** `watchhub task list [--json] | run <name> [field=value ...] | runs [<name>] [--json] | show <run id> [--json] | cancel <run id> | reply <run id> ok|fail '<text>'`.
- **Person asks work with no chat module at all.** The core path is the engine's own: the question shows in the tray and in `watchhub task list`, any sinks named are notified (a desktop toast needs nothing installed), and the person answers with `watchhub task reply` or in the tray.
  - An ask may also name a two-way source (`"via": "<source>"`, a module or a watch) to put the question where the person already talks, and take the answer from there. That needs the source to read answers in one place: an optional `answers(to, since)` method on `TwoWay`, beside `send()`. A source without it can still be notified, but cannot take the answer.
  - `doctor` fails a task whose `via` names a source that is not loaded or has no `answers()`, so an instance without that source learns at load, not when the ask times out.
  - The `slack` watch kind would be the first to have `answers()` (replies in the thread the question was posted in), but it is optional like any source: an instance with no Slack watch loses nothing but that one route.

## Performance, reliability and fault tolerance

Asked for by Mark (17 Oct): the whole design holds to the rules below, and each layer's tests cover its fault cases, not only the happy path.

### Performance

- **No new busy loops.** The engine keeps schedules in memory and re-reads `schedules.json` only when its size or modified time changes (one `stat` every 5 s), so a schedule fires within 5 s of its time. Action and task definitions are loaded once and again only when their folder changes.
- **Cheap matching.** Every `on`, `wait` and `match` pattern is compiled once at load. A line is tested only against definitions whose probe and scope filters pass first, and a pattern sees at most the first 4,000 characters of the line. Node cannot stop a runaway regex, so `doctor` refuses patterns with nested quantifiers such as `(a+)+`: the pattern is the person's, but the text it runs over comes from outside.
- **Nothing blocks the engine.** Commands start with an async spawn and never with the sync calls. A run's output goes to its log file as a stream, not through memory.
- **Bounded concurrency.** One run per action, and at most 4 action runs at once across the engine. Further runs wait in a queue of up to 50; beyond that a run is refused with a line saying so.
- **Bounded files.** At most 1,000 pending schedules; `at` and `in` refuse beyond that. Each action keeps its newest 100 history entries and newest 20 logs of 1 MB each. Each task keeps its newest 100 runs. Every state write is one small whole-file atomic write.
- **Answers read through a two-way source** (`via`) are polled on that source's own interval: one read per open ask per poll, backing off on a rate limit as the source's other polls do. With no `via`, a person ask costs nothing until it is answered.

### Reliability

- **One engine.** `engine.lock` (pid plus a touch every 30 s) already keeps a second engine from running, and every layer relies on it: only the lock holder fires schedules, starts actions or moves tasks. An engine that finds another process holding the lock when it exits does not write `state.json`, so a stale engine never writes over a live one's state; `once` refuses while an engine runs, as today.
- **Written before announced.** Each change of state reaches its file (temp file plus rename) before the line that reports it is emitted, so a reader acting on the line finds the file agrees.
- **Schedules fire at least once.**
  - The line is emitted first and the entry removed after. A crash between the two fires the schedule again after the restart, marked late and with the same id, so a repeat can be spotted; a schedule is never lost.
  - If the removal write fails (disk full, a locked file), an in-memory list of fired ids stops a repeat within the same engine, and the removal is tried again on the next tick.
- **Sink sends are retried.** Today the sink sender drops a batch that fails to send. A failed batch, whatever probes its lines came from, is tried again after 1, 5 and 15 minutes before the existing "sink failing" line. At most 200 lines are held per sink; beyond that the oldest are dropped with a log line. The retries live in memory, so a restart during them loses the lines from that sink only; the lines themselves are still in `events.log`.
- **Time is absolute.** Due times are stored in UTC and compared with the wall clock on each tick. Sleep, hibernation and clock changes therefore make a schedule late, never lost. `HH:MM` is turned into a local date and time once, when the schedule is created, so daylight saving is handled by the calendar.
- **Task deadlines live in the run file.** Timeouts are stored as deadlines in the run state, not as in-memory timers, so a restart keeps them.
- **Restart order.** At start the engine restores task runs and their open waits before any source runs, so the first lines after a restart reach the waits.
- **Orphaned commands.** On Windows a child process outlives the engine. Each run records its pid and the process start time. After a restart, a run still marked running whose process is alive with the same start time is stopped, by pid and with its tree, and marked `interrupted`. A pid that now belongs to some other process is left alone. An action alone is never re-run by itself; only a task step's `retry` re-runs one.
- **Replies are idempotent.** `task reply` for a finished or unknown run is refused with a message saying so, and a second reply to the same ask is ignored.

### Fault tolerance

- **Corrupt files are set aside, never overwritten.**
  - Today `readJson` treats a file that does not parse as empty, and the next write replaces it. For `state.json` or `schedules.json` that silently loses everything.
  - Files the engine both reads and rewrites are read strictly instead: `state.json`, `schedules.json`, `replies.json`, run state and action history. One that does not parse is renamed to `<name>.bad-<time>`, a health line says so, and the engine carries on from empty.
  - Layer 1 makes this change for all of those files, not only the new one.
- **One bad definition stops only itself.** Action and task files load one by one. One that fails to load is skipped and reported, `doctor` fails it, and the rest run. A definition whose runs throw inside the engine 3 times in a row is switched off with one line.
- **Each layer's tick is guarded,** as the probes' are today, so a throw in one schedule, action or task is logged and reported while the others carry on.
- **Storms are capped.** An action has `cooldownSec` and `maxPerHour`. A task started by `on` has `overlap` and the same `maxPerHour` (default 20), after which it switches itself off with one line until a person turns it back on. Lines from probes `action` and `task` never start anything through `on`.
- **Nothing is removed until its replacement is written.** A failed write leaves the old file in place and is tried again on the next tick.

## Registration and identity

Decided 17 Oct (Mark): identity, not keys. It is its own small release, after layer 1.

- **What it can and cannot stop.** Everything runs as one user on one machine, so any process running as that user can read any key kept there. Keys would add chores without adding protection. This guards against mistakes, against sessions getting in each other's way, against other accounts on the machine, and against web pages.
- **A session knows itself.** Claude Code gives every command it runs the session id in `CLAUDE_CODE_SESSION_ID` (seen in the desktop app; not documented, so it is checked for, never assumed). With it, `sub`, `unsub`, `ack`, `at` and `in` act only on the caller's own `s-` inbox, and `at` and `in` default to it. Today any caller can subscribe to another session's inbox and take its lease, and the owner's waiter then exits as superseded.
- **A person registers, once.** Harnesses (Claude Code, Cursor) and shared inboxes (`ops`) are registered in the tray, or in a terminal by typing the name back, the same gate as switching on an action. A shared inbox lists which sessions may hold it.
- **Callers that are not registered** (no session id, no terminal) can still read, but every command that changes something is refused with a message saying to ask the person.
- **Outside the user:** `doctor` checks that the instance folder and `~/.watchhub/env` can be read only by their owner, and `--fix` makes them so.
- **Web pages:** the webhook listener refuses any request that carries `Origin` or `Sec-Fetch-Site`. Browsers always send one, and webhook senders do not, so a page open in a browser cannot post a line to the loopback port.

## For displays (the tray)

Everything a display needs is a file or a `--json` command; nothing new is pushed.

- **Schedules:** `schedules.json`, or `watchhub schedules --json`. Show due time, targets and text, with cancel (`unschedule <id>`).
- **Actions:** `actions/<name>.json` for definitions (`enabled`, triggers, limits) and `actions/runs/<name>/index.json` for history. Offer run now, enable or disable, and the log of a run (`action log <run id>`). A switched-off action with an `on` trigger is the one place a person must act, so it deserves a visible prompt.
- **Tasks:** `tasks/<name>.json` for definitions and `tasks/runs/<name>/*.json` for runs. A run view lists steps with status, attempts, timings and detail. A running `ask` step shows its question and, for an inbox ask, which inbox holds it. Offer run now and cancel.
- **Live updates:** watch those folders, or the `schedule`, `action` and `task` lines in `events.log`, which say the same thing as they happen.
- **Counts:** runs, failures and last results come from the run files above; `metrics.json` (numbers a source reads) is unchanged.

## Out of scope

Several machines, workers or queues; parallel branches and loops inside a task; an editor UI for definitions; a secrets store beyond `~/.watchhub/env`; running anything as another user; a model inside the engine.

## Order

1. **Schedules:** the `schedule` source, `at`, `in`, `schedules`, `unschedule`, the Stop hook holding for pending schedules, tests. Small.
2. **Actions:** the action runner, field patterns, limits, result lines, run logs, `doctor` checks, `--run` on schedules. Medium.
3. **Tasks:** the step runner, the condition parser, run state and resume, the `ask` steps (`answers()` on two-way sources is the optional part), displays. Larger; may split at the `ask` (person) step.

Each layer is its own release, through the full review. Between 1 and 2 goes **a fly.io module** (`FLY <app> release v42 SUCCEEDED / FAILED`, `FLY <app> machine <id> started / stopped / crashed`, `FLY <app> checks passing / failing`), read from the Fly Machines API with `FLY_API_TOKEN` in `~/.watchhub/env` and never through `flyctl`: the engine runs as a service, without a shell's PATH or login. It is its own small release and depends on none of the layers.

## Decisions

1. **`at` to an inbox with no subscription:** decided (17 Oct): the Stop hook holds the session for a pending schedule, subscribed or not, so asking to be woken needs nothing else arranged first.
2. **Who switches on an action with an `on` trigger:** decided (17 Oct): a person only, through the tray or the typed-back confirmation in a terminal (Layer 2, Trust).
3. **Task `if`:** decided (17 Oct): a small expression language (Layer 3, Conditions), not literal comparisons only.
4. **Holding for a schedule with no subscription:** decided (17 Oct): `at` and `in` make or extend a schedule-only subscription on the inbox (Layer 1, Delivery), so the hold that exists today does the holding.
5. **Sink retries:** decided (17 Oct): a failed batch is retried whatever its lines' probes, with a cap per sink (Reliability).
6. **Line fields as options:** decided (17 Oct): a filled-in argument beginning with `-` refuses the run; `{text}` and `{line}` in `env` only (Layer 2, Fields).
7. **Default target for `at` and `in`:** decided (17 Oct): the caller's own inbox from `WATCHHUB_INBOX`, `.watchhub.json` or the Claude Code session id, in that order, so a harness other than Claude Code (Cursor, say) has a route too (Layer 1, Target).
8. **Fields in a `wait` pattern:** decided (17 Oct): escaped and matched literally (Layer 3, Steps).
9. **Fly.io:** decided (17 Oct): the Machines API with a token, not `flyctl`; its own release after layer 1 (Order).
