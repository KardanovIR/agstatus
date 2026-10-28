import type { Status } from './store';

/*
 * Subtasks: the running subagents of a Claude Code or Codex session, listed as
 * rows on the parent's card.
 *
 * Everything here is pure: no I/O and no clock reads (whatever needs the time
 * takes `now`), so the rules can be tested a table at a time. store.ts keeps a
 * SubtaskState on each session that has subagents (Session.sub), calls in here
 * on every post and on the sweep, and puts what derive() and toWireSubtasks()
 * return on the wire.
 *
 * The state never overwrites the parent. `own` is what the parent's last
 * main-thread post said; an agent post (one that carries `agent`) changes rows
 * only. What a client sees as the session's status and message is derived from
 * the two (derive), and it is always one of the six statuses: an app that has
 * never heard of subtasks gets a calmer card, never a status it cannot draw.
 *
 * Posts arrive only on a subagent's start, its stop, and a change of its status
 * class (the hook's flood control), so silence is not a liveness signal. Rows
 * end by their own posts, by the parent's Stop (reconciliation, applyTurn) and,
 * failing both, by expiry (sweepState).
 */

/**
 * An agent's id on the wire. From the 1.7.0 hook it is 24 lowercase hex: a hash
 * of the raw id, which can carry words of a /fork directive or a teammate's name
 * and so never leaves the machine. Opaque here. The charset is what makes it
 * safe in a quoted attribute selector, which is how the web board finds a row.
 */
export const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** What a subagent was asked to do, after cleaning. Sampled labels: p50 23, p99 62. */
export const LABEL_MAX = 64;
/** What a subagent is doing now. */
export const ACTIVITY_MAX = 80;
/** Live rows one card lists. The most ever observed running at once was 30. */
export const MAX_LIVE_ROWS = 48;
/**
 * Live rows across one board. Without it a board's heap allowance would be 50
 * cards of 48 rows each; with it, subtask state stays under about 0.7 MB for a
 * pathological 50-card board (see the per-board reasoning in store.ts).
 */
export const MAX_LIVE_ROWS_PER_WORKSPACE = 256;
/** Failed rows listed per card. The failed COUNT stays exact past it. */
export const MAX_FAILED_ROWS = 8;
/** Finished ids remembered per card, and for how long (see SubtaskTomb). */
export const MAX_TOMBS = 64;
export const TOMB_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * How long a working row may go without a post before the sweep closes it. A
 * replay of the class-change rule over 3,093 subagent transcripts found 0.6%
 * with a silence over an hour; those close early and come back at their next
 * class change, or are counted at their stop. It is the price of bounding the
 * rows a lost stop would otherwise strand.
 */
export const LIVE_STALE_MS = 60 * 60 * 1000;
/**
 * Closes a blocked row, drops a failed one and resets an idle tally. Long,
 * because a pending approval is the one row somebody must still act on.
 */
export const BLOCKED_STALE_MS = 6 * 60 * 60 * 1000;
/** The longest the card may say "Reading subagent results" without the parent posting. */
export const REPORT_HOLD_MS = 120_000;
export const SUBTASK_SWEEP_MS = 60_000;
/** The most often one session's agent posts produce a `session` frame (app.ts). */
export const AGENT_FRAME_THROTTLE_MS = 250;
/** UTF-8 bytes of one session's `subtasks` JSON, enforced by clipping text (toWireSubtasks). */
export const WIRE_SUBTASKS_MAX_BYTES = 8192;
/** A stored `sessions.subtasks` longer than this loads as no state (and is never read at all). */
export const SUBTASKS_COLUMN_MAX_CHARS = 65_536;
/** Keys a turn hint may list as still running. The hook sends no list rather than a cut one. */
export const TURN_RUNNING_MAX = 64;
/** The largest `turn.workflows` a hint may carry. */
const TURN_WORKFLOWS_MAX = 1000;
/**
 * How far an agent post's own clock (`at`) may sit from the server's. `at` only
 * orders updates for one id and is never shown; a value outside the window is a
 * broken clock or a forged post, and is replaced by the time the post arrived.
 */
const AT_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
/** A stored own message is a webhook message, so app.ts's MESSAGE_MAX bounds it. */
const OWN_MESSAGE_MAX = 300;

/** The line a card shows between the last background finish and the parent's report turn. */
export const REPORT_HOLD_MESSAGE = 'Reading subagent results';
const NEEDS_APPROVAL = 'Needs approval: ';
/** "1 subagent still running", "12 subagents still running": every after-turn line. */
export const RUNNING_RE = /^\d+ subagents? still running$/;

export type LiveState = 'planning' | 'coding' | 'testing' | 'blocked';
export type RowState = LiveState | 'failed';
export type AgentState = LiveState | 'done' | 'failed';
export type Kind = 'agent' | 'workflow' | 'codex';

const AGENT_STATES: readonly AgentState[] = ['planning', 'coding', 'testing', 'blocked', 'done', 'failed'];
const KINDS: readonly Kind[] = ['agent', 'workflow', 'codex'];
/** The order "busiest" means after the turn: one testing subagent outranks five coding. */
const BUSIEST: readonly LiveState[] = ['testing', 'coding', 'planning'];

/**
 * The six wire statuses (store.ts STATUSES) as a record, so the compiler
 * insists on every one of them. This module takes only a type from the store,
 * never a value: the two import each other, and a value import would make the
 * result depend on which of them loads first.
 */
const IS_STATUS: Record<Status, true> = {
  idle: true, planning: true, coding: true, testing: true, blocked: true, done: true,
};
const isStatus = (v: unknown): v is Status =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(IS_STATUS, v);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
const isLive = (s: RowState): s is LiveState => s !== 'failed';
const isWorking = (s: AgentState): boolean => s === 'planning' || s === 'coding' || s === 'testing';

/** One agent post's `agent`, rebuilt key by key (parseAgent). */
export interface AgentUpdate {
  id: string;
  state: AgentState;
  /** Absent: 'agent' for a new row, the row's own kind for an update. */
  kind?: Kind;
  /** Absent: keep the label held (none known yet means "Subagent N"). */
  label?: string;
  /** Absent: keep the activity held; '' clears it. */
  activity?: string;
  /** The hook's clock when it read the event: orders updates for one id, nothing else. */
  at: number;
}

/** The `turn` hint of a main-thread post (parseTurn). */
export interface TurnHint {
  phase: 'start' | 'end' | 'reset';
  /** end only: the background subagents the parent's Stop listed as still running. Absent = unknown. */
  running?: string[];
  /** end only, and only with `running`: background workflows still running. */
  workflows?: number;
}

export interface Own {
  status: Status;
  message: string;
  /**
   * Set while own is a soft block: an approval prompt the hook could not pin on
   * any thread, posted while subagents were live. It is the reading to go back
   * to when some thread makes progress (applyAgent), which is how 1.6.3 cleared
   * such a block — the next subagent tool call overwrote it.
   */
  soft?: { status: Status; message: string };
}

export interface SubtaskRow {
  id: string;
  /** The ordinal, ≥ 1 and unique among rows at all times: "Subagent 3", and the start order. */
  n: number;
  kind: Kind;
  state: RowState;
  /** null: the wire shows `Subagent ${n}` (always so in minimal mode). */
  label: string | null;
  activity: string;
  /** Server clock. */
  startedAt: number;
  /** Server clock of the last update applied; what expiry runs on. */
  updatedAt: number;
  /** The hook's clock of the last update applied; ordering only. */
  at: number;
}

/**
 * A finished id. It is what makes a finish count once per turn however often it
 * is reported (a task-notification "may notify more than once"), keeps an
 * update that overtook the finish from bringing the row back, and gives a
 * resumed agent its old number.
 */
export interface SubtaskTomb {
  id: string;
  /** The hook's clock of the finish. */
  at: number;
  /** Server clock: what the 2-hour retention runs on. */
  t: number;
  /** The turn it finished in. */
  turn: number;
  /** done (counted), failed, or closed without a count (expired, reconciled, reset). */
  o: 'd' | 'f' | 'x';
  /** The row's ordinal; 0 when it never had one. */
  n: number;
}

export interface SubtaskState {
  v: 1;
  own: Own;
  /** Increments on turn start, reset and quiet end; tombs carry it to tell this turn from earlier ones. */
  turn: number;
  /** Finished OK this turn. Exact rather than complete: a close by expiry or reconciliation is never counted. */
  done: number;
  /** Failed this turn. Exact; can exceed the failed rows listed (MAX_FAILED_ROWS). */
  failed: number;
  nextN: number;
  /** A Stop announced background work, so a report turn will follow. */
  awaitReport: boolean;
  /** Server clock the report hold began; 0 when not holding. */
  holdSince: number;
  /** Ascending n. */
  rows: SubtaskRow[];
  tombs: SubtaskTomb[];
}

/** What a client sees of one row. */
export interface WireSubtask {
  id: string;
  n: number;
  label: string;
  state: RowState;
  activity: string;
}

/** The `subtasks` object on a session, for clients (docs/api.md). */
export interface WireSubtasks {
  /** The parent's own turn is over and some subagent is still live: clients draw WORKING. */
  turnEnded: boolean;
  running: number;
  blocked: number;
  failed: number;
  done: number;
  /** Live and failed rows, ascending n (start order). */
  items: WireSubtask[];
}

export interface Derived {
  status: Status;
  message: string;
  turnEnded: boolean;
  /** Whether the session carries a `subtasks` object at all. */
  show: boolean;
}

// ---- text ----------------------------------------------------------------

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
// A UTF-16 surrogate without its partner. It survives JSON.stringify as a
// \udXXX escape, which is not text, and a client that decodes a snapshot as one
// array (both native apps do) loses the whole board to it.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

/**
 * Truncates to `max` UTF-16 units without leaving half a surrogate pair: every
 * unpaired surrogate is removed first, then a high surrogate the cut leaves at
 * the end goes too. A regex rather than String.prototype.toWellFormed(), which
 * Node 18 (engines.node) does not have.
 */
export function safeClip(s: string, max: number): string {
  const whole = s.replace(LONE_SURROGATE_RE, '');
  if (whole.length <= max) return whole;
  const cut = whole.slice(0, max);
  return TRAILING_HIGH_SURROGATE_RE.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A label or an activity line: every run of whitespace one space, control
 * characters out, trimmed, then safeClip. The hook cleans in the same order
 * before it sends, so a label arrives here already in its final form.
 * undefined for anything that is not a string.
 */
export function cleanLabel(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  return safeClip(v.replace(/\s+/g, ' ').replace(CONTROL_CHARS_RE, '').trim(), max);
}

/** Whether a stored message is one the server composes rather than one the parent posted. */
export const isDerivedMessage = (message: string): boolean =>
  message.startsWith(NEEDS_APPROVAL) || RUNNING_RE.test(message) || message === REPORT_HOLD_MESSAGE;

/**
 * What the session timeline compares to decide a post is news. Every after-turn
 * "N subagents still running" reading shares one key, so a drain of thirty
 * subagents records the reading once rather than thirty times: each recorded
 * event is a permanent row, and a session's timeline keeps only its newest 100.
 * The separator is written as an escape, never a literal NUL byte.
 */
export const historyKey = (status: string, message: string): string =>
  RUNNING_RE.test(message) ? 'running' : `${status}\u0000${message}`;

// ---- webhook input -------------------------------------------------------

/**
 * The `agent` object of a webhook. undefined when absent or null (a main-thread
 * post); 'invalid' when it is not a plain object or its id or state is unusable,
 * which app.ts refuses with a 400 — applying such a post's compat `status`
 * would be wrong. Otherwise rebuilt key by key, unknown keys dropped.
 */
export function parseAgent(raw: unknown, now: number): AgentUpdate | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) return 'invalid';
  if (!isOneOf(AGENT_STATES, a.state)) return 'invalid';
  const at = a.at;
  const update: AgentUpdate = {
    id: a.id,
    state: a.state,
    at: typeof at === 'number' && Number.isSafeInteger(at) && at >= 1 && Math.abs(at - now) <= AT_SKEW_MS
      ? at
      : now,
  };
  if (isOneOf(KINDS, a.kind)) update.kind = a.kind;
  const label = cleanLabel(a.label, LABEL_MAX);
  if (label) update.label = label; // '' after cleaning is no label at all
  const activity = cleanLabel(a.activity, ACTIVITY_MAX);
  if (activity !== undefined) update.activity = activity;
  return update;
}

/**
 * The `turn` hint of a main-thread post. Malformed is dropped, never refused:
 * the post also carries the parent's own update, which must still land. A
 * `running` list that is not a list of ids is unknown, and so is `workflows`
 * then, because reconciling against a partial list would close live rows.
 */
export function parseTurn(raw: unknown): TurnHint | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  if (t.phase !== 'start' && t.phase !== 'end' && t.phase !== 'reset') return undefined;
  if (t.phase !== 'end') return { phase: t.phase };
  const hint: TurnHint = { phase: 'end' };
  const running = t.running;
  if (
    Array.isArray(running) &&
    running.length <= TURN_RUNNING_MAX &&
    running.every((id) => typeof id === 'string' && AGENT_ID_RE.test(id))
  ) {
    hint.running = running.slice() as string[];
    const workflows = t.workflows;
    if (typeof workflows === 'number' && Number.isInteger(workflows) && workflows >= 0 && workflows <= TURN_WORKFLOWS_MAX) {
      hint.workflows = workflows;
    }
  }
  return hint;
}

// ---- the model -----------------------------------------------------------

/** A fresh state around the parent's current reading: with no state, the stored reading IS own. */
export function materialize(status: Status, message: string): SubtaskState {
  return {
    v: 1,
    own: { status, message },
    turn: 0,
    done: 0,
    failed: 0,
    nextN: 1,
    awaitReport: false,
    holdSince: 0,
    rows: [],
    tombs: [],
  };
}

export const liveCount = (st: SubtaskState): number => st.rows.filter((r) => isLive(r.state)).length;

export const blockedIds = (st: SubtaskState): Set<string> =>
  new Set(st.rows.filter((r) => r.state === 'blocked').map((r) => r.id));

/** Nothing left to show, count, dedupe or restore: the session goes back to having no state. */
export const isEmpty = (st: SubtaskState): boolean =>
  st.rows.length === 0 &&
  st.tombs.length === 0 &&
  st.done === 0 &&
  st.failed === 0 &&
  !st.awaitReport &&
  !st.own.soft;

const labelOf = (r: SubtaskRow): string => r.label ?? `Subagent ${r.n}`;

/** Keeps rows in ascending n, which is start order and the order every client lists them in. */
function insertRow(st: SubtaskState, row: SubtaskRow): void {
  const i = st.rows.findIndex((r) => r.n > row.n);
  if (i < 0) st.rows.push(row);
  else st.rows.splice(i, 0, row);
}

function upsertTomb(st: SubtaskState, tomb: SubtaskTomb): void {
  const i = st.tombs.findIndex((t) => t.id === tomb.id);
  if (i >= 0) st.tombs[i] = tomb;
  else st.tombs.push(tomb);
}

/**
 * The number an id gets back: its own from earlier this turn, unless another
 * row holds it now. A number from an earlier turn may have gone to someone else
 * since (a turn restarts the count), so it is never reused.
 */
function ordinalFor(st: SubtaskState, tomb: SubtaskTomb | undefined): number {
  if (tomb && tomb.turn === st.turn && tomb.n >= 1 && !st.rows.some((r) => r.n === tomb.n)) return tomb.n;
  const n = st.nextN;
  st.nextN += 1;
  return n;
}

/**
 * Ends a row without counting it (expiry, reconciliation, reset): tomb 'x'. A
 * tomb this id already holds as 'd' for this turn stays 'd': the row was a
 * re-tasked agent counted once this turn already, and that holds whatever
 * ends its second run.
 */
function closeRow(st: SubtaskState, row: SubtaskRow, now: number): void {
  const prior = st.tombs.find((t) => t.id === row.id);
  const o = prior && prior.o === 'd' && prior.turn === st.turn ? 'd' : 'x';
  upsertTomb(st, { id: row.id, at: row.at, t: now, turn: st.turn, o, n: row.n });
}

/** At most MAX_FAILED_ROWS listed, the oldest dropped first; `failed` keeps counting them. */
function capFailedRows(st: SubtaskState): void {
  const failed = st.rows.filter((r) => r.state === 'failed');
  if (failed.length <= MAX_FAILED_ROWS) return;
  const drop = new Set(failed.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, failed.length - MAX_FAILED_ROWS));
  st.rows = st.rows.filter((r) => !drop.has(r));
}

/**
 * A main-thread post: the parent's own reading. `message` is what own says now
 * (the post's message, or the one carried forward). Any main-thread post ends a
 * soft block and a report hold — the parent spoke — except that an
 * unattributed prompt arriving while subagents are live becomes the soft block
 * itself, remembering the reading to restore.
 */
export function applyMain(
  st: SubtaskState,
  post: { status: Status; message: string; unattributed?: boolean; turn?: TurnHint },
  now: number,
): void {
  if (post.status === 'blocked' && post.unattributed && liveCount(st) > 0) {
    const prior = st.own.soft
      ?? (st.own.status !== 'blocked' ? { status: st.own.status, message: st.own.message } : undefined);
    st.own = prior
      ? { status: 'blocked', message: post.message, soft: prior }
      : { status: 'blocked', message: post.message };
  } else {
    st.own = { status: post.status, message: post.message };
  }
  st.awaitReport = false;
  st.holdSince = 0;
  if (post.turn) applyTurn(st, post.turn, now);
}

/**
 * One agent post. `wsLive` is the live rows across the whole board, for
 * MAX_LIVE_ROWS_PER_WORKSPACE. 'untracked' when a new row was refused by a cap
 * (the store logs that once); 'ignored' when the post changed nothing that
 * counts — older than what is held, or a finish already recorded.
 *
 * A finish for an id the server never saw running is counted: the 1.7.0 hook
 * posts a finish only for an agent whose start it recorded, so such a post
 * means the start was lost (a 429, a restart), not that nothing ran.
 */
export function applyAgent(
  st: SubtaskState,
  a: AgentUpdate,
  now: number,
  wsLive: number,
): 'applied' | 'ignored' | 'untracked' {
  const row = st.rows.find((r) => r.id === a.id);
  const tomb = st.tombs.find((t) => t.id === a.id);
  if (row && a.at < row.at) return 'ignored';
  // A late update for an agent that already finished, overtaken by its finish.
  if (!row && tomb && a.at <= tomb.at) return 'ignored';
  // Some thread made progress, so the prompt nobody could attribute was answered.
  if (st.own.soft && isWorking(a.state)) st.own = st.own.soft;

  if (a.state !== 'done' && a.state !== 'failed') {
    if (row) {
      if (row.state === 'failed') st.failed = Math.max(0, st.failed - 1); // resumed after failing
      row.state = a.state;
      row.kind = a.kind ?? row.kind;
      if (a.label !== undefined) row.label = a.label;
      if (a.activity !== undefined) row.activity = a.activity;
      row.at = a.at;
      row.updatedAt = now;
      return 'applied';
    }
    if (liveCount(st) >= MAX_LIVE_ROWS || wsLive >= MAX_LIVE_ROWS_PER_WORKSPACE) return 'untracked';
    // Any running state for an id without a row is a start. Its tomb, if it has
    // one, stays: it records whether this id was already counted this turn.
    insertRow(st, {
      id: a.id,
      n: ordinalFor(st, tomb),
      kind: a.kind ?? 'agent',
      state: a.state,
      label: a.label ?? null,
      activity: a.activity ?? '',
      startedAt: now,
      updatedAt: now,
      at: a.at,
    });
    return 'applied';
  }

  const counted = tomb !== undefined && tomb.turn === st.turn && tomb.o === 'd';

  if (a.state === 'done') {
    if (row && row.state === 'failed') return 'ignored'; // the stop behind a failure signal: a duplicate
    if (!row && tomb && (tomb.o === 'd' || tomb.o === 'f')) {
      // Already finished: a repeated notification. A new finish of the same id
      // needs a running update first.
      tomb.at = Math.max(tomb.at, a.at);
      return 'ignored';
    }
    // A row, a tomb 'x' (closed while it really ran on), or nothing known at all.
    if (row) st.rows = st.rows.filter((r) => r !== row);
    if (!counted) st.done += 1; // once per id per turn
    upsertTomb(st, { id: a.id, at: a.at, t: now, turn: st.turn, o: 'd', n: row?.n ?? tomb?.n ?? 0 });
    return 'applied';
  }

  // failed
  if (row && row.state === 'failed') {
    row.activity = a.activity ?? row.activity;
    row.label = a.label ?? row.label;
    row.at = a.at;
    row.updatedAt = now;
    return 'applied';
  }
  if (!row && tomb && tomb.o === 'f') return 'ignored'; // already failed
  if (!row && tomb && tomb.o === 'd' && tomb.turn !== st.turn) return 'ignored'; // about a previous turn
  // SubagentStop said done and a failure signal followed: the correction.
  if (counted) st.done = Math.max(0, st.done - 1);
  const n = row?.n ?? ordinalFor(st, tomb);
  if (row) st.rows = st.rows.filter((r) => r !== row);
  insertRow(st, {
    id: a.id,
    n,
    kind: row?.kind ?? a.kind ?? 'agent',
    state: 'failed',
    label: a.label ?? row?.label ?? null,
    activity: a.activity || 'Failed',
    startedAt: row?.startedAt ?? now,
    updatedAt: now,
    at: a.at,
  });
  st.failed += 1;
  upsertTomb(st, { id: a.id, at: a.at, t: now, turn: st.turn, o: 'f', n });
  capFailedRows(st);
  return 'applied';
}

/** The turn is fully over, nothing live and nothing to report: the tally goes with it. */
export function quietEnd(st: SubtaskState): void {
  st.rows = [];
  st.done = 0;
  st.failed = 0;
  st.turn += 1;
  st.nextN = 1;
}

/**
 * A main-thread post's `turn` hint.
 *
 * - reset (SessionStart, not a compaction): a (re)started process has no
 *   subagents, so every row goes, uncounted.
 * - start (a real user prompt): a new tally. Background rows still live carry
 *   over, keeping their numbers, and new numbers start above them.
 * - end (Stop): with a `running` list and no workflow running, every Agent-tool
 *   row the list does not name has finished (a turn cannot end with a
 *   foreground Agent call pending), and so has every workflow row. Blocked rows
 *   are never reconciled: a pending approval goes only by its own agent's posts
 *   or by expiry. Nested agents and teammates are not in the list at all, and
 *   while a workflow runs an unlisted row may be one of its agents, whose
 *   workflow is listed instead of them. Codex rows are never reconciled (Codex
 *   sends no list); each closes at its own SubagentStop.
 *   Reconciled closes are never counted, which keeps `done` exact rather than
 *   complete.
 */
export function applyTurn(st: SubtaskState, t: TurnHint, now: number): void {
  if (t.phase === 'reset') {
    for (const row of st.rows) if (isLive(row.state)) closeRow(st, row, now);
    st.rows = [];
    st.done = 0;
    st.failed = 0;
    st.turn += 1;
    st.nextN = 1;
    st.awaitReport = false;
    st.holdSince = 0;
    return;
  }
  if (t.phase === 'start') {
    st.rows = st.rows.filter((r) => r.state !== 'failed');
    st.done = 0;
    st.failed = 0;
    st.turn += 1;
    st.nextN = 1 + st.rows.reduce((max, r) => Math.max(max, r.n), 0);
    st.awaitReport = false;
    st.holdSince = 0;
    return;
  }
  if (Array.isArray(t.running)) {
    if (t.workflows === 0) {
      const running = new Set(t.running);
      const closing = st.rows.filter((r) =>
        isLive(r.state) && r.state !== 'blocked' &&
        ((r.kind === 'agent' && !running.has(r.id)) || r.kind === 'workflow'));
      for (const row of closing) closeRow(st, row, now);
      st.rows = st.rows.filter((r) => !closing.includes(r));
    }
    // Claude runs a report turn once the last background task notifies.
    st.awaitReport = liveCount(st) > 0 || (t.workflows ?? 0) > 0;
  } else {
    st.awaitReport = false;
  }
  st.holdSince = 0;
  // Quiet end also moves `turn`, so a Codex sub-agent re-tasked in the next
  // root turn is counted again when it finishes there.
  if (liveCount(st) === 0 && !st.awaitReport) quietEnd(st);
}

/**
 * Runs after every apply (agent post, main-thread post, sweep): retires tombs,
 * starts or stops the report hold, and returns null when the state has nothing
 * left in it, at which point the stored status and message are own again.
 */
export function afterApply(st: SubtaskState, now: number): SubtaskState | null {
  st.tombs = st.tombs.filter((t) => now - t.t <= TOMB_TTL_MS);
  if (st.tombs.length > MAX_TOMBS) {
    st.tombs.sort((a, b) => a.t - b.t);
    st.tombs.splice(0, st.tombs.length - MAX_TOMBS);
  }
  if (liveCount(st) > 0) st.holdSince = 0;
  else if (st.awaitReport && st.holdSince === 0) st.holdSince = now;
  return isEmpty(st) ? null : st;
}

/**
 * What clients see. A blocked subagent beats everything unless the parent is
 * itself blocked, in which case the parent's own line stays. After the turn
 * (own done, or idle: a card an agent post created, or a SessionStart mid-run)
 * while subagents still work, the busiest of them and how many. Between the
 * last background finish and the report turn, the report hold, so the done push
 * goes out once, at the report turn's Stop. Otherwise own.
 */
export function derive(st: SubtaskState): Derived {
  const live = st.rows.filter((r) => isLive(r.state));
  const blocked = live.filter((r) => r.state === 'blocked');
  const working = live.filter((r) => isWorking(r.state));
  const ownEnded = st.own.status === 'done' || st.own.status === 'idle';
  const holding = ownEnded && st.awaitReport && st.holdSince > 0 && live.length === 0;
  let status: Status = st.own.status;
  let message = st.own.message;
  if (st.own.status !== 'blocked' && blocked.length > 0) {
    status = 'blocked';
    message = NEEDS_APPROVAL + labelOf(blocked[0]) + (blocked.length > 1 ? ` +${blocked.length - 1}` : '');
  } else if (ownEnded && working.length > 0) {
    status = BUSIEST.find((s) => working.some((r) => r.state === s)) ?? 'planning';
    message = `${working.length} ${working.length === 1 ? 'subagent' : 'subagents'} still running`;
  } else if (holding) {
    status = 'planning';
    message = REPORT_HOLD_MESSAGE;
  }
  return {
    status,
    message,
    turnEnded: ownEnded && live.length > 0,
    // A count with nothing running stays until the turn ends, and goes with it.
    show: st.rows.length > 0 || (st.done > 0 && (!ownEnded || holding)),
  };
}

const wireBytes = (w: WireSubtasks): number => Buffer.byteLength(JSON.stringify(w));

/**
 * The session's `subtasks` object, or null when there is nothing to show.
 *
 * Bounded at WIRE_SUBTASKS_MAX_BYTES by clipping text, a step at a time and
 * only while still over: activities to 24, then labels to 24, then activities
 * cleared and labels at 12. It never drops an item or touches a count. With 24
 * character ids the last step always fits; typical payloads (30 items, ASCII)
 * are about 4.6 KB and never clipped.
 */
export function toWireSubtasks(st: SubtaskState): WireSubtasks | null {
  const d = derive(st);
  if (!d.show) return null;
  const items: WireSubtask[] = st.rows.map((r) => ({
    id: r.id,
    n: r.n,
    label: labelOf(r),
    state: r.state,
    activity: r.activity,
  }));
  const wire: WireSubtasks = {
    turnEnded: d.turnEnded,
    running: items.filter((i) => isWorking(i.state)).length,
    blocked: items.filter((i) => i.state === 'blocked').length,
    failed: st.failed,
    done: st.done,
    items,
  };
  if (wireBytes(wire) > WIRE_SUBTASKS_MAX_BYTES) {
    for (const i of items) i.activity = safeClip(i.activity, 24);
  }
  if (wireBytes(wire) > WIRE_SUBTASKS_MAX_BYTES) {
    for (const i of items) i.label = safeClip(i.label, 24);
  }
  if (wireBytes(wire) > WIRE_SUBTASKS_MAX_BYTES) {
    for (const i of items) {
      i.activity = '';
      i.label = safeClip(i.label, 12);
    }
  }
  return wire;
}

/**
 * The sweep's pass over one state: working rows silent past LIVE_STALE_MS and
 * blocked rows past BLOCKED_STALE_MS close uncounted (a later post from the
 * agent, with a newer clock, brings the row back; a later finish is counted),
 * failed rows go after BLOCKED_STALE_MS, a report hold nobody ended within
 * REPORT_HOLD_MS is released, and a tally idle past BLOCKED_STALE_MS resets.
 * Every change it makes moves the card toward less activity.
 *
 * `changed` is whether anything in the state moved, which is not the same as
 * the wire moving: retiring a tomb changes no frame.
 */
export function sweepState(st: SubtaskState, now: number): { state: SubtaskState | null; changed: boolean } {
  let changed = false;
  const kept: SubtaskRow[] = [];
  for (const row of st.rows) {
    const limit = row.state === 'blocked' || row.state === 'failed' ? BLOCKED_STALE_MS : LIVE_STALE_MS;
    if (now - row.updatedAt > limit) {
      if (row.state !== 'failed') closeRow(st, row, now);
      changed = true;
    } else {
      kept.push(row);
    }
  }
  st.rows = kept;
  if (st.awaitReport && st.holdSince > 0 && now - st.holdSince > REPORT_HOLD_MS) {
    st.awaitReport = false;
    st.holdSince = 0;
    quietEnd(st);
    changed = true;
  }
  if (liveCount(st) === 0 && !st.awaitReport && (st.rows.length > 0 || st.done > 0 || st.failed > 0)) {
    // Once its last tomb has retired (TOMB_TTL_MS), nothing remembers when the
    // tally last moved — nor which finishes it already counted, so it could no
    // longer be kept exact anyway.
    const newest = Math.max(-Infinity, ...st.rows.map((r) => r.updatedAt), ...st.tombs.map((t) => t.t));
    if (now - newest > BLOCKED_STALE_MS) {
      quietEnd(st);
      changed = true;
    }
  }
  const tombs = st.tombs.length;
  const holdSince = st.holdSince;
  const state = afterApply(st, now);
  if (!state || st.tombs.length !== tombs || st.holdSince !== holdSince) changed = true;
  return { state, changed };
}

// ---- persistence ---------------------------------------------------------

const KIND_CODE: Record<Kind, string> = { agent: 'a', workflow: 'w', codex: 'c' };
const STATE_CODE: Record<RowState, string> = { planning: 'p', coding: 'c', testing: 't', blocked: 'b', failed: 'f' };
const KIND_OF: Record<string, Kind> = { a: 'agent', w: 'workflow', c: 'codex' };
const STATE_OF: Record<string, RowState> = { p: 'planning', c: 'coding', t: 'testing', b: 'blocked', f: 'failed' };
const TOMB_OS = ['d', 'f', 'x'] as const;

/**
 * The `sessions.subtasks` column: compact JSON, with `savedAt` the
 * session.updatedAt it was written with. A 1.6.3 server writes status, message
 * and updated_at without ever touching the column, so on a rollback and
 * redeploy a mismatched savedAt is what tells a stale state from a current one.
 */
export function serializeSubtaskState(st: SubtaskState, savedAt: number): string {
  return JSON.stringify({
    v: 1,
    savedAt,
    own: [st.own.status, st.own.message, st.own.soft?.status ?? null, st.own.soft?.message ?? null],
    turn: st.turn,
    done: st.done,
    failed: st.failed,
    nextN: st.nextN,
    await: st.awaitReport ? 1 : 0,
    hold: st.holdSince,
    rows: st.rows.map((r) => [
      r.id, r.n, KIND_CODE[r.kind], STATE_CODE[r.state], r.label, r.activity, r.startedAt, r.updatedAt, r.at,
    ]),
    tombs: st.tombs.map((t) => [t.id, t.at, t.t, t.turn, t.o, t.n]),
  });
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const ownMessage = (v: unknown): string | null =>
  typeof v === 'string' ? safeClip(v.replace(CONTROL_CHARS_RE, ''), OWN_MESSAGE_MAX) : null;

function parseOwn(raw: unknown): Own | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [status, message, softStatus, softMessage] = raw as unknown[];
  const msg = ownMessage(message);
  if (!isStatus(status) || msg === null) return null;
  if (softStatus === null && softMessage === null) return { status, message: msg };
  const soft = ownMessage(softMessage);
  if (!isStatus(softStatus) || soft === null) return null;
  return { status, message: msg, soft: { status: softStatus, message: soft } };
}

function parseRow(raw: unknown): SubtaskRow | null {
  if (!Array.isArray(raw) || raw.length !== 9) return null;
  const [id, n, kind, state, label, activity, startedAt, updatedAt, at] = raw as unknown[];
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return null;
  const ordinal = count(n);
  if (ordinal === null || ordinal < 1) return null;
  if (typeof kind !== 'string' || !KIND_OF[kind] || typeof state !== 'string' || !STATE_OF[state]) return null;
  if (label !== null && typeof label !== 'string') return null;
  const act = cleanLabel(activity, ACTIVITY_MAX);
  const started = count(startedAt);
  const updated = count(updatedAt);
  const hookAt = count(at);
  if (act === undefined || started === null || updated === null || hookAt === null) return null;
  return {
    id,
    n: ordinal,
    kind: KIND_OF[kind],
    state: STATE_OF[state],
    label: label === null ? null : cleanLabel(label, LABEL_MAX) || null,
    activity: act,
    startedAt: started,
    updatedAt: updated,
    at: hookAt,
  };
}

function parseTomb(raw: unknown): SubtaskTomb | null {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const [id, at, t, turn, o, n] = raw as unknown[];
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id) || !isOneOf(TOMB_OS, o)) return null;
  const hookAt = count(at);
  const when = count(t);
  const inTurn = count(turn);
  const ordinal = count(n);
  if (hookAt === null || when === null || inTurn === null || ordinal === null) return null;
  return { id, at: hookAt, t: when, turn: inTurn, o, n: ordinal };
}

/**
 * The stored column back into a state, or null for no state: unparseable, the
 * wrong shape, an invalid own, or a savedAt other than the row's updated_at.
 * Rebuilt entry by entry with every cap and enum applied again — a malformed
 * row or tomb is dropped on its own, the rest kept — so a column edited by
 * hand, or written by some other version, can only ever load as a state this
 * version could have produced.
 */
export function normalizeSubtaskState(raw: unknown, updatedAt: number): SubtaskState | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const s = o as Record<string, unknown>;
  if (s.v !== 1 || s.savedAt !== updatedAt) return null;
  const own = parseOwn(s.own);
  const turn = count(s.turn);
  const done = count(s.done);
  const failed = count(s.failed);
  const nextN = count(s.nextN);
  const hold = count(s.hold);
  if (!own || turn === null || done === null || failed === null || nextN === null || hold === null) return null;
  if ((s.await !== 0 && s.await !== 1) || !Array.isArray(s.rows) || !Array.isArray(s.tombs)) return null;

  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const live: SubtaskRow[] = [];
  const failedRows: SubtaskRow[] = [];
  for (const entry of s.rows) {
    const row = parseRow(entry);
    if (!row || ids.has(row.id) || ordinals.has(row.n)) continue;
    ids.add(row.id);
    ordinals.add(row.n);
    (row.state === 'failed' ? failedRows : live).push(row);
  }
  failedRows.sort((a, b) => b.updatedAt - a.updatedAt);
  const rows = [...live.slice(0, MAX_LIVE_ROWS), ...failedRows.slice(0, MAX_FAILED_ROWS)].sort((a, b) => a.n - b.n);

  const tombIds = new Set<string>();
  const tombs: SubtaskTomb[] = [];
  for (const entry of s.tombs) {
    const tomb = parseTomb(entry);
    if (!tomb || tombIds.has(tomb.id)) continue;
    tombIds.add(tomb.id);
    tombs.push(tomb);
  }
  tombs.sort((a, b) => a.t - b.t);
  if (tombs.length > MAX_TOMBS) tombs.splice(0, tombs.length - MAX_TOMBS);

  const awaitReport = s.await === 1;
  const st: SubtaskState = {
    v: 1,
    own,
    turn,
    done,
    // Never fewer than the failed rows it lists.
    failed: Math.max(failed, rows.filter((r) => r.state === 'failed').length),
    // Always past every number in use, so a new row can never take one.
    nextN: Math.max(nextN, 1, 1 + rows.reduce((max, r) => Math.max(max, r.n), 0)),
    awaitReport,
    holdSince: awaitReport ? hold : 0,
    rows,
    tombs,
  };
  return isEmpty(st) ? null : st;
}
