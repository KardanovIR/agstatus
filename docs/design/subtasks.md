# AgStatus 1.7.0: subtasks on session cards (implementation spec)

> Recovered on 2026-11-07 from the transcript of the session that wrote it on
> 2026-10-28, after its scratchpad was cleared. The research files and probe
> captures it cites by scratchpad path did not survive; the probe payloads the
> tests replay are in `cli/test/fixtures/subtasks`, and the probe logger it
> names, `subtasks/probe/bin/log-hook.js`, is now `docs/design/subtasks-probe`.

This is the single contract for five implementers working in parallel (hook, server, web, iOS, Android) plus docs. They do not talk to each other, so every cross-layer detail is fixed here: field names, types, bounds, enum values, ordering, timing, and who computes what.

- Owner decisions are final. Appendix B lists every point where this spec chose between the brief and the prototype, or filled a gap neither covers, and why.
- Where this spec and the prototype disagree, this spec wins.
- The prototype is `docs/design/prototypes/subtasks.html`. Its reference functions are `view()` 1863-1883, `pick()` 1912-1965, `footHTML()` 1981-2000, `cardHTML()` 2029-2045, `screenInnerHTML()` 2137-2163 and `screenHTML()` 2165-2187.
- Citations as `file:line` point at origin/master (v1.6.3, 112cc05). Every non-iOS file in this checkout is identical to it. iOS citations point at branch `claude/session-organization-agents-c27901`.
- Research lives in the scratchpad: `subtasks/research.json` and the probe captures `subtasks/probe/events-{a,b,c,d,d2,e,e2,b284}.jsonl` and `subtasks/probe/payload-excerpts.json`. Probe facts are cited by run letter: a = parallel foreground, b = nested, c = background, d/d2 = permission, e/e2 = workflow. "Binary" means the Claude Code 2.1.284 strings dump (`scratchpad/strings.txt`).

---

## 0. Vocabulary and constants

| Term | Meaning |
|---|---|
| parent | The session that owns the card (`session_id`). Subagent events carry the parent's `session_id` (Claude research fact 5; Codex fact 5: always the ROOT id). |
| subagent | Anything that runs under the parent with its own `agent_id`: an Agent-tool subagent (foreground, background or nested), a dynamic-workflow agent, a Codex sub-agent thread, an in-process teammate, a `/fork`. Detection keys on `agent_id` only, never on `agent_type` (`agent_type` also appears on main-thread events under `--agent`). |
| agent key | The subagent's id on the wire: 24 lowercase hex characters, `sha256(base + "\n" + SOURCE + "\n" + session_id + "\n" + agent_id)`, first 24 hex digits (`base` as `boardBase()` normalizes it, hook `:204-206`). The raw `agent_id` never leaves the machine (§3.2). |
| known agent | A subagent this hook process can find local state for (§3.6): it saw the subagent's `SubagentStart` and recorded it. |
| 1.6.3 path | How an agent-tagged event of an UNKNOWN agent is handled: exactly as the 1.6.3 hook handled it (through the main-thread switch, no `agent` key), except that host detection never runs for it (§3.2). |
| main-thread post | A webhook post without `agent`. |
| agent post | A webhook post with `agent`. |
| own status / own message | The parent's own reading: what its last main-thread post said. |
| soft block | An own `blocked` reading that came from a permission or input prompt the hook could not attribute to any thread, posted while subagents were live. The next running agent post clears it (§4.2). |
| report hold | The short window after the last background subagent finished, before the parent's report turn posts, during which the server shows `planning` "Reading subagent results" instead of `done` (§4.5). |
| wire status / wire message | What clients receive, derived by the server (§4.5). Always one of the six statuses. |
| live row | A subagent in `planning`, `coding`, `testing` or `blocked`. **working** means `planning`, `coding` or `testing`. |
| tally | The current turn's done count plus its failed rows. |
| turn | A user turn. It starts at a real user prompt (Claude `UserPromptSubmit` with user text; Codex root `UserPromptSubmit`). It ends at `Stop`, and is fully over when `Stop` leaves nothing live and nothing reporting back. |

**Constants.** Every number in one place. Each layer uses the names below.

| Name | Value | Layer |
|---|---|---|
| `AGENT_KEY` | 24 lowercase hex chars (see "agent key") | hook |
| `AGENT_ID_MAX_CHARS` | 256. A non-string, empty or longer `agent_id` makes the event unusable; it is dropped (§3.2). Claude ids are up to 81 chars (binary `bk()`: `^a(?:[\w-]{1,63}-)?[0-9a-f]{16}$`), Codex ids are 36. | hook |
| `AGENT_ID_RE` | `/^[A-Za-z0-9._:-]{1,64}$/` (server validation; it accepts the 24-hex key) | server |
| `LABEL_MAX` | 64 characters after cleaning. Labels: p50 23, p90 52, p99 62. | hook, server |
| `ACTIVITY_MAX` | 80 characters | hook, server |
| `MAX_LIVE_ROWS` | 48 live rows per session (observed max 30 at once) | server |
| `MAX_LIVE_ROWS_PER_WORKSPACE` | 256 live rows across a board | server |
| `MAX_FAILED_ROWS` | 8 failed rows listed per session; the `failed` count stays exact | server |
| `MAX_TOMBS` / `TOMB_TTL_MS` | 64 per session / 2 h | server |
| `LIVE_STALE_MS` | 60 min without an update closes a working row | server |
| `BLOCKED_STALE_MS` | 6 h without an update closes a blocked row, drops a failed row, and resets an idle tally | server |
| `REPORT_HOLD_MS` | 120 s | server |
| `SUBTASK_SWEEP_MS` | 60 s | server |
| `AGENT_FRAME_THROTTLE_MS` | 250 ms | server |
| `WIRE_SUBTASKS_MAX_BYTES` | 8,192 bytes of UTF-8 JSON per session's `subtasks` | server |
| `SUBTASKS_COLUMN_MAX_CHARS` | 65,536. A longer stored column loads as no state. | server |
| `TURN_RUNNING_MAX` | 64 keys in `turn.running` (the hook omits the list rather than truncate it) | hook, server |
| `NOTIFICATIONS_PER_PROMPT_MAX` | 8 `<task-notification>` blocks handled per prompt | hook |
| `LAUNCH_CLAIM_WINDOW_MS` | 10 s | hook |
| `PERM_MARKER_MIN_AGE_MS` / `PERM_MARKER_MAX_AGE_MS` | 2 s / 30 min | hook |
| `LABEL_POSTS_MAX` | 2 label-only posts per agent | hook |
| `META_TRIES` | 3 | hook |
| Local state caps | per session directory: `launch/`, `perm/`, `runs/` 64 entries each; `agents/`, `labels/`, `bind/` 2,048 each | hook |
| Local state ages | `launch/` 10 min; `perm/` 30 min; `agents/`, `labels/`, `bind/`, `runs/` 24 h; session directories 24 h | hook |
| Read caps | state files 8 KiB; `meta.json` 8 KiB; workflow journal tail 64 KiB, at most 4 journals; Codex `session_meta` `CODEX_META_MAX_BYTES` (hook `:1548`) | hook |
| Hook entry timeout | `timeout: 10` on every Claude entry except `SessionEnd`; every Codex entry already has it | hook |
| Slots | 3 on wide layouts: iOS when `plan.arrangement` is not `.narrow` (any device), web wider than 560 px. 2 under phone rules: iOS `.narrow` on any device, web at 560 px or less, Android always. | clients |
| Arrival highlight | 2 s | clients |
| `STALE_MS` (existing) | 10 min; never applied to a card whose `subtasks.running > 0` (§6.1) | clients |

---

## 1. Summary and non-goals

### 1.1 Summary

When a Claude Code or Codex session runs subagents, its card lists each **running** subagent as a row: label · activity · status mark and word. At most 3 rows fit on iPad and web, 2 on a phone, followed by a footer reading "+N more · M done".

Mechanism (Option B, owner-approved):

1. **Hook.** It adds an optional `agent` object to the existing webhook post, a `turn` hint to some main-thread posts, and an `unattributed` flag to prompts it cannot attribute. A subagent is posted only on start, stop and a change of status class; a start whose label arrives late may add at most 2 label-only posts (Appendix B). The raw `agent_id` is replaced by the agent key in every mode.
2. **Server.** It merges agent posts into a bounded per-session subtask state, which never overwrites the parent's own status and message. The state is persisted in one new nullable `TEXT` column, `sessions.subtasks`.
   - It derives the wire status and message, always one of today's six statuses: a blocked subagent gives `blocked` / "Needs approval: <label>"; after the turn, while subagents still work, the busiest state / "<n> subagents still running"; between the last background finish and the parent's report turn, `planning` / "Reading subagent results".
   - It attaches an optional `subtasks` object to the session JSON.
3. **Clients.** They render rows using the prototype's `view()`, `pick()`, `footHTML()` and `screenInnerHTML()` behaviour.
   - **WORKING** is a client-only reading, computed from `subtasks.turnEnded`. It is never sent as a session status.
   - Older clients ignore `subtasks` and get a calmer card. Old servers ignore `agent`, `turn` and `unattributed`.
4. **Bug fixes in passing:**
   - The hook's `tool === 'Task'` check drops every Agent launch (`plugin/scripts/agstatus-hook.js:2763`).
   - Background completions (`<task-notification>`) are shown as the user's prompt.
   - `Stop` reports `done` while background agents still run.
   - Non-asking Notification types (`auth_success`, `agent_completed`, …) turn a card blocked and push.
   - Host detection reads a Codex sub-agent's rollout as the root's (Focus mis-routing, research codex fact 17).

### 1.2 Non-goals for 1.7.0

- No child sessions or per-subagent cards (Option A was rejected), and no per-subagent Focus. Focus still raises the parent's window.
- No per-subagent history events. The timeline stays the parent's (§4.10).
- No per-subagent token figures.
- No activity refreshes within a status class, and no keepalive posts: a row's activity is "what it last changed to" (owner flood-control decision; see the owner question on keepalives).
- No new SSE event type and no seventh wire status. `failed` is a row state only; `working` is a client reading only.
- No grouping of rows by workflow or phase. Nesting is listed flat (owner).
- No failure detection for workflow agents or Codex sub-agents. No signal exists, so they count as done (§3.9).
- No change to `src/push.ts`. A second subagent block re-arms the existing push from `src/app.ts` (§4.9).
- Codex prompt text stays off the card: the newly registered Codex `UserPromptSubmit` posts the fixed line "Processing prompt" (§3.3).
- No Android tablet layout. Android always uses the phone rules.
- Out of scope, though noticed by the research:
  - Codex sub-agent tokens never reach the parent card (research codex fact 18).
  - A paginated Codex rollout filename breaks the token-scan session id (codex fact 19).
  - The deprecated bash hook (`hooks/claude-status-hook.sh`).

---

## 2. Wire: hook → server

### 2.1 Body shapes

**Main-thread post.** Today's body (`agstatus-hook.js:2827-2834`, `host` added at `:2840-2846`), plus two optional keys:

```json
{ "session_id": "<parent>", "name": "…", "status": "planning", "message": "…",
  "project": "…", "source": "claude", "host": { … },
  "turn": { "phase": "start" },
  "unattributed": true }
```

`turn` is described in §2.3, `unattributed` in §2.4. Both are absent when they do not apply.

**Agent post.** One post describes exactly one subagent. It never carries `turn` or `unattributed`.

```json
{ "session_id": "<parent>", "status": "coding", "source": "claude", "name": "<see below>",
  "agent": { "id": "3f9c1e07b2d4a85c6e1f0a92", "state": "coding", "kind": "agent",
             "label": "Run echo alpha", "activity": "Print alpha", "at": 1793138690842 } }
```

Rules for agent posts:

- `status` is **required** (every server version 400s without it; `src/app.ts:383`). It carries the **compat status**, which only old servers use (§2.6):
  - For running states it equals `agent.state`.
  - For `done` or `failed` it is the agent's last confirmed running class (`planning`/`coding`/`testing`) from the hook's local state; `planning` when that is unknown or was `blocked`.
  - The new server checks `status` against the six and otherwise ignores it.
- `message` is **omitted**, except on posts whose `agent.state` is `blocked`: there it carries exactly the text the 1.6.3 hook would have posted for the same event (the Notification's `message`, or 'Needs input' in minimal mode; for Codex the `tool_input.description` or `message`, clipped to 120, or 'Needs approval' in minimal mode). Old servers then push and show the same blocked line as 1.6.3; the new server ignores `message` on every agent post.
- `project` and `host` are **omitted**. Old servers keep the parent's folder and host (`src/store.ts:1225-1229`). The hook never runs host detection for an agent-tagged event (§3.2).
- `name` is always sent: the read-only pinned-name lookup of §3.11. The new server uses it only when the agent post creates the card (§4.3); old servers apply it as they apply every name.
- `source` is sent as today.

### 2.2 The `agent` object

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | The agent key (24 lowercase hex). The server validates it against `AGENT_ID_RE` and treats it as opaque. |
| `state` | string | yes | One of `planning`, `coding`, `testing`, `blocked`, `done`, `failed`. The first four mean the subagent is running. Any running state for an id the server holds no row for is an implicit start, so there is no separate "start" verb. `done` means it finished. `failed` means it finished without success (§3.9). |
| `kind` | string | no | `agent` (Agent tool, teammate, `/fork`), `workflow` (a workflow agent, §3.5) or `codex` (`SOURCE === 'codex'`). Absent or unknown means `agent`. Only the server reads it, for reconciliation (§4.4). It is never on the client wire. |
| `label` | string | no | What the subagent was asked to do (§3.5). Sent on **every** agent post once known, in detail mode; **never sent in minimal mode**. Absent means "no label known"; the server keeps any label it already holds. |
| `activity` | string | no | What the subagent is doing now. Detail mode: the text a main-thread post would carry for the tool (`describeEdit`/`describeBash`/`describeResearch`), or `Approve: …`, `Failed: …`. Minimal mode: an allowlisted tool name or a fixed word (§3.10). Clipped to 80. Absent means "keep the previous value"; `''` clears it. |
| `at` | integer | yes (from the 1.7.0 hook) | Epoch ms on the hook's clock, taken when the hook read stdin. It orders updates for the same `id`; it is never displayed and never compared with server time except for the sanity bound in §2.5. |

The owner's sketch was `agent: {id, type, label, state}`. Here `type` becomes the closed enum `kind`; the raw `agent_type` is not sent (nothing consumes it, and custom or plugin agent names are user-chosen text). Unknown keys inside `agent` are dropped.

### 2.3 The `turn` object (main-thread posts only)

| Field | Type | Present when | Meaning |
|---|---|---|---|
| `phase` | string | always | `start`: a real user prompt (Claude `UserPromptSubmit` with user text, §3.8; Codex root `UserPromptSubmit`). `end`: `Stop` (Claude and Codex). `reset`: `SessionStart` with source ≠ `compact` (Claude and Codex); it drops every live row, because a (re)started process has none (§4.4). |
| `running` | string[] | `phase:"end"`, only when `Stop.background_tasks` is an array and every eligible entry could be listed | Agent keys of the `background_tasks` entries with `type === "subagent"` whose `status` is not one of {`completed`, `failed`, `killed`, `stopped`, `cancelled`, `error`}. At most 64. If any eligible entry has a non-string or empty `id`, or there are more than 64, the hook omits `running` **and** `workflows` (unknown), because a partial list would close live rows (§4.4). Descriptions are never sent. |
| `workflows` | integer | with `running` | The count of non-terminal `background_tasks` entries with `type === "workflow"`. |

- `teammate` entries are not listed: an in-process teammate's task id is a separate `in_process_teammate` id, never its `agent_id` (binary: `f=Hb("in_process_teammate")` beside `identity:{agentId:…}`), so listing it could never match a row.
- An absent `background_tasks` means the task registry was unreachable. That is "unknown", not "none running": the hook omits `running` and `workflows` and the server skips reconciliation.
- Codex `Stop` has no `background_tasks`, so it sends `{ "phase": "end" }` only.

### 2.4 The `unattributed` flag (main-thread posts only)

`unattributed: true` rides on a main-thread `blocked` post the hook could not attribute to a thread: a `Notification(permission_prompt)` for which no permission marker could be claimed, and the `elicitation_dialog`, `elicitation_url_dialog` and `agent_needs_input` Notifications (§3.3, §3.7). The server makes such a block **soft** when subagents are live (§4.2). Any other value is ignored.

### 2.5 Server validation and rejection

Order in `handleWebhook` (`src/app.ts:368-415`). Everything that exists today is unchanged:

1. Rate limit, then `session_id`, `status` (must be one of the six), `source` and `host`, exactly as today.
2. `agent`:
   - Absent or `null`: a main-thread post.
   - Not a plain object, a missing or invalid `id`, or a `state` outside the six agent states: **400** `{"error":"agent must be an object with id matching ^[A-Za-z0-9._:-]{1,64}$ and state one of planning, coding, testing, blocked, done, failed"}`. Rejecting is deliberate, as with `host` (`src/app.ts:130-138`): applying a malformed agent post's compat `status` would be wrong.
   - Otherwise rebuilt key by key: `label` through `cleanLabel(v, 64)` (an empty result counts as absent); `activity` through `cleanLabel(v, 80)` (empty allowed); `kind` as in §2.2; `at` kept when it is an integer in `[1, Number.MAX_SAFE_INTEGER]` within 7 days of the server clock, otherwise replaced by the server's receive time.
3. `turn` is ignored on agent posts. On main-thread posts a malformed `turn` is **ignored**, never a 400, so the parent's own update is not lost: a non-object or a `phase` outside `start|end|reset` drops the whole `turn`; a `running` that is not an array of at most 64 ids matching `AGENT_ID_RE` is treated as absent, and then `workflows` is treated as absent too; a `workflows` that is not an integer from 0 to 1,000 is treated as absent.
4. `unattributed` is honoured only as `=== true` on a main-thread post with `status: "blocked"`; anything else is ignored.
5. `UpsertInput` gains `agent?: AgentUpdate`, `turn?: TurnHint` and `unattributed?: boolean`. All are optional, so direct callers such as `test/history.test.ts:49` still compile.

**Text cleaning (all string fields, new and existing).**

- `clean()` (`src/app.ts:120-121`) becomes surrogate-safe: after stripping control characters it removes every unpaired UTF-16 surrogate, slices, then drops a trailing high surrogate left by the slice. Today a slice can end in a lone `\ud83d`, which Swift's `JSONDecoder` rejects, so iOS drops a whole snapshot (`SSEClient.swift:167`; the hook's own `cleanTitle` already steps back off one, hook `:2302-2315`). Use a regex, not `String.prototype.toWellFormed()`, because `engines.node` is `>=18` (`package.json`).
- `cleanLabel(v, max)` for `agent.label` and `agent.activity`: collapse every run of whitespace (including `\t\n\r`) to one space, strip remaining control characters, trim, then the surrogate-safe clip.
- The hook applies the same order and the same surrogate-safe clip before sending (§3.11).

### 2.6 Compatibility

**New hook → old server (≤ 1.6.3).** `agent`, `turn` and `unattributed` are dropped (`UpsertInput` is built from named fields, `src/app.ts:399-407`). Each agent post sets the parent's status to the compat status and carries the rest forward. Compared with a 1.6.3 hook on the same server:

| Situation | Effect |
|---|---|
| Ordinary subagent work | Fewer status flips (class changes only), and the parent's line is no longer overwritten. |
| `SubagentStart` | The parent shows `planning`. |
| `SubagentStop` | The parent shows the agent's last class, usually no visible change. Never `done`, so there is no mid-turn done push. A stop for an agent the hook never saw start posts nothing. |
| Blocked subagent | Parent `blocked`, a push with the same body 1.6.3 sent (the agent post carries 1.6.3's message, §2.1). |
| Notification-only `<task-notification>` prompt | `planning` "Reading subagent results" instead of the notification text. |
| Background subagent after the parent's `Stop` | Can flip the old server's card from `done` to its class, exactly as today's subagent tool calls do (research model fact 22). The second `Stop` returns it to `done`. |

Self-hosters should upgrade the server before the hooks; the table above is the worst they see otherwise.

**Old hook → new server.** No `agent`, `turn` or `unattributed` ever arrives. Every post is a main-thread post, no subtask state is created, the session JSON has no `subtasks` key, and wire status and message equal own status and message. This is today's behaviour, byte for byte.

**New hook → new server.** The full feature.

**New hook with old registrations, or with an unusable local state directory** (plugin cache, a partial install, Codex entries not yet trusted, a squatted `/tmp`). No `SubagentStart` is recorded, so every subagent is unknown and takes the 1.6.3 path (§3.2): today's behaviour, minus the host-detection bug, plus the Agent-launch fix. No rows appear and none can be left behind.

**Old clients ↔ new server.**

- iOS ignores the `subtasks` key: Session decodes through explicit private CodingKeys (`ios/AgStatus/Models.swift:93-95`).
- Android ignores it: `ignoreUnknownKeys = true` (`Api.kt:63`).
- Old clients see only the derived six-status reading.
- A seventh status would draw as IDLE on a shipped app (`Models.swift:104`, `Models.kt:48`). The prototype's FOUND note says such an app "fails to decode"; that mechanism is wrong, but the conclusion stands: keep six statuses on the wire and in history.

**New clients ↔ old server.** No `subtasks` key, so today's card.

The full matrix is in §9.3.

### 2.7 Golden bodies

Both the hook tests and the server tests use these fixtures (`cli/test/fixtures/subtasks/*.json` and `test/fixtures/subtasks/*.json`). Payload sources are probe captures. `K(x)` is the agent key of raw id `x` for the test's board URL, source and session; tests compute it with `crypto`. In every agent body `at` is asserted only as a positive integer and `name` as a non-empty string. Detail mode unless noted.

| # | Input payload | Expected request(s) |
|---|---|---|
| G1 | `a_parent_PreToolUse_Agent` (main, tool `Agent`, description "Run echo alpha") | One main-thread post `{status:"planning", message:"Run echo alpha", …}` (the fixed Task→Agent branch). A launch record is written (§3.6). |
| G2 | `a_SubagentStart` (agent_id `a28b0e80d3d1190c2`, agent_type `general-purpose`), right after G1 | `{session_id:"5cef7152-…", name, status:"planning", source:"claude", agent:{id:K("a28b0e80d3d1190c2"), state:"planning", kind:"agent", label:"Run echo alpha", at}}` |
| G3 | `a_PreToolUse_inside_subagent` (Bash `echo alpha`, description "Print alpha") | `{status:"coding", agent:{id, state:"coding", kind:"agent", label:"Run echo alpha", activity:"Print alpha", at}}` |
| G4 | Same agent: PreToolUse `Edit` on `store.ts`, a second `Edit`, then Bash `npm test` | The two `Edit`s give no post (`coding` → `coding`). The Bash gives `{status:"testing", agent:{…, state:"testing", activity:"<description or command>"}}`. |
| G5 | `a_SubagentStop` | `{status:"testing", agent:{id, state:"done", kind:"agent", label:"Run echo alpha", at}}` (`status` = last confirmed class). |
| G6 | SubagentStop with `agent_type: ""`; or SubagentStop for an agent with no local state | No request. |
| G7 | `c_Stop_while_bg_running` | Main-thread `{status:"done", message:"Turn finished", …, turn:{phase:"end", running:[K("a81211a654bc21fa3")], workflows:0}}` |
| G8 | `e_Stop_while_workflow_running` | `turn:{phase:"end", running:[], workflows:1}` |
| G9 | `c_UserPromptSubmit_task_notification` | (a) local state for the agent already records `done` (run c order): one main-thread post `{status:"planning", message:"Reading subagent results"}`, no `turn`. (b) local state records a running class (its stop was lost): that main-thread post plus `{status:"coding", agent:{id:K("a81211a654bc21fa3"), state:"done", kind:"agent", …}}`. (c) no local state: the main-thread post only. |
| G10 | `UserPromptSubmit` with ordinary text | Main-thread `{status:"planning", message:"<prompt>", turn:{phase:"start"}}` |
| G11 | G2 and G3 with `AGSTATUS_DETAIL=off` | `agent:{id, state:"planning", kind:"agent", at}` then `agent:{id, state:"coding", kind:"agent", activity:"Bash", at}`. No `label` anywhere; `name` is the folder (titles are off). |
| G12 | Codex `SubagentStart`, with a rollout fixture whose `session_meta` has `id` = agent_id and `agent_nickname:"Feynman"` | `{status:"planning", source:"codex", agent:{id:K(<thread id>), state:"planning", kind:"codex", label:"Feynman", at}}` |
| G13 | Codex agent-tagged `PermissionRequest` from a known agent, not auto-reviewed, `tool_input.description` "May I run …" | `{status:"blocked", message:"May I run …", source:"codex", agent:{…, state:"blocked", label:"Feynman", activity:"May I run …", at}}` |
| G14 | `d2_PermissionRequest_inside_subagent` (Claude), after a SubagentStart for `a9f11cbaeca3764d9` from an Agent call described "try touch" | No request; a marker is written. Then a `Notification {notification_type:"permission_prompt", message:"Claude needs your permission to use Bash"}` at least 2 s later gives `{status:"blocked", message:"Claude needs your permission to use Bash", agent:{id:K("a9f11cbaeca3764d9"), state:"blocked", kind:"agent", label:"try touch", activity:"Approve: Create empty file denied-probe.txt", at}}` |
| G15 | `PostToolUseFailure` with `tool_name:"Agent"` and the `tool_use_id` of a bound launch | `{status:"<last class>", agent:{id, state:"failed", label, activity:"Failed: <first line of error>", at}}`; with `is_interrupt:true`, `activity:"Stopped"`. |
| G16 | `SessionStart` with `source:"compact"` | No request. With `source:"startup"`: `{status:"idle", message:"Session started", …, turn:{phase:"reset"}}` |
| G17 | `PostToolUse` tool `Agent` with `tool_response.status` `remote_launched`; or `teammate_spawned`; or `completed` | No request (the launch record is consumed, a binding is written). With `async_launched` whose `description` differs from the label already sent: one label post `{status:"<class>", agent:{…, state:"<class>", label:"<description>"}}`. Never a `failed` post. |
| G18 | `e_parent_PostToolUse_Workflow` | No request; a run record for `wf_63757895-43f` is written. |
| G19 | Codex root `UserPromptSubmit` | `{status:"planning", message:"Processing prompt", source:"codex", turn:{phase:"start"}}` (prompt text never sent for Codex). |
| G20 | Agent-tagged PreToolUse (Bash, description "Say hi") for an agent with **no** local state | Today's main-thread body `{status:"coding", message:"Say hi", name, project, source}`: no `agent`, no `host`. |
| G21 | `Notification {notification_type:"permission_prompt"}` with no claimable marker while local state shows a live agent | Main-thread `{status:"blocked", message:"<payload.message>", unattributed:true}` |

---

## 3. Hook behaviour

The canonical file is `cli/assets/agstatus-hook.js`. Edit it, then run `npm run sync:plugin` (`package.json:15`); `cli/test/plugin.test.ts:13` fails on any difference between the two copies. The script stays dependency-free, never writes stdout (`:11`), and keeps its 3 s HTTP abort and 4 s safety exit (`:82`, `:361`).

### 3.1 Registration and how existing installs get it

**Claude Code.** `cli/src/settings.ts` `HOOK_EVENTS` (`:8-15`) and `plugin/hooks/hooks.json` must stay identical in events, matchers and timeouts; extend `cli/test/plugin.test.ts:22-34` to compare `timeout` too. `HOOK_EVENTS` entries gain an optional `timeout`, which `mergeSettings` (`:182-185`) writes into the hook object. No entry is `async`.

| Event | Matcher | `timeout` | New in 1.7.0 |
|---|---|---|---|
| SessionStart | none | 10 | timeout |
| UserPromptSubmit | none | 10 | timeout |
| PreToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash\|Agent\|Task\|WebSearch\|WebFetch\|Workflow` | 10 | `Agent` and `Workflow` added (`Task` kept for older Claude Code); timeout |
| Stop | none | 10 | timeout |
| Notification | none | 10 | timeout |
| SessionEnd | none | none | unchanged: a `timeout` would raise Claude Code's shared 1.5 s session-end budget (hooks.md, Common fields) |
| SubagentStart | none | 10 | yes |
| SubagentStop | none | 10 | yes |
| PermissionRequest | none | 10 | yes (Claude). It only writes a local marker (§3.7). |
| PostToolUse | `Agent\|Task\|Workflow` | 10 | yes: launch bindings and workflow run records (§3.3) |
| PostToolUseFailure | `Agent\|Task` | 10 | yes: foreground failure (§3.9) |

Why `timeout: 10`: Claude Code's default for a command hook is 600 s (hooks.md:414). The 4 s safety exit cannot fire while the event loop is stuck in a blocking syscall (hook `:2364-2369`); every new read is non-blocking (§3.6), and the timeout bounds anything left.

Why everything stays synchronous: label claiming relies on `PreToolUse(Agent)` completing before its `SubagentStart` usually (§3.5), synchronous hooks give per-agent post ordering, and the added latency is one Node start plus one POST per subagent start and stop, against today's one per subagent tool call (about 22 per subagent over 30 days: 34,619 subagent posts for 1,597 subagents, `subtasks/events-30d.txt`, `counts-30d.txt`).

**Codex.** `cli/src/codex.ts` `CODEX_EVENTS` (`:27-32`) gains `UserPromptSubmit`, `SubagentStart` and `SubagentStop`, all without a matcher and with timeout 10 like the others (`:35`). The PreToolUse matcher stays `^(Bash|apply_patch|Edit|Write)$`.

**Upgrading existing installs.**

| Channel | How the new hook and registrations arrive |
|---|---|
| CLI (`agstatus init`, which both web installers run) | Re-running init copies the bundled hook (`cli/src/index.ts:95`) and re-merges `HOOK_EVENTS` (`cli/src/settings.ts:176-186`), so script and registrations move together. Until a user re-runs init, they keep 1.6.3 behaviour. |
| Claude Code plugin | Bump `plugin/.claude-plugin/plugin.json:4` and `.claude-plugin/marketplace.json:12` to 1.7.0. The plugin update ships `hooks.json` and the script together. |
| Codex | Init re-merges `CODEX_EVENTS` into `~/.codex/hooks.json`. Codex trusts a hook by a hash of its command string (`cli/src/codex.ts:22-24`), and init warns only when the command string changes (`cli/src/index.ts:128-129`). Whether newly added entries with an unchanged command need `/hooks` again is **unknown** (Appendix A, P3). Until they run, every Codex sub-agent is unknown and takes the 1.6.3 path, so nothing is left behind (§3.2). |

The Codex notice when the event set grew: "Codex: AgStatus now also listens for UserPromptSubmit, SubagentStart and SubagentStop. If `/hooks` in Codex lists an AgStatus entry as untrusted, trust it once."

- Implement it with a pure, exported `codexAddedEvents(hooks): string[]` that returns the `CODEX_EVENTS` names with no entry carrying our command.
- Print the notice when the previous set is non-empty, the added set is non-empty, and the re-trust warning is not already printed.

### 3.2 Routing (new step after `transcript` is hoisted, `agstatus-hook.js:2679-2682`)

```
raw := payload.agent_id
if raw !== undefined and (typeof raw !== 'string' or raw === '' or raw.length > 256) → return       // unusable: drop, never main
agentId := raw ?? ''                                 // the raw id stays local; only agentKey(agentId) is posted
if SOURCE === 'claude' and agentId and payload.agent_type === '' → return                            // internal agents (prompt suggestions, /btw)
if event ∈ {PostToolUse, PostToolUseFailure} → handleLaunchResult(); return                          // Claude; about the LAUNCHED agent
if agentId:
    known := local state exists for agentKey(agentId) (§3.6)
    SubagentStart                              → handleAgentStart()                 // records state first, then posts
    SubagentStop, UserPromptSubmit             → known ? handleAgentEvent() : return
    PreToolUse                                 → known ? handleAgentEvent() : main-thread switch (1.6.3 path)
    PermissionRequest                          → known ? handleAgentEvent()
                                                 : (SOURCE === 'codex' ? main-thread switch (1.6.3 path) : return)
    any other event                            → return
otherwise → the main-thread switch (§3.3)
```

- **Events that carry `agent_id` never run host detection and never send `host`**, including the 1.6.3 path. `detectHost` reads `payload.transcript_path` (`:2124`), which is a Codex sub-agent's own rollout on its events (codex fact 7), so the root's host record could take the sub-agent's thread id.
- Agent events (known or not) skip `readTranscriptTitle` and `pinnedName`'s write path; they use the read-only lookup of §3.11.
- Usage and project reports keep their 1.6.3 triggers: they run on Codex PreToolUse whether or not it is agent-tagged (Codex bars would otherwise freeze while a root waits on sub-agents, `:2847-2862`), and on the same main-thread events as before. They never run for Claude agent events, Claude `PermissionRequest`, `PostToolUse*`, `Subagent*` or Codex `UserPromptSubmit`.
- The 1.6.3 path is deliberately the old behaviour: it is what an install without the new registrations, with an untrusted Codex entry, or with an unusable state directory gets, and it can neither create rows nor leave them behind.

### 3.3 Per-event behaviour

**Main-thread events.**

| Event | Condition | Posts |
|---|---|---|
| SessionStart | `source === "compact"` | Nothing (new). Auto-compaction mid-turn used to post `idle` "Session started" (`:2687`). |
| SessionStart | anything else | `idle` "Session started" as today, plus `turn:{phase:"reset"}`. Prunes local state (§3.6). |
| UserPromptSubmit | Claude, notification-only (§3.8) | Main-thread `planning` "Reading subagent results" (fixed text in both modes), no `turn`. Plus one agent post per block of a known agent (§3.8). All posts are sent together. |
| UserPromptSubmit | Claude, otherwise | `planning` with the prompt as today (`:2735-2744`), plus `turn:{phase:"start"}`. Plus agent posts for any notification blocks of known agents it contains. |
| UserPromptSubmit | Codex root (new registration) | `planning` "Processing prompt" in both modes, plus `turn:{phase:"start"}`. Codex prompt text is never sent. |
| PreToolUse | tool `Agent` or `Task` | `planning`, `describeResearch` (`:308-324`); the check becomes `tool === 'Agent' \|\| tool === 'Task'`. Minimal mode: the tool name, as today. Writes a launch record (§3.6). Drops the session's `main` permission markers (§3.7). |
| PreToolUse | tool `Workflow` | `planning`. Detail mode: `Running workflow: <description>` when a regex finds `description: '…'` (single, double or backtick quotes, at most 200 characters) in the first 4 KB of `tool_input.script`; otherwise "Running a workflow". Minimal mode: `Workflow`. Drops `main` markers. |
| PreToolUse | other matched tools | Unchanged. Drops `main` markers. |
| Notification | `permission_prompt` | Claim a permission marker (§3.7): a subagent marker gives an agent post with state `blocked`; a `main` marker gives today's main-thread `blocked` (`:2693-2702`); no marker gives today's main-thread `blocked` plus `unattributed: true`. |
| Notification | `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | Today's main-thread `blocked`, plus `unattributed: true` (the asking thread is unknown). |
| Notification | `idle_prompt`, `quota_auto_resume_stale`, absent or unknown type | Today's main-thread `blocked`. |
| Notification | `auth_success`, `elicitation_complete`, `elicitation_response`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_disabled`, `plugin_notification` | Nothing (new). None asks a human (hooks.md Notification table), and each would otherwise turn a WORKING card blocked and push. |
| PermissionRequest | Claude | Writes a `main` marker; no post. `codexApprovalReviewer` must not run for Claude: gate it on `SOURCE === 'codex'` (`:2712`). |
| PermissionRequest | Codex | Unchanged (auto-review check, then `blocked`). |
| Stop | | `done` "Turn finished", plus `turn:{phase:"end", running?, workflows?}` (§2.3). Removes the session's `main` markers. Prunes local state. |
| SessionEnd | | Unchanged (`:2657-2675`), plus removal of the session's local directory: the DELETE is issued first, then the directory is removed, then both are awaited with `allSettled` (SessionEnd hooks share a 1.5 s budget). |

**Agent-tagged events.** "Known" is defined in §3.2.

| Event | Known agent | Unknown agent |
|---|---|---|
| SubagentStart | Repeated start (resume, a teammate's next message): post `planning` with the stored label; no launch claim. | First start: write the agent state (`seen`, kind, label per §3.5, a launch claim for Claude kind `agent`) **before** posting, then post `planning` with the label. If the state cannot be written, post nothing (the agent stays unknown). |
| PreToolUse | Class: `EDIT_TOOLS` (`:198`) give `coding`; `Bash` gives `testing` when `TEST_RE` matches the command (`:195`), else `coding`; `Agent`/`Task`/`WebSearch`/`WebFetch`/`Workflow` give `planning`. Activity: `describeEdit`/`describeBash`/`describeResearch`, or `Delegating: <description>` for `Agent`/`Task`, clipped to 80; minimal mode per §3.10. Posts under §3.4. Drops this agent's permission markers (§3.7). Tries `meta.json` (§3.5). A nested `Agent`/`Task` writes a launch record. | 1.6.3 path. |
| PermissionRequest | Claude: writes a marker for this agent; no post. Codex: auto-reviewed → nothing; otherwise post `state:"blocked"` with activity `tool_input.description \|\| message` (detail, clipped to 80) or per §3.10 (minimal), plus 1.6.3's `message` (§2.1). | Claude: nothing (no marker; a later Notification is then unattributed). Codex: 1.6.3 path. |
| SubagentStop | Post `state:"done"` unless the local state already confirms `done`. Holds for both agents; Codex fires it at the end of every sub-agent turn. Reads `meta.json` (always present by now) and sets kind `workflow` when `agent_transcript_path` contains `/subagents/workflows/`. Drops this agent's markers. | Nothing. |
| UserPromptSubmit | Codex sub-agent follow-up: `state:"planning"` under §3.4. (Claude subagents never fire it.) | Nothing. |

**Launch results (`handleLaunchResult`, Claude only).** The Agent tool's result schema is the union `completed | async_launched | remote_launched` plus the agent-teams `teammate_spawned` (binary: `$e([n,e,h])` and `{status:"teammate_spawned",…}`). None is a failure; a failed Agent call throws and surfaces as `PostToolUseFailure`. So **no `PostToolUse` ever produces a `failed` post.**

| Event | Condition | Action |
|---|---|---|
| PostToolUse, tool `Agent`/`Task` | `tool_response.status === "completed"` | Bind `tool_use_id` → `agentKey(tool_response.agentId)` (firm); consume the launch record. No post. |
| | `"async_launched"` | Bind firm; in detail mode take `tool_response.description` as a firm label: if the agent is known and its sent label differs, post a label update (§3.4); if it is not yet known, write `labels/<key>` for its `SubagentStart` (they run in the same millisecond, probe c). Consume the launch record. |
| | `"teammate_spawned"` | Bind firm to `agentKey(tool_response.agent_id \|\| tool_response.teammate_id)`. Consume the launch record. No post. |
| | `"remote_launched"` | Consume the unclaimed launch record (the agent runs remotely and fires no local hooks). No post. |
| | anything else, or no object | Nothing. |
| PostToolUse, tool `Workflow` | `tool_response.runId` matches `^wf_[A-Za-z0-9_-]{1,64}$` | Write `runs/<runId>.json` with the run directory: `path.join(dirname(transcript), session, 'subagents', 'workflows', runId)` (computed, never taken from `transcriptDir`). No post. |
| PostToolUseFailure, tool `Agent`/`Task` | | Resolve the agent from the binding for `tool_use_id` (firm or tentative). If it resolves to a known agent: post `state:"failed"`, activity `Stopped` when `is_interrupt === true`, else `Failed: <first line of error>` (detail, clipped to 80) or `Failed` (minimal). Consume the launch record either way. |

### 3.4 Flood control: when an agent post is sent

The owner's rule is to post a subagent only on start, stop and a change of status class. Per known agent:

- **Start** (`SubagentStart`): always post (when the state could be recorded). A start is never suppressed on the strength of racy state.
- **Running event** (PreToolUse, Codex PermissionRequest, a Notification-claimed block, a Codex follow-up `UserPromptSubmit`): post when the agent has no confirmed class (`cls` unset: its start post was never confirmed), or `newClass !== cls`, or the best label (§3.5) differs from the last confirmed label and fewer than `LABEL_POSTS_MAX` label-only posts were sent.
- **Terminal** (`done`/`failed`): post unless `cls` already equals that terminal state.
- **Confirmation.** `send()` returns whether the response was 2xx (§3.11). `cls` and the confirmed label are written **only after a 2xx**. A 429 or a timeout therefore leaves the next same-class event, or the task-notification after a lost `SubagentStop`, free to post again.
- **Compat status.** Running states send `status = state`. Terminal states send `status = cls` when it is `planning`/`coding`/`testing`, otherwise `planning`.

Main-thread posts are unchanged: every qualifying main-thread event still posts as today.

Server-side closes (expiry, reconciliation, reset; §4.4, §4.7) are not mirrored in local state, so a closed row comes back at its agent's next class change, or is counted at its stop. That is the documented cost of posting nothing within a class (§9.5).

### 3.5 Labels

Detail mode only. In minimal mode the hook reads none of these sources and never sends `label`. Every label is cleaned as in §2.5 and clipped to 64. Sources rank **firm** (`meta.json`, the `PostToolUse` result) above **tentative** (a launch claim); a firm label replaces a tentative one and is posted per §3.4.

| kind | Resolution |
|---|---|
| `agent` (Claude Agent tool, teammate, `/fork`) | 1. **`labels/<key>`**, written by `PostToolUse(async_launched)` if it landed first (firm). 2. **Tentative launch claim**, at the agent's FIRST `SubagentStart` only: the **oldest** unclaimed launch record of this session written in the last 10 s; write a tentative binding for its `toolUseId`. Never claim on a repeated start: resumes, teammate messages and `/fork` have no `PreToolUse(Agent)` of their own (hooks.md SubagentStart). 3. **`meta.json`**: `path.join(path.dirname(transcript), session, 'subagents', 'agent-' + agentId + '.meta.json')`, fields `description` and `toolUseId`. It is absent at SubagentStart and present by the first tool call (fact 11), and always present at SubagentStop. Try it at the first `META_TRIES` agent-tagged events after start, and at SubagentStop (via `dirname(agent_transcript_path)`). A `description` is a firm label; a `toolUseId` rewrites the binding firm. 112 of 400 sampled files hold no `description` (fact 23). 4. **`PostToolUse(async_launched).description`** (firm). 5. Nothing: the server shows `Subagent N`. |
| `workflow` | 1. **Active runs**: for each `runs/` record whose `journal.jsonl` mtime is at most 15 min old (newest first, at most 4), tail-read 64 KiB and parse only lines containing `"agentId":"<agent_id>"` with `type === "started"` (`label`, already on disk at SubagentStart, fact 19). Remember the `runId` in the agent state. 2. **No run record** (the `PostToolUse(Workflow)` hook races the first `SubagentStart`: 3-15 ms apart in probes e and e2): the bounded scan of `path.join(dirname(transcript), session, 'subagents', 'workflows')`: at most 64 entries matching `^wf_[A-Za-z0-9_-]{1,64}$`, journal mtime at most 15 min, newest 4, same 64 KiB tail. 3. **`meta.json`** at `<runDir>/agent-<agent_id>.meta.json`, field `description` (equal to the label), on the same tries as above. |
| `codex` | The sub-agent rollout's first line (`session_meta`) at `payload.transcript_path`: the sub-agent's own rollout on SubagentStart and PreToolUse, written before the hook runs (codex fact 7). Pass the path through `codexRolloutFromPath` (`:610-619`) first, then read it with the non-blocking discipline of §3.6. Accept it only if `payload.id === agent_id`. Take `agent_nickname`, else `source.subagent.thread_spawn.agent_nickname`, else the last segment of `agent_path`. |

**Kind.** A Claude agent is kind `workflow` when `agent_type === "workflow-subagent"`, when it is found in an active run's journal (step 1 above, tried whenever the session has run records), or when its `agent_transcript_path` lies under `/subagents/workflows/`. Otherwise `agent`. `agent_type` alone is not enough: 111 of the 362 sampled agents under `subagents/workflows/` are typed Explore, Plan or general-purpose (research fact 23), and a workflow agent classified `agent` would be closed at the parent's next `Stop` (§4.4).

**Why the oldest launch record.** Parallel Agent calls run their `PreToolUse` hooks concurrently (the Agent tool is `isConcurrencySafe(){return!0}`, binary), and this hook's main-thread `PreToolUse(Agent)` does a title read, host detection and a POST of up to 3 s before the agent can start. So `Pre A, Pre B, Start A` happens; probe a's strict order came from an 825 ms gap between the two calls. The first-launched call usually starts first, so the oldest pending record is the better guess; `meta.json` (keyed by `toolUseId`) corrects a wrong guess at the agent's first tool call, and the firm binding keeps `PostToolUseFailure` attribution right. Stale records are consumed by `PostToolUse`/`PostToolUseFailure` and expire after the 10 s claim window.

**Path safety.** `session` must pass `SESSION_ID_RE` and not be `.`/`..` (`:1555`, `:1707`) before it is joined into a path. A raw `agent_id` is used in a `meta.json` or journal path only when it matches `^[A-Za-z0-9_-]{1,128}$`; otherwise that source is skipped. A `runId` must match `^wf_[A-Za-z0-9_-]{1,64}$`. Every read is bounded (constants table).

### 3.6 Local state (new)

```
<os.tmpdir()>/agstatus-subtasks-<uid>-<key>/          0700   uid = process.getuid() (POSIX) or "w"; key = sha256(base + "\n" + SOURCE).hex[0..12]
  <sha256(session_id).hex[0..16]>/                    0700   created lazily, on the first write
    agents/<agentKey>.json                            0600   {"v":1,"seen":true,"kind","cls"?,"label"?,"labelSrc"?,"labelSent"?,"labelPosts","metaTries","runId"?,"at"}
    labels/<agentKey>.json                            0600   {"v":1,"label"}                         (from PostToolUse async_launched)
    launch/<sha256(toolUseId).hex[0..24]>.json        0600   {"v":1,"toolUseId","desc"?,"by","at"}    (by = agentKey of the launching agent, or "main")
    bind/<sha256(toolUseId).hex[0..24]>.json          0600   {"v":1,"agentKey","firm":bool}
    perm/<who>-<at>.json                              0600   {"v":1,"who","tool","act"?,"at"}          (who = agentKey or "main")
    runs/<runId>.json                                 0600   {"v":1,"runId","dir","at"}
```

**Why tmpdir, hardened.** The names map already lives in tmpdir (`:2443-2445`), and host.test.ts pins that the hook writes nothing under the Focus state directory when Focus is off (`cli/test/host.test.ts:276-289`). On macOS and Windows `os.tmpdir()` is per-user. On Linux it is the shared `/tmp`, where another local user can pre-create a directory with a predictable name, so:

- **Root check.** Create the root with `fs.mkdirSync(root, {mode: 0o700})`, non-recursive. On `EEXIST`, `fs.lstatSync(root)` must show a real directory (not a symlink) and, on POSIX, `st.uid === process.getuid()` and `(st.mode & 0o077) === 0`. Otherwise the hook runs **stateless** for this event: no agent is known, so every agent-tagged event takes the 1.6.3 path and `SubagentStart` posts nothing (§3.2). Below a verified root nobody else can create entries.
- **Reads.** Open every state file with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (each `|| 0` where undefined, as on Windows), `fstat` it, require `isFile()` and a size of at most 8 KiB, then parse. Anything missing, oversized, unparseable or of the wrong `v` reads as absent. Values read back (keys, `runId`, `toolUseId`) are validated again before they are used in a path or a post.
- **Writes.** A temp file named `<target>.<8 random hex>.tmp`, opened with flag `'wx'` (`O_CREAT|O_EXCL`) and mode `0o600`, written, then renamed over the target. Never the pid as the suffix (`:2523` uses it for the names map in sticky `/tmp`, which is safe there and not here).
- **Claims** are atomic renames: a launch record is claimed by renaming it from `launch/` into `bind/` under its own name, then rewritten with the agent key; a permission marker by renaming it to a name with a `c-` prefix, which no scan treats as a candidate. Any rename failure (`ENOENT`, `EPERM`) means another process won; try the next candidate.
- **Pruning.** On `SessionStart` and `Stop`, unlink entries past their age (constants table), judged by `lstat` mtime, never following links, examining at most 512 entries per subdirectory per run; remove sibling session directories older than 24 h, examining at most 64 per run, and only entries named `^[0-9a-f]{16}$` that `lstat` shows as real directories. `SessionEnd` removes the session's directory (`fs.rmSync(dir, {recursive: true, force: true})`, our own directory only). Codex never sends SessionEnd, so its directories age out.
- **Caps.** A full subdirectory (constants table) refuses new files of that kind. A refused `agents/` write leaves the agent unknown (1.6.3 path); a refused launch or marker write costs a label or an attribution, never a post.
- **One file per agent**, so parallel subagents (routinely 10, up to 30 at once) never lose each other's updates; the names map's read-modify-write race (`:2489`) does not apply. Two processes writing the same agent's file (a SubagentStop and its task-notification) write the same terminal state, so last-writer-wins is harmless.

This is local scratch of the same class as the names map. It is not backend data.

### 3.7 Permission attribution (Claude)

Facts:

- `PermissionRequest` fires at once and carries `agent_id` for a subagent (fact 17, run d2). It also fires, and auto-denies, for headless background subagents that no human sees.
- `Notification(permission_prompt)` fires about 6 s after a prompt appears, only while it is unanswered, **without** `agent_id`. Each queued prompt gets its own timer from its arrival (hooks.md Notification note). In terminal sessions each keystroke defers it.
- The terminal message names no tool: every permission dialog maps to `notification: vh`, `vh = {text: "Claude needs your permission"}` (binary). Only the SDK/`canUseTool` path (desktop, VS Code) sends `Claude needs your permission to use <Tool>`, 6 s after the request (`rPt=6000`), not deferred by typing.

Posting on `PermissionRequest` would push for prompts answered within a second and for prompts nobody saw, so:

1. **PermissionRequest (Claude)** writes `perm/<who>-<at>.json` with `tool = tool_name` and, in detail mode, `act` = `describeEdit`/`describeBash`/`describeResearch` for the tools they cover and the bare tool name for every other tool (never any other `tool_input` field), clipped to 72. It posts nothing.
2. **Progress drops markers.** A marker is answered once its thread moves on: an agent's markers are deleted at its next agent-tagged `PreToolUse` and at its `SubagentStop`; `main` markers at the next main-thread `PreToolUse` and at `Stop`. Markers older than 30 min are never candidates and age out.
3. **Notification(permission_prompt)** at time T:
   1. Candidates are unclaimed markers aged between 2 s and 30 min.
   2. If the message names a tool (`… to use <Tool>`) and some candidates have that tool, keep only those.
   3. Take the **oldest** (prompts notify in arrival order), and claim it by rename.
   4. A subagent marker gives an agent post with state `blocked`, activity `Approve: <act>` in detail mode (the Notification message when `act` is missing) or per §3.10 in minimal mode, plus 1.6.3's `message` (§2.1).
   5. A `main` marker gives today's main-thread `blocked` (hard: the main thread is asking).
   6. No marker gives today's main-thread `blocked` plus `unattributed: true`. This covers sandbox network prompts (they run no PermissionRequest hook, hooks.md:2079), failed marker writes, and the desktop path if PermissionRequest does not fire there (Appendix A, P2).

An unblock arrives with the agent's next class-change post or its stop: there is no "permission granted" hook. A long approved command keeps the row blocked until it ends (§9.5).

For Codex, `PermissionRequest` is immediate, as today, and agent-tagged when it comes from a sub-agent (§3.3).

### 3.8 Background agents and `<task-notification>` prompts

Facts (run c, probe excerpt `c_UserPromptSubmit_task_notification`):

- The parent's `Stop` fires while the subagent runs, with `background_tasks: [{id, type:"subagent", status:"running", …}]`. Then `SubagentStop` fires (+1.05 s), then a `UserPromptSubmit` whose prompt is a `<task-notification>` block (+0.1 s), then the parent's report turn, then a second `Stop` with `background_tasks: []` (+1.0 s).
- The block carries `<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>completed|failed|killed|blocked</status>`, `<summary>`, `<note>`, `<result>` (the agent's own final text) and `<usage>`. Its note: "the same task-id may notify more than once".
- In the desktop app it may arrive inside a `<system-reminder>` (Appendix A, P4).

Parsing (`parseTaskNotifications(prompt)`, a sibling of `stripHostNotices`, `:326-358`), with `indexOf`, never a regex, over at most the first 64 KB:

1. For each `<task-notification>` open (at most 8): its **head** runs from the open to the first `<result>` or `</task-notification>` after it, whichever comes first. Read `<task-id>`, `<status>` and `<summary>` (at most 200 characters) from the head only. **Never** read or send `<result>`. The next block is searched for after the head.
2. `userText := collapse(stripHostNotices(prompt with every bare block removed, each ending at the first close after its open))`.
3. **Notification-only** when either the prompt's first non-whitespace token, after skipping any leading `<system-reminder>` opens, is `<task-notification>`; or at least one block was found and `userText === ''`. The first rule keeps a result that quotes the close tag from turning the rest of the block into "user text" and resetting the tally.
4. Notification-only: the fixed main-thread post of §3.3, no `turn`. Otherwise: today's planning post with `userText`, plus `turn:{phase:"start"}`. A reminder-only prompt with no notification stays "Processing prompt", as today.

For each block whose `agentKey(task-id)` names a **known** agent (workflow task ids such as `wxtleurg3` never do):

| `<status>` | Agent post (unless local state already confirms that terminal state) |
|---|---|
| `completed` | `done` |
| `failed` | `failed`, activity `Failed: <reason from "failed: {error}" in the summary>` or `Failed` (minimal mode: `Failed`) |
| `killed` | `failed`, activity `Stopped` |
| `blocked` | `failed`, activity `Blocked` (meaning unknown; a finished worker is not running and must not raise the card) |
| anything else | `done` |

**Stop** sends `turn.running` and `turn.workflows` from `background_tasks` (§2.3). The server, not the hook, decides the "<n> subagents still running" and "Reading subagent results" lines (owner; §4.5).

### 3.9 Failure detection

`failed` comes from two sources only:

- `PostToolUseFailure(Agent|Task)` for a launch bound to a known agent.
- A `<task-notification>` whose `<status>` is not `completed`.

`SubagentStop` carries no outcome (fact 4), so the hook posts `done` there; a later `failed` for the same id corrects it on the server (§4.3). `PostToolUse(Agent)` is never a failure signal (§3.3). Whether failures surface through these channels is **unverified**: no probe observed one (Appendix A, P1). If none fires, failed subagents count as done, and the rows still leave. Workflow agents and Codex sub-agents have no failure signal at all.

### 3.10 Minimal mode (`MINIMAL`, `:278`)

| | Detail | Minimal |
|---|---|---|
| `agent.id` | agent key (hashed) | agent key (hashed). Raw ids can embed words of a `/fork` directive (binary `lkt()`: `Zm(allocateName(h(directive)))`, `h` keeps its first three words) or a teammate's name (`Zm(name)`), so they never leave the machine in either mode. |
| `label` | resolved per §3.5 | never sent (the server shows `Subagent N`) |
| `activity` (tool events) | description/command text, `Approve: …`, `Failed: …` | the tool name only if it is in the allowlist {`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `apply_patch`, `Bash`, `Agent`, `Task`, `WebSearch`, `WebFetch`, `Workflow`, `Read`, `Glob`, `Grep`, `Skill`}; otherwise `Needs approval` for a block. Fixed words `Failed`, `Stopped`, `Blocked`. MCP names (`mcp__<server>__<tool>`) never go out in minimal mode, as today (docs/hooks.md:278). |
| blocked agent post `message` | 1.6.3's text | 1.6.3's minimal text (`Needs input` / `Needs approval`) |
| launch record `desc` | stored | not stored (the record still links `tool_use_id` to the agent) |
| permission marker `act` | stored | not stored |
| `turn.running` | agent keys | agent keys |
| notification `<summary>` / `<result>` | summary used for the failure reason only | neither |
| `meta.json`, journal and Codex `session_meta` reads | yes | not performed |
| raw `agent_type` | never sent | never sent |
| `name` on agent posts | per §3.11 | per §3.11 (titles are off, `TITLES`, `:2300`) |

### 3.11 What stays the same, and shared helpers

- Main-thread bodies and their status mapping, apart from the fixes above.
- `name` and `project` logic for main-thread posts (`:2790-2826`), host detection on main-thread events, and the no-stdout rule.
- **`send()`** (`:398-414`) now returns `true` for a 2xx response and `false` for anything else, including a rejection, which it catches. Runs that send more than one request await them with `Promise.allSettled`, as the SessionEnd branch already does (`:2664-2667`); `main()`'s final `Promise.all` (`:2863`) becomes `allSettled`, so one failed POST no longer aborts the others in flight.
- **`lookupPinnedName(base, session, folder)`**, read-only (no transcript read, no write): with an entry from `loadSessionNames(sessionNameFile(base))` (`:2443-2482`), return `(TITLES && entry.title) || entry.name`, the same choice `pinnedName` makes (`:2633`); with no entry, or an entry that yields '', return `folder` when it is non-empty and not a UUID (`UUID_NAME_RE`), else `agentLabel()`. A title therefore never goes out in minimal mode, and a card an agent post creates is never named by its UUID.
- **`clip(s, max)`**: collapse whitespace, strip control characters, trim, remove unpaired surrogates, slice, drop a trailing high surrogate. Used for every label, activity, `act` and summary the hook sends.

The hook's own comments that become stale must be updated: the header (`:2-9`, the events), the Codex usage comment (`:2847-2852`), and the Stop comment (`:2770-2779`, `turn.end`).

---

## 4. Server behaviour

All subtask logic lives in a new pure module, `src/subtasks.ts`, with no I/O, so it can be unit-tested. `src/store.ts` and `src/app.ts` call into it.

### 4.1 Model

```ts
type LiveState = 'planning' | 'coding' | 'testing' | 'blocked';
type RowState = LiveState | 'failed';
type AgentState = LiveState | 'done' | 'failed';
type Kind = 'agent' | 'workflow' | 'codex';

interface Own {
  status: Status; message: string;
  soft?: { status: Status; message: string };   // set while own is a soft block: the reading to restore
}
interface SubtaskRow {
  id: string;            // AGENT_ID_RE
  n: number;             // ordinal ≥ 1, unique among rows at all times
  kind: Kind;
  state: RowState;
  label: string | null;  // ≤ 64; null → wire shows `Subagent ${n}`
  activity: string;      // ≤ 80, may be ''
  startedAt: number;     // server ms
  updatedAt: number;     // server ms of the last applied update (drives expiry)
  at: number;            // hook clock of the last applied update (ordering only)
}
interface SubtaskTomb {  // a finished id, for dedupe, counted-once and out-of-order protection
  id: string; at: number /* hook clock */; t: number /* server ms */; turn: number;
  o: 'd' | 'f' | 'x';    // done (counted), failed, closed without a count (expired / reconciled / reset)
  n: number;             // the row's ordinal, 0 when none was ever assigned
}
interface SubtaskState {
  v: 1;
  own: Own;
  turn: number;          // increments on turn start, reset and quiet end
  done: number;          // finished OK this turn (exact)
  failed: number;        // failed this turn (exact; can exceed listed failed rows)
  nextN: number;
  awaitReport: boolean;  // a Stop announced background work: a report turn will follow
  holdSince: number;     // server ms the report hold began, 0 when not holding
  rows: SubtaskRow[];    // ascending n
  tombs: SubtaskTomb[];  // ≤ 64, ≤ 2 h old (by t)
}
```

The in-memory `Session` gets an internal field, `sub?: SubtaskState | null`. It lives on the stored object, so every removal path drops it with the session. It must **never** be serialized directly. `withTokens` (`src/store.ts:1746-1749`) is replaced by `toWire(wsId, session)` at its three call sites: `getSession` (`:1815`), `getSessions` (`:1821`) and `upsertSession`'s return (`:1281`). `toWire` builds a fresh object from an explicit field list in today's key order (`id, name, status, message, project, source, host, createdAt, updatedAt`), then adds `tokens?` and then `subtasks?`. A card without subtasks therefore emits the same JSON as today. A test asserts that no outbound JSON contains `"own"`, `"tombs"`, `"nextN"`, `"awaitReport"` or `"holdSince"`.

### 4.2 Main-thread post (no `agent`)

```
ownMsg := input.message !== undefined ? input.message
        : prev?.sub ? prev.sub.own.message : prev?.message ?? ''
if sub:
  if input.status == 'blocked' and input.unattributed and liveCount(sub) > 0:
      prior := sub.own.soft ?? (sub.own.status != 'blocked' ? { status: sub.own.status, message: sub.own.message } : null)
      sub.own := prior ? { status: 'blocked', message: ownMsg, soft: prior } : { status: 'blocked', message: ownMsg }
  else:
      sub.own := { status: input.status, message: ownMsg }          // any main-thread post ends a soft block
  sub.awaitReport := false; sub.holdSince := 0                       // the parent spoke: no report hold
  if input.turn: applyTurn(sub, input.turn, now)                     // §4.4
```

- When `sub` is null, `status = input.status` and `message = ownMsg`: exactly today's literal (`src/store.ts:1221-1232`). With no live rows an unattributed block is a plain block (the main thread is the only thread).
- A soft block is cleared by the next agent post with a running state `planning`, `coding` or `testing` (§4.3): some thread made progress, so the prompt was answered. This keeps 1.6.3's behaviour, where the next subagent tool call cleared such a block, instead of leaving the card BLOCKED for the rest of a foreground subagent's run.
- `name`, `project`, `source` and `host` carry forward or set as today.

### 4.3 Agent post (`agent` present)

The top-level `status` and `message` are not applied to `own`. `project`, `source` and `host` carry forward or set as today. `name` is applied only when the post creates the card.

**No live card for the id** (`prev` undefined: never seen, dismissed, evicted, expired, deleted at SessionEnd):

- `done` or `failed`: **no upsert**. Answer `200 {"ok":true,"session":null}`; no broadcast, no push, no eviction. A finish has nothing live to show, and a card made from it would be a ghost no later post updates.
- A running state: create the card with `own = {status: 'idle', message: ''}` and `name` from the post (`input.name || input.id`). Never the compat status: a blocked agent then derives "Needs approval: <label>", and the card returns to own when the agent unblocks.

**A live card with no state** (`prev.sub` null): materialize `own = {status: prev.status, message: prev.message}` (without state, the stored reading IS own), `turn = 0`, `done = failed = 0`, `nextN = 1`, `awaitReport = false`, `holdSince = 0`, `rows = tombs = []`.

```
applyAgent(st, a, now, wsLive):                          // wsLive: live rows across the workspace
  row  := rows.find(id == a.id); tomb := tombs.find(id == a.id)
  if row and a.at < row.at: return                       // older than what we hold
  if !row and tomb and a.at <= tomb.at: return           // a late update for an agent that already finished
  if a.state ∈ {planning, coding, testing} and st.own.soft: st.own := st.own.soft   // progress ends a soft block (§4.2)

  if a.state ∈ LIVE:
    if row:
      if row.state == 'failed': st.failed := max(0, st.failed − 1)    // resumed after failing
      row.state := a.state; row.kind := a.kind ?? row.kind
      if a.label !== undefined: row.label := a.label
      if a.activity !== undefined: row.activity := a.activity
      row.at := a.at; row.updatedAt := now
    else:
      if liveCount(st) >= 48 or wsLive >= 256: return    // untracked; logged once per session
      n := (tomb and tomb.turn == st.turn and tomb.n >= 1 and no row has tomb.n) ? tomb.n : st.nextN++
      rows.push({ id, n, kind: a.kind ?? 'agent', state: a.state, label: a.label ?? null,
                  activity: a.activity ?? '', startedAt: now, updatedAt: now, at: a.at })   // keep ascending n
      // the tomb stays: it records whether this id was already counted this turn
    return

  counted := tomb and tomb.turn == st.turn and tomb.o == 'd'

  if a.state == 'done':
    if row and row.state == 'failed': return             // done after failed: a duplicate, ignore
    if !row and tomb and tomb.o ∈ {'d','f'}: tomb.at := max(tomb.at, a.at); return
        // already finished: a repeated task-notification. A NEW finish of the same id needs a running update first.
    // a row, a tomb 'x' (expired or reconciled while it really ran), or nothing known (its start post was lost):
    if row: remove row
    if !counted: st.done++                               // once per id per turn
    upsertTomb(id, at: a.at, t: now, turn: st.turn, o: 'd', n: row?.n ?? tomb?.n ?? 0)
    return

  // a.state == 'failed'
  if row and row.state == 'failed':
    row.activity := a.activity ?? row.activity; row.label := a.label ?? row.label
    row.at := a.at; row.updatedAt := now; return
  if !row and tomb and tomb.o == 'f': return             // already failed
  if !row and tomb and tomb.o == 'd' and tomb.turn != st.turn: return   // a late signal about a previous turn
  if counted: st.done := max(0, st.done − 1)             // correction: SubagentStop said done, a failure signal followed
  n := row?.n ?? (tomb and tomb.n >= 1 ? tomb.n : st.nextN++)
  remove live row if any
  rows.push({ id, n, kind: row?.kind ?? a.kind ?? 'agent', state: 'failed', label: a.label ?? row?.label ?? null,
              activity: a.activity || 'Failed', startedAt: row?.startedAt ?? now, updatedAt: now, at: a.at })
  st.failed++
  upsertTomb(id, at: a.at, t: now, turn: st.turn, o: 'f', n)
  keep at most 8 failed rows (drop the oldest by updatedAt; st.failed stays exact)
```

A finish for an id the server never saw running is counted: since 1.7.0 the hook only posts terminal states for agents whose start it recorded (§3.2), such a post means the start or its updates were lost (a 429, a restart), not an internal agent or a workflow task id.

**After every apply** (agent post, main-thread post, sweep):

1. Prune tombs older than 2 h by `t`, and keep the newest 64.
2. If `awaitReport` and no live rows and `holdSince == 0`, set `holdSince := now`; if live rows exist, set `holdSince := 0`.
3. Drop the state entirely (`sub = null`) when `rows` and `tombs` are empty, `done` and `failed` are zero, `awaitReport` is false and `own.soft` is absent. The stored status and message are then own again.

### 4.4 Turn phases

```
applyTurn(st, t, now):
  reset: close every live row as tomb 'x' (at = row.at, n = row.n); rows := []; done := 0; failed := 0
         turn++; nextN := 1; awaitReport := false; holdSince := 0
  start: rows := rows.filter(state != 'failed'); done := 0; failed := 0; turn++
         nextN := 1 + max(n of remaining rows, 0)      // keeps numbers unique while background rows carry over
         awaitReport := false; holdSince := 0
  end:   if Array.isArray(t.running):
           if t.workflows === 0:
             close every live row with kind 'agent' and state != 'blocked' whose id ∉ t.running, as tomb 'x' (at = row.at)
             close every live row with kind 'workflow' and state != 'blocked', as tomb 'x'
           awaitReport := (live rows remain) or (t.workflows > 0)
         else:
           awaitReport := false
         holdSince := 0
         if no live rows remain and not awaitReport: quietEnd(st)
  quietEnd(st): rows := []; done := 0; failed := 0; turn++; nextN := 1        // the turn is fully over: the tally goes with it
```

- **Reconciled closes are never counted**, so `done` stays exact rather than complete.
- **Blocked rows are never reconciled.** A pending approval disappears only through its own agent's posts or `BLOCKED_STALE_MS`. Nested agents under a background agent and teammates are not in `background_tasks` (§2.3) and must not lose a pending prompt.
- **Agent rows close only when no workflow runs** (`workflows === 0`): an agent missing from `running` may belong to a running workflow, whose agents are never listed individually (probe e: `[{"id":"wxtleurg3","type":"workflow",…}]`).
- At `Stop` every foreground subagent has finished, because a turn cannot end with a foreground Agent call pending. Codex `kind:"codex"` rows are never reconciled (Codex has no `background_tasks`); they close at each `SubagentStop`.
- **Quiet end increments `turn`.** Codex's done count therefore resets per root turn, and a re-tasked sub-agent finishing in a later turn is counted again (Codex fires `SubagentStop` per sub-agent turn; parents re-task often: 15 `followup_task` against 12 `spawn_agent` in one rollout, codex fact 11). Claude's next `start` increments again, which is harmless.
- **Tally lifecycle.** Done count and failed rows reset at `start` and at quiet end. A failed row stays listed while the turn runs, including after `Stop` while background agents run and during the report turn, and goes when the turn is fully over (prototype: the count "stays until the turn ends, and goes with it"; owner: "resets when the parent's turn ends / a new user prompt starts").
- **awaitReport.** A `Stop` that announced background work (Claude, `running` present) expects a report turn: Claude runs one after the last background task notifies (probes c, e). Codex `end` never sets it.

### 4.5 Derived wire status and message

Port of the prototype's `view()` with `bgstatus=busiest`, plus the report hold:

```
derive(st):
  live     := rows where state != 'failed'
  blocked  := live where state == 'blocked'               (ascending n)
  working  := live where state ∈ {planning, coding, testing}
  ownEnded := st.own.status ∈ {'done', 'idle'}
  holding  := ownEnded and st.awaitReport and st.holdSince > 0 and live.length == 0
  if st.own.status != 'blocked' and blocked.length > 0:
      status  := 'blocked'
      message := 'Needs approval: ' + labelOf(blocked[0]) + (blocked.length > 1 ? ' +' + (blocked.length − 1) : '')
  else if ownEnded and working.length > 0:
      status  := first of ['testing', 'coding', 'planning'] present in working
      message := working.length + (working.length == 1 ? ' subagent still running' : ' subagents still running')
  else if holding:
      status  := 'planning'; message := 'Reading subagent results'
  else:
      status  := st.own.status; message := st.own.message
  turnEnded := ownEnded and live.length > 0
  show      := rows.length > 0 or (st.done > 0 and (not ownEnded or holding))
labelOf(r) := r.label ?? 'Subagent ' + r.n
```

- Precedence (owner): a blocked subagent beats everything unless the parent is itself blocked, in which case the parent's own line is kept (prototype guard `s.status !== 'blocked'`). After that testing > coding > planning.
- `idle` counts as "turn ended" so that a card created by an agent post (own `idle`) or a mid-session `SessionStart` cannot hide live rows.
- **Report hold.** Between the last background finish and the report turn's first post (about 0.1 s in run c), and while a workflow announced at `Stop` has no agent live, the card says `planning` "Reading subagent results" instead of `done`, so the done push fires once, at the report turn's `Stop`. The hook's notification-only post (§3.3) carries the same line, so nothing flickers. If no main-thread post arrives within `REPORT_HOLD_MS`, the sweep releases the hold (§4.7).
- The stored `sessions.status` and `sessions.message` columns hold the **wire** values, the ones clients saw and history recorded.

### 4.6 Wire projection (`toWireSubtasks`)

When `show` is true, add `subtasks` to the session object; the shape is in §5. Then apply the size guard, each step only if the serialized `subtasks` still exceeds `WIRE_SUBTASKS_MAX_BYTES` (`Buffer.byteLength(JSON.stringify(subtasks))`):

1. clip every item's `activity` to 24 characters;
2. clip every `label` to 24;
3. set every `activity` to `''` and clip labels to 12.

Clips use the surrogate-safe clip of §2.5. With at most 56 items and 24-character ids, step 3 always fits (about 120 bytes an item with multibyte labels, 6.7 KB in all). The guard never drops an item or changes a count. Typical payloads (30 items, ASCII) are about 4.6 KB and are never clipped.

### 4.7 The subtask sweep

`Store.sweepSubtasks(now)` runs every `SUBTASK_SWEEP_MS` from `app.ts`, on its own `unref`'d interval in **both** modes. It must not hang off `sessionTtlMs`, which is 0 in legacy mode (`src/config.ts:152`, `src/app.ts:1308`). For every session with state:

- close working rows whose `updatedAt` is older than `LIVE_STALE_MS` and blocked rows older than `BLOCKED_STALE_MS`, as tombs `'x'` with `at = row.at`, not counted (a later post from the agent, with a newer hook clock, resurrects it; a later `done` is counted);
- drop failed rows older than `BLOCKED_STALE_MS`;
- release a hold: when `awaitReport` and `holdSince > 0` and `now − holdSince > REPORT_HOLD_MS`, set `awaitReport := false`, `holdSince := 0` and apply `quietEnd`;
- reset an idle tally: with no live rows and no `awaitReport`, when the newest `row.updatedAt` or `tomb.t` is older than `BLOCKED_STALE_MS`, apply `quietEnd`;
- run the after-apply steps of §4.3.

For each session that changed: derive; write the derived status and message; set `updatedAt := prev.updatedAt + 1` (it wins a REST tie on every client, `public/app.js:386`, `SessionStore.swift:386`, `SessionStore.kt:309`, without reordering the grid or resetting "12m ago"); record a history event when the history key changed (§4.10); persist; then `app.ts` broadcasts one `session` frame and calls `pusher.notifyTransition(wsId, session, prevWireStatus)`. Every sweep change moves toward less activity, so the only push it can cause is a `done` push, for a card that really became done.

Silence is not a liveness signal: subagents post nothing within a class, and a reviewer's replay of the class-change rule over 3,093 subagent transcripts (60 days) found 20.4% with a gap over 10 min, 3.1% over 30 min and 0.6% over 60 min. `LIVE_STALE_MS` bounds zombie rows (lost stops with no reconciliation) at the price of closing that 0.6% early; they come back at their next class change or are counted at their stop. Clients never dim a card with live rows (§6.1).

### 4.8 Lifecycle of the parent

| Event | Subtask effect |
|---|---|
| `Stop` (`turn.end`) | §4.4 |
| `SessionStart` (`turn.reset`) | §4.4. Covers `--resume` in a new process. |
| SessionEnd (hook `DELETE /sessions/:id`), dismiss, eviction at the 50-card cap, 24 h TTL, clear, workspace delete | The session object leaves memory with its `sub`. The row is **flagged** (`deleted_at`), and the `subtasks` column is kept like every other column (`src/store.ts:1241-1250`, `:1826-1849`, `:2139-2161`). Nothing is blanked or removed. |
| A running agent post for a flagged id (revival) | Creates the card fresh (§4.3); the upsert overwrites the column as it overwrites `status` and `message` today (`ON CONFLICT … deleted_at = NULL`, `:1261-1280`). A terminal agent post never revives. |
| Codex sub-agents never send SessionEnd (codex fact 8) | Rows close at each SubagentStop. Zombies go by expiry. |

### 4.9 Push

No code change in `src/push.ts`, which contains literal NUL bytes at `:107` and is not to be edited. `upsertSession` additionally returns `newlyBlocked`; `handleWebhook` calls `pusher.notifyTransition(wsId, session, newlyBlocked ? null : prevStatus)`.

```
newlyBlocked := wire status after == 'blocked' and
                ( (blocked row ids after) − (blocked row ids before) ≠ ∅
                  or (own.status after == 'blocked' and own.status before != 'blocked') )
```

A `null` previous status with a `blocked` status pushes (`push.ts:93`); the existing 60 s debounce per (workspace, session, kind) still caps bursts.

| Situation | Push |
|---|---|
| Wire status moves into `blocked` | Pushed to all devices, as for any blocked session. Body: the wire message, "Needs approval: <label>" (`:146`); `Subagent N` in minimal mode. |
| Another subagent (or the parent) starts waiting while the card is already BLOCKED | Pushed again (newlyBlocked), unless within 60 s of the previous blocked push for that card. In 1.6.3 the next subagent tool call flipped the card out of blocked and re-armed the push; in 1.7.0 a row stays blocked until its agent's next class change, so without this a second approval would never be pushed. The body names the first blocked subagent in start order plus `+N`. |
| Approval | The blocked row's next post clears it. With no blocked rows left, the wire returns to own, WORKING (busiest) or the hold. No push. |
| `done` | Pushed to `notify_done` devices only when the wire status becomes `done` (`:96`): a turn ending with nothing live and nothing to report, the report turn's `Stop`, or a sweep release. While background subagents run after `Stop` the wire says the busiest class, and between their finish and the report turn it says `planning`, so there is no premature done push. |
| Subagent churn (starts, stops, class changes) | Changes rows, not the wire status, so no push, except the blocked and end-of-work transitions above. |

### 4.10 History

**Decision: record nothing per subagent.** The condition at `src/store.ts:1258` compares a history key instead of the raw status and message:

```ts
const RUNNING_RE = /^\d+ subagents? still running$/;
const historyKey = (status: string, message: string) =>
  RUNNING_RE.test(message) ? 'running' : `${status}\u0000${message}`;
// record when !prev || historyKey(prev.status, prev.message) !== historyKey(session.status, session.message)
```

Write the separator as the escape sequence `\u0000` in source, never a literal NUL byte (see `push.ts`). The same rule applies to sweep changes.

Why: every recorded event is a permanent row and trims are flagged, never removed (`:1786-1792`); a 629-subagent session would add at least 1,258 rows if starts and finishes were recorded, and push the parent's own story out of its 100-event window (`MAX_EVENTS_PER_SESSION`, `:419`). Today the parent's 100 events cover roughly 40-60 s at peak subagent rates (model fact 16).

What does record: entering the after-turn reading once (for example `testing · 3 subagents still running`; later count or busiest-class changes do not record), the hold (`planning · Reading subagent results`), blocked readings ("Needs approval: X", "Needs approval: X +1"), and the final `done`.

### 4.11 Persistence

- **Schema.** Add `subtasks TEXT` to `CREATE TABLE sessions` (`:669-682`) and `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS subtasks TEXT` beside the `host` ALTER (`:744`). It must be nullable: `scripts/migrate-sqlite-to-postgres.js:89` inserts without it. It is a column, not a table, so `test/helpers.ts:108-111`, `test/flag-flood-rows.test.ts` and `scripts/flag-flood-rows.sql` need no change.
- **Format.** Compact JSON, `NULL` when there is no state:

  ```
  {"v":1,"savedAt":<session.updatedAt>,
   "own":[status,message,softStatus|null,softMessage|null],
   "turn":n,"done":n,"failed":n,"nextN":n,"await":0|1,"hold":ms,
   "rows":[[id,n,kind,state,label|null,activity,startedAt,updatedAt,at],…],
   "tombs":[[id,at,t,turn,o,n],…]}
  ```

  `kind` is `"a"`/`"w"`/`"c"`; `state` is `"p"`/`"c"`/`"t"`/`"b"`/`"f"`; `o` is `"d"`/`"f"`/`"x"`. Bound: 56 rows and 64 tombs are about 22 KB with ASCII text and about 43 KB with CJK text; typical states are 1-3 KB.
- **Write.** The upsert (`:1261-1280`) adds `subtasks` to the column list, to `VALUES` as `$11`, and `subtasks = EXCLUDED.subtasks` to `ON CONFLICT … SET`. Memory stays authoritative and the write queue stays ordered (`:1079`).
- **Load** (`:779-805`). Replace `SELECT *` with an explicit column list that reads the column as `CASE WHEN length(subtasks) <= 65536 THEN subtasks END AS subtasks`, so an oversized value is never shipped to the process (the store's own reasoning at `:829-833`). Then, beside the `host` parse:
  - a parse failure, a wrong shape, or `savedAt !== Number(row.updated_at)` loads as **no state**. The `savedAt` check catches a rollback: a 1.6.3 server writes `status`, `message` and `updated_at` but never touches `subtasks`, so a stale state would otherwise come back on the next 1.7.0 deploy;
  - `normalizeSubtaskState` rebuilds the state entry by entry and re-applies every cap and enum (56 rows of which at most 48 live, 64 tombs, `n` unique and ≥ 1 for rows, strings clipped); malformed entries are dropped one by one; an invalid `own` means no state;
  - when no state loads and the stored message is a derived one (starts with `Needs approval: `, matches `RUNNING_RE`, or equals `Reading subagent results`), load the session as `status: 'idle'`, `message: ''`, so a derived reading never poses as the parent's own.
- **Restarts.** Every push to master restarts production (`:758-760`). Rows, the tally, the ordinals, the hold and a soft block survive; expiry clocks continue from the stored `updatedAt`.
- **Never hard-delete.** No path blanks or removes the column (§4.8).

### 4.12 Size, rate, SSE, memory

| Concern | Bound |
|---|---|
| Body | Agent posts are under 1 KB, far below the 16 KB body limit (`src/app.ts:323`). |
| Frame | At most 8 KB of `subtasks` per session (§4.6); typical under 2 KB. |
| Snapshot | At most 50 cards × (8 KB + about 1.5 KB) ≈ 475 KB, under the 1,000,000-byte stream cap (`:229`). Legacy mode has no card cap, as today. |
| Agent frames | Throttled per session: an agent post broadcasts at once when its wire status changed or no frame for that session went out in the last `AGENT_FRAME_THROTTLE_MS`; otherwise one trailing frame goes out `AGENT_FRAME_THROTTLE_MS` after the last one, carrying the then-current session. Any other broadcast for the session (main-thread post, sweep, token totals, removal) cancels a pending trailing frame. The webhook response and the push decision are never deferred. A 10-agent burst inside a second becomes at most 4 frames. |
| Outbound per post | At most one frame of about 9.5 KB to each of up to 15 streams (10 viewers, 5 listeners; `docs/api.md:651`, `:660`) against about 1.5 KB today. |
| Broadcast rate | Bounded by the existing 120 posts/min/workspace limit (`src/store.ts:426`) in multi-tenant mode with `rateLimit` on; legacy mode and `rateLimit: false` have no webhook limit, as today, and rely on the agent-frame throttle. |
| Write per post | The whole `sessions` row is rewritten on every webhook (`:1261-1280`), now with the column: at most about 22 KB with ASCII text and 43 KB with CJK text, 1-3 KB typical. |
| Memory per board | At most 256 live rows across a board plus 8 failed rows and 64 tombs per session: about 0.7 MB of heap for a pathological 50-card board (rows about 500 B each in V8, tombs about 120 B). Record this allowance beside the per-board reasoning at `src/store.ts:495-505`, which `MAX_WORKSPACES` is sized against. |
| Budget | Per subagent about 3-5 posts (start, 1-2 class changes, maybe a label, stop) against about 22 today (one per tool call, §3.1). A 30-agent burst is about 60 posts in its first minute (a start and a first class change each): fine for one session, but the 120-a-minute window is per workspace and shared across sessions, machines and the usage endpoints, so two concurrent bursts can still overflow it. Lost posts are healed by §3.4 confirmation, `Stop` reconciliation and expiry. |
| `GET /api/sessions`, snapshot, `session` frames, webhook response | All go through `toWire`, so they carry the same `subtasks`. `GET /api/config` still advertises the six statuses (`:1266`). |

---

## 5. Session JSON for clients

`subtasks` is optional. It is **absent** when there is nothing to show. Clients must treat absent, `null`, a non-object, or `items:[]` with `done:0` as "no subtasks", which means today's card.

```json
{
  "id": "5cef7152-ef68-481f-8a4f-463f66702bf9",
  "name": "Session organization by agent",
  "status": "blocked",
  "message": "Needs approval: verify:hook",
  "project": "claude-status",
  "source": "claude",
  "host": null,
  "createdAt": 1793138000000,
  "updatedAt": 1793138693838,
  "tokens": 1100000,
  "subtasks": {
    "turnEnded": false,
    "running": 9,
    "blocked": 1,
    "failed": 0,
    "done": 15,
    "items": [
      { "id": "3f9c1e07b2d4a85c6e1f0a92", "n": 3, "label": "review:hook",     "state": "testing", "activity": "Run hook tests with --no-file-parallelism" },
      { "id": "a0d5b8e1c2f34a6b7d8e9f01", "n": 4, "label": "review:listener", "state": "coding",  "activity": "Editing listener.ts" },
      { "id": "9b2e7c4d1a0f3e5b6c8d7a90", "n": 9, "label": "verify:hook",     "state": "blocked", "activity": "Approve: Run the hook suite" }
    ]
  }
}
```

(The example shows 3 of the 10 items.)

| Field | Type | Invariant |
|---|---|---|
| `turnEnded` | boolean | True ⇔ the parent's own turn is over (own status `done` or `idle`) **and** at least one subagent is live. Clients use it for WORKING (§6.1). |
| `running` | int ≥ 0 | The exact count of items in `planning`, `coding` or `testing`. Every live subagent is listed. |
| `blocked` | int ≥ 0 | The exact count of items in `blocked`. |
| `failed` | int ≥ 0 | Failed this turn. It is ≥ the number of `failed` items, and equal unless more than 8 failed. |
| `done` | int ≥ 0 | Finished OK this turn. It only climbs within a turn, except for the one correction case (§4.3, a `failed` arriving moments after `done`). It resets when the turn is fully over or a new user prompt starts. |
| `items` | array | Live and failed rows, **ascending `n` = start order**. At most 56. `n` is unique, ≥ 1, and stable per subagent. |
| `items[].id` | string | Matches `^[A-Za-z0-9._:-]{1,64}$` (24 lowercase hex from 1.7.0 hooks; may start with a digit). Opaque. Safe in a quoted attribute selector. |
| `items[].n` | int | The ordinal. `Subagent N` labels use it. |
| `items[].label` | string | Non-empty, at most 64 characters. The server substitutes `Subagent <n>` when no label is known, always in minimal mode. |
| `items[].state` | string | One of `planning`, `coding`, `testing`, `blocked`, `failed`, and no others. `researching` is never sent. |
| `items[].activity` | string | At most 80 characters. May be `''`. |

Client decoders must be tolerant **per element**: a malformed item is dropped and the others kept; an unknown `state` maps to `planning` and the item is kept; a missing or malformed count falls back to the count derived from `items` (0 for `done`). Both native clients decode a snapshot as one array (`SSEClient.swift:167`, `SseClient.kt:97`), so one throw would drop the whole board.

`status` is always one of the six. `failed` and `working` never appear as a session status, in frames or in history. During a report hold the session reads `planning` / "Reading subagent results" and `turnEnded` is false.

---

## 6. Client behaviour (common to web, iOS, Android)

### 6.1 Display status and WORKING

```
display(s) := (s.subtasks?.turnEnded && s.status != 'blocked' && s.subtasks.running > 0) ? 'working' : s.status
```

| Aspect | Rule |
|---|---|
| Mark | `working`: a branch, from the prototype path at `subtasks.html:1561-1563`; SF Symbol `arrow.triangle.branch` is the nearest on iOS; on Android, port the path as an `ImageVector`. `failed` (row only): a crossed circle, prototype `:1552-1554`; SF `xmark.circle`; on Android, port the path. |
| Colour tokens | `--st-working: var(--st-coding)`, so WORKING has coding's colour, surface and edge exactly (iOS `0x78B2DB` / surface `0x1D2525` / edge `0x475E69`). `--st-failed: oklch(from var(--st-blocked) 72% 0.06 h)`, sRGB `#C89790` (iOS `0xC89790`, Android `0xFFC89790`), each written with its OKLCH origin, as the token conventions require. |
| Word | Lowercase `working` wherever the client prints status words (web badge). iOS and Android use their existing capitalisation convention. |
| Card tint, edge, badge, edge lift | All read the display status. |
| Stale dimming | The 10-minute rule on `updatedAt` (web `public/app.js:5-8`, `:322-325` and the 15 s timer at `:872-878`; iOS `SessionCardView.swift:25`, `:65-66`; Android `SessionCard.kt:82`) applies to `working` like the other active statuses, **except that a card with `subtasks.running > 0` is never dimmed**. Subagents post nothing within a status class (§3.4), so a live subagent can stay silent for many minutes; the server's `LIVE_STALE_MS` expiry is the liveness authority (§4.7). |
| Message | The wire message ("<n> subagents still running"). |

### 6.2 Show rule

Clients show the subtask block exactly when `subtasks` is present and passes the tolerance check (§5). The server already applies the prototype's `show` rule.

### 6.3 Slots and `pick()`

The owner's rule: **oldest, slot-stable**. Each client keeps a per-card ledger outside the session object, because every frame replaces the session whole:

- web: a `Map` (`public/app.js:733` replaces the object);
- iOS: `BoardView` `@State`, next to `sides` (`BoardView.swift:20`);
- Android: a `SessionStore` `StateFlow`.

The ledger resets when the card's slot count changes, and is dropped when the card has no subtasks.

```
// ledger: { slots: Int, shown: [id] } or nil.  items: subtasks.items (start order).
pick(ledger, items, slots, open) -> (ledger', rows):
  live := map id → item
  L := ledger
  if L == nil or L.slots != slots:                                     // first drawing
    B := first `slots` items with state == blocked                     (start order)
    R := first (slots − |B|) items with state != blocked               (start order)
    L := { slots, shown: ids of items in B ∪ R, in start order }
  if open:                                                             // expanded in place (never under phone rules)
    kept := L.shown filtered to ids present in live
    L.shown := kept ++ ids of the other items in start order
    return (L, L.shown → items)
  at := the first `slots` entries of L.shown, each replaced by nil when absent from live   // a finished row leaves a hole in ITS slot
  for x in items (start order) where x.state == blocked and x.id ∉ at:                    // a blocked subagent always takes a slot
    i := index of the first nil in at
    if none and |at| < slots: i := |at|                                // append
    if none: i := the HIGHEST index j with live[at[j]].state != blocked   // the bottom-most slot whose row is not blocked
    if i exists: at[i] := x.id                                         // the displaced row goes hidden
  hidden := items whose id ∉ at                                         (start order)
  for i in 0 ..< slots while hidden not empty:
    if i == |at|: append nil
    if at[i] == nil: at[i] := hidden.removeFirst().id                  // the next hidden row takes a freed slot IN PLACE
  L.shown := at with nils removed                                      // a slot nothing could take closes
  return (L, L.shown → items)
```

Consequences, matching the prototype's AUDITED notes:

- A row keeps its slot until it finishes, whatever its state does; an approved row keeps its slot; a displaced row returns only into a slot freed by a finish.
- Opening the list keeps the rows on show where they are and adds the rest below. Folding keeps the first `slots`.
- Failed rows are ordinary non-blocked rows: blocked rows can displace them, and they free their slot when the tally resets.
- **`pick` must be idempotent**: `pick(L', items, slots, open)` returns `(L', rows)` again. iOS resolves it purely in `body` and stores it in `onChange`, as `CardSides` does (`BoardLayout.swift:280`, `BoardView.swift:136-143`).
- **Expanded state** follows the prototype: a card stays expanded until the reader folds it (the footer is a control only while `items.length > slots`, but the flag is kept, so a list that shrinks and grows again stays open). It is dropped when the card loses its `subtasks` block or leaves the board.

### 6.4 Card layout and rows

The order, from the prototype (`cardHTML` and `webCardHTML`): name and status → message (the wire message) → **rows** → **footer** → meta → Focus rail. Rows sit under one hairline in the card's edge colour: no box, no fill, no card inside the card. A card without a subtask block is unchanged in markup and view tree.

| | iOS / Android | Web |
|---|---|---|
| Row content | label (≤ 58% of the row's text width) · activity (fills the rest) · state mark and word (trailing) | state mark and word **leading**, in a 76 px column under the badge's mark · label · activity |
| Row height | 28 pt/dp minimum | 26 px minimum |
| Type | label 13 pt weight 500 in text-2 (text-1 when blocked); activity 13 pt in text-3; state 11 pt regular in text-3; mark 11 pt in the state colour; a blocked row's word in the state colour | prototype `.w-card .sub*` (subtasks.html:1395-1406) |
| Tap | A row opens the session screen at that subtask. The footer opens the session screen when it navigates (§6.5). | same |
| Meta line | iOS moves it under the footer whenever the subtask block shows (`show`, including the count-only "12 done" state), out of the content column's tap target (`SessionCardView.swift:124-213`). Its facts stay in the card's combined accessibility label (§6.9). Android keeps today's order (meta after the footer). | Stays where it is (after the subtasks block). |

**Web grid.** While at least one card shows a subtask block, `#grid` gets the class `has-subs`, and `board.css` sets `#grid.has-subs { align-items: start; }`, so cards beside a taller card keep their own height instead of stretching (prototype FOUND note). A board with no subtask block anywhere keeps today's stretched rows and bottom-aligned Focus rails exactly. `landing.html` (which loads `card.css` but not `board.css`) is untouched.

### 6.5 Footer

This ports `footHTML` with the owner's expanded copy.

```
total := |items|; hidden := total − |rows|; done := subtasks.done
more := hidden > 0 ? "+{hidden} more" : ""
dn   := done > 0 ? "{done} done" : ""
text := non-empty of [more, dn] joined by " · "
phoneRules and hidden > 0              → control: navigate to the session screen (no subtask); text + chevron-right
!phoneRules and open and total > slots → control (aria-expanded=true): "Show less" + (dn ? " · " + dn : ""); chevron-up
!phoneRules and hidden > 0             → control (aria-expanded=false): text; chevron-down
text != ""                             → plain text, not a control
otherwise                              → no footer
```

Phone rules apply on iOS exactly when `plan.arrangement == .narrow`, on any device (by measured width, never size class, `BoardLayout.swift:97-156`: an iPad in Split View at 646 pt is a phone; an iPhone in landscape that fits two columns is not), on the web at `(max-width: 560px)`, and on Android always.

### 6.6 Session screen

Port of `screenInnerHTML` and `screenHTML`, and the owner's phone-screen decision. When `subtasks` is present, the screen shows a **Subtasks** section above the timeline.

| Element | Rule |
|---|---|
| Header | "Subtasks" plus counts from the wire: `[running → "running", blocked → "blocked", failed → "failed"]`, non-zero parts only, joined by " · ". Example: "9 running · 1 blocked · 1 failed". |
| List | Blocked items first (start order), then the rest in start order (failed items included). Roomy rows: two lines on a phone (label 15 pt, then activity), 52 pt tall. On wide screens the state leads in an 80 pt column (prototype `.sub.is-roomy`, `:1060-1090`). Rows here are **not controls** (the prototype ignores row taps on this screen, `:2598`): plain list items. |
| Done line | `"{done} done this turn"` when `done > 0`. |
| Timeline heading | When the Subtasks section shows, the timeline below it gets the heading "Timeline" (prototype `screenHTML`, `:2173`, `:2184`). |
| Independence | The section is painted from the live session, independently of the history fetch: it shows while history is loading, empty ("No history yet") or failed. The empty and error states apply to the timeline part only (today they replace the whole screen: web `public/app.js:1135-1153`, iOS `SessionCardView.swift:730`, Android `HistoryScreen.kt:138-146`; Android's `history()` and iOS's decoder both turn failures into an empty list). |
| Arrival | Opened from a row: scroll the row to the centre, move keyboard focus (web) and VoiceOver/TalkBack focus (native) to it, and light its ground (ink-850) for 2 s, then let it go out. It fades, or goes at once with reduced motion. It is not lit again by a later redraw. If the subtask is gone on arrival, open at the top with no highlight. |
| Live updates | The section re-renders from the live session on every frame and must not steal focus. |
| Timeline | Server history, the six statuses. The screen's status capsule or badge uses the display status. The newest timeline row may read `testing · 2 subagents still running` while the capsule says WORKING: history records the wire status, and WORKING is a reading of the live card only (no synthesized "current" event). |
| History refetch (native) | iOS (`SessionCardView.swift:743`) and Android (`HistoryScreen.kt:90`) refetch history when the session's `(status, message)` change, no longer on every `updatedAt`: agent posts bump `updatedAt` often, and history records only status and message transitions. |

### 6.7 Stats strip (web only)

The strip counts **display** statuses. The slots are idle · planning · coding · testing · **working** · blocked · done. The `working` slot appears **only while at least one card is WORKING**, as the prototype does (`:2124-2125`) and its AUDITED note says ("so the strip still sums to the board"). The strip therefore changes shape only when a card enters or leaves WORKING, which is news; otherwise the six slots stay put. Update both comments that state the six-slot rule: `public/app.js:217-225` and `public/shell.css:67-70`.

### 6.8 Motion

- A row moves only when it starts, finishes or gets blocked (owner). Activity, label and ordinary class changes (planning ↔ coding ↔ testing) are written in place.
- Nothing loops. All of it is instant under `prefers-reduced-motion` / Reduce Motion / Android reduced motion.

| Change | Motion (prototype `:960-992`) |
|---|---|
| Row starts (a new id on show) | `row-in`: fade from −3 px, `--d-mid` 220 ms |
| Row becomes blocked, stops being blocked, or becomes failed | The state cell re-enters, `--d-slow` 420 ms. No other state change animates. |
| Count changes (`more`, `done`) | `tick`, 220 ms |
| Row leaves | Fade out 220 ms. If no row takes its slot, the slot height collapses over 200 ms. |
| Card display status changes | The existing `changed` edge lift (`public/board.css:224-230`) |

**Web rule.** The web repaints a card's whole `innerHTML` when its markup string changes (`public/app.js:117-128`, `:327-330`). The markup that `patchCard` compares and paints is **motion-free**. Motion classes (`.sub.entering`, `.sub.changed`, `.n.ticked`) are added with `classList` to the newly created nodes right after a repaint, from the per-card memory's diff of previous and current row ids, states and counts computed in the same render, and removed on `animationend`/`animationcancel`. A frame for another card therefore neither repaints this card nor replays its motion. The web may skip the leave fade in 1.7.0 (a leaving row disappears and its heir fades in) but must do enter, blocked/failed state change and tick. Keyframes go into the existing motion block in `public/board.css`, which the global reduced-motion block covers (`:232-240`). No Web Animations: the test harness has no `matchMedia` or `Element.animate`.

### 6.9 Accessibility

- The rows container is a group labelled "Subagents" (web `role="group" aria-label="Subagents"`).
- Each card row is a real button. Its accessible name is `"{label}, {state}: {activity}"`, or `"{label}, {state}"` when the activity is empty.
- The footer, when a control: web `<button aria-expanded>` for expand. Under phone rules the visible text is the name plus the hint "Opens the session screen" (iOS `accessibilityHint`, Android `onClickLabel`).
- The card's own combined label keeps today's content, using the display status word, **including the meta facts** (machine, project, time, tokens) on iOS even when the meta line is drawn under the footer; the relocated meta line itself is hidden from accessibility so it is not read twice.
- Session-screen subtask rows are non-interactive list items (web: no button; `tabindex="-1"` on the arrived row only, for focus).
- On arrival, focus moves to the arrived row: web `focus()`, iOS `AccessibilityFocusState`, Android an accessibility focus request on the item.
- State is never carried by hue alone: every row has a mark and a word, and blocked has a solid mark (`public/marks.js:46-48`).
- Web focus survives repaints. `focusKey` (`public/app.js:107-114`) gains `[data-sub="<id>"]`, after checking the id against `^[A-Za-z0-9._:-]{1,64}$` (keys can start with a digit, so `SAFE` is not reused), and `[data-foot="<session id>"]`.
- Web focus return: closing the session screen returns focus to the control that opened it: the footer (`[data-foot]`), the row (`[data-sub]`), else the title (`[data-open]`), falling back to the title when the opener is gone (`public/app.js:1181-1209`).

### 6.10 Minimal mode

Labels arrive as `Subagent N` from the server; activities are tool names or fixed words. Clients do nothing differently.

### 6.11 Older servers and malformed data

With no `subtasks`, clients draw today's card. A malformed `subtasks` is treated as absent, and malformed items are dropped individually (§5). It never fails the session or the snapshot.

### 6.12 Copy (identical on all clients, pinned by copy tests)

| Key | Text |
|---|---|
| more | `+{N} more` |
| done | `{M} done` |
| separator | ` · ` (U+00B7 with spaces) |
| expanded footer | `Show less` / `Show less · {M} done` |
| session header counts | `{r} running · {b} blocked · {f} failed` (non-zero parts) |
| session done line | `{M} done this turn` |
| session timeline heading | `Timeline` |
| row state words | `planning`, `coding`, `testing`, `blocked`, `failed` |
| card word | `working` |
| server: blocked | `Needs approval: {label}` / `Needs approval: {label} +{k}` |
| server: after turn | `1 subagent still running` / `{n} subagents still running` |
| server and hook: report hold | `Reading subagent results` |
| server: fallback label | `Subagent {n}` |
| hook: Codex prompt | `Processing prompt` |
| row a11y | `{label}, {state}: {activity}` |

---

## 7. Per-layer implementation notes

### 7.1 Hook (base `origin/master`)

`cli/assets/agstatus-hook.js`, then `npm run sync:plugin`:

1. Constants: `AGENT_ID_MAX_CHARS`, `LABEL_MAX`, `ACTIVITY_MAX`, the claim and marker windows, `LABEL_POSTS_MAX`, `META_TRIES`, the local-state caps and ages, the read caps, the minimal-mode tool allowlist.
2. Helpers:
   - `agentKey(base, session, agentId)`, `clip(s, max)`;
   - `subtaskRoot(base)` (create-and-verify, §3.6), `sessionDir(root, session)`;
   - `readStateFile` (O_NOFOLLOW|O_NONBLOCK, fstat, 8 KiB) and `writeStateFile` (`'wx'` random temp, rename);
   - `readAgent`, `writeAgent`, `writeLaunch`, `claimOldestLaunch(dir, now)`, `bindToolUse(dir, toolUseId, key, firm)`, `resolveToolUse(dir, toolUseId)`, `consumeLaunch(dir, toolUseId)`;
   - `writePermMarker`, `dropPermMarkers(dir, who)`, `claimPermMarker(dir, now, message)`;
   - `writeRun`, `activeRuns(dir, now)`;
   - `pruneSubtaskState(root, dir, now)`, `forgetSubtaskState(root, session)`.
3. Label readers, all non-blocking and bounded: `readAgentMeta(path)` → `{description, toolUseId}`; `readWorkflowLabel(runs, scanDir, agentId)` → `{label, runId}`; `readCodexAgentMeta(file, agentId)` → `{nickname, agentPath}` (through `codexRolloutFromPath`).
4. `parseTaskNotifications(prompt)` → `{notificationOnly, userText, notes: [{id, status, summary}]}`.
5. `lookupPinnedName(base, session, folder)` (§3.11).
6. `agentBody(...)`, `handleAgentStart`, `handleAgentEvent`, `handleLaunchResult`.
7. `send()` returns a boolean (§3.11); every multi-request run uses `Promise.allSettled`.
8. `main()`:
   - routing (§3.2), including the 1.6.3 path with host detection off for agent-tagged events;
   - `SessionStart` compact skip and reset hint;
   - `Notification` type table, marker claim, `unattributed`;
   - `PermissionRequest`: Claude marker, `codexApprovalReviewer` gated to Codex;
   - `UserPromptSubmit`: notification parse, the fixed notification-only post, the start hint, the Codex branch;
   - `PreToolUse`: the `Agent`/`Task` fix, `Workflow`, launch records, `main` marker drops;
   - `Stop` end hint; `SessionEnd` DELETE then directory removal;
   - usage and project reports also on Codex agent-tagged PreToolUse.
9. Update the stale comments (§3.11).
10. Registration and installer:
    - `cli/src/settings.ts` `HOOK_EVENTS` (11 entries with `timeout`, §3.1) and `mergeSettings` writing `timeout`; `plugin/hooks/hooks.json` mirrors them;
    - `cli/src/codex.ts` `CODEX_EVENTS` (+3) and `codexAddedEvents`;
    - `cli/src/index.ts`: the `setupCodex` notice (`:128-150`), and the init disclosure text (`:268-276`), which must now also say that subagent task descriptions and workflow labels are sent in detail mode, and that `--minimal` sends "Subagent N" and tool names instead.

### 7.2 Server (base `origin/master`)

1. **New `src/subtasks.ts`:**
   - types (§4.1) and constants;
   - `parseAgent(raw): AgentUpdate | undefined | 'invalid'`, `parseTurn(raw): TurnHint | undefined`, `cleanLabel(v, max)`, `safeClip(s, max)`;
   - `normalizeSubtaskState(raw, updatedAt)`, `serializeSubtaskState(st, savedAt)`;
   - `materialize(prev)`, `applyMain`, `applyAgent`, `applyTurn`, `quietEnd`, `afterApply(st, now)`, `sweepState(st, now)`;
   - `derive(st)`, `toWireSubtasks(st)` (with the byte guard), `isEmpty(st)`, `blockedIds(st)`, `historyKey(status, message)`.
2. **`src/store.ts`:**
   - `Session.sub?` (internal); `UpsertInput.agent?`, `turn?`, `unattributed?`;
   - `upsertSession` per §4.2-4.5: own carry-forward, the no-card rules for agent posts (return `session: null` for a terminal post), the derived status and message written into the literal at `:1221-1232`, `sub` carried explicitly, `newlyBlocked` in the return value, the per-workspace live-row count;
   - the history condition at `:1258` uses `historyKey`;
   - SQL at `:1261-1280`, schema at `:669-682` and `:744`, load at `:779-805` (explicit column list with the `CASE` guard, `savedAt`, derived-message reset);
   - `toWire` replaces `withTokens` (`:1746-1749`, called at `:1281`, `:1815`, `:1821`);
   - `sweepSubtasks(now): Array<{wsId, session, prevStatus}>`;
   - the per-board allowance note beside `:495-505`.
3. **`src/app.ts`:**
   - `clean()` surrogate-safe (§2.5);
   - in `handleWebhook`, after the host check (`:392-398`): parse `agent` (400 on `'invalid'`), `turn` and `unattributed`, and pass them in `UpsertInput` (`:399-407`); a `session: null` result answers `{ok: true, session: null}` with no broadcast and no push; otherwise broadcast (agent posts through the throttle of §4.12) and call `notifyTransition(wsId, session, newlyBlocked ? null : prevStatus)`;
   - the agent-frame throttle: per (workspace, session) last-sent time and one pending timer, cancelled by any other broadcast of that session, by its removal and at shutdown;
   - a new interval: `store.sweepSubtasks(Date.now())`, then broadcast and `notifyTransition` per change, beside the TTL sweep (`:1308-1316`), unconditional, `unref`'d, added to `timers`.
4. `src/push.ts` and `src/config.ts`: no change.

### 7.3 Web (base `origin/master`)

| File | Changes |
|---|---|
| `public/app.js` | Constants `DISPLAY_STATUSES = [...STATUSES, 'working']`, `ROW_STATES`, `PHONE_QUERY = '(max-width: 560px)'`. `display(s)`; `statusClass` and `stateMark` accept the display statuses (`:83-84`); `ACTIVE_STATUSES` adds `working` (`:5`); the stale toggle (`:322-325`) and the 15 s timer (`:872-878`) skip cards with `subtasks.running > 0`. `subsHTML(s)`, `subRowHTML`, `footHTML` and `pick` (§6.3-6.5); a per-card memory `subs: Map<id, {ledger, rowStates, counts}>` and `expanded: Set<id>`, pruned beside `pruneFocus` (`:538-543`), in the `remove` handler (`:738-743`) and in `dismissSession` (`:392-407`). `cardInner` inserts the block between the message and `cardMeta` (`:300-302`); its markup is motion-free and motion classes are applied after paint (§6.8). `renderGrid` toggles `#grid.has-subs`. `patchCard` keys the class, edge lift, stale timer and `dataset.status` on the display status (`:305-326`). `renderStats` counts display statuses with the conditional `working` slot (`:226-233`); update its comment (`:217-225`). Click delegation for `[data-foot]` and `[data-sub]` (`:645-671`), recording the opener for focus return. Phone rules are guarded by `typeof window.matchMedia === 'function'` (wide when absent) and re-rendered on change. The route regex becomes `/^#session\/([A-Za-z0-9._:-]{1,128})(?:\/([A-Za-z0-9._:-]{1,64}))?$/` (`:1179`); `applyRoute` passes the subtask and returns focus per §6.9 (`:1181-1209`). `renderSession` always emits `<section id="dv-subs">` (possibly empty) between `dv-head` and the timeline, a "Timeline" heading when the section has content, and keeps the loading, empty and error states inside the timeline part (`:1127-1153`); arriving at a subtask focuses the row instead of Back. The SSE `session` handler repaints only `#dv-subs` through `paint()` when that id is open (`:731-736`). The arrival highlight uses a 2 s timer. |
| `public/marks.js` | `STATE_MARK.working` and `STATE_MARK.failed` from the prototype paths (`:49-61`). They become available to `landing.html` too, which is harmless. |
| `public/tokens.css` | `--st-working` and `--st-failed` after the six (`:102-112`). |
| `public/card.css` | `.card.status-working { --state: var(--st-working); }` (beside `:48-53`). A derived `--rule: color-mix(in oklab, var(--ink-800) 62%, var(--state))` on `.card`, used by the existing border and by `.subs`. `.subs`, `.sub`, `.sub.st-*`, `.sub-text`, `.sub-label` (max-width 58%), `.sub-act`, `.sub-st`, `.sub-foot`, `.foot-sep`, `.n`, ported from prototype `:824-959`, with the web overrides from `:1395-1406`. |
| `public/board.css` | Keyframes `row-in` and `tick`, and the `.sub.entering`, `.sub.changed .sub-st` and `.n.ticked` rules, inside the motion block (`:205-230`). `#grid.has-subs { align-items: start; }`. |
| `public/shell.css` | `.dot.status-working` (`:106-111`); update the six-slot comment (`:67-70`); session-screen `.dv-subs`, `.ss-label`, `.ss-count`, `.sub.is-roomy`, `.is-arrived`, `.is-settled`, `.ss-done` (prototype `:997-1108`, `:1409-1431`). |
| `public/index.html` | `#detail`'s `aria-label` becomes "Detail" (`:35`). |

### 7.4 iOS (base `claude/session-organization-agents-c27901`)

1. **`Models.swift`**
   - `SubtaskState` enum (`planning`, `coding`, `testing`, `blocked`, `failed`; unknown → `.planning`).
   - `Subtask` (`id`, `n`, `label`, `state`, `activity`; Identifiable, Equatable, Codable, Sendable).
   - `Subtasks` (`turnEnded`, `running`, `blocked`, `failed`, `done`, `items`).
   - `Session.subtasks: Subtasks?`: CodingKeys gain `subtasks` (`:93-95`); `init(from:)` decodes with `try?` and lossy per-element items, deriving missing counts (`:99-122`); the memberwise init gains a defaulted parameter (`:71-91`).
   - `DisplayStatus`, `Session.displayStatus` (§6.1), and `Session.isStaleExempt` (`subtasks?.running ?? 0 > 0`).
2. **`Theme.swift`**: overloads of `color`, `cardSurface`, `cardEdge` and `symbol` for `DisplayStatus` (`working` = coding's values plus `arrow.triangle.branch`). Failed `0xC89790` / `xmark.circle`, with its OKLCH origin in a comment (`:88-140`, `:229-238`).
3. **`BoardLayout.swift`**: `struct SubtaskSlots` beside `CardSides` (`:253`), pure and idempotent: `resolved(for: [Session], slots: Int, expanded: Set<String>) -> SubtaskSlots` and `rows(for:)`. Add assert cases to `BoardArrangement.verify()` (`:369`).
4. **`BoardView.swift`**:
   - `@State var subtaskSlots` and `@State var expandedSubtasks` next to `sides` (`:20`), resolved in body and stored via `onChange` (`:136-143`);
   - slots 2 and a navigating footer exactly when `plan.arrangement == .narrow`, else 3 and expand in place, on every device; passed to cards through environment keys (precedent `cardsSwipeToDismiss`, `:502`);
   - `struct SessionRoute: Hashable { sessionId; subtaskId? }` replaces the `String` destination (`:78`) and the `openSession` closure type (`:81`; `SessionCardView.swift:688-704`);
   - the DEBUG hook `AGSTATUS_OPEN_HISTORY` (`:222-230`) appends a `SessionRoute`; new DEBUG hooks `AGSTATUS_OPEN_SUBTASK=<n>` and `AGSTATUS_EXPAND_SUBTASKS=1`, because `simctl` cannot tap.
5. **`SessionCardView.swift`**:
   - rows, footer and the relocated meta line (whenever `show`) between `HStack{content, rail}` and `FocusStatusLine` (`:82-92`);
   - a custom `Layout` for the 58% label cap;
   - the rail badge, `statusColor`, `stale` (with the exemption), surface and edge read `displayStatus` (`:25-27`, `:65-66`, `:105`, `:110`, `:421-432`);
   - the content column's combined accessibility label keeps the meta facts when the meta line moves; the relocated line is `accessibilityHidden`;
   - `SessionHistoryView`: the subtasks section rendered outside the `events.isEmpty && loaded` branch (`:730`), so it shows with an empty or failed history; a "Timeline" heading when it shows; rows non-interactive; a `ScrollViewReader` arrival with `AccessibilityFocusState` and a highlight using `Theme.raised` (skipped when `DemoData.isFrozen`; precedent `BoardView.fadeRing`); `onChange` of `(status, message)` instead of `updatedAt` (`:743`); the header capsule uses `displayStatus` (`:793-812`).
6. **`SessionStore.swift`**: `noteBeat` (`:768-777`) keeps the beat and its baseline across frames where `status` and `message` are unchanged: keep `statusSince[id]`, set in `.upsert` when the status changes, and use it instead of `old.updatedDate`.
7. **`DemoData.swift`**: scenarios `subtasks`, `subtasks-ten`, `subtasks-thirty`, `subtasks-blocked`, `subtasks-failed`, `subtasks-background`, `subtasks-minimal`, `subtasks-codex` and `subtasks-long`, mirroring the prototype's `SCENARIOS` (`:1669-1763`) and documented in the Scenario comment (`:367-381`); the tick changes subtasks only by start, finish or block; `verifySubtaskDecoding()`, called from `startDemo` (`:804-820`).
8. **New file `SubtaskRows.swift`** (the row, footer and session-section views), registered in `project.pbxproj` with ids `A10000000000000000000016` and `B10000000000000000000018`.
9. The app version moves only for a store build (release mechanics).

### 7.5 Android (base `origin/master`)

1. **`Models.kt`**:
   - `@Serializable(with = SubtasksSerializer::class) val subtasks: Subtasks? = null` on `Session`;
   - `SubtasksSerializer` decodes a `JsonElement` and turns null, a wrong type or a malformed value into `null`, dropping bad items and deriving missing counts (precedent `SessionHostSerializer`, `:137-155`); `AgStatusJson` has no `coerceInputValues` (`Api.kt:62-65`), so an explicit `"subtasks": null` must be handled here;
   - `SubtaskState` with an unknown → `PLANNING` fallback (precedent `AgentStatusSerializer`, `:52-61`);
   - `DisplayStatus` and `Session.displayStatus`.
2. **`Theme.kt`**: `colorFor`, `iconFor`, `cardSurface` and `cardEdge` for `DisplayStatus` (`:133-198`). Working uses coding's values plus the ported branch `ImageVector`; failed is `Color(0xFFC89790)` plus the ported crossed-circle `ImageVector`.
3. **New `SubtaskSlots.kt`**: the pure `pick` in an `object`, unit-testable like `SessionStore.stableOrder` (`SessionStore.kt:684-690`).
4. **`SessionStore.kt`**: a `StateFlow<Map<String, SubtaskLedger>>` updated in Snapshot and Upsert (`:191-215`), cleared in `adopt`, `disconnectBoard` and `stopDemo` (`:106-128`, `:637-645`). `LazyColumn` drops `remember` state for off-screen items, hence the ViewModel.
5. **New `ui/SubtaskRows.kt`**, and **`ui/SessionCard.kt`**: rows (2) and the footer after the message (`:127-135`), before `MetaLine` (`:137`); `FocusFooter` stays last. Rows are clickable children with their own semantics inside the merged card node (`:88`). `StatusMark` (`:124`) and `stale` (`:82`, with the exemption) use the display status.
6. **`MainActivity.kt`**: `Route.HISTORY = "history/{sessionId}?subtask={subtask}"` with a nullable argument (`:131`, `:135`, `:198-207`), and the debug extra `agstatus_open_subtask` (`:57`). In **`ui/BoardScreen.kt`**, `onOpenHistory` becomes `(sessionId, subtaskId?)` (`:89`, `:266-268`).
7. **`ui/HistoryScreen.kt`**: the subtask items and counts rendered from the live session outside the `loaded && events.isEmpty()` branch (`:138-146`), so they show with an empty or failed history; a "Timeline" heading item when they show; items keyed by subtask id, non-clickable; `LazyListState` scroll plus a 2 s highlight (instant when `rememberReduceMotion()`) and an accessibility focus request on arrival; refetch on `(status, message)` (`:90`); the badge uses the display status (`:194`).
8. **`DemoData.kt`**: one session with subtasks in `initialSessions` (`:22-77`). The tick must not re-stamp subtasks except on start, finish or block.

### 7.6 Docs (base `origin/master`)

| File | Changes |
|---|---|
| `docs/api.md` | Session object: `subtasks`, modelled on the `tokens` paragraph (`:14-51`). Webhook table (`:61-95`): `agent`, `turn` and `unattributed`; what `status` and `message` mean on an agent post; the `{ok: true, session: null}` answer to a terminal agent post for a card that does not exist. Session history: the running-reading rule (`:311-334`). SSE: frames carry `subtasks`, agent frames are throttled to one per 250 ms per session (`:580-641`). Limits: subtask caps (48 live per card, 256 per board, 8 failed listed, 8 KB guard, expiry at 60 min and 6 h, the 120 s report hold) (`:644-683`). Fix the stale line about scrubbing `host` (`:79`). |
| `docs/hooks.md` | The event mapping (`:192-219`): replace the `Task` row (`:208`) with `Agent`/`Task`/`Workflow`; add rows for SubagentStart, SubagentStop, PermissionRequest (Claude: attribution only), PostToolUse/PostToolUseFailure, the Notification type table, the SessionStart compact skip, Stop with background work, the notification-only prompt and Codex UserPromptSubmit. Minimal-mode text (`:216-218`): hashed agent keys, "Subagent N", the tool-name allowlist. "What each status means": WORKING and `failed` are client readings, never sent (`:283-292`). Codex events wired, plus the trust notice (`:823-824`). |
| `docs/privacy.md` **and** `public/privacy.html` | The same edits in both, with the same "Last updated" date (`docs/privacy.md:3-10`: "if you change one, change both, and keep the dates equal"; `/privacy` serves the HTML copy, `src/app.ts:332-333`). Stored fields (`docs/privacy.md:39-47`, `privacy.html:90-97`): in detail mode, subagent task descriptions, workflow labels, Codex nicknames and task paths, and activity lines including `Approve: …` and `Failed: …`; in minimal mode only "Subagent N", allowlisted tool names, opaque agent keys, states and counts. A label can appear in the card line, the timeline (as permanent flagged rows) and push bodies. Push (`docs/privacy.md:137-145`, `privacy.html:174-177`): a notification can carry the server-composed "Needs approval: <label>". Retention (`:161-178`): flagged with the card, never removed. |
| `public/landing.html` | "What it sends" (`:693-697`): subagent descriptions in detail mode; numbered subagents in `--minimal`. |
| `README.md` | The privacy-switch bullet (`:90-92`): `--minimal` also numbers subagents instead of describing them. |
| `public/docs.html` | Generated with `npm run build:docs`; never hand-edited (`public/docs.html:2`). |
| Release notes and manifests | `docs/release-notes/v1.7.0.md`, plus the four manifests (§9.1). |

---

## 8. Test plan

### 8.1 Hook (`cli/test`, `cd cli && npx vitest run`; CI uses `--testTimeout 30000 --hookTimeout 30000` after a root build, `.github/workflows/ci.yml:62-63`)

New file `cli/test/subtasks.test.ts`.

**Harness.** Copy the capture server and `fire()` from `cli/test/codex-approval.test.ts:104-120`, which records the URL and body of every request; let the capture server answer a configurable status (200 by default, 429 on demand). Each test gets its own `HOME`, `TMPDIR` and `AGSTATUS_STATE_DIR`, plus `AGSTATUS_USAGE=off`. Payloads come from `subtasks/probe/payload-excerpts.json`, saved as `cli/test/fixtures/subtasks/*.json`, with transcript paths rewritten to a temp project dir.

Cases:

1. **G1-G21** exactly (`at` checked as a positive integer, keys computed with `crypto`).
2. **Flood control.** SubagentStart → Bash → Edit → Edit → Bash(test) → Edit gives exactly 4 agent posts (start, coding, testing, coding).
3. **Confirmation.** The capture server answers 429 to a class-change post: the next same-class event posts again. It answers 429 to a SubagentStop: the task-notification for that agent posts `done`.
4. **Unknown agents.** An agent-tagged PreToolUse with no prior SubagentStart gives today's main-thread body without `host` (G20); a SubagentStop or task-notification for it gives nothing; a Codex agent PermissionRequest for it gives today's Codex blocked body.
5. **Unusable ids.** `agent_id` of 300 characters, or a number: no request, and no main-thread post.
6. **Labels:**
   - a `meta.json` fixture at `<dir>/<session>/subagents/agent-<id>.meta.json` with a different description gives exactly one label correction;
   - overlap: Pre A, Pre B, Start A, Start B with `meta.json` files naming each agent's `toolUseId`: the tentative labels go oldest-first and a swapped pair is corrected at each agent's first tool event; `PostToolUseFailure` for B's `tool_use_id` then fails B, not A;
   - `PostToolUse(async_launched)` before its `SubagentStart` gives the start post the result's description;
   - a repeated `SubagentStart` for a known agent claims no launch record (a pending record for another launch survives for its own start);
   - `PostToolUse(Workflow)` then a workflow `SubagentStart` reads the run's journal; with no run record, the bounded scan finds it; an agent typed `Explore` found in a run's journal is posted with `kind:"workflow"`.
7. **Launch results.** `remote_launched`, `teammate_spawned` and `completed` never post `failed`; `remote_launched` consumes the record, so a `SubagentStart` 1 s later claims nothing.
8. **Minimal mode.** No `label`, description, journal label, nickname, summary text, raw `agent_id` or `mcp__` name appears in **any** body (assert by substring on the serialized bodies); activities are allowlisted tool names or fixed words; a pinned title in the names file never appears as `name` (pre-seed `{name, title}`, set `AGSTATUS_DETAIL=off`).
9. **Permissions.**
   - A `main` marker then a Notification gives today's main-thread `blocked`, no `unattributed`.
   - Two subagent markers (A older than B), no tool in the message: A is claimed. With "… to use Edit" and only B's tool `Edit`: B is claimed.
   - A's marker, then an agent-tagged PreToolUse from A (progress), then a Notification: A's marker is not a candidate; with no other marker the post carries `unattributed: true`.
   - No marker, live agents: `unattributed: true` (G21).
   - An auto-denied background PermissionRequest with no Notification gives no request.
   - The Claude PermissionRequest never touches `CODEX_HOME`: run the hook with `node --require <preload>` where the preload wraps `fs.readdirSync`, `fs.statSync` and `fs.openSync` and records every path under `CODEX_HOME` to a file; assert the record is empty.
10. **Notification types.** Each ignored type gives no request; `idle_prompt` and an absent type give `blocked`; the elicitation types carry `unattributed: true`.
11. **Task notifications.** Bare and `<system-reminder>`-wrapped notification-only prompts give only the fixed planning post; a notification plus user text gives a planning post with `turn.start` and the user text only; a `<result>` that quotes `</task-notification>` followed by text is still notification-only; `killed` gives `failed`/`Stopped`; `completed` with state already `done` gives no agent post; a workflow task id gives no agent post.
12. **Stop.** `background_tasks` with a subagent, a shell, a workflow and a teammate gives `running` = [K(subagent)] and `workflows` = 1. An absent array gives no lists. 65 subagent entries, or one with a numeric id, give no lists.
13. **Codex.** `AGSTATUS_SOURCE=codex`, a sub-agent rollout fixture whose first line is `session_meta` with `agent_nickname`, `agent_path`, `parent_thread_id` and `source.subagent.thread_spawn.depth`. Fire root UserPromptSubmit (G19), SubagentStart, an agent PreToolUse, an agent PermissionRequest (auto-review and not), SubagentStop with `agent_transcript_path`, then an agent PreToolUse again (follow-up). Check the posts; check that usage reports still run on agent-tagged PreToolUse; check (Focus on) that **no host record** under `AGSTATUS_STATE_DIR` contains the sub-agent's thread id.
14. **Concurrency.** `spawn` (not `execFileSync`) 20 SubagentStart processes for distinct ids at once, then 20 SubagentStop: exactly 20 start posts and 20 stop posts arrive.
15. **Local state safety.** Files are 0600 and directories 0700 (POSIX). A pre-created root that is 0777, owned by root, or a symlink makes the hook stateless (agent events take the 1.6.3 path, no files written through it). A symlink planted at a temp name is not written through (`'wx'`). A FIFO planted as an agent file does not hang the hook (it finishes well under the 4 s safety exit). SessionEnd removes the session directory after issuing the DELETE. Ageing via `utimes` removes `launch/` files over 10 min, `perm/` over 30 min, others over 24 h.
16. **`allSettled`.** A notification prompt producing 3 posts where the server resets the connection for one: the other two still arrive.
17. **`SessionStart` compact** gives no request.

Existing tests to update:

- `messages.test.ts:161-177`: `Task` → `Agent` cases, keeping one `Task` case.
- `plugin.test.ts`: parity of events, matchers and `timeout`.
- `settings.test.ts`: the new entries, matchers and timeouts.
- `codex.test.ts:41-52`: seven events, plus `codexAddedEvents`.
- `e2e.test.ts:142-144`: the 11 event names.
- `host.test.ts`: agent-tagged events never write or alter host records; the existing "writes nothing when focus is not configured" tests still pass (subtask state lives in `TMPDIR`).
- `codex-approval.test.ts`: the reviewer still runs for Codex.

Plus one **cross-layer e2e**: real `agstatus init` and the real `dist/server.js`. Fire G1 → G2 → G3 → G5 → G7 and assert the server's `GET /api/sessions` `subtasks` and wire status at each step. This needs the server package merged.

### 8.2 Server (root, `npx vitest run --no-file-parallelism`; CI adds Postgres via `TEST_DATABASE_URL`)

1. **`test/subtasks-model.test.ts`** (pure `src/subtasks.ts`), table-driven over §4.2-4.7:
   - out-of-order (`done` at t5, then `coding` at t4: ignored);
   - Codex follow-up within a turn (start, coding, done, coding (newer), done: one done, the same `n`), and across turns (a quiet `end`, then the follow-up finishes: counted again);
   - a repeated `done` for an already-finished id with no running update between: ignored;
   - a `failed` about a previous turn's finish: ignored;
   - a `done` after an expiry (`'x'`): counted once; a `done` for a never-seen id: counted, no row;
   - correction (`done` then `failed`: done −1, failed +1, a failed row with the posted label); resume after failed;
   - `n` uniqueness across turns, never 0;
   - the 48-live cap and the 256-per-workspace cap (the next row is untracked); 8 failed rows listed while the count is exact;
   - soft block: an unattributed block with live rows becomes soft, a running agent post restores own, a blocked agent post does not, a main-thread post replaces it; with no live rows it is hard;
   - reconciliation: a blocked agent row survives `end`; an agent row not in `running` survives while `workflows > 0` and closes when `workflows === 0`; a workflow row survives `workflows: 1`;
   - hold: `end` with live rows sets `awaitReport`; the last finish starts the hold (`planning` "Reading subagent results", `show` with the done count); a main-thread post ends it; `end` with `workflows: 1` and no live rows holds at once;
   - quiet end increments `turn` and resets `nextN`;
   - the byte guard (56 items with 4-byte characters stay ≤ 8,192 bytes, steps apply in order, counts untouched);
   - `normalizeSubtaskState` on malformed, oversized and mismatched-`savedAt` input; `historyKey`; `cleanLabel`/`safeClip` with an emoji straddling 64, 80, 24 and 12.
2. **`test/subtasks.test.ts`** (supertest, `makeApp()`):
   - **S1 (foreground pair):** turn start → `Agent` main post → A start → B start → A coding → B coding → A done → B done → Stop(end, running []). After the B coding step: status `planning`, message "Run echo beta", `subtasks` `{turnEnded:false, running:2, blocked:0, failed:0, done:0, items:[A n1, B n2]}`. After B done: `subtasks` `{running:0, done:2, items:[]}`. After Stop: status `done` "Turn finished", no `subtasks` key.
   - **S2 (background):** Stop with `running:[X]` gives `coding` "1 subagent still running" and `turnEnded:true`. X done gives `planning` "Reading subagent results". The notification-only planning post keeps that reading. The report turn's Stop (`running: []`) gives `done` "Turn finished" and no `subtasks` key.
   - **S3 (blocked):** Y blocked gives `blocked` "Needs approval: verify:hook". Then Z blocked (lower `n`) gives "Needs approval: <Z> +1", following start order. Then Y testing, then Z coding gives back own.
   - **S4 (failed lifecycle):** a failed row persists through `Stop` while a background row lives, through the hold and the report turn, and goes at the quiet `Stop`.
   - **S5 minimal:** "Subagent 1".
   - **S6 ghost cards:** a `done` agent post for an unknown session answers `{ok:true, session:null}`, creates no card and evicts nothing at the 50-card cap; dismiss, then a blocked agent post, recreates the card with "Needs approval: …" and own `idle`; a later coding post clears blocked.
   - **S7 soft block:** Notification-style main `blocked` with `unattributed:true` while a row is live; the row's next coding post returns the card to its prior reading.
   - **S9 reconcile**, **S10 reset**, **S11 sweep** (spy `Date.now`, call `sweepSubtasks`): 61 min closes a working row, 6 h a blocked row and a failed row, 121 s releases a hold; `updatedAt` moves by exactly 1; a history event records when the reading changes.
   - **Validation:** a malformed `agent` gives 400; `agent: null` is a main-thread post; a malformed `turn` is ignored with a 200; an `at` of `1e300` is replaced; an agent post with `message` does not change own; `name` on an agent post renames only a card it creates.
   - **Compat:** a post without `agent` on a card with no state returns the JSON keys in today's order with no `subtasks`; every wire status is in `STATUSES`; no outbound JSON contains `own`, `tombs`, `nextN`, `awaitReport` or `holdSince`; a message with a lone surrogate in the post comes back well-formed.
   - **Throttle:** five agent posts within 100 ms produce at most 2 `session` frames, the last carrying all five changes; a main-thread post in between is broadcast at once.
   - **Legacy mode:** `makeApp({multiTenant:false})`.
3. **`test/push.test.ts`** (mock APNs, `:48-94`):
   - a blocked subagent pushes once, body "Needs approval: <label>", `aps` keys unchanged;
   - A blocked (push), then B blocked 90 s later while A is still blocked: a second push;
   - B blocked 30 s after A's push: debounced;
   - no done push at `Stop` while a background row runs, none when it finishes (hold), exactly one at the report turn's `Stop`;
   - a hold released by the sweep pushes `done` once; a row expiry that leaves the card active does not push.
4. **`test/sse.test.ts`:** a `session` frame carries `subtasks`; a snapshot of 50 maximal cards stays under 1,000,000 bytes; with 10 viewers and 5 listeners open, one accepted agent post writes at most 15 × (8,192 + 2,048) bytes in total.
5. **`test/persistence.test.ts` (Postgres):**
   - subtasks, the tally, the ordinals, a hold and a soft block survive a restart;
   - a malformed column, an oversized column (the `CASE` guard), or a `savedAt` that differs from `updated_at` loads as no state; with a derived stored message the session loads as `idle` / '';
   - soft deletes keep the column on the flagged row;
   - a database whose `sessions` table lacks the column gains it at boot (precedent `:139-178`).
6. **`test/history.test.ts`:** a 30-agent drain after `Stop`, with busiest-class flips during the drain, records exactly 3 events after the first `done`: the running reading, the hold, the final `done`.

### 8.3 Web

**Harness.** Extract `loadBoard` from `test/review-fixes.test.ts:151-194` into `test/board-harness.ts`, or add a `describe` block in place. Add an optional `matchMedia` stub.

Assertions (jsdom, fake SSE frames, fixtures from §5):

- A card without `subtasks` has the same markup as today (snapshot against the 1.6.3 markup); a board without subtask blocks has no `has-subs` class on `#grid`, and gains it when one card shows a block.
- At most 3 `.sub` rows with stable `data-sub`, and the footer text "+N more · M done".
- A finish frame gives the next hidden row the same `data-slot`; the others keep theirs.
- A hidden blocked subagent takes the bottom-most non-blocked slot; an approved row stays in its slot.
- `turnEnded` gives `status-working`, the badge word `working`, `.changed`, and a stats-strip `working` slot that disappears again.
- A WORKING card whose `updatedAt` is 20 min old is not `stale`; the same card without live rows is.
- A failed row stays until a quiet `Stop`.
- The footer toggles `aria-expanded`; expanded copy is "Show less · 15 done"; focus stays on the footer through the next frame; a card that shrinks to 3 items and grows again stays expanded.
- Motion: a new row gets `.entering`; a planning → coding change gets no `.changed` but coding → blocked does; a frame for another card neither repaints this card nor re-adds `.entering`; dispatching `animationend` removes the class.
- At ≤560 px the stub gives 2 rows and the footer sets the hash to `session/<id>`; Back returns focus to that footer.
- A row click gives `#session/<id>/<sub>`; Back returns focus to the row.
- The session screen lists blocked first with header counts and a "Timeline" heading; its rows are not buttons; a frame updates `#dv-subs` without moving focus; when the history fetch fails, the subtasks section still shows above the error.
- Minimal labels render as sent; unknown item states render as planning; a malformed `subtasks` gives today's card.

Also pin the existing behaviours: the test at `:515-528` (wholesale repaint) and the unknown-status test (`:409`).

`test/pages.test.ts`: the `card.css` regex contract for `.sub-label` `max-width: 58%`, and that `#grid.has-subs` `align-items: start` lives in `board.css`, not `card.css`.

**Visual.** Run the server locally with a seeded board. Capture at 1280 px with headless Chrome and at 375 px with the Browser pane's `resize_window` (Chrome cannot lay out under about 500 px), in both scenarios. Run the `/impeccable` audit before calling it done.

### 8.4 iOS

There is no test target (`BoardLayout.swift:364`). Use DEBUG assert tables, run by `SessionStore.startDemo`:

1. `verifySubtaskDecoding()`: absent, `null`, string or number `subtasks` give nil while the session still decodes; one malformed item is dropped and the others kept; an unknown state gives `.planning`; missing counts are derived; an encode/decode round trip is stable; a snapshot array with one bad item still yields every session.
2. A `SubtaskSlots` table in `BoardArrangement.verify()`: first fill (oldest, blocked first); a finish fills its slot in place; a blocked subagent takes the bottom-most non-blocked slot; an approved row keeps its slot; an untaken slot closes; a 2 → 3 slot change resets the ledger; resolving twice gives the same result; 30 running; open and fold; expanded survives a shrink below the slot count.
3. A display-status table (including the stale exemption) and copy tables (§6.12).

**Simulator.** Use the `SIMCTL_CHILD_` prefix with `AGSTATUS_DEMO=1`, `AGSTATUS_DEMO_SCENARIO=subtasks-*` and `AGSTATUS_DEMO_FREEZE=1`. Phone layout on an iPad needs `AGSTATUS_BOARD_WIDTH=408`; force landscape with the `notifyutil` command. Use `AGSTATUS_EXPAND_SUBTASKS=1` and `AGSTATUS_OPEN_SUBTASK=3`. Capture each scenario beside the prototype (`?device=iphone|ipad-l&scenario=…&bare=1`), including an iPhone in landscape, then run `/impeccable`. Only the iOS 26.5 runtime is installed, so the iOS 17 and 18 fallbacks stay untested.

### 8.5 Android

These JUnit4 tests run in CI's "Android (build + tests)" job (`.github/workflows/ci.yml:416-451`); this Mac cannot run Gradle.

- **`ApiParsingTest`:** mirror the iOS decode table, especially an explicit `"subtasks": null` and `"subtasks": "x"` inside a `List<Session>` snapshot.
- **New `SubtaskSlotsTest`:** the iOS cases without the 3-slot and expand cases.
- **New `SubtaskCopyTest`:** the copy table, in the style of `FocusCopyTest`.

Visual: CI's `agstatus-debug-apk` on the `agstatus_test` emulator. Run `adb shell am force-stop com.kardanov.agstatus`, then `am start … --ez agstatus_demo true` (plus `--ez agstatus_open_history true --es agstatus_open_subtask <n>`). Then run `/impeccable`. There is no design reference for Android, so the audit is the reference.

### 8.6 Docs

- `npm run build:docs` completes and `public/docs.html` contains the new sections.
- A new `test/privacy-pages.test.ts` asserts that `docs/privacy.md` and `public/privacy.html` carry the same "Last updated" date and both mention subagent labels.

---

## 9. Rollout

### 9.1 Version and artifacts

- Version **1.7.0** in exactly the four manifests: `package.json:3`, `cli/package.json:3`, `plugin/.claude-plugin/plugin.json:4` and `.claude-plugin/marketplace.json:12`. Lockfiles are left stale, by precedent.
- Release notes go in `docs/release-notes/v1.7.0.md`, covering this release only. The annotated tag message is `AgStatus 1.7.0 — subagents on the board`. `release.yml` requires the tag to match `cli/package.json`, and requires the notes file.
- The iOS (`MARKETING_VERSION` 1.6.2) and Android (`versionName` 1.6.2, `versionCode` 6) versions move only for a store build.
- **Nothing is pushed in this work.** Every push to master deploys production, and `deploy.yml` does not wait for CI. Each push needs the owner's explicit "push it".

### 9.2 Order

1. **Server.** Merge to master; deploy on the owner's go. It is backward compatible with every old hook and client, so it can ship first and alone. Run the full suite with `--no-file-parallelism` first.
2. **Web.** Served by the server, so it ships with it or after it. Cached tabs keep the old client until reload, which is harmless.
3. **Hook, CLI and plugin.** Tag 1.7.0. Users re-run the installer or update the plugin.
4. **iOS and Android.** Store builds when ready. The server works with the shipped apps, which get the derived reading.

### 9.3 Compatibility matrix

| Hook | Server | Client | Result |
|---|---|---|---|
| ≤ 1.6.3 | ≤ 1.6.3 | any | Today. |
| ≤ 1.6.3 | 1.7.0 | any | Today. Old hooks fold subagents into the parent; no `subtasks` key. |
| 1.7.0 | ≤ 1.6.3 | any | `agent`, `turn` and `unattributed` ignored. The parent follows compat statuses: fewer flips, no `done` from a subagent stop, no task-notification prompts, 1.6.3's blocked push bodies. No rows. |
| 1.7.0 | 1.7.0 | iOS/Android ≤ 1.6.x, cached web | The derived six-status reading: "Needs approval: X"; after the turn, the busiest class with "N subagents still running"; "Reading subagent results" before the report turn. The parent's line is no longer overwritten by subagent tool calls. No rows. |
| 1.7.0 | 1.7.0 | 1.7.0 clients | The full feature. |
| 1.7.0 script, old registrations or untrusted Codex entries, or an unusable state directory | any | any | Every subagent is unknown and takes the 1.6.3 path: today's card (subagent tool calls on the parent's line), minus the Codex host-detection bug, plus the Agent-launch fix. No rows, so none can be stranded. |

### 9.4 What the owner must do

1. Say "push it" for the master push (server and web), and again for the tag push.
2. On each machine, re-run the installer (`curl -fsSL https://agstatus.online/install.sh | sh`, or `agstatus init`) so that the new hook script **and** the new event registrations land. Plugin users update the plugin instead.
3. Codex: if `/hooks` lists an AgStatus entry as untrusted after the upgrade, trust it once. The installer says so when the event set grew (§3.1).
4. Run `/impeccable` on web, iOS and Android before shipping the UI (standing rule), including the scoped `has-subs` grid alignment. Start iOS and Android store builds when ready.
5. Production Postgres on the mini PC needs no manual step. The column is added at boot with `ADD COLUMN IF NOT EXISTS`.

### 9.5 Risks

| Risk | Mitigation or acceptance |
|---|---|
| A blocked row stays blocked after approval until the subagent's next class change or stop; a long approved command keeps the card BLOCKED. | There is no "permission granted" hook. The main thread has the same stickiness today. Accepted and documented. |
| Permission attribution relies on marker timing. Terminal messages name no tool; an answered marker whose agent has not yet made a hooked call, or a sandbox prompt (no marker) arriving while another prompt is pending, can make the card name the wrong subagent. | The card is blocked either way (correct urgency); only the label and which row is marked may be wrong, and the wrong row unblocks at its agent's next class change. Progress drops answered markers; oldest-first follows the notification order. Probe P2. |
| An unattributed prompt is cleared by any subagent's progress, even while it still waits. | The 1.6.3 behaviour exactly (any subagent tool call cleared it). Attributed prompts are hard. |
| Subagents post nothing within a class, so rows silent for over 60 min (0.6% of subagents) are closed early, and a row closed by expiry, reconciliation or reset returns only at its agent's next class change or is counted at its stop. | The owner's flood-control rule. Cards with live rows are never stale-dimmed. A keepalive would fix it at about 1 post per 5 min per running subagent; it is the one owner question. |
| Lost posts (429s, timeouts) leave zombie rows. | Posts are confirmed before local state records them (§3.4), so a later event or the task-notification retries; `Stop` reconciliation for Agent-tool rows; quiet end; expiry after 60 min (working) or 6 h (blocked); `reset` at SessionStart. Workflow zombies close at a `Stop` with `workflows:0`. Codex zombies wait for expiry. |
| The done count undercounts when stops are lost and a row is reconciled. | Chosen deliberately: numbers are exact, not estimated. |
| Failure signals are unverified. | If none fires, failed subagents count as done. Probe P1. |
| The report hold is a prediction: a workflow between phases also reads "Reading subagent results", and a report turn that never comes holds the card at `planning` for up to 120 s. | Both are short. The sweep releases the hold and pushes `done`. When background work ended before `Stop` (probe e2), the report turn flips the card `done` → `planning` → `done` as 1.6.3 does, with a second done push only if it lasts over 60 s. |
| A second subagent blocking within 60 s of a blocked push for the same card is not pushed again (debounce). | The owner decided push works "as for any blocked session". The card still shows it. |
| In-process teammates show as rows and close at each lead `Stop` when no workflow runs (their task ids never match their agent ids). | Uncounted closes; the teammate's next message fires `SubagentStart`, which always posts. |
| Nested agents launched by a background agent are not in `background_tasks`, so they close at a `Stop` with no workflow running and return at their next class change. | Rare (nesting is 8 of 3,775 at depth ≥ 2). Blocked rows are never closed this way. |
| Claude's internal agents in a `--agent` session carry the session's agent name as `agent_type`, so the `''` filter misses them. | A terminal post needs a recorded start, so they cause no phantom finishes; if they fire `SubagentStart` (unknown, probe P7) they show as a brief row. |
| Codex trust for added events is unknown. | Until trusted, Codex runs the 1.6.3 path. Installer notice. Probe P3. |
| Codex cards now show `planning` "Processing prompt" at each root prompt. | A visible change for Codex users, consistent with Claude cards; needed as the Codex turn start. |
| `#grid.has-subs` changes how every card on a board aligns while any card shows a subtask block: Focus rails no longer line up across a row. | Boards without subtask blocks are untouched. The prototype recommends it. Flag it in the `/impeccable` audit. |
| The `working` stats slot reshapes the strip when it appears. | Follows the prototype and its AUDITED note. It happens only when a card actually enters or leaves WORKING. |
| More hook processes: SubagentStart/Stop per subagent, plus PermissionRequest and PostToolUse(Agent/Workflow). | Far fewer POSTs than today's one per subagent tool call. Each process does bounded, non-blocking I/O, with no title read and no host detection. |
| A shared Linux `/tmp` can be squatted by another local user. | The root is verified (real directory, ours, mode 0700); otherwise the hook runs stateless (1.6.3 path). No file is read or written through a link. |
| The repo lives in iCloud. A dataless file can make git or vitest look corrupt. | Check `stat -f %Sf` before trusting a failure. |

---

## Appendix A: unknowns and the probes that settle them

The design works either way in each case. Run probes in throwaway directories and a throwaway `CODEX_HOME`, **never** against the live `~/.claude`, `~/.agstatus` or `~/.codex`.

| # | Unknown | The design without an answer | Probe |
|---|---|---|---|
| P1 | How subagent failure surfaces: whether `PostToolUseFailure(Agent)` fires, with what `error` and `is_interrupt`; the task-notification `<status>` for failed and killed agents; whether `SubagentStop` fires for a killed agent (claude unknown 2). | Two channels (§3.9). With none firing, a failure counts as done. | Headless, with the probe logger (`subtasks/probe/bin/log-hook.js`) registered for all events: (a) `TaskStop` a background agent; (b) a custom agent whose `model` is invalid; (c) Esc on a foreground agent in an interactive session. |
| P2 | `Notification(permission_prompt)` timing and order with several subagent prompts queued, in terminal and desktop sessions; whether PermissionRequest fires in the desktop (`canUseTool`) path (claude unknowns 0 and 1). | Markers dropped on progress, oldest-first, tool-name filter when the message names one, `unattributed` otherwise. | An interactive session with the probe logger: two subagents each ask for an unapproved Bash command; compare `PermissionRequest` and `Notification` timestamps and messages. Repeat in the desktop app. |
| P3 | Whether Codex needs `/hooks` re-trust for added event entries with an unchanged command (codex unknown 3). | The 1.6.3 path until they run; an installer notice. | A throwaway `CODEX_HOME`: install the 1.6.3 registration, trust it, run 1.7.0 init, start codex, spawn a sub-agent with `AGSTATUS_DEBUG=1` pointed at a local test board, and check `/hooks` and whether SubagentStart posted. |
| P4 | The `<task-notification>` wrapping in the desktop app (inside `<system-reminder>`, with or without other text). | The parser's two notification-only rules (§3.8). | A desktop session with the probe logger: launch a background agent and capture `UserPromptSubmit.prompt`. |
| P5 | How often parallel Agent launches overlap (`Pre A, Pre B, Start A`) with the real AgStatus hook installed, and whether the first-launched call always starts first. | Oldest-first tentative claims, corrected by `meta.json` at the first tool call. | Headless with the probe logger plus a 1 s sleep in a second `PreToolUse` hook, three parallel Agent calls, 10 runs. |
| P6 | Whether `SessionStart(resume)` happens while background agents of the same process still live. | `reset` drops rows; they return at their next class change. | Resume a session in the desktop app while a background agent runs, with the probe logger. |
| P7 | Whether internal agents (prompt suggestions, `/btw`, memory extraction) fire `SubagentStart` (hooks.md documents only `SubagentStop`). | Dropped when `agent_type` is `""`; in `--agent` sessions a brief row at worst; never a phantom finish. | An interactive session with prompt suggestions on, with and without `--agent`, and the probe logger. |
| P8 | Whether `meta.json` is always written before the first tool call (claude unknown 4). | Up to 3 tries, then at `SubagentStop`; the launch claim and the `Subagent N` fallback before that. | Repeat run b 20 times and log the snapshot at every event. |
| P9 | Whether a Codex sub-agent's follow-up turn fires an agent-tagged `UserPromptSubmit` (codex fact 4 says the field exists). | Handled when it arrives; otherwise the follow-up's first matched `PreToolUse` brings the row back. | The P3 setup: `followup_task` to a finished sub-agent, with the probe logger. |

Settled from the binary since the draft: an in-process teammate's `background_tasks` id is a separate `in_process_teammate` task id, never its `agent_id` (former P5), so teammates are not listed in `turn.running` (§2.3).

## Appendix B: decisions this spec took

| Topic | Brief or prototype | This spec | Why |
|---|---|---|---|
| Expanded footer copy | The brief says "Show less · 15 done". The prototype renders "15 done · Show less" (`:1994`). | **"Show less · 15 done"** | The owner's decision is final. |
| Blocked slot | The brief says "lowest non-blocked slot". The prototype code takes the highest index (`free.reverse()`). | The **bottom-most** (highest-index) non-blocked slot | Both say the same in visual terms; now unambiguous. |
| "Needs approval" subject | Prototype: the first blocked in start order. | The same | Reference behaviour. |
| The `agent` field | `{id, type, label, state}` | `{id, state, kind, label, activity, at}`; `id` is a hashed agent key | `kind` is what the server needs; raw `agent_type` has no consumer and may be user text; `at` orders updates; raw ids can carry words of a `/fork` directive or a teammate's name, and Claude's id grammar (`_`, up to 81 chars) does not fit a validation regex. |
| WORKING signal | The prototype reads `s.turnEnded`, which nothing sent. | `subtasks.turnEnded` on the wire | Clients cannot tell "parent coding" from "turn over, subagents coding" without it. |
| Stats strip | The shipped strip has six fixed slots. The prototype adds `working` while non-zero. | Prototype | The AUDITED note, which the owner confirmed with the design. |
| Web at ≤560 px | Unspecified (the prototype draws the web at 1280 only). | Phone rules | The phone-glance context, and the same breakpoint as the 1-column grid. |
| iPhone in landscape | Unspecified ("phone" vs "iPad"). | Phone rules ⇔ `.narrow` on every iOS device | The codebase decides layout by measured width, never size class. |
| Expanded state | Prototype keeps it until the reader folds. | The same | Prototype fidelity; a list that shrinks and grows again does not fold itself. |
| Timeline heading | Prototype labels the timeline "Timeline" under the Subtasks section. | The same, when the section shows | Without it the timeline reads as a continuation of the subtask list. |
| iOS meta line | Prototype moves it whenever the block shows (`v.show`). | The same, including the count-only state | Prototype fidelity. |
| Row motion | DECIDED: a row moves only when it starts, finishes or gets blocked; the prototype's paint re-enters the state cell on any status change. | Only into or out of blocked, and into failed | Under Option B every agent post after the start is a class change; animating each would move rows almost continuously. |
| Failed-row lifetime | "Until the parent's turn ends". | It resets with the done count: at a new prompt, or when the turn is fully over (after the report turn when background work ran). | Coherent with the prototype's count rule and the background case. |
| History | The research suggested recording subtask start and finish. | Record nothing per subagent; all "N subagents still running" readings share one key. | Permanent rows and the 100-event window (§4.10). |
| Agent posts and `updatedAt` | Not stated. | Agent posts bump `updatedAt`, as subagent tool calls do today; cards with live rows are exempt from stale dimming. | Keeps REST merges, ordering and TTL right; the class-change rule means posts are not a liveness signal. iOS beat and history refetch are adjusted. |
| Keepalive | DECIDED: post only on start, stop and class change. | No keepalive; asked as the one owner question. | It would relax the owner's rule. |
| Label-only posts | Not stated. | At most 2 per agent, when a firm label (meta.json, the launch result) corrects or completes the start's label. | Part of the start's information arriving late; bounded far below the flood the rule prevents. |
| Report hold | DECIDED: after the turn the card does not say DONE while background subagents run. | `planning` "Reading subagent results" between the last background finish and the report turn, and as the notification-only prompt's line. | Otherwise the card read DONE, and pushed done, about 0.1 s before the parent read the results (runs c, e). |
| Unattributed prompts | Not stated. | Soft own block, cleared by the next running agent post. | Agent posts never touch own, so a misattributed main block would otherwise stick for a foreground subagent's whole run. |
| Second approval push | DECIDED: push as for any blocked session. | A newly blocked subagent re-arms the push while the card is already BLOCKED (60 s debounce kept). | Rows stay blocked until their agent's next class change, so the transition-only push would miss the second prompt. |
| Agent posts for a card that does not exist | Not stated. | Terminal: ignored. Running: creates the card with own `idle`. | A ghost card made from a finish, or a card stuck in a compat `blocked`, no later post would fix. |
| Unknown agents | Draft: implicit start. | The 1.6.3 path. | It degrades to known behaviour when registrations are missing or untrusted, and can strand no rows. |
| Codex turn start | Draft: no Codex `UserPromptSubmit`. | Registered; posts "Processing prompt" with `turn.start`; prompt text never sent. | Without it a Codex root read WORKING, and pushed done, mid-turn, and its done count never reset. |
| Failure from `PostToolUse(Agent)` | Draft: a non-success `tool_response.status` meant failure. | Never; only `PostToolUseFailure` and task-notifications. | The result union has no failure value; `remote_launched` and `teammate_spawned` are successes. |
| Notification types | Every type means `blocked`. | Non-asking types post nothing. | They would turn a WORKING card blocked and push. |
| SessionStart compact | Posts `idle`. | Posts nothing. | Auto-compaction is not a session start. |
| Permission attribution | "PermissionRequest carries agent_id". | `PermissionRequest` writes a marker; `Notification` posts; progress drops markers; oldest wins. | The 6 s presence gate, no push spam, no headless false blocks. |
| Local state location | Not stated. | tmpdir, with ownership, mode and no-follow checks. | host.test.ts pins that nothing is written under the Focus state directory with Focus off. |
| Hook timeouts | Claude entries had none (600 s default). | `timeout: 10` on every Claude entry but SessionEnd. | Bounds a stuck syscall; SessionEnd keeps its 1.5 s budget. |
| Web grid alignment | Prototype adds `align-items: start` to the grid. | Only while a card shows a subtask block (`#grid.has-subs`). | DECIDED: a card with no subagents looks exactly as it does today. |
| Wire budget | Draft: 64 live rows, 16 KB per session. | 48 live rows per card, 256 per board, 8 KB per session, throttled agent frames. | Observed max is 30 at once; bounds per-post outbound bytes, snapshot size and per-board heap. |
| Prototype FOUND note | "A shipped app fails to decode" a seventh status. | It decodes as idle (iOS since v1.0.0, Android since 41ed3d8). | The six-status rule stands anyway. |
