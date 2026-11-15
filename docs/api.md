# HTTP API reference

The server runs in one of two modes:

- **Legacy (single-tenant)** — the default. One global board; the endpoints
  under [Legacy endpoints](#legacy-single-tenant-endpoints) apply.
- **Multi-tenant** (`MULTI_TENANT=true`) — boards ("workspaces") live under
  `/w/<token>/...`. The global `/webhook`, `/events`, `/api/sessions`, and
  `/sessions/...` endpoints return `404`. The hosted instance at
  `https://agstatus.online` runs in this mode.

`GET /api/config` tells you which mode a server is in.

## The session object

```json
{
  "id": "sess-abc",
  "name": "Refactor auth",
  "status": "coding",
  "message": "Editing server.ts",
  "project": "my-repo",
  "source": "claude",
  "host": {
    "machine": { "id": "9f2c1b7e4d3a8f0c5e6b2a1d9c8f7e6b", "name": "Mac" },
    "app": { "slug": "herdr", "name": "herdr", "kind": "multiplexer" }
  },
  "createdAt": 1752096000000,
  "updatedAt": 1752096030000,
  "homeProject": "my-repo",
  "tokens": 1284000
}
```

Timestamps are epoch milliseconds. `status` is one of `idle`, `planning`,
`coding`, `testing`, `blocked`, `done`
([what each one means](hooks.md#what-each-status-means)). Two of them the
server itself acts on: a transition into `blocked` — the agent has stopped and
needs a human — pushes every registered device, and a transition into `done` —
a turn finished and its answer is waiting to be read — pushes the devices that
asked for it (`notify_done`). The bundled hooks send `done` at the end of every
turn and `idle` only at `SessionStart`, so `idle` is close to unseen on a live
board and `done` is where a card rests between prompts. `host` says where the session runs
(see the [webhook table](#webhook-body-and-validation)); it is `null` for
the many sessions whose hook has not opted in, and the key is always present.

`homeProject` is the project the boards file the session under, and the
server works it out itself: the first usable `project` the session
reported, kept for the rest of its life. A session that starts in
`acme-api` and runs `cd web` keeps `"homeProject": "acme-api"` while
`project` says `web`. A `project` is usable unless, with the white space at
its ends trimmed, it is empty, `/`, `.` or a bare UUID: a session started at
`/` (an empty `project` from the Node hook, `/` from the shell hook), a
Codex scratch folder, or a raw post's blank name. Such a session has
`"homeProject": ""` until a post names a real folder, which then claims it;
a post without a `project` changes nothing. A usable name is kept as sent,
never trimmed, and in Unicode NFC like every `name` and `project` (below).
The key is always present, and it is never read from a webhook body: a
`homeProject` posted there is ignored. It is stored with the session, so it
survives a restart of a server with
[Postgres](self-hosting.md#persistence-postgresql); a server without a
database forgets it with the card. Since 1.7.0.

A card the board drops on request (dismissed with a `DELETE` of the
session, which the bundled hooks also send at `SessionEnd`; cleared with
`sessions/clear`; or evicted by the 50-card cap) keeps its `homeProject`
for its session's return: if the session posts again within 24 hours of
its last post, its new card is filed where the old one was, whatever folder
it is in by then. That memory is held in the server process alone, so a
restart in between forgets it, and the session's next post then starts over
from the folder it names. A card the session TTL expired
(`SESSION_TTL_MS`, 24 hours without an update on a hosted board) starts
over too, as the hook's pinned card name does.

`name` and `project`, and so `homeProject`, are stored and served in
Unicode NFC. The server composes what it is sent, so one folder that
reaches it decomposed from one machine (NFD, an `e` and then its accent, as
a folder made in the macOS Finder often is) and composed from another (NFC,
one `é`) is one name, and one section on every board. A row an older server
stored is composed as it loads. Since 1.7.0.

The boards key their project sections by it: `homeProject` when it is
usable; otherwise `project`, when that is usable by the same rule, which
covers servers older than 1.7.0 that send no `homeProject`; otherwise the
**No project** section. A UUID here is what the bundled hook takes for one:
32 hex digits in the hyphenated 8-4-4-4-12 form, in either case.
Sections run in name order: the names lowercased, with Unicode's final-sigma
rule as JavaScript's `toLowerCase` applies it (a `Σ` that ends a word is `ς`,
any other `σ`), and compared by UTF-16 code unit, then the exact names
(`AgStatus` before `agstatus`), with No project last; activity, state and
arrival never reorder them. A section is a folder name and nothing more: the
same name on two machines is one section, and one repository checked out
under two names is two.

`tokens` is the lifetime token total this session's agent reports for it (see
[Per-session token totals](#per-session-token-totals)). Unlike `host` the key
is **absent**, not `null`, when the board holds no total — and absent means
*unknown*, never zero. It is not part of the webhook body: it arrives on its
own endpoint and is attached to the card on the way out, so a board that never
receives one emits exactly the session object it always did.

`subtasks` lists the session's running subagents (see [Subagents](#subagents)).
Like `tokens` the key is **absent** when there is nothing to show — no
subagent has reported, or the turn they ran in is over — and it comes last, so
a session without subagents is exactly the object above, key order included.
It is not part of the webhook body either: the server builds it from the
subagents' own posts and attaches it on the way out.

```json
"subtasks": {
  "turnEnded": false,
  "running": 9,
  "blocked": 1,
  "failed": 0,
  "done": 15,
  "items": [
    { "id": "3f9c1e07b2d4a85c6e1f0a92", "n": 3, "label": "review:hook", "state": "testing", "activity": "Run hook tests with --no-file-parallelism" },
    { "id": "9b2e7c4d1a0f3e5b6c8d7a90", "n": 9, "label": "verify:hook", "state": "blocked", "activity": "Approve: Run the hook suite" }
  ]
}
```

| Field | Type | What it holds |
| ----- | ---- | ------------- |
| `turnEnded` | boolean | The parent's own reading is `done` or `idle` — its turn is over — **and** at least one subagent is still running or waiting. Boards draw such a card as *working*. |
| `running` | integer | Subagents in `planning`, `coding` or `testing`: exactly the items in those states. |
| `blocked` | integer | Subagents waiting on approval: exactly the items in `blocked`. |
| `failed` | integer | Subagents that failed this turn. At least the number of `failed` items; more once over 8 failed, since only the newest 8 are listed. |
| `done` | integer | Subagents that finished this turn, each counted once. It only climbs within a turn — except when a failure is reported for a subagent already counted, which moves it from `done` to `failed` — and resets when the turn is over or a new prompt starts. |
| `items` | array | Every live subagent and the failed ones, in **start order** (ascending `n`), at most 56. |
| `items[].id` | string | Opaque, matches `^[A-Za-z0-9._:-]{1,64}$` — 24 lowercase hex from the bundled hook, and it may start with a digit. Stable for the subagent's life. |
| `items[].n` | integer | The subagent's place in start order, from 1, unique on the card. |
| `items[].label` | string | What it was asked to do, at most 64 characters; `Subagent <n>` when nothing is known, and always in minimal mode. Never empty. |
| `items[].state` | string | `planning`, `coding`, `testing`, `blocked` or `failed`. |
| `items[].activity` | string | What it is doing now, at most 80 characters. May be `""`. |

The JSON is at most 8 KB per session: past that the server shortens the
activities, then the labels, and never drops an item or changes a count. A
client should still treat a `subtasks` that is `null`, not an object, or has
no items and `done: 0` as absent, drop a malformed item and keep the rest,
read an unknown `state` as `planning`, and derive a missing count from
`items` — both phone apps decode a snapshot as one array, so one bad value
must not cost the board.

With subagents, a session's `status` and `message` are the **board's
reading** of the parent and its subagents together, and still one of the six
statuses:

- `blocked` / "Needs approval: verify:hook" while a subagent waits on
  approval, naming the first to start of those waiting, with "+1", "+2" for
  the others — unless the parent is itself blocked, which keeps its own line;
- after the parent's turn has ended, while subagents still work, the busiest
  of their states (`testing` over `coding` over `planning`) with
  "3 subagents still running";
- `planning` / "Reading subagent results" in the moment between the last
  background subagent finishing and the parent's report turn;
- otherwise exactly what the parent last posted. A subagent's post never
  overwrites it.

A client that knows nothing of `subtasks` therefore still draws a correct
card. *Working* and *failed* are readings the boards make of `subtasks`:
neither is ever sent as a `status`, in a frame or in the session timeline.

## Shared endpoints (both modes)

| Method & path     | Purpose |
| ----------------- | ------- |
| `GET /api/config` | `{mode: "legacy"\|"multi", version, statuses, push}`. Legacy mode adds `webhookUrl` and `requiresSecret`. `push` is `true` iff APNs is configured. |
| `GET /healthz`    | Liveness probe: `{ok: true, version}`. Legacy mode adds a `sessions` count. |
| `GET /`           | Dashboard UI shell (in multi-tenant mode the board itself is at `/w/<token>`). |

## Webhook body and validation

`POST /webhook` (legacy) and `POST /w/<token>/webhook` (multi-tenant) accept
the same JSON body and upsert a session by `session_id`:

| Field        | Type   | Required | Notes |
| ------------ | ------ | -------- | ----- |
| `session_id` | string | yes      | Unique session identifier. Must match `^[A-Za-z0-9._:-]{1,128}$`. |
| `status`     | enum   | yes      | One of `idle`, `planning`, `coding`, `testing`, `blocked`, `done`. |
| `name`       | string | no       | Human-readable title. Defaults to `session_id` if omitted (and never yet set — on update an omitted `name` carries the stored one forward). An empty `name` counts as omitted, and since 1.7.0 so does one of white space alone once control characters are stripped (what JavaScript's `trim()` removes, and U+0085): no board is sent a blank name, and a card an older server stored with one is named by its `session_id` as it loads. Composed to Unicode NFC, then truncated to 120 chars. The bundled Node hook sends a Claude Code session's own title when it has one (the Claude desktop app titles every session, `/rename` titles one in the CLI; never in minimal mode), otherwise the folder it pinned at `SessionStart` — the name a session is given there is the name it keeps, even if the session later changes directory — and the agent's name (`Claude`, `Codex`) for a session with no folder at all. It holds folder and title in a small local map and re-sends the name on every post rather than leaning on carry-forward; a folder pin on file wins over any later `SessionStart` for the same id, so `/compact`, `/clear` and `--resume` leave it alone, while a renamed session renames its card. See [Card names and projects](hooks.md#card-names-and-projects). |
| `message`    | string | no       | Short description of the current activity (shown on the card). Truncated to 300 chars. |
| `project`    | string | no       | Project or repo the session is working on. Composed to Unicode NFC, then truncated to 120 chars. Unlike `name`, the bundled hooks recompute it from the session's live working directory on every post, so after a `cd` the two legitimately disagree — the card keeps its original name while `project` follows the session. Per-project spend depends on that; see [Usage history and per-project spend](#usage-history-and-per-project-spend). The Node hook reports a working directory that is exactly a Claude worktree root, `<repo>/.claude/worktrees/<name>`, as `<repo>` — on the card only: the per-project usage rows still file that worktree's spend under its own folder. The server keeps the first usable one as the session's [`homeProject`](#the-session-object), which no later post moves. |
| `source`     | string | no       | Agent kind that owns the session, e.g. `claude` or `codex` (same regex as the usage `source`). Defaults to `claude`; omitted on update = carried forward. Dashboards use it to show only the limit bars of agents present on the board. |
| `host`       | object \| null | no | Where the session runs, sent by hooks that opted in to Focus: `{"machine": {"id", "name"}, "app": {"slug", "name", "kind"}}`. Omitted = carried forward; `null` = cleared (the hook opted out). `machine.id` must match `^[0-9a-f]{32}$` (a per-board hash, never a raw machine id) or the post is `400`. `machine.name` and `app.name` are trimmed and truncated to 32 chars; blank ones become `Machine` and the slug. `app.slug` is one of `agterm`, `iterm2`, `kitty`, `wezterm`, `terminal`, `ghostty`, `alacritty`, `warp`, `vscode`, `cursor`, `windsurf`, `jetbrains`, `zed`, `claude-desktop`, `codex-desktop`, `herdr`, `tmux`, `zellij`, `screen`, `windows-terminal`, `other` — anything else is stored as `other`; `app.kind` is one of `terminal`, `multiplexer`, `ide`, `desktop-app`, `unknown` — anything else becomes `unknown`. Every other key is dropped. |
| `agent`      | object \| null | no | Makes this a subagent's post, about one subagent of the session: `{"id", "state", "kind"?, "label"?, "activity"?, "at"?}`. It changes that subagent's row and never the session's own reading, and `status` and `message` mean something else on it — see [Agent posts](#agent-posts). A malformed one is a `400`; `null` or absent is the session's own post. |
| `turn`       | object | no | On the session's own post only: where its turn stands, so the server knows what happens to the rows (`{"phase": "start" \| "end" \| "reset", "running"?, "workflows"?}`; see [Turn hints](#turn-hints-and-unattributed-prompts)). Malformed is ignored, never a `400`, so the post itself still lands. Ignored on a subagent's post. |
| `unattributed` | boolean | no | `true` on the session's own `blocked` post when the hook cannot tell which thread is asking. While subagents are running such a block is undone by the next subagent's progress (see [Turn hints](#turn-hints-and-unattributed-prompts)). Anything but `true`, or on any other post, is ignored. |

Control characters are stripped from all string fields, and no string is cut
in the middle of a surrogate pair. Omitted optional fields carry the previous
value forward on update. The JSON body is capped at 16 KB. `host` is the one
nullable field: it goes out as `null` on every session that has none (REST and
SSE alike). A session that is dismissed, evicted, expired or whose workspace is
deleted stops being served, and its stored row, `host`, `homeProject` and
subagent rows included, is flagged as deleted rather than blanked. `host` never appears in
the session timeline or in push notifications.

**Response** — `200 OK`:

```json
{ "ok": true, "session": { "id": "sess-abc", "status": "coding", ... } }
```

The one exception is a subagent's finish (`agent.state` `done` or `failed`)
for a session that is not on the board — never seen, dismissed, evicted,
expired or ended: nothing is stored, nothing is broadcast or pushed, and the
answer is `{"ok": true, "session": null}`. A subagent's start that the
live-row caps turn away for such a session gets the same answer (see
[Limits](#limits)).

**Errors** — `400` on missing/malformed `session_id`, invalid `status`,
malformed `source`, a `host` that is neither an object nor `null` or whose
`machine.id` fails the regex, or a malformed `agent`
(`{"error": "agent must be an object with id matching ^[A-Za-z0-9._:-]{1,64}$ and state one of planning, coding, testing, blocked, done, failed"}`);
`401` on bad secret (legacy mode with `WEBHOOK_SECRET` set); `404` unknown
workspace (multi-tenant); `413` on bodies over 16 KB; `429` over the
per-workspace rate limit (multi-tenant).

## Plan usage

`POST /usage` (legacy, same secret rules as the webhook) and
`POST /w/<token>/usage` (multi-tenant) let a hook report how much of an
agent plan's rate limits is consumed, so dashboards can draw limit bars:

```json
{
  "source": "claude",
  "windows": [
    { "id": "session", "label": "Current session", "usedPct": 42, "resetsAt": 1752100000000 },
    { "id": "week", "label": "Weekly (all models)", "usedPct": 61.5, "resetsAt": 1752300000000 }
  ]
}
```

| Field      | Type   | Required | Notes |
| ---------- | ------ | -------- | ----- |
| `source`   | string | yes      | Agent kind, e.g. `claude` or `codex`. Must match `^[a-z][a-z0-9_-]{0,23}$`. |
| `windows`  | array  | yes      | 1–6 windows with unique `id`s (`^[a-z][a-z0-9_-]{0,31}$`). |
| `usedPct`  | number | yes      | Percent of the limit consumed. Clamped to 0–100. |
| `label`    | string | no       | Display name; defaults to `id`. Truncated to 48 chars. |
| `resetsAt` | number | no       | Epoch ms when the window resets; anything invalid becomes `null`. |

A report is stored per workspace, per `source`, per window id — **never per
session.** A plan limit is account-wide, so every session of an agent reports
the same numbers into the same set of windows and the newest report wins; the
bars do not belong to a card, and dismissing a card does not clear them. The
window id `session` is the plan's own name for its 5-hour rolling window (the
bundled hooks label it "Current session"), not the agent session in front of
you: it keeps counting across restarts and does not reset when a session ends.

The server keeps the latest report per `source` (a re-post replaces the
previous one), broadcasts the full usage list as an SSE `usage` event, and
answers `{ok: true}`. Usage posts share the webhook rate-limit budget.
Reports older than 24 hours are dropped from reads — stale percentages
mislead.

**At most 8 sources per workspace**, counted across `/usage`,
`/usage/projects` and `/usage/sessions` together. A report from a ninth source
gets `429 {"error": "too many usage sources for this workspace (at most 8)"}`;
the sources already held keep reporting on every endpoint. The bundled hooks
use two (`claude`, `codex`). A malformed report never takes a slot.

`GET /api/usage` (legacy) and `GET /w/<token>/api/usage` return the
current list:

```json
[ { "source": "claude", "windows": [ ... ], "updatedAt": 1752096030000 } ]
```

## Usage history and per-project spend

Two series back the usage detail screen, and they are **different measures**.

**The limit over time.** Every report is kept, not just the newest, but only
when a window's `usedPct` actually moved — a plan limit is a step function and
reports arrive far more often than it changes — and at most one point per
window per minute: a reading less than a minute after the last recorded one
still moves the live bar but is not added to the history (the charts sample
once a day, and each hook reports at most every five minutes). A workspace keeps
history for at most 48 (source, window) series; past that a new window id
still shows as a bar but keeps no history, and a series silent for 90 days
gives its slot back. Nothing is retroactive: a board has limit history from
the moment it first receives a report.

**Where the tokens went.** Neither agent's usage API says which project spent
the quota, so the hook derives it from the logs each agent already writes
locally and reports daily totals with `POST /usage/projects` (legacy, same
secret rules as the webhook) or `POST /w/<token>/usage/projects`:

```json
{
  "source": "claude",
  "days": [
    { "project": "jobsearch", "day": "2026-09-07", "tokens": 87600000 },
    { "project": "claude-status", "day": "2026-09-07", "tokens": 18700000 }
  ]
}
```

| Field     | Type   | Required | Notes |
| --------- | ------ | -------- | ----- |
| `source`  | string | yes      | Agent kind, same rule as plan usage. |
| `days`    | array  | yes      | 1–200 rows. The cap keeps a report inside the 16kb body limit; a longer backfill sends several. |
| `project` | string | yes      | Project folder name, truncated to 120 chars. |
| `day`     | string | yes      | `YYYY-MM-DD`, UTC. A row whose day does not exist (`2026-02-30`, `9999-99-99`) or falls outside the last 90 days through tomorrow is dropped, not rejected — see below. |
| `tokens`  | number | yes      | Tokens spent that day. Clamped to ≥ 0 and floored; above `Number.MAX_SAFE_INTEGER` the report is a `400`. |

A day is **replaced**, not accumulated, so re-running a backfill converges
instead of double-counting. Reported tokens are input + output + cache
creation; cache reads are excluded because they are ~94% of raw token volume
but a small share of what a plan limit charges.

**Not every well-formed row is kept**, and the response says what became of
them: `{"ok": true, "days": N, "dropped": D, "refused": R}`. `days` rows were
stored. `dropped` rows named a day that does not exist or lies outside the
retained window — today minus 90 days through tomorrow (UTC) — and are
skipped silently rather than failing the report, because a backfill
legitimately sends everything the local logs still hold. `refused` rows were
new (source, project, day) keys arriving when the workspace already holds
5,000; a row for a key it already holds is always stored. Days that age out of
the window leave the board (flagged on disk, never deleted) and free their
slots. A malformed row — a bad shape, a missing field — still fails the whole
report with `400`.

**A row is a folder and a day, not a session.** There is no session id and no
card name in this series: every session that spent tokens in a folder on a day
is summed into the same row. So one row can be several sessions' work, and a
session that moves between projects contributes to two rows, split at the point
it moved — even though its card keeps its name through the move
(see [the webhook `name` field](#webhook-body-and-validation)). The two series
answer different questions: a card says which session this is, these rows say
where the quota went. How fine the split can be depends on the agent's own
logs: Claude Code stamps every request with the directory it ran in, so a
Claude session that moves is split at the moment it moved, while a Codex
rollout names its directory once at the top of the file, so a Codex session
that moves keeps all of its spend under the folder it started in.

`GET /api/usage/history` and `GET /w/<token>/api/usage/history` return both
series. `?days=N` selects the range (default 30, capped at 90). Reads have a
budget of their own, 30 a minute per workspace (`429 {"error": "rate limit
exceeded"}` beyond), separate from the webhook's:

```json
{
  "days": 30,
  "history": [
    { "source": "claude", "windowId": "week",
      "points": [ { "at": 1752096030000, "usedPct": 54 } ] }
  ],
  "projects": [
    { "source": "claude", "project": "jobsearch", "day": "2026-09-07", "tokens": 87600000 }
  ]
}
```

Each series keeps the last reading from *before* the requested range as its
first point, so a step chart has a value to start from. Both are retained for
90 days.

## Per-session token totals

The same pass over the same local logs that produces the project-day rows also
keys them by session id — Claude stamps every assistant record with the session
that produced it, and a Codex rollout is named after its session. The hook
reports those totals with `POST /usage/sessions` (legacy, same secret rules as
the webhook) or `POST /w/<token>/usage/sessions`:

```json
{
  "source": "claude",
  "sessions": [
    { "session_id": "019a7f3c-8b21-7c4e-9d6f-2b6e4a1c77d0", "tokens": 1284000 },
    { "session_id": "019a7f3c-9c02-7a55-b1e4-8d3f0c2a91b7", "tokens": 96500 }
  ]
}
```

| Field        | Type   | Required | Notes |
| ------------ | ------ | -------- | ----- |
| `source`     | string | yes      | Agent kind, same rule as plan usage. Part of the key: the two agents mint session ids independently. |
| `sessions`   | array  | yes      | 1–100 rows. The cap keeps a report inside the 16 KB body limit; a longer run sends several. |
| `session_id` | string | yes      | Must match `^[A-Za-z0-9._:-]{1,64}$` — the webhook's charset, held to half its length (both agents use a uuid). The same id the webhook posts, so a row joins straight onto the card. |
| `tokens`     | number | yes      | The session's **absolute lifetime total**, never a delta. Clamped to ≥ 0 and floored. |

A row is stored under (workspace, `source`, `session_id`) and **replaces** the
value held, so a re-post is harmless and a post that never lands costs only
freshness. It may legitimately move **down**: the hook's counter restarts when
its state file is lost with the log already pruned, or when a session was
evicted by the hook's own 400-entry cap and later resumed. The server stores
what it is sent — it does not take the larger of the two, and a decrease is not
an error. A duplicated `session_id` inside one body is not rejected either: the
last one wins. A total for a session that has no card is accepted and kept, so
a session that comes back finds its number waiting. Session-total posts share
the webhook rate-limit budget. The response is
`{"ok": true, "sessions": N, "refused": R}`: `N` rows stored after duplicates
collapse, and `R` new session ids the board had no room for. A workspace holds
at most 500 totals; past that a new `(source, session_id)` is refused unless
that session has a card on the board right now, and at 550 (500 plus one
board's worth of cards) it is refused even then. A total it already holds is
always updated. Totals past their 7-day retention free their slots.

**Where it shows up.** There is no read endpoint: the number is served as the
`tokens` field of [the session object](#the-session-object), which the
`snapshot` and `session` SSE events already carry, so a card gets its total the
same way it gets every other change. When a report moves a number, every card
it belongs to is rebroadcast as a `session` event; a report that repeats itself
broadcasts nothing.

**What the number is, and what it is not.** It is the tokens *this session*
spent, summed across days and — for Claude — across every folder it worked in.
It is **not** a plan-limit percentage and does not convert into one: a limit
window says how much of an account-wide allowance is gone
(see [Plan usage](#plan-usage)), while this counts tokens, and nothing here
supplies a denominator. It is also **not** a slice of the per-project series:
a project-day row sums across sessions, this sums across days, and adding the
two together means nothing. Finally, the two agents count differently — Claude's
figure is input + output + cache creation, Codex's is its own cumulative
`total_token_usage`, which includes cache reads — so a Claude card's number and
a Codex card's number are each exact about their own agent and are not
comparable with each other. Anything showing them side by side should say whose
they are rather than imply a shared scale.

**Retention.** A total is kept for **7 days** after the report that set it,
on the server's own received-at clock — not the day-keyed retention the project
rows use, and not the card's 24 hours. The hook reports on a 15-minute throttle
and only for sessions whose number moved, so a session resumed after a weekend
gets its card back from the first webhook but its total only from the next
usage run; the stored value carries the card in between. Older totals are
dropped from reads and from memory, and a workspace holds at most 500 (past
that, a new session id is refused unless its session has a card on the board,
up to 550; see above). Deleting a workspace removes its totals with everything else.

## Subagents

A session's subagents — Agent-tool subagents (foreground, background or
nested), dynamic-workflow agents, Codex sub-agent threads, in-process
teammates — are listed on their **parent's** card, as rows. The bundled hook
posts each one to the parent's webhook with an `agent` object
([docs/hooks.md](hooks.md#subagents) says when), and the server keeps a small,
bounded state per session beside the parent's own reading, which a subagent's
post never overwrites. Clients receive the [`subtasks` object](#the-session-object)
and the reading derived from the two. A hook that sends no `agent` never
creates any of this: its sessions read exactly as before.

### Agent posts

```json
{ "session_id": "5cef7152-ef68-481f-8a4f-463f66702bf9", "name": "Session organization by agent",
  "status": "coding", "source": "claude",
  "agent": { "id": "3f9c1e07b2d4a85c6e1f0a92", "state": "coding", "kind": "agent",
             "label": "Run echo alpha", "activity": "Print alpha", "at": 1793138690842 } }
```

| Field      | Type    | Required | Notes |
| ---------- | ------- | -------- | ----- |
| `id`       | string  | yes      | Must match `^[A-Za-z0-9._:-]{1,64}$`; opaque. The bundled hook sends 24 lowercase hex: a hash of the board URL, the agent (`claude` or `codex`), the session and the subagent's own id, so the raw id never leaves the machine. |
| `state`    | enum    | yes      | `planning`, `coding`, `testing` or `blocked` while it runs; `done` or `failed` once it has finished. A running state for an id the session has no row for starts one: there is no separate start. |
| `kind`     | enum    | no       | `agent` (Agent tool, teammate, `/fork`), `workflow` or `codex`; anything else counts as `agent`. Only reconciliation reads it (see [Turn hints](#turn-hints-and-unattributed-prompts)), and clients never see it. |
| `label`    | string  | no       | What the subagent was asked to do. Runs of whitespace become one space, control characters go, and it is cut to 64 characters. Absent or empty keeps the label the row has; a row with none shows `Subagent <n>`. |
| `activity` | string  | no       | What it is doing now, cleaned the same way and cut to 80. Absent keeps the row's; `""` clears it. |
| `at`       | integer | no       | The hook's clock when it read the event, epoch ms. It orders one subagent's posts — one older than what its row holds is ignored — and is never shown. Anything but a whole number within 7 days of the server's clock is replaced by the time the post arrived. |

Unknown keys inside `agent` are dropped. On such a post the top-level fields
are not the session's own:

- **`status`** is still required, and still one of the six: it is the
  reading for servers older than 1.7.0, which drop `agent` and apply `status`
  to the card. The bundled hook sends the subagent's state while it runs and,
  once it has finished, the last of `planning`, `coding` or `testing` it was
  in — never `done`, which an older server would show, and push, in the
  middle of the turn. This server checks it and otherwise ignores it.
- **`message`** is ignored. The bundled hook sends one only with
  `state: "blocked"`: the line it posted for the same prompt before 1.7.0, so
  an older server pushes the same words.
- **`name`** names the card only when this post creates it. `project`,
  `source` and `host` carry forward or set as on any post; the bundled hook
  sends no `project` or `host` with a subagent's post.
- A running post for a session that is not on the board **creates its
  card**, with the parent's own reading empty (`idle`), so the card reads as
  its subagent does: "1 subagent still running", or "Needs approval: &lt;label&gt;"
  while it waits. A finish for such a session creates nothing and answers
  `{"ok": true, "session": null}`.

### Turn hints and unattributed prompts

The session's own posts carry two optional hints about its rows. `turn`:

| Field       | Type     | Notes |
| ----------- | -------- | ----- |
| `phase`     | enum     | `start`: a prompt you submitted. The done count and the failed rows reset; subagents still running in the background carry over with their numbers. `end`: the parent's turn ended (`Stop`). `reset`: the session started or restarted (`SessionStart`, except a compaction) — every row goes, uncounted, since a new process has no subagents running. |
| `running`   | string[] | With `end` only: the ids of the background subagents still running, at most 64, each matching the `agent.id` rule. Absent means *unknown*: the hook leaves it out rather than send a partial list, which would close rows that are still live. |
| `workflows` | integer  | With `running` only: how many background workflows are still running, 0–1000. |

At an `end` whose `running` is present and `workflows` is 0, every Agent-tool
row the list does not name, and every workflow row, has finished — a turn
cannot end while a foreground subagent runs — and they close **uncounted**,
which keeps `done` exact rather than complete. A row waiting on approval is
never closed this way, nor is a Codex row (Codex sends no list; each of its
rows closes at its own finish). While a workflow runs, a row the list does not
name stays: a workflow's agents are never listed one by one.

If rows remain, or a workflow runs, the parent will take a **report turn** once
they finish. From the last finish until the parent's next post the card reads
`planning` / "Reading subagent results" instead of `done`, so it does not read
done — and push done — a moment before the parent has read the results. A
`Stop` that announces a running workflow holds the card this way even before
any of the workflow's agents has posted. If the parent says nothing for 120 s,
the sweep releases the hold and the card reads `done`.

Once nothing is left running and nothing is awaited, the turn is over: the
done count, the failed rows and the numbering go with it, and so does the
`subtasks` key.

`unattributed: true` rides on a `blocked` post the hook could not pin on a
thread — a permission prompt with no matching request behind it, or a
question (`elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`).
While subagents are running such a block is **soft**: the next running post of
any of them ends it, and the card goes back to what it read before, which is
how 1.6.3 behaved, when the next subagent tool call overwrote the parent's
line. With no subagent running it is an ordinary block.

### How rows end

- **`done`** removes the row and counts it, once per subagent per turn however
  often the finish is reported (a background task may notify more than once).
  A finish for a subagent the server never saw running still counts: its
  start was lost on the way.
- **`failed`** keeps the row, as `failed`, until the turn is over. A failure
  reported for a subagent already counted done this turn corrects it — one
  fewer done, one more failed — and a running post after a failure resumes
  the row.
- **Expiry.** The subtask sweep runs once a minute, in both modes. It closes a
  running row after 60 minutes without a post and a waiting one after 6 hours,
  uncounted, drops a failed row after 6 hours, and resets a done count left
  with nothing running after at most 6 hours. A later post from the same
  subagent brings its row back. Silence is not a sign of death: within a
  status class a subagent posts only what it is now doing, when that changed,
  and at most once a minute.
- **Persistence.** With PostgreSQL the state is kept in the session's own row,
  in a nullable `subtasks` column added at boot, so rows, counts, numbers, a
  report hold and a soft block survive a restart. When the session goes it is
  flagged with the rest of the row, never blanked.

### Push

- A card that turns `blocked` because a subagent is waiting pushes every
  registered device, as any blocked card does. The body is the card's line,
  "Needs approval: verify:hook" ("Needs approval: Subagent 3" in minimal mode).
- Another subagent starting to wait while the card is already blocked pushes
  again, unless that card pushed blocked within the last minute: a row stays
  blocked until its subagent next posts, so there would otherwise be no
  transition to push on.
- A `done` push (`notify_done`) fires only when the card's reading becomes
  `done`. While background subagents run after the parent's turn it reads
  their state, and in the hold "Reading subagent results", so the push goes
  out once, when the report turn ends.

## Session history

`GET /api/sessions/:id/history` (legacy) and
`GET /w/<token>/api/sessions/:id/history` return a session's timeline —
one entry per status/message transition, newest first (identical
keep-alive re-posts are not recorded):

```json
[
  { "seq": 2, "status": "testing", "message": "npm test", "at": 1752096030000 },
  { "seq": 1, "status": "coding", "message": "Editing server.ts", "at": 1752096010000 },
  { "seq": 0, "status": "idle", "message": "Session started", "at": 1752096000000 }
]
```

`seq` increases monotonically per session and is a stable identity for
clients. It is not dense and does not start at 0 for each session — the server
numbers every session of a workspace from one counter, so the values a session
sees have gaps — and nothing should be read into its size. The counter is per
workspace: a gap only ever counts that workspace's own transitions, never
another tenant's. The last 100 entries
are kept per session (older ones are
soft-deleted); dismissing or expiring a session drops its history. Unknown
sessions return `[]`.

On a session with subagents the timeline records the card's reading (see
[Subagents](#subagents)) and nothing per subagent: a subagent starting,
finishing or changing state is not an entry. Every "N subagents still running"
reading counts as one, so a background drain of thirty subagents records that
line once — `testing`, "3 subagents still running", say — however its count
and its busiest state change on the way down. A waiting subagent records
"Needs approval: &lt;label&gt;", and the report hold "Reading subagent results". So
thirty subagents cannot push a session's own story out of the 100 entries it
keeps. The newest entry can therefore read `testing` while a board shows the
card as *working*, which is a reading of the live card only.

## Focus commands

Focus lets a tap on a card bring the session's terminal to the front on the
machine running it (design: [docs/design/focus-protocol.md](design/focus-protocol.md)).
Three parties take part: a **viewer** (the phone or web board), the
**server**, and a **listener** — the AgStatus process on each machine that
opted in. A session can be focused only when its `host` is set and that
machine's listener is online.

```
viewer   ─▶ POST …/commands {id, type, session_id}      server attaches machine_id from session.host
server   ─▶ SSE `command` ─▶ listener                     only the listener for that machine
listener ─▶ POST …/commands/:id/claim                    exactly-once, then acts locally
listener ─▶ POST …/commands/:id/ack {result, reach, reason}
server   ─▶ SSE `command_ack` ─▶ everyone                 or {result: "failed", reason: "expired"} at the TTL
viewer   ─▶ GET …/commands/:id                           polling, for a phone that backgrounded
```

Commands carry **ids only** — never a path, a binary or an argument — and
live **in memory only**, like pairing codes: a restart drops them, and the
phone simply sees its command time out. The paths below are shown for
multi-tenant mode; legacy mode mounts the same handlers at the root
(`POST /commands`, `POST /commands/:id/claim`, …) with the `POST`s behind
`X-Webhook-Secret` when `WEBHOOK_SECRET` is set, like the webhook.

### Listener presence

A listener subscribes to the ordinary event stream with a `listener` query
parameter, and proves it is that machine with an `Authorization: Bearer` header:

```
GET /w/<token>/events?listener=<machine_id>&name=<label>
Authorization: Bearer <machine_key>
```

| Field                    | Rule |
| ------------------------ | ---- |
| `?listener=`             | Required. The machine id the hook reports in `host.machine.id`; must match `^[0-9a-f]{32}$` (`400` otherwise). Public — every viewer reads it off the `machines` frame — so it is a routing label, not a credential, and it stays in the URL. |
| `Authorization: Bearer <key>` | Required. The **machine key**: 64 lowercase hex, the value the id is derived from (`machine_id = sha256(key)[0..32]`, see the [design](design/focus-protocol.md#32-wire-summary--the-host-webhook-field)). `400` when malformed; `403 {"error": "wrong_key"}` when it does not hash to `?listener=`. Only the machine holds the key — every viewer sees the id in the snapshot, so the id alone proves nothing, and a viewer can neither take a machine's slot nor end its stream. A header, not a query parameter, because nginx, Cloudflare and most PaaS record `$request_uri` verbatim: a key in the URL lands in access logs, which are shipped to aggregators and shared far more widely than the board token. And `Authorization` rather than a name of our own, because log pipelines that redact credentials match on the header name — Caddy's `log_credentials` covers exactly Cookie, Set-Cookie, Authorization and Proxy-Authorization, so a custom name would be logged in full. |
| `?name=`                 | Label shown on the board; control characters stripped, trimmed, truncated to 32 chars; blank → `Machine`. Nothing else from the query reaches the board. |

**`?key=` is refused.** Any `GET /events` carrying a `key` query parameter —
listener or plain viewer — answers `400` and opens no stream, so a client
still on the old shape cannot appear connected while unauthenticated. The
rejection never echoes the value; a key that reached a URL is in an access
log already and should be rotated.

Listener slots are separate from the 10 viewer slots: at most **5 listeners
per workspace** (`429 {"error": "too many listeners"}` for a 6th machine),
one per `machine_id` — a new connection for a machine that is already
connected replaces the old stream (the old one is ended without an
`offline` event). Connects are limited to **30/min per workspace**
(`429 {"error": "rate limit exceeded"}`; the listener should sleep 60 s),
since every one is broadcast to every viewer. On connect the listener
receives `snapshot`, then a `commands` frame with the unclaimed commands
waiting for that machine, and every viewer (and listener) receives
`machine {online: true}`. When the stream closes everyone receives
`machine {online: false}`. After that the listener gets every event a viewer
gets, plus `command` frames addressed to its machine, and the same 25 s
keepalive.

`GET /w/<token>/api/machines` (legacy: `GET /api/machines`) returns the
machines currently online, the same array a viewer gets in its `machines`
frame — id, label, and since when; no platform or version:

```json
[ { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 } ]
```

### Command endpoints

| Method & path                          | Purpose |
| -------------------------------------- | ------- |
| `POST /w/<token>/commands`             | Send a command. Body `{"id": "<client uuid>", "type": "focus"\|"resume", "session_id": "<id>"}`. `id` is a UUID the client mints (normalized to lowercase) so a retry can be told from a second tap. `200 {id, delivered, expires_in_ms}` — `delivered` is whether a listener for the session's machine is connected right now. |
| `POST /w/<token>/commands/:id/claim`   | Listener only. Body `{"machine_key": "<64 hex>"}` — the key of the machine the command was routed to (see [presence](#listener-presence)). Moves `pending → claimed`; a second claim fails, so execution is exactly-once across a LaunchAgent and a stray manual run. `200 {ok: true, expires_in_ms}`. Nothing is broadcast. |
| `POST /w/<token>/commands/:id/ack`     | Listener only. Body `{"machine_key", "result", "reach"?, "reason"?}` — **enums only, no other keys** (see below). Moves `claimed → done`, answers `200 {ok: true}` and broadcasts `command_ack`. |
| `GET /w/<token>/commands/:id`          | `200 {id, type, session_id, machine_id, state, result, reach, reason, created_at, expires_at, claimed_at, done_at}` (unset values are `null`); `404` when unknown or already swept. |

**Status codes.** `POST /commands`: `400` on a malformed `id`, `type` or
`session_id`; `404 {"error": "unknown_session"}`; `409 {"error": "no_host"}`
when the session's hook has not opted in to Focus; `409 {"error": "duplicate_id"}`;
`429 {"error": "rate limit exceeded"}` past 10 commands/min per workspace;
`429 {"error": "too_many_pending"}` at 10 pending commands per workspace (a
re-tap on a card that is already waiting replaces its predecessor and is not
counted). `claim`: `400` bad `machine_key`; `404 {"error": "not_found"}`;
`403 {"error": "wrong_machine"}` when `machine_key` is not the key of the
machine the command was routed to — the public `machine_id` is no
credential; `409 {"error": "already_claimed"}` unless the command is pending;
`410 {"error": "expired"}`. `ack`: `400` on an unknown body key, a bad
`machine_key`, a value outside its enum, or `result: "failed"` without a
`reason`; `404`/`403` as for claim; `409 {"error": "not_claimed"}` while
still pending; `409 {"error": "already_done"}`; `410 {"error": "expired"}`.

**Enums.** `type` ∈ `focus | resume`. `result` ∈
`focused | activated | selected | resumed | failed`. `reach` (how far the
listener got) ∈ `pane | tab | window | app | thread`. `reason` (required when
`result` is `failed`) ∈ `no-record | remote | not-running | app-not-running |
consent-needed | mux-detached | ambiguous | unsupported-host | bad-record |
respawn-failed | unsupported-type | superseded | expired`. There is no free
text anywhere on this channel: a message field would put the machine's cwd,
tty or stderr in front of every board viewer.

**Lifecycle.** `pending → claimed → done`, or `→ expired` from either live
state once `COMMAND_TTL_MS` (default 120000, 2 minutes; whole milliseconds,
at least 1000) has passed — the server then broadcasts
`command_ack {result: "failed", reason: "expired"}` so every command
terminates observably. A session that leaves the board (dismissed, cleared,
evicted or expired) takes its pending commands with it: each is finished as
`failed / superseded` and its `command_ack` follows the `remove` (or
`snapshot`) event, so the listener never raises a window for a card nobody
is looking at; a claimed one is left to ack or expire. The `machine_id` always comes from
`session.host` on the server; a client cannot aim a command at a machine of
its choosing. A second command for the same `(session_id, type, machine_id)`
while the first is still pending **supersedes** it: the older one is
finished as `failed / superseded` (its `command_ack` is broadcast) and the
new one goes out. Done and expired commands stay readable through `GET` for
10 minutes, then are forgotten.

## Legacy (single-tenant) endpoints

| Method & path          | Purpose                                        | Auth |
| ---------------------- | ---------------------------------------------- | ---- |
| `POST /webhook`        | Create/update a session, or a subagent's row (see above; `host` included). | yes* |
| `POST /usage`          | Report plan usage (see [Plan usage](#plan-usage)). | yes* |
| `POST /usage/projects` | Report per-project token spend (see [Usage history](#usage-history-and-per-project-spend)). | yes* |
| `POST /usage/sessions` | Report per-session token totals (see [Per-session token totals](#per-session-token-totals)). | yes* |
| `GET /events`          | SSE stream (see [format](#sse-event-format)); `?listener=` plus `Authorization: Bearer` subscribes a Focus listener (see [presence](#listener-presence)). | no; yes* with `?listener=` |
| `GET /api/sessions`    | JSON list of all sessions.                     | no   |
| `GET /api/machines`    | Focus listeners currently online.              | no   |
| `POST /commands`       | Send a Focus command (see [Focus commands](#focus-commands)). | yes* |
| `POST /commands/:id/claim` | Listener claims a command.                 | yes* |
| `POST /commands/:id/ack` | Listener reports the outcome.                | yes* |
| `GET /commands/:id`    | Command state, for polling.                    | no   |
| `GET /api/usage`       | Current plan usage list.                       | no   |
| `GET /api/usage/history` | Limit history + per-project spend.           | no   |
| `GET /api/sessions/:id/history` | Session timeline (see [Session history](#session-history)). | no |
| `DELETE /sessions/:id` | Remove one session. Returns `{ok: boolean}`.   | no   |
| `POST /sessions/clear` | Remove all sessions. Returns `{ok: true}`.     | yes* |

\* Only when `WEBHOOK_SECRET` is configured: send `X-Webhook-Secret: <value>`,
else `401`. Reads and `DELETE /sessions/:id` stay open so the dashboard can
list and dismiss cards. Focus is otherwise identical in legacy mode.

## Multi-tenant: workspace endpoints

There are no accounts — a workspace is identified by an unguessable token
embedded in its URLs (`ags_` + 32 URL-safe characters). Anyone who has the
URL can view and update that workspace; treat it like a secret. The server
stores only a SHA-256 hash of the token; the raw token is returned exactly
once, at creation.

### Create a workspace

```bash
curl -X POST https://agstatus.online/api/workspaces
```

**Response** — `201 Created`:

```json
{
  "ok": true,
  "token": "ags_...",
  "dashboardUrl": "https://.../w/ags_...",
  "webhookUrl": "https://.../w/ags_.../webhook"
}
```

Save the token — it is not shown again. Creation is limited three ways:

- **20 per hour per IP**: `429` beyond.
- **200 per hour for the whole server** (`MAX_NEW_WORKSPACES_PER_HOUR`), in
  any 60 minutes rather than per clock hour: `503` with a `Retry-After`
  header giving the seconds until the oldest of those creations is an hour
  old, which is when the next board can be made, and
  `{"error": "too many workspaces were created on this server in the last hour, try again in 12 minutes"}`.
  Only boards actually created count, deleted ones included; refused
  requests do not.
- **`MAX_WORKSPACES` live workspaces** (default 10000): `503`
  `{"error": "server at capacity, try again later"}`, with no `Retry-After`,
  because a slot frees only when a board is deleted or idles out.

Both `503`s are checked first and mean the server is not taking new boards
right now, so a client should say so rather than retry on its own, and
neither spends any of the caller's 20. `429` is about the caller.

### Workspace-scoped endpoints

Everything under `/w/<token>/...` mirrors the legacy API, scoped to one
workspace:

| Method & path                    | Purpose |
| -------------------------------- | ------- |
| `GET /w/<token>`                 | Dashboard UI for this workspace. |
| `GET /w/<token>/api/sessions`    | JSON list of the workspace's sessions (newest first). |
| `GET /w/<token>/events`          | SSE stream (see [format](#sse-event-format)). `429` past 10 concurrent connections. `?listener=<machine_id>` with an `Authorization: Bearer` header subscribes a Focus listener instead, in its own slot budget (see [presence](#listener-presence)). |
| `POST /w/<token>/webhook`        | Create/update a session, or a subagent's row (same body as legacy, `host` and `agent` included). `200` with `{ok, session}`, `session` being `null` for a [finish nothing was stored for](#webhook-body-and-validation); `400` on validation errors; `429` over the rate limit. |
| `POST /w/<token>/usage`          | Report plan usage (see [Plan usage](#plan-usage)). |
| `POST /w/<token>/usage/projects` | Report per-project token spend (see [Usage history](#usage-history-and-per-project-spend)). |
| `POST /w/<token>/usage/sessions` | Report per-session token totals (see [Per-session token totals](#per-session-token-totals)). |
| `GET /w/<token>/api/usage`       | Current plan usage list. |
| `GET /w/<token>/api/usage/history` | Limit history + per-project spend. `?days=N` (default 30, max 90). |
| `GET /w/<token>/api/sessions/:id/history` | Session timeline (see [Session history](#session-history)). |
| `GET /w/<token>/api/machines`    | Focus listeners currently online (see [presence](#listener-presence)). |
| `POST /w/<token>/commands`       | Send a Focus command (see [Focus commands](#focus-commands)). |
| `POST /w/<token>/commands/:id/claim` | Listener claims a command. |
| `POST /w/<token>/commands/:id/ack` | Listener reports the outcome. |
| `GET /w/<token>/commands/:id`    | Command state, for polling. |
| `DELETE /w/<token>/sessions/:id` | Remove one session. Returns `{ok: boolean}`. |
| `POST /w/<token>/sessions/clear` | Remove all sessions in the workspace. Returns `{ok: true}`. |
| `DELETE /w/<token>`              | Delete the whole workspace: all sessions, device registrations and pending commands removed, event and listener streams closed. Returns `{ok: true}`. |

Any request with an invalid or unknown token returns
`404 {"error": "unknown workspace"}`. All `/w/...` routes send permissive
CORS headers (`Access-Control-Allow-Origin: *`; methods
`GET,POST,DELETE,OPTIONS`; `OPTIONS` answers `204`) — the token in the path
is the credential, so origins add nothing.

### Pairing endpoints

Pairing lets a device that owns a workspace (e.g. the iOS app) hand it to
another machine (the CLI) via a short, typeable code. Codes are 8 characters
from an ambiguity-free alphabet (no `I`/`L`/`O`/`0`/`1`), displayed grouped
as `XXXX-XXXX`, single-use, held in memory only, and expire after 15 minutes.

| Method & path          | Purpose |
| ---------------------- | ------- |
| `POST /w/<token>/pair` | Create a pairing code for this workspace. `201` with `{ok: true, code: "XXXX-XXXX", expiresInSeconds: 900}`. Max 3 outstanding codes per workspace (`429` beyond); creating a new code does not invalidate the others. |
| `POST /api/pair/claim` | Body `{"code": "XXXX-XXXX"}` (case, dashes, and whitespace are normalized away). `200` with the same `{ok, token, dashboardUrl, webhookUrl}` shape as workspace creation; the code is consumed. `400` on a missing/non-string code; `404` on unknown/expired/already-used codes. Rate limited to 10 attempts per minute per IP (`429`). |

### Device (push) endpoints

Multi-tenant mode only. Devices register per workspace to receive APNs
notifications; see [docs/self-hosting.md](self-hosting.md#push-notifications-apns)
for the server-side setup and trigger rules.

| Method & path                            | Purpose |
| ---------------------------------------- | ------- |
| `POST /w/<token>/devices`                | Register/update a device. Body: `{"device_token": "<hex>", "platform": "ios", "notify_done": false}`. `device_token` must match `^[0-9a-fA-F]{16,200}$` and `platform` must be `"ios"` (`400` otherwise). Upserts by (workspace, token) — re-POST updates `notify_done`. Max 10 devices per workspace: `429` for a new device past the cap; updates to existing devices always succeed. A workspace may also hold at most 100 distinct device tokens counting the ones unregistered in the last 90 days (an unregistered device's row is kept, flagged, and counts until 90 days after it was unregistered — including tokens the server prunes itself when APNs reports them gone): `429 {"error": "too many device tokens have been registered to this workspace in the last 90 days"}` for a new token past that, while a token it already counts can always come back. Returns `{ok: true}`. At most 10 registrations a minute per workspace (`429 {"error": "rate limit exceeded"}`). |
| `DELETE /w/<token>/devices/:deviceToken` | Unregister. Returns `{ok: boolean}` (`false` when the token was not registered). Never rate limited, and spends none of the registration budget. |

Deleting the workspace purges its device registrations. Tokens Apple reports
as expired or unregistered are pruned automatically.

## SSE event format

`GET /events` (legacy) and `GET /w/<token>/events` (multi-tenant) are
standard `text/event-stream` responses:

```
event: snapshot
data: [ { ...session }, ... ]

event: session
data: { ...session }

event: remove
data: { "id": "sess-abc" }

event: usage
data: [ { "source": "claude", "windows": [ ... ], "updatedAt": 1752096030000 } ]

event: machines
data: [ { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 } ]

event: machine
data: { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 }

event: machine
data: { "id": "9f2c…", "online": false, "lastSeen": 1752096900000 }

event: commands
data: [ { "id": "6c1f…", "type": "focus", "session_id": "sess-abc", "machine_id": "9f2c…", "expires_in_ms": 98000 } ]

event: command
data: { "id": "6c1f…", "type": "focus", "session_id": "sess-abc", "machine_id": "9f2c…", "expires_in_ms": 120000 }

event: command_ack
data: { "id": "6c1f…", "session_id": "sess-abc", "machine_id": "9f2c…", "type": "focus", "result": "focused", "reach": "tab", "reason": null }

: keepalive
```

- `snapshot` — the full session list. Sent once on connect and again (empty)
  after `sessions/clear` or workspace deletion.
- `session` — a session was created or updated. It carries `subtasks` when
  the session has any to show, as every other read does. A subagent's post is
  sent at once when it changes the session's `status`, or when no frame for
  that session went out in the last 250 ms; otherwise a single frame follows
  once 250 ms have passed since the last one, carrying the session as it is by
  then, so ten subagents reporting within a second make at most four frames.
  Any other frame for the session supersedes one still waiting. The subtask
  sweep sends one too whenever it changes what a card shows (an expired row, a
  released report hold); its frame moves `updatedAt` by exactly 1 ms, enough
  to win a tie with a REST read without reordering the board.
- `remove` — a session was deleted, evicted, or expired.
- `usage` — the full plan-usage list (see [Plan usage](#plan-usage)). Sent
  on connect when non-empty, and after every usage report.
- `machines` — every Focus listener currently online. Sent to viewers once,
  right after `snapshot` (an empty array when none is connected).
- `machine` — a listener came online (`{id, name, online: true, since}`) or
  went away (`{id, online: false, lastSeen}`). Sent to everyone.
- `commands` — the unclaimed commands waiting for a listener's machine. Sent
  to that listener once, right after its `snapshot`.
- `command` — a new command for the listener's machine. Sent **only** to
  that listener; viewers never see it.
- `command_ack` — a command finished: the listener acked it, a re-tap or the
  session's removal superseded it, or it expired
  (`{result: "failed", reason: "expired"}`). Sent to everyone. See
  [Focus commands](#focus-commands).
- A `: keepalive` comment line is sent every 25 s, on listener streams too.

The server sets `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` so reverse proxies don't buffer the stream. When a
workspace is deleted, its open streams receive a final empty `snapshot` and
are closed. When the server shuts down (SIGTERM or SIGINT, which every restart
sends), open streams end with no final event: the board is still there, so
reconnect, backing off while the server is away. A stream requested while it
shuts down gets `503`.

## Limits

To keep a shared instance healthy, multi-tenant workspaces are capped:

| Limit | Value | Behavior at the limit |
| ----- | ----- | --------------------- |
| Sessions per workspace | 50 | A new session evicts the oldest-updated one (a `remove` event is broadcast for it). |
| Concurrent SSE connections per workspace | 10 | The 11th gets `429` before the stream starts. |
| Webhook requests per workspace | 120/min | `429`. |
| Devices per workspace | 10 | `429` for new devices. |
| Device tokens per workspace | 100, live plus unregistered in the last 90 days | `429` for a token not already counted; a returning one is fine, and a slot frees 90 days after its token was unregistered. |
| Device registrations per workspace | 10/min | `429`. Unregistering is never limited. |
| Usage-history reads per workspace | 30/min | `429` (its own budget, separate from the webhook's). |
| Outstanding pairing codes per workspace | 3 | `429`. |
| Focus commands per workspace | 10/min | `429` (its own budget, separate from the webhook's). |
| Pending Focus commands per workspace | 10 | `429 {"error": "too_many_pending"}`. |
| Focus listeners per workspace | 5 (one per machine) | `429` for a 6th machine; a reconnect replaces the machine's old stream. |
| Focus listener connects per workspace | 30/min | `429`; the listener sleeps 60 s. |
| Focus command TTL | 2 min (`COMMAND_TTL_MS`) | Unclaimed or unacked commands fail as `expired` (a `command_ack` is broadcast); finished ones are forgotten 10 min later. Commands are in memory only — a restart drops them. |
| Workspace creations | 20/hour/IP | `429`. |
| Workspace creations, server-wide | 200 in any 60 minutes (`MAX_NEW_WORKSPACES_PER_HOUR`) | `503` with `Retry-After` (seconds until the oldest of them is an hour old). Counts created boards only, deleted ones included; with Postgres it carries across a restart. Refusals spend none of the per-IP 20. |
| Pair-code claims | 10/min/IP | `429`. |
| Session TTL | 24 h (`SESSION_TTL_MS`) | Expired sessions are swept and `remove` events broadcast. |
| Dropped cards' homes per workspace | 500, each for 24 h after its session's last post | The earliest drop is forgotten first. Held in memory only, so a restart forgets them all (see [`homeProject`](#the-session-object)). |
| Idle workspaces | 60 days | Deleted by a periodic sweep (every 6 hours). |
| Live workspaces | `MAX_WORKSPACES` (default 10000) | Creation returns `503`, with no `Retry-After`. |
| Rows per project-day report | 200 | `400`; the hook sends several reports. |
| Project days per workspace | 5,000 (source, project, day) keys | New keys are refused and counted in the response's `refused`; held keys still update. |
| Project-day window | today − 90 days … tomorrow (UTC), real dates only | Other rows are dropped and counted in `dropped`; aged-out days are flagged and free their slots. |
| Usage sources per workspace | 8, across `/usage`, `/usage/projects` and `/usage/sessions` | `429` for a new source. |
| Limit-history series per workspace | 48 (source, window) pairs | A new window shows as a bar but keeps no history. |
| Limit-history points | 1 per series per minute | The reading moves the bar; no history point is added. |
| Rows per session-total report | 100 | `400`; the hook chunks at the same number. |
| Per-session totals per workspace | 500, or 550 for sessions with a card on the board | New session ids are refused (counted in `refused`); past 500 a session with a card on the board still gets in, up to 550. Held ones always update. |
| Per-session total retention | 7 days | Dropped from reads and from memory; see [Per-session token totals](#per-session-token-totals). |
| Request body | 16 KB | `413`. |

In both modes: `name`/`project` are composed to Unicode NFC and truncate to
120 chars, `message` to 300, `host.machine.name`/`host.app.name` to 32;
control characters are stripped. Push alerts per (session, kind) are
debounced to one per minute.

[Subagents](#subagents) are bounded in both modes too:

| Limit | Value | Behavior at the limit |
| ----- | ----- | --------------------- |
| Live subagent rows per session | 48 | A subagent starting past it gets no row, and its finish still counts. Logged once per card. |
| Live subagent rows per board | 256 | The same. A start turned away for a session not on the board makes no card: `{"ok": true, "session": null}`. |
| Failed rows listed per session | 8 | The oldest leaves the list; `failed` keeps counting. |
| `subtasks` JSON per session | 8 KB | Activities, then labels, are shortened; no item and no count is dropped. |
| Running row without a post | 60 min | Closed by the sweep, uncounted; the subagent's next post brings it back. |
| Waiting or failed row without a post | 6 h | A waiting row is closed, a failed one dropped. |
| Report hold without a post from the parent | 120 s | Released by the sweep: the card reads `done`. |
| Frames from subagent posts | 1 per 250 ms per session | The rest fold into one trailing frame. |

Subagent posts share the webhook's 120 a minute in multi-tenant mode: about
four per subagent (its start, a change of status class or two, its finish),
plus at most one activity refresh a minute while it runs.
