import { describe, it, expect } from 'vitest';
import {
  afterApply,
  AgentState,
  AgentUpdate,
  applyAgent,
  applyMain,
  applyTurn,
  BLOCKED_STALE_MS,
  cleanLabel,
  derive,
  historyKey,
  isDerivedMessage,
  LIVE_STALE_MS,
  liveCount,
  materialize,
  MAX_FAILED_ROWS,
  MAX_LIVE_ROWS,
  MAX_LIVE_ROWS_PER_WORKSPACE,
  MAX_TOMBS,
  normalizeSubtaskState,
  parseAgent,
  parseTurn,
  REPORT_HOLD_MS,
  safeClip,
  serializeSubtaskState,
  SubtaskState,
  sweepState,
  TOMB_TTL_MS,
  toWireSubtasks,
  TurnHint,
  WIRE_SUBTASKS_MAX_BYTES,
} from '../src/subtasks';
import type { Status } from '../src/store';

// The pure subtask model (src/subtasks.ts): every rule of the server's half of
// the 1.7.0 subtasks spec (§4.2-4.7), one table or case at a time, with the
// clock passed in.

const T0 = 1_793_200_000_000;
const id = (i: number): string => i.toString(16).padStart(24, '0');
const A = id(0xa);
const B = id(0xb);
const C = id(0xc);

const agent = (aid: string, state: AgentState, at: number, extra: Partial<AgentUpdate> = {}): AgentUpdate =>
  ({ id: aid, state, at, ...extra });

/** A state as the store would hold it after each post: applied, then afterApply. */
function run(st: SubtaskState, steps: Array<AgentUpdate | { main: Status; message?: string; unattributed?: boolean; turn?: TurnHint }>, now = T0): SubtaskState {
  for (const step of steps) {
    if ('main' in step) {
      applyMain(st, { status: step.main, message: step.message ?? st.own.message, unattributed: step.unattributed, turn: step.turn }, now);
    } else {
      applyAgent(st, step, now, 0);
    }
    afterApply(st, now);
  }
  return st;
}

const fresh = (status: Status = 'coding', message = 'Working'): SubtaskState => materialize(status, message);
const rowsOf = (st: SubtaskState) => st.rows.map((r) => ({ id: r.id, n: r.n, state: r.state }));

describe('text cleaning', () => {
  it('safeClip never leaves half a surrogate pair, at any of the bounds the server uses', () => {
    const emoji = '\u{1F600}'; // two UTF-16 units
    for (const max of [64, 80, 24, 12]) {
      const straddling = 'a'.repeat(max - 1) + emoji; // the pair would be cut in half at `max`
      const clipped = safeClip(straddling, max);
      expect(clipped, String(max)).toBe('a'.repeat(max - 1));
      expect(clipped.length).toBeLessThanOrEqual(max);
      // A pair that fits whole is kept whole.
      expect(safeClip('a'.repeat(max - 2) + emoji, max)).toBe('a'.repeat(max - 2) + emoji);
    }
  });

  it('safeClip drops unpaired surrogates that arrive as such, and keeps real pairs', () => {
    expect(safeClip('a\uD83Db', 10)).toBe('ab');
    expect(safeClip('\uDE00x', 10)).toBe('x');
    expect(safeClip('x\uD83D', 10)).toBe('x');
    expect(safeClip('\uD83D😀', 10)).toBe('😀');
    expect(safeClip('😀\uDE00', 10)).toBe('😀');
    expect(safeClip('plain', 3)).toBe('pla');
  });

  it('cleanLabel collapses whitespace, strips controls, trims, then clips', () => {
    expect(cleanLabel('  review:\t\nhook \r ', 64)).toBe('review: hook');
    expect(cleanLabel('a\u0007b\u007Fc', 64)).toBe('abc');
    expect(cleanLabel('x'.repeat(100), 64)).toBe('x'.repeat(64));
    expect(cleanLabel('   ', 64)).toBe('');
    expect(cleanLabel(42, 64)).toBeUndefined();
    expect(cleanLabel('a'.repeat(79) + '\u{1F600}', 80)).toBe('a'.repeat(79));
  });

  it('historyKey gives every after-turn reading one key, and anything else its status and message', () => {
    expect(historyKey('testing', '3 subagents still running')).toBe('running');
    expect(historyKey('coding', '1 subagent still running')).toBe('running');
    expect(historyKey('planning', '30 subagents still running')).toBe('running');
    expect(historyKey('coding', 'Editing store.ts')).toBe('coding\u0000Editing store.ts');
    expect(historyKey('planning', 'Reading subagent results')).toBe('planning\u0000Reading subagent results');
    expect(historyKey('coding', 'subagents still running')).toBe('coding\u0000subagents still running');
  });

  it('isDerivedMessage knows the three lines the server composes', () => {
    expect(isDerivedMessage('Needs approval: verify:hook +1')).toBe(true);
    expect(isDerivedMessage('2 subagents still running')).toBe(true);
    expect(isDerivedMessage('Reading subagent results')).toBe(true);
    expect(isDerivedMessage('Needs approval')).toBe(false); // the hook's minimal-mode Codex line is own
    expect(isDerivedMessage('Editing store.ts')).toBe(false);
  });
});

describe('parseAgent', () => {
  const now = T0;

  it('absent or null is a main-thread post; anything else unusable is invalid', () => {
    expect(parseAgent(undefined, now)).toBeUndefined();
    expect(parseAgent(null, now)).toBeUndefined();
    for (const bad of [
      'x', 42, [], true,
      { state: 'coding' },
      { id: '', state: 'coding' },
      { id: 'x'.repeat(65), state: 'coding' },
      { id: 'a/b', state: 'coding' },
      { id: 12, state: 'coding' },
      { id: A },
      { id: A, state: 'working' },
      { id: A, state: 'idle' },
    ]) {
      expect(parseAgent(bad, now), JSON.stringify(bad)).toBe('invalid');
    }
  });

  it('rebuilds key by key: labels and activities cleaned, kind closed, unknown keys dropped', () => {
    expect(parseAgent({
      id: A, state: 'coding', kind: 'workflow', label: '  echo:one\n', activity: 'Print\talpha', at: now - 5,
      agent_type: 'general-purpose', extra: { a: 1 },
    }, now)).toEqual({ id: A, state: 'coding', kind: 'workflow', label: 'echo:one', activity: 'Print alpha', at: now - 5 });

    // An empty label after cleaning is no label; an empty activity is a value (it clears).
    expect(parseAgent({ id: A, state: 'coding', label: ' \t ', activity: '', at: now }, now))
      .toEqual({ id: A, state: 'coding', activity: '', at: now });
    // Unknown kind means "agent", which absent already means.
    expect(parseAgent({ id: A, state: 'done', kind: 'teammate', at: now }, now)).toEqual({ id: A, state: 'done', at: now });
    expect(parseAgent({ id: A, state: 'planning', label: 'x'.repeat(70), activity: 'y'.repeat(90), at: now }, now))
      .toMatchObject({ label: 'x'.repeat(64), activity: 'y'.repeat(80) });
    // The 24-hex key may start with a digit.
    expect(parseAgent({ id: '0123456789abcdef01234567', state: 'blocked', at: now }, now)).toMatchObject({ id: '0123456789abcdef01234567' });
  });

  it('keeps `at` only as an integer within 7 days of the server clock', () => {
    const day = 24 * 60 * 60 * 1000;
    const at = (v: unknown) => (parseAgent({ id: A, state: 'coding', at: v }, now) as AgentUpdate).at;
    expect(at(now - 6 * day)).toBe(now - 6 * day);
    expect(at(now + 6 * day)).toBe(now + 6 * day);
    for (const bad of [1e300, now - 8 * day, now + 8 * day, 0, -5, 1.5, '1793200000000', null, undefined, Number.NaN]) {
      expect(at(bad), String(bad)).toBe(now);
    }
  });
});

describe('parseTurn', () => {
  it('drops a malformed hint whole, and a bad list as unknown', () => {
    for (const bad of [undefined, null, 'end', 1, [], {}, { phase: 'stop' }]) {
      expect(parseTurn(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseTurn({ phase: 'start', running: [A] })).toEqual({ phase: 'start' });
    expect(parseTurn({ phase: 'reset' })).toEqual({ phase: 'reset' });
    expect(parseTurn({ phase: 'end' })).toEqual({ phase: 'end' });
    expect(parseTurn({ phase: 'end', running: [A, B], workflows: 2 })).toEqual({ phase: 'end', running: [A, B], workflows: 2 });
    expect(parseTurn({ phase: 'end', running: [], workflows: 0 })).toEqual({ phase: 'end', running: [], workflows: 0 });
  });

  it('a list that is not a list of at most 64 ids is unknown, and takes workflows with it', () => {
    const ids65 = Array.from({ length: 65 }, (_, i) => id(i));
    expect(parseTurn({ phase: 'end', running: ids65, workflows: 0 })).toEqual({ phase: 'end' });
    expect(parseTurn({ phase: 'end', running: [A, 7], workflows: 0 })).toEqual({ phase: 'end' });
    expect(parseTurn({ phase: 'end', running: [A, 'no/slash'], workflows: 0 })).toEqual({ phase: 'end' });
    expect(parseTurn({ phase: 'end', running: 'x', workflows: 0 })).toEqual({ phase: 'end' });
    expect(parseTurn({ phase: 'end', workflows: 1 })).toEqual({ phase: 'end' });
    // A bad count alone is just an absent count.
    for (const w of [1001, -1, 1.5, '1', null]) {
      expect(parseTurn({ phase: 'end', running: [A], workflows: w }), String(w)).toEqual({ phase: 'end', running: [A] });
    }
    expect(parseTurn({ phase: 'end', running: Array.from({ length: 64 }, (_, i) => id(i)), workflows: 1000 }))
      .toMatchObject({ workflows: 1000 });
  });
});

describe('agent posts', () => {
  it('a running state for an unknown id starts a row; numbers follow start order', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(B, 'coding', 2), agent(A, 'coding', 3, { label: 'Run echo alpha', activity: 'Print alpha' })]);
    expect(st.rows.map((r) => [r.id, r.n, r.state, r.label, r.activity])).toEqual([
      [A, 1, 'coding', 'Run echo alpha', 'Print alpha'],
      [B, 2, 'coding', null, ''],
    ]);
    expect(st.own).toEqual({ status: 'coding', message: 'Working' }); // agent posts never touch own
  });

  it('an update older than what is held is ignored (done at t5, then coding at t4)', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(A, 'done', 5)]);
    expect(applyAgent(st, agent(A, 'coding', 4), T0, 0)).toBe('ignored');
    expect(st.rows).toEqual([]);
    expect(st.done).toBe(1);
    // And older than the row: a testing update from before its last coding one.
    const st2 = run(fresh(), [agent(B, 'coding', 10)]);
    expect(applyAgent(st2, agent(B, 'testing', 9), T0, 0)).toBe('ignored');
    expect(st2.rows[0].state).toBe('coding');
  });

  it('a Codex follow-up within a turn counts once and keeps its number', () => {
    const st = run(fresh(), [
      agent(A, 'planning', 1), agent(A, 'coding', 2), agent(A, 'done', 3),
      agent(B, 'planning', 4),
      agent(A, 'coding', 5), // re-tasked: a newer clock brings the row back
    ]);
    expect(rowsOf(st)).toEqual([{ id: A, n: 1, state: 'coding' }, { id: B, n: 2, state: 'planning' }]);
    run(st, [agent(A, 'done', 6)]);
    expect(st.done).toBe(1);
  });

  it('a Codex follow-up finishing in a later turn is counted again', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(A, 'coding', 2), agent(A, 'done', 3)]);
    expect(st.done).toBe(1);
    run(st, [{ main: 'done', message: 'Turn finished', turn: { phase: 'end' } }]); // Codex: no list; a quiet end
    expect(st.done).toBe(0);
    run(st, [agent(A, 'coding', 5), agent(A, 'done', 6)]);
    expect(st.done).toBe(1);
  });

  it('a repeated finish with no running update in between is ignored', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(A, 'done', 2)]);
    expect(applyAgent(st, agent(A, 'done', 3), T0, 0)).toBe('ignored'); // a second task-notification
    expect(st.done).toBe(1);
    expect(st.tombs.find((t) => t.id === A)?.at).toBe(3);
  });

  it('a failure signal about a previous turn\'s finish is ignored', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(A, 'done', 2)]);
    applyTurn(st, { phase: 'start' }, T0);
    expect(applyAgent(st, agent(A, 'failed', 3, { activity: 'Failed: late' }), T0, 0)).toBe('ignored');
    expect(st.failed).toBe(0);
    expect(st.rows).toEqual([]);
  });

  it('a finish after an expiry counts once; a finish for a never-seen id counts with no row', () => {
    const st = run(fresh(), [agent(A, 'coding', 1)], T0);
    sweepState(st, T0 + LIVE_STALE_MS + 1);
    expect(st.rows).toEqual([]);
    expect(st.tombs.find((t) => t.id === A)?.o).toBe('x');
    run(st, [agent(A, 'done', 2), agent(A, 'done', 3)], T0 + LIVE_STALE_MS + 2);
    expect(st.done).toBe(1);

    const st2 = run(fresh(), [agent(B, 'done', 1)]);
    expect(st2.done).toBe(1);
    expect(st2.rows).toEqual([]);
    expect(derive(st2).show).toBe(true); // "1 done" while the parent works
  });

  it('a failure after done is a correction: done -1, failed +1, a failed row with the posted label', () => {
    const st = run(fresh(), [agent(A, 'planning', 1, { label: 'Run echo alpha' }), agent(A, 'done', 2)]);
    expect([st.done, st.failed]).toEqual([1, 0]);
    run(st, [agent(A, 'failed', 3, { label: 'Run echo alpha', activity: 'Failed: boom' })]);
    expect([st.done, st.failed]).toEqual([0, 1]);
    expect(st.rows).toEqual([expect.objectContaining({ id: A, n: 1, state: 'failed', label: 'Run echo alpha', activity: 'Failed: boom' })]);
    // The stop behind it is a duplicate, not a second finish.
    expect(applyAgent(st, agent(A, 'done', 4), T0, 0)).toBe('ignored');
    expect([st.done, st.failed]).toEqual([0, 1]);
  });

  it('a failed agent that resumes is live again and uncounted; an empty activity reads Failed', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(A, 'failed', 2, { activity: '' })]);
    expect(st.rows[0]).toMatchObject({ state: 'failed', activity: 'Failed', n: 1 });
    expect(st.failed).toBe(1);
    run(st, [agent(A, 'coding', 3, { activity: 'Retrying' })]);
    expect(st.rows[0]).toMatchObject({ state: 'coding', activity: 'Retrying', n: 1 });
    expect(st.failed).toBe(0);
    run(st, [agent(A, 'done', 4)]);
    expect([st.done, st.failed]).toEqual([1, 0]);
  });

  it('numbers stay unique and at least 1 across turns, and a reused number is never one taken since', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'coding', 2)]);
    applyTurn(st, { phase: 'end', running: [B], workflows: 0 }, T0); // A reconciled (x), B carries on
    afterApply(st, T0);
    applyTurn(st, { phase: 'start' }, T0); // B carries over as n 2; new numbers start at 3
    run(st, [agent(C, 'planning', 3)]);
    expect(rowsOf(st)).toEqual([{ id: B, n: 2, state: 'coding' }, { id: C, n: 3, state: 'planning' }]);
    // A comes back in the new turn: its old number (1) belongs to an earlier turn.
    run(st, [agent(A, 'failed', 4)]);
    run(st, [{ main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [], workflows: 0 } }]);
    run(st, [agent(id(0xd), 'planning', 5), agent(id(0xe), 'planning', 6), agent(A, 'coding', 7)]);
    const ns = st.rows.map((r) => r.n);
    expect(new Set(ns).size).toBe(ns.length);
    expect(Math.min(...ns)).toBeGreaterThanOrEqual(1);
  });

  it('a failure for an id closed in an earlier turn takes a fresh number, never one handed out since', () => {
    const st = run(fresh(), [agent(A, 'coding', 1)]);
    run(st, [{ main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [], workflows: 0 } }]);
    expect(st.tombs.find((t) => t.id === A)).toMatchObject({ o: 'x', n: 1 }); // reconciled, then a quiet end
    run(st, [agent(B, 'planning', 2)]); // the new turn hands out 1 again
    run(st, [agent(A, 'failed', 3, { activity: 'Failed: boom' })]);
    expect(rowsOf(st)).toEqual([{ id: B, n: 1, state: 'planning' }, { id: A, n: 2, state: 'failed' }]);
  });

  it('a re-tasked agent counted this turn is not counted again after its second run is closed', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), agent(A, 'done', 2), agent(A, 'coding', 3)], T0);
    expect(st.done).toBe(1);
    sweepState(st, T0 + LIVE_STALE_MS + 1); // its second run goes silent and expires
    expect(st.tombs.find((t) => t.id === A)?.o).toBe('d');
    run(st, [agent(A, 'done', 4)], T0 + LIVE_STALE_MS + 2);
    expect(st.done).toBe(1);
  });

  it('a card lists at most 48 live rows, a board at most 256; the next start is untracked', () => {
    const st = fresh();
    for (let i = 0; i < MAX_LIVE_ROWS; i++) expect(applyAgent(st, agent(id(i), 'coding', 1), T0, 0)).toBe('applied');
    expect(applyAgent(st, agent(id(999), 'coding', 1), T0, 0)).toBe('untracked');
    expect(st.rows).toHaveLength(MAX_LIVE_ROWS);
    // An update to a held row always lands, whatever the caps.
    expect(applyAgent(st, agent(id(0), 'testing', 2), T0, MAX_LIVE_ROWS_PER_WORKSPACE)).toBe('applied');

    const other = fresh();
    expect(applyAgent(other, agent(A, 'coding', 1), T0, MAX_LIVE_ROWS_PER_WORKSPACE - 1)).toBe('applied');
    expect(applyAgent(other, agent(B, 'coding', 1), T0, MAX_LIVE_ROWS_PER_WORKSPACE)).toBe('untracked');
  });

  it('a failed row that resumes is a start: at either cap it stays failed, so fail-and-resume adds no live row', () => {
    const st = fresh();
    for (let i = 0; i < MAX_LIVE_ROWS; i++) applyAgent(st, agent(id(100 + i), 'coding', 1), T0, 0);
    // A failure needs no live slot, so a failed row for a new id lands at the cap...
    expect(applyAgent(st, agent(A, 'failed', 2), T0, 0)).toBe('applied');
    // ...but its resume would be a 49th live row.
    expect(applyAgent(st, agent(A, 'blocked', 3), T0, 0)).toBe('untracked');
    expect(st.rows.find((r) => r.id === A)).toMatchObject({ state: 'failed' });
    expect(st.failed).toBe(1);
    // Failing a batch of new ids and resuming them, over and over.
    for (let cycle = 0; cycle < 5; cycle++) {
      const ids = Array.from({ length: MAX_FAILED_ROWS }, (_, k) => id(5000 + cycle * 100 + k));
      for (const x of ids) applyAgent(st, agent(x, 'failed', 10 + cycle), T0, 0);
      for (const x of ids) expect(applyAgent(st, agent(x, 'coding', 20 + cycle), T0, 0)).toBe('untracked');
      afterApply(st, T0);
    }
    expect(liveCount(st)).toBe(MAX_LIVE_ROWS);

    // The board's cap the same way.
    const other = run(fresh(), [agent(B, 'coding', 1), agent(B, 'failed', 2)]);
    expect(applyAgent(other, agent(B, 'coding', 3), T0, MAX_LIVE_ROWS_PER_WORKSPACE)).toBe('untracked');
    expect([liveCount(other), other.failed]).toEqual([0, 1]);
    expect(applyAgent(other, agent(B, 'coding', 3), T0, MAX_LIVE_ROWS_PER_WORKSPACE - 1)).toBe('applied');
    expect([liveCount(other), other.failed]).toEqual([1, 0]);
  });

  it('lists 8 failed rows, the newest, while the failed count stays exact', () => {
    const st = fresh();
    for (let i = 0; i < 11; i++) {
      applyAgent(st, agent(id(i), 'coding', 1), T0 + i, 0);
      applyAgent(st, agent(id(i), 'failed', 2), T0 + i, 0);
    }
    expect(st.failed).toBe(11);
    expect(st.rows).toHaveLength(MAX_FAILED_ROWS);
    expect(st.rows.map((r) => r.id)).toEqual(Array.from({ length: 8 }, (_, i) => id(i + 3)));
    expect(toWireSubtasks(st)?.failed).toBe(11);
  });
});

describe('soft blocks', () => {
  const unattributed = { main: 'blocked' as const, message: 'Claude needs your permission', unattributed: true };

  it('an unattributed prompt with live rows is soft: a running agent post restores the reading', () => {
    const st = run(fresh('coding', 'Editing app.ts'), [agent(A, 'planning', 1), unattributed]);
    expect(st.own).toEqual({ status: 'blocked', message: 'Claude needs your permission', soft: { status: 'coding', message: 'Editing app.ts' } });
    expect(derive(st)).toMatchObject({ status: 'blocked', message: 'Claude needs your permission' });
    run(st, [agent(A, 'coding', 2)]);
    expect(st.own).toEqual({ status: 'coding', message: 'Editing app.ts' });
  });

  it('a blocked agent post does not end it; a second unattributed prompt keeps the first reading to restore', () => {
    const st = run(fresh('coding', 'Editing app.ts'), [agent(A, 'planning', 1), unattributed, agent(B, 'blocked', 2)]);
    expect(st.own.soft).toEqual({ status: 'coding', message: 'Editing app.ts' });
    run(st, [{ ...unattributed, message: 'Claude needs your permission again' }]);
    expect(st.own).toEqual({ status: 'blocked', message: 'Claude needs your permission again', soft: { status: 'coding', message: 'Editing app.ts' } });
  });

  it('a main-thread post replaces it; with no live rows the block is hard', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), unattributed, { main: 'testing', message: 'npm test' }]);
    expect(st.own).toEqual({ status: 'testing', message: 'npm test' });

    const lone = run(fresh(), [agent(A, 'planning', 1), agent(A, 'done', 2), unattributed]);
    expect(lone.own).toEqual({ status: 'blocked', message: 'Claude needs your permission' });
    run(lone, [agent(B, 'coding', 3)]);
    expect(lone.own.status).toBe('blocked');
  });

  it('an unattributed prompt over a hard block stays hard', () => {
    const st = run(fresh(), [agent(A, 'planning', 1), { main: 'blocked', message: 'Main asks' }, unattributed]);
    expect(st.own).toEqual({ status: 'blocked', message: 'Claude needs your permission' });
  });
});

describe('turn phases', () => {
  it('end reconciles: a blocked row survives, unlisted agent rows survive while a workflow runs', () => {
    const st = run(fresh(), [
      agent(A, 'coding', 1), agent(B, 'blocked', 2), agent(C, 'planning', 3, { kind: 'workflow' }),
    ]);
    applyTurn(st, { phase: 'end', running: [], workflows: 1 }, T0);
    expect(rowsOf(st).map((r) => r.id)).toEqual([A, B, C]);
    expect(st.awaitReport).toBe(true);

    applyTurn(st, { phase: 'end', running: [], workflows: 0 }, T0);
    expect(rowsOf(st)).toEqual([{ id: B, n: 2, state: 'blocked' }]);
    expect(st.tombs.filter((t) => t.o === 'x').map((t) => t.id).sort()).toEqual([A, C].sort());
    expect(st.done).toBe(0); // reconciled closes are never counted
  });

  it('end closes agent rows the list does not name, keeps the listed, and never touches Codex rows', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'coding', 2), agent(C, 'coding', 3, { kind: 'codex' })]);
    applyTurn(st, { phase: 'end', running: [B], workflows: 0 }, T0);
    expect(st.rows.map((r) => r.id)).toEqual([B, C]);
    // No list (Codex, or a registry the hook could not read) reconciles nothing.
    applyTurn(st, { phase: 'end' }, T0);
    expect(st.rows.map((r) => r.id)).toEqual([B, C]);
    expect(st.awaitReport).toBe(false);
  });

  it('start drops failed rows and the tally; live background rows carry over', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'coding', 2), agent(B, 'failed', 3), agent(C, 'planning', 4), agent(C, 'done', 5)]);
    expect([st.done, st.failed]).toEqual([1, 1]);
    applyTurn(st, { phase: 'start' }, T0);
    expect(rowsOf(st)).toEqual([{ id: A, n: 1, state: 'coding' }]);
    expect([st.done, st.failed, st.nextN]).toEqual([0, 0, 2]);
  });

  it('reset drops every row uncounted', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'blocked', 2), agent(C, 'planning', 3), agent(C, 'failed', 4), agent(id(9), 'done', 5)]);
    const turn = st.turn;
    applyTurn(st, { phase: 'reset' }, T0);
    expect(st.rows).toEqual([]);
    expect([st.done, st.failed, st.nextN, st.turn]).toEqual([0, 0, 1, turn + 1]);
    expect(st.tombs.find((t) => t.id === B)?.o).toBe('x');
  });

  it('a quiet end moves the turn and restarts the numbering', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'coding', 2), agent(A, 'done', 3), agent(B, 'done', 4)]);
    expect([st.turn, st.nextN, st.done]).toEqual([0, 3, 2]);
    run(st, [{ main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [], workflows: 0 } }]);
    expect([st.turn, st.nextN, st.done, st.rows.length]).toEqual([1, 1, 0, 0]);
    run(st, [agent(C, 'planning', 5)]);
    expect(st.rows[0].n).toBe(1);
  });
});

describe('the report hold', () => {
  it('end with live rows awaits the report; the last finish holds; a main-thread post ends it', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), { main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [A], workflows: 0 } }]);
    expect(st.awaitReport).toBe(true);
    expect(derive(st)).toEqual({ status: 'coding', message: '1 subagent still running', turnEnded: true, show: true });

    run(st, [agent(A, 'done', 2)], T0 + 1000);
    expect(st.holdSince).toBe(T0 + 1000);
    expect(derive(st)).toEqual({ status: 'planning', message: 'Reading subagent results', turnEnded: false, show: true });
    expect(toWireSubtasks(st)).toEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] });

    run(st, [{ main: 'planning', message: 'Reading subagent results' }]); // the notification-only post
    expect([st.awaitReport, st.holdSince]).toEqual([false, 0]);
    expect(derive(st)).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
  });

  it('end with a running workflow and nothing live holds at once', () => {
    const st = run(fresh(), [agent(A, 'coding', 1, { kind: 'workflow' }), agent(A, 'done', 2)]);
    run(st, [{ main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [], workflows: 1 } }], T0 + 5);
    expect(st.holdSince).toBe(T0 + 5);
    expect(derive(st)).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
  });

  it('a live row ends a hold that had begun', () => {
    const st = run(fresh(), [{ main: 'done', message: 'Turn finished' }, agent(A, 'coding', 1), { main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [A], workflows: 1 } }, agent(A, 'done', 2)]);
    expect(st.holdSince).toBe(T0);
    run(st, [agent(B, 'coding', 3, { kind: 'workflow' })]);
    expect(st.holdSince).toBe(0);
    expect(derive(st)).toMatchObject({ status: 'coding', message: '1 subagent still running' });
  });
});

describe('derive', () => {
  it('a blocked subagent beats the rest; the first blocked in start order names the line', () => {
    const st = run(fresh(), [agent(A, 'testing', 1), agent(B, 'coding', 2, { label: 'verify:hook' }), agent(C, 'coding', 3)]);
    run(st, [agent(C, 'blocked', 4, { label: 'review:hook' })]);
    expect(derive(st)).toMatchObject({ status: 'blocked', message: 'Needs approval: review:hook' });
    run(st, [agent(B, 'blocked', 5)]);
    expect(derive(st)).toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook +1' });
    run(st, [agent(id(7), 'blocked', 6)]);
    expect(derive(st).message).toBe('Needs approval: verify:hook +2');
    // Unlabelled: the number stands in.
    run(st, [agent(B, 'coding', 7), agent(C, 'coding', 8)]);
    expect(derive(st).message).toBe('Needs approval: Subagent 4');
  });

  it('a blocked parent keeps its own line', () => {
    const st = run(fresh('blocked', 'May I run rm?'), [agent(A, 'blocked', 1)]);
    expect(derive(st)).toMatchObject({ status: 'blocked', message: 'May I run rm?' });
  });

  it('after the turn the busiest state leads: testing over coding over planning', () => {
    const cases: Array<[AgentState[], Status, string]> = [
      [['planning'], 'planning', '1 subagent still running'],
      [['planning', 'coding'], 'coding', '2 subagents still running'],
      [['coding', 'planning', 'testing'], 'testing', '3 subagents still running'],
    ];
    for (const [states, status, message] of cases) {
      const st = run(fresh('done', 'Turn finished'), states.map((s, i) => agent(id(i), s, 1)));
      expect(derive(st), states.join()).toMatchObject({ status, message, turnEnded: true });
    }
    // While the parent still works, its own line stays.
    const working = run(fresh('coding', 'Editing app.ts'), [agent(A, 'testing', 1)]);
    expect(derive(working)).toEqual({ status: 'coding', message: 'Editing app.ts', turnEnded: false, show: true });
  });

  it('idle counts as the turn being over, so a card an agent post created shows its rows', () => {
    const st = run(fresh('idle', ''), [agent(A, 'coding', 1)]);
    expect(derive(st)).toMatchObject({ status: 'coding', message: '1 subagent still running', turnEnded: true });
    run(st, [agent(A, 'blocked', 2, { label: 'verify:hook' })]);
    expect(derive(st)).toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook' });
    run(st, [agent(A, 'done', 3)]);
    expect(derive(st)).toMatchObject({ status: 'idle', message: '', show: false });
  });

  it('a count with nothing running shows while the parent works, and goes when its turn has ended', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(A, 'done', 2)]);
    expect(derive(st).show).toBe(true);
    run(st, [{ main: 'done', message: 'Turn finished' }]); // no turn hint: the tally is not reset
    expect(derive(st).show).toBe(false);
  });
});

describe('the wire projection', () => {
  it('lists live and failed rows in start order, with exact counts', () => {
    const st = run(fresh(), [
      agent(A, 'testing', 1, { label: 'review:hook', activity: 'Run hook tests' }),
      agent(B, 'blocked', 2, { label: 'verify:hook', activity: 'Approve: Run the hook suite' }),
      agent(C, 'coding', 3),
      agent(C, 'failed', 4, { activity: 'Failed: boom' }),
      agent(id(9), 'done', 5),
    ]);
    expect(toWireSubtasks(st)).toEqual({
      turnEnded: false,
      running: 1,
      blocked: 1,
      failed: 1,
      done: 1,
      items: [
        { id: A, n: 1, label: 'review:hook', state: 'testing', activity: 'Run hook tests' },
        { id: B, n: 2, label: 'verify:hook', state: 'blocked', activity: 'Approve: Run the hook suite' },
        { id: C, n: 3, label: 'Subagent 3', state: 'failed', activity: 'Failed: boom' },
      ],
    });
    expect(Object.keys(toWireSubtasks(st)!)).toEqual(['turnEnded', 'running', 'blocked', 'failed', 'done', 'items']);
    expect(toWireSubtasks(fresh())).toBeNull();
  });

  /** A state with `live` live rows and `failed` failed rows, all with the given text. */
  function big(live: number, failed: number, label: string, activity: string): SubtaskState {
    const st = fresh();
    for (let i = 0; i < failed; i++) {
      applyAgent(st, agent(id(1000 + i), 'coding', 1, { label, activity }), T0, 0);
      applyAgent(st, agent(id(1000 + i), 'failed', 2, { activity }), T0, 0);
    }
    for (let i = 0; i < live; i++) applyAgent(st, agent(id(i), 'coding', 1, { label, activity }), T0, 0);
    return st;
  }
  const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

  it('clips text in order, only as far as the budget needs, and never an item or a count', () => {
    // Small enough: untouched.
    const small = toWireSubtasks(big(30, 0, 'l'.repeat(64), 'a'.repeat(80)))!;
    expect(small.items.every((i) => i.label.length === 64 && i.activity.length === 80)).toBe(true);

    // Activities alone bring it under.
    const one = toWireSubtasks(big(40, 0, 'l'.repeat(64), 'a'.repeat(80)))!;
    expect(one.items.every((i) => i.label.length === 64 && i.activity.length === 24)).toBe(true);

    // Activities, then labels.
    const two = toWireSubtasks(big(48, 8, 'l'.repeat(64), 'a'.repeat(80)))!;
    expect(two.items.every((i) => i.label.length === 24 && i.activity.length === 24)).toBe(true);

    for (const w of [small, one, two]) expect(bytes(w)).toBeLessThanOrEqual(WIRE_SUBTASKS_MAX_BYTES);
  });

  it('56 items of 4-byte characters stay within 8,192 bytes, with every count intact', () => {
    const emoji = '\u{1F680}'; // 4 bytes in UTF-8, 2 UTF-16 units
    const st = big(MAX_LIVE_ROWS, MAX_FAILED_ROWS, emoji.repeat(32), emoji.repeat(40));
    const wire = toWireSubtasks(st)!;
    expect(wire.items).toHaveLength(56);
    expect(bytes(wire)).toBeLessThanOrEqual(WIRE_SUBTASKS_MAX_BYTES);
    expect(wire.items.every((i) => i.activity === '' && i.label === emoji.repeat(6))).toBe(true);
    expect([wire.running, wire.blocked, wire.failed]).toEqual([48, 0, 8]);
    // The state itself keeps every character.
    expect(st.rows[0].label).toBe(emoji.repeat(32));
  });
});

describe('the sweep', () => {
  it('closes a working row after an hour and a blocked row after 6 hours, uncounted', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(B, 'blocked', 2)], T0);
    expect(sweepState(st, T0 + LIVE_STALE_MS).changed).toBe(false);
    expect(sweepState(st, T0 + LIVE_STALE_MS + 1).changed).toBe(true);
    expect(rowsOf(st)).toEqual([{ id: B, n: 2, state: 'blocked' }]);
    sweepState(st, T0 + BLOCKED_STALE_MS + 1);
    expect(st.rows).toEqual([]);
    expect(st.done).toBe(0);
    // A later post from the agent, with a newer clock, brings it back under its number.
    run(st, [agent(B, 'coding', 3)], T0 + BLOCKED_STALE_MS + 2);
    expect(rowsOf(st)).toEqual([{ id: B, n: 2, state: 'coding' }]);
  });

  it('drops a failed row after 6 hours and keeps its count', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(A, 'failed', 2), agent(B, 'coding', 3)], T0);
    run(st, [agent(B, 'coding', 4)], T0 + BLOCKED_STALE_MS);
    sweepState(st, T0 + BLOCKED_STALE_MS + 1);
    expect(rowsOf(st)).toEqual([{ id: B, n: 2, state: 'coding' }]);
    expect(st.failed).toBe(1);
  });

  it('releases a hold nobody ended after 120 s, and the tally with it', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), { main: 'done', message: 'Turn finished', turn: { phase: 'end', running: [A], workflows: 0 } }, agent(A, 'done', 2)], T0);
    expect(sweepState(st, T0 + REPORT_HOLD_MS).changed).toBe(false);
    const swept = sweepState(st, T0 + REPORT_HOLD_MS + 1);
    expect(swept.changed).toBe(true);
    expect([st.awaitReport, st.holdSince, st.done]).toEqual([false, 0, 0]);
    expect(derive(st)).toEqual({ status: 'done', message: 'Turn finished', turnEnded: false, show: false });
  });

  it('resets a tally idle for 6 hours, and lets the state go once nothing is left', () => {
    const st = run(fresh(), [agent(A, 'coding', 1), agent(A, 'done', 2)], T0);
    expect(st.done).toBe(1);
    // The tomb retires at 2 hours: a change, but not one any client sees.
    const retired = sweepState(st, T0 + TOMB_TTL_MS + 1);
    expect(retired).toMatchObject({ changed: true });
    expect(st.tombs).toEqual([]);
    expect(derive(st).show).toBe(true);
    // With nothing left to say when it last moved, the tally is idle.
    const reset = sweepState(st, T0 + TOMB_TTL_MS + 60_001);
    expect(reset).toEqual({ state: null, changed: true });
    expect(st.done).toBe(0);
  });

  it('an untouched state is not a change', () => {
    const st = run(fresh(), [agent(A, 'coding', 1)], T0);
    expect(sweepState(st, T0 + 60_000)).toEqual({ state: st, changed: false });
  });
});

describe('afterApply', () => {
  it('retires tombs past 2 hours, keeps the newest 64, and lets an empty state go', () => {
    const st = fresh();
    for (let i = 0; i < 70; i++) applyAgent(st, agent(id(i), 'done', 1), T0 + i, 0);
    afterApply(st, T0 + 70);
    expect(st.tombs).toHaveLength(MAX_TOMBS);
    expect(st.tombs[0].id).toBe(id(6)); // the six oldest went
    // Exactly 2 hours old is kept; a millisecond more is not.
    expect(afterApply(st, T0 + TOMB_TTL_MS + 6)).toBe(st);
    expect(st.tombs).toHaveLength(MAX_TOMBS);
    afterApply(st, T0 + TOMB_TTL_MS + 7);
    expect(st.tombs).toHaveLength(MAX_TOMBS - 1);
    expect(st.tombs[0].id).toBe(id(7));
    // done is still 70, so the state stays; with nothing at all left it goes.
    st.done = 0;
    st.tombs = [];
    expect(afterApply(st, T0)).toBeNull();
  });
});

describe('persistence', () => {
  /** A state with a bit of everything: rows of each kind and state, tombs, a soft block, a hold. */
  function everything(): SubtaskState {
    const st = run(fresh('coding', 'Editing app.ts'), [
      agent(A, 'testing', 1, { label: 'review:hook', activity: 'Run hook tests', kind: 'workflow' }),
      agent(B, 'blocked', 2, { kind: 'codex', activity: 'Approve: npm test' }),
      agent(C, 'coding', 3),
      agent(C, 'failed', 4, { label: 'verify:hook', activity: 'Failed: boom' }),
      agent(id(9), 'done', 5),
      { main: 'blocked', message: 'Claude needs your permission', unattributed: true },
    ]);
    st.awaitReport = true;
    st.holdSince = T0;
    return st;
  }

  it('round-trips through the column', () => {
    const st = everything();
    const text = serializeSubtaskState(st, 1234);
    expect(JSON.parse(text)).toMatchObject({ v: 1, savedAt: 1234, await: 1, hold: T0 });
    expect(normalizeSubtaskState(text, 1234)).toEqual(st);
  });

  it('loads nothing from a malformed column, a wrong shape, an invalid own or another savedAt', () => {
    const text = serializeSubtaskState(everything(), 1234);
    const edit = (fn: (o: Record<string, unknown>) => void): string => {
      const o = JSON.parse(text) as Record<string, unknown>;
      fn(o);
      return JSON.stringify(o);
    };
    expect(normalizeSubtaskState(text, 1235)).toBeNull();
    for (const bad of [
      '{not json', '"x"', '[]', 'null',
      edit((o) => { o.v = 2; }),
      edit((o) => { delete o.savedAt; }),
      edit((o) => { o.own = ['working', 'x', null, null]; }),
      edit((o) => { o.own = ['coding', 7, null, null]; }),
      edit((o) => { o.own = ['coding', 'x', 'done', null]; }),
      edit((o) => { o.turn = -1; }),
      edit((o) => { o.done = 1.5; }),
      edit((o) => { o.await = true; }),
      edit((o) => { o.rows = {}; }),
    ]) {
      expect(normalizeSubtaskState(bad, 1234), bad.slice(0, 60)).toBeNull();
    }
  });

  it('drops malformed entries one by one and re-applies every cap', () => {
    const rows: unknown[] = [];
    for (let i = 1; i <= 60; i++) rows.push([id(i), i, 'a', 'c', 'x'.repeat(100), 'y'.repeat(200), T0, T0, 1]);
    for (let i = 61; i <= 72; i++) rows.push([id(i), i, 'a', 'f', null, 'Failed', T0, T0 + i, 1]);
    rows.push(
      [id(1), 99, 'a', 'c', null, '', T0, T0, 1], // a second row for an id
      [id(500), 5, 'a', 'c', null, '', T0, T0, 1], // a second row for a number
      ['bad id!', 200, 'a', 'c', null, '', T0, T0, 1],
      [id(501), 0, 'a', 'c', null, '', T0, T0, 1],
      [id(502), 201, 'z', 'c', null, '', T0, T0, 1],
      [id(503), 202, 'a', 'x', null, '', T0, T0, 1],
      [id(504), 203, 'a', 'c', 5, '', T0, T0, 1],
      'not a row',
    );
    const tombs: unknown[] = [];
    for (let i = 0; i < 70; i++) tombs.push([id(2000 + i), 1, T0 + i, 0, 'd', 0]);
    tombs.push([id(2000), 1, T0 + 999, 0, 'd', 0], [id(3000), 1, T0, 0, 'q', 0], ['x', 1]);
    const text = JSON.stringify({
      v: 1, savedAt: 7, own: ['coding', 'm', null, null],
      turn: 3, done: 70, failed: 0, nextN: 2, await: 0, hold: 55, rows, tombs,
    });
    const st = normalizeSubtaskState(text, 7)!;
    const live = st.rows.filter((r) => r.state !== 'failed');
    const failed = st.rows.filter((r) => r.state === 'failed');
    expect(live).toHaveLength(48);
    expect(live[0]).toMatchObject({ id: id(1), n: 1, label: 'x'.repeat(64), activity: 'y'.repeat(80) });
    expect(failed.map((r) => r.n)).toEqual([65, 66, 67, 68, 69, 70, 71, 72]); // the newest 8
    expect(st.failed).toBe(8); // never fewer than it lists
    expect(st.nextN).toBe(73); // past every number in use
    expect(st.holdSince).toBe(0); // no hold without awaitReport
    expect(st.tombs).toHaveLength(64);
    expect(new Set(st.tombs.map((t) => t.id)).size).toBe(64);
    const ns = st.rows.map((r) => r.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });

  it('a column that rebuilds to nothing loads as no state', () => {
    const text = JSON.stringify({
      v: 1, savedAt: 7, own: ['coding', 'm', null, null], turn: 0, done: 0, failed: 0, nextN: 1, await: 0, hold: 0,
      rows: [['bad id!', 1, 'a', 'c', null, '', 1, 1, 1]], tombs: [],
    });
    expect(normalizeSubtaskState(text, 7)).toBeNull();
  });
});
