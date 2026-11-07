import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { makeApp, createWorkspace } from './helpers';
import { STATUSES } from '../src/store';
import {
  ACTIVITY_MAX,
  AGENT_ID_RE,
  LABEL_MAX,
  MAX_FAILED_ROWS,
  MAX_LIVE_ROWS,
  REPORT_HOLD_MESSAGE,
  RUNNING_RE,
  safeClip,
  WIRE_SUBTASKS_MAX_BYTES,
} from '../src/subtasks';

// The session JSON clients decode (spec 5), checked on the server's own output.
//
// fixtures/subtasks/wire/ is what a 1.7.0 server answered after a seed drove
// it through thirteen scenarios with bodies shaped exactly as the 1.7.0 hook
// sends them: GET /api/sessions for each scenario's session and for the whole
// board, and the snapshot frame that opens GET /events. scenarios.json says
// what each one shows. The web board and both apps are built and tested
// against these states, so every promise spec 5 makes a client is asserted on
// every session here: a capture edited, or regenerated, into a state the
// server must never send fails, and so does one that stops showing what its
// scenario is for. And each capture is rebuilt on this server from nothing but
// what it shows, which must give it back byte for byte: when the server's
// output changes, the captures the clients test against have to change too.

type Json = Record<string, any>;

const WIRE = path.join(__dirname, 'fixtures', 'subtasks', 'wire');
const read = (name: string): string => fs.readFileSync(path.join(WIRE, name), 'utf8');

const SCENARIOS = JSON.parse(read('scenarios.json')) as Record<string, { session: string; name: string; source: string; story: string }>;
const BOARD = JSON.parse(read('sessions-all.json')) as Json[];
const captured = (scenario: string): Json[] => JSON.parse(read(`sessions-${scenario}.json`)) as Json[];
const session = (scenario: string): Json => captured(scenario)[0];

// Spec 5's numbers, written out rather than imported: the contract is with
// clients already built against them. The server's own bounds are checked
// against these below.
const SPEC = { label: 64, activity: 80, items: 56, failedListed: 8, liveListed: 48, bytes: 8192 };

const SESSION_KEYS = ['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt'];
const SUBTASKS_KEYS = ['turnEnded', 'running', 'blocked', 'failed', 'done', 'items'];
const ITEM_KEYS = ['id', 'n', 'label', 'state', 'activity'];
const ITEM_STATES = ['planning', 'coding', 'testing', 'blocked', 'failed'];
const WORKING = ['planning', 'coding', 'testing'];
/** The order "busiest" means after the turn (spec 4.5). */
const BUSIEST = ['testing', 'coding', 'planning'];
// What the server keeps per session and never sends. A row's own internals
// (kind, at, startedAt, updatedAt) are ruled out by the item layout itself.
const INTERNAL = ['own', 'soft', 'sub', 'tombs', 'nextN', 'awaitReport', 'holdSince', 'savedAt', 'startedAt'];
// Spec 3.10: what minimal mode may say a subagent is doing.
const MINIMAL_ACTIVITIES = [
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'Bash', 'Agent', 'Task', 'WebSearch', 'WebFetch',
  'Workflow', 'Read', 'Glob', 'Grep', 'Skill', 'Needs approval', 'Failed', 'Stopped', 'Blocked', '',
];
// Characters no card can print. The server strips them from every string.
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
/** Text a client can draw as it is: no control characters, and no half of a surrogate pair (Swift's decoder rejects a whole snapshot over one). */
const printable = (v: string): boolean => !CONTROL_RE.test(v) && safeClip(v, v.length) === v;
const where = (s: Json, i?: Json): string => (i ? `${s.id} item n${i.n}` : String(s.id));
/** Spec 6.1: what a client draws. WORKING is computed, never sent. */
const display = (s: Json): string =>
  s.subtasks?.turnEnded && s.status !== 'blocked' && s.subtasks.running > 0 ? 'working' : s.status;

describe('subtasks: the session JSON clients decode (spec 5)', () => {
  it('holds one capture per scenario, and the whole board they make', () => {
    const files = fs.readdirSync(WIRE).filter((f) => /^sessions-.+\.json$/.test(f) && f !== 'sessions-all.json');
    expect(files.map((f) => f.slice('sessions-'.length, -'.json'.length)).sort()).toEqual(Object.keys(SCENARIOS).sort());
    for (const [scenario, entry] of Object.entries(SCENARIOS)) {
      const sessions = captured(scenario);
      expect(sessions, scenario).toHaveLength(1);
      expect(sessions[0], scenario).toMatchObject({ id: entry.session, name: entry.name, source: entry.source });
      // The scenario's capture is the board's own card, value for value.
      expect(BOARD.find((s) => s.id === entry.session), scenario).toStrictEqual(sessions[0]);
    }
    expect(BOARD).toHaveLength(Object.keys(SCENARIOS).length);
    expect(new Set(BOARD.map((s) => s.id)).size).toBe(BOARD.length);
    // GET /api/sessions answers the most recently updated first.
    const updated = BOARD.map((s) => s.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
  });

  it('opens the event stream with the same board, as one array', () => {
    // Both apps decode the snapshot as one array, so one bad session there
    // would drop the whole board (SSEClient.swift, SseClient.kt).
    const frame = /^event: snapshot\ndata: (.*)\n\n$/.exec(read('snapshot.sse'));
    expect(frame).not.toBeNull();
    expect(JSON.parse(frame![1])).toStrictEqual(BOARD);
    expect(frame![1]).toBe(JSON.stringify(BOARD));
  });

  it('lays every session out in the documented order, with nothing internal', () => {
    for (const s of BOARD) {
      const keys = Object.keys(s);
      expect(keys.slice(0, SESSION_KEYS.length), where(s)).toEqual(SESSION_KEYS);
      // Then tokens, then subtasks, each only when there is something to say.
      expect(keys.slice(SESSION_KEYS.length), where(s)).toEqual(['tokens', 'subtasks'].filter((k) => k in s));
      if (!('subtasks' in s)) continue;
      expect(Object.keys(s.subtasks), where(s)).toEqual(SUBTASKS_KEYS);
      for (const item of s.subtasks.items) expect(Object.keys(item), where(s, item)).toEqual(ITEM_KEYS);
    }
    const text = read('sessions-all.json');
    for (const key of INTERNAL) expect(text, key).not.toContain(`"${key}":`);
  });

  it('sends the documented types, and only the six statuses', () => {
    for (const s of BOARD) {
      for (const key of ['id', 'name', 'message', 'project', 'source']) {
        expect(typeof s[key], `${where(s)} ${key}`).toBe('string');
        expect(printable(s[key]), `${where(s)} ${key}`).toBe(true);
      }
      expect(s.id.length, where(s)).toBeGreaterThan(0);
      // `failed` and `working` are a row state and a client reading, never a session status.
      expect(STATUSES, where(s)).toContain(s.status);
      expect(s.host === null || (typeof s.host === 'object' && !Array.isArray(s.host)), where(s)).toBe(true);
      expect(Number.isInteger(s.createdAt) && Number.isInteger(s.updatedAt), where(s)).toBe(true);
      expect(s.createdAt, where(s)).toBeLessThanOrEqual(s.updatedAt);
      if ('tokens' in s) expect(isCount(s.tokens), where(s)).toBe(true);
      if (!('subtasks' in s)) continue;

      const st = s.subtasks;
      expect(typeof st.turnEnded, where(s)).toBe('boolean');
      for (const key of ['running', 'blocked', 'failed', 'done']) expect(isCount(st[key]), `${where(s)} ${key}`).toBe(true);
      expect(Array.isArray(st.items), where(s)).toBe(true);
      for (const item of st.items) {
        expect(typeof item.id, where(s, item)).toBe('string');
        expect(Number.isInteger(item.n), where(s, item)).toBe(true);
        expect(typeof item.label, where(s, item)).toBe('string');
        expect(typeof item.activity, where(s, item)).toBe('string');
        // `researching` is never sent, nor is `done`: a finished row leaves the list.
        expect(ITEM_STATES, where(s, item)).toContain(item.state);
      }
    }
  });

  it('counts exactly what the items show, within the listing caps', () => {
    for (const s of BOARD) {
      if (!('subtasks' in s)) continue;
      const { items } = s.subtasks;
      const failedItems = items.filter((i: Json) => i.state === 'failed').length;
      expect(s.subtasks.running, where(s)).toBe(items.filter((i: Json) => WORKING.includes(i.state)).length);
      expect(s.subtasks.blocked, where(s)).toBe(items.filter((i: Json) => i.state === 'blocked').length);
      // Every live subagent is listed; failed rows are listed up to a cap, and
      // the failed count stays exact past it.
      expect(s.subtasks.running + s.subtasks.blocked, where(s)).toBeLessThanOrEqual(SPEC.liveListed);
      expect(failedItems, where(s)).toBeLessThanOrEqual(SPEC.failedListed);
      expect(items.length, where(s)).toBeLessThanOrEqual(SPEC.items);
      if (failedItems < SPEC.failedListed) expect(s.subtasks.failed, where(s)).toBe(failedItems);
      else expect(s.subtasks.failed, where(s)).toBeGreaterThanOrEqual(failedItems);
    }
  });

  it('lists items in start order, each with a stable, unique ordinal and an opaque id', () => {
    for (const s of BOARD) {
      if (!('subtasks' in s)) continue;
      const ns = s.subtasks.items.map((i: Json) => i.n);
      expect(ns.every((n: number) => n >= 1), where(s)).toBe(true);
      // Strictly ascending: start order, and no ordinal twice.
      expect(ns.every((n: number, k: number) => k === 0 || n > ns[k - 1]), where(s)).toBe(true);
      for (const item of s.subtasks.items) {
        // Safe in a quoted attribute selector, which is how the web board finds a row.
        expect(item.id, where(s, item)).toMatch(AGENT_ID_RE);
        // What a 1.7.0 hook sends: the agent key, never the raw agent_id.
        expect(item.id, where(s, item)).toMatch(/^[0-9a-f]{24}$/);
      }
      expect(new Set(s.subtasks.items.map((i: Json) => i.id)).size, where(s)).toBe(s.subtasks.items.length);
    }
  });

  it('gives every item a label and an activity a client can print as they are', () => {
    for (const s of BOARD) {
      if (!('subtasks' in s)) continue;
      for (const item of s.subtasks.items) {
        // Never empty: the server writes `Subagent <n>` when it knows no label.
        expect(item.label.trim().length, where(s, item)).toBeGreaterThan(0);
        expect(item.label.length, where(s, item)).toBeLessThanOrEqual(SPEC.label);
        expect(printable(item.label), where(s, item)).toBe(true);
        // May be '': a subagent that has not called a tool yet.
        expect(item.activity.length, where(s, item)).toBeLessThanOrEqual(SPEC.activity);
        expect(printable(item.activity), where(s, item)).toBe(true);
      }
    }
  });

  it('never sends an empty block, and keeps each one inside its frame budget', () => {
    for (const s of BOARD) {
      if (!('subtasks' in s)) continue;
      // Absent is how "nothing to show" is said; clients read `items: []` with
      // `done: 0` the same way, but the server never sends it.
      expect(s.subtasks.items.length > 0 || s.subtasks.done > 0, where(s)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(s.subtasks)), where(s)).toBeLessThanOrEqual(SPEC.bytes);
    }
  });

  it('reads a status and message that agree with the rows', () => {
    for (const s of BOARD) {
      const st = s.subtasks;
      const live = st ? st.running + st.blocked : 0;
      // The two lines only the server composes come with the rows behind them.
      const needsApproval = s.message.startsWith('Needs approval: ');
      const stillRunning = RUNNING_RE.test(s.message);
      if (!st) {
        expect(needsApproval || stillRunning, where(s)).toBe(false);
        continue;
      }
      // turnEnded: the parent's turn is over and some subagent is still live.
      if (st.turnEnded) expect(live, where(s)).toBeGreaterThan(0);
      // A subagent waiting for approval blocks the card, whatever else runs.
      if (st.blocked > 0) expect(s.status, where(s)).toBe('blocked');
      if (needsApproval) {
        const first = st.items.find((i: Json) => i.state === 'blocked');
        expect(first, where(s)).toBeDefined();
        expect(s.message, where(s)).toBe(`Needs approval: ${first.label}${st.blocked > 1 ? ` +${st.blocked - 1}` : ''}`);
      }
      // After the turn, while subagents still work: the busiest of them, and how many.
      expect(stillRunning, where(s)).toBe(st.turnEnded && st.blocked === 0);
      if (stillRunning) {
        const working = st.items.filter((i: Json) => WORKING.includes(i.state));
        expect(s.status, where(s)).toBe(BUSIEST.find((c) => working.some((i: Json) => i.state === c)));
        expect(s.message, where(s)).toBe(`${st.running} ${st.running === 1 ? 'subagent' : 'subagents'} still running`);
      }
      // The report hold reads planning, and is never WORKING.
      if (s.message === REPORT_HOLD_MESSAGE) {
        expect(s.status, where(s)).toBe('planning');
        expect(st.turnEnded, where(s)).toBe(false);
      }
    }
  });

  // Each scenario is there for one state a client has to draw; this keeps it showing that state.
  const STORIES: Record<string, (s: Json) => void> = {
    none: (s) => expect(s).not.toHaveProperty('subtasks'),
    two: (s) => {
      expect(s).toMatchObject({ status: 'planning', message: 'Draft release notes' });
      expect(s.subtasks.items.map((i: Json) => i.state)).toEqual(['testing', 'coding']);
    },
    ten: (s) => {
      expect(s.subtasks).toMatchObject({ running: 10, done: 15 });
      expect(s.subtasks.items.map((i: Json) => i.n)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    },
    thirty: (s) => expect(s.subtasks).toMatchObject({ running: 30, blocked: 0, done: 186 }),
    // Spec 5's own example.
    blocked: (s) => {
      expect(s).toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook' });
      expect(s.subtasks).toMatchObject({ turnEnded: false, running: 9, blocked: 1, failed: 0, done: 15 });
    },
    'two-blocked': (s) => {
      expect(s).toMatchObject({ status: 'blocked', message: 'Needs approval: Audit the Android strings +1' });
      expect(s.subtasks.items.filter((i: Json) => i.state === 'blocked').map((i: Json) => i.n)).toEqual([3, 5]);
    },
    failed: (s) => {
      expect(s.subtasks).toMatchObject({ running: 2, failed: 1, done: 4 });
      expect(s.subtasks.items.find((i: Json) => i.state === 'failed').activity).toBe('Failed: API error (overloaded)');
    },
    // A count with nothing running: it stays until the turn ends.
    finished: (s) => expect(s.subtasks).toStrictEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 12, items: [] }),
    background: (s) => {
      expect(s).toMatchObject({ status: 'testing', message: '2 subagents still running' });
      expect(s.subtasks).toMatchObject({ turnEnded: true, running: 2, done: 3 });
      expect(display(s)).toBe('working');
    },
    hold: (s) => {
      expect(s).toMatchObject({ status: 'planning', message: REPORT_HOLD_MESSAGE });
      expect(s.subtasks).toStrictEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 3, items: [] });
    },
    // Labels from the server, tool names for activities, the folder as name.
    minimal: (s) => {
      expect(s.name).toBe(s.project);
      for (const i of s.subtasks.items) {
        expect(i.label).toBe(`Subagent ${i.n}`);
        expect(MINIMAL_ACTIVITIES).toContain(i.activity);
      }
    },
    codex: (s) => {
      expect(s.source).toBe('codex');
      expect(s.subtasks.items.map((i: Json) => i.label)).toEqual(['Feynman', 'Noether', 'Hypatia']);
      expect(s.subtasks.items.some((i: Json) => i.activity === '')).toBe(true);
    },
    // Near the caps: labels at the p90 length, an activity cut at exactly 80.
    long: (s) => {
      for (const i of s.subtasks.items) expect(i.label.length).toBeGreaterThanOrEqual(50);
      expect(s.subtasks.items.some((i: Json) => i.activity.length === SPEC.activity)).toBe(true);
    },
  };

  it('keeps every scenario showing the state it is there for', () => {
    expect(Object.keys(STORIES).sort()).toEqual(Object.keys(SCENARIOS).sort());
    for (const [scenario, check] of Object.entries(STORIES)) {
      try {
        check(session(scenario));
      } catch (err) {
        throw new Error(`${scenario} (${SCENARIOS[scenario].story}): ${(err as Error).message}`);
      }
    }
    // Between them, every reading a card with subagents can have.
    const drawn = new Set(BOARD.filter((s) => 'subtasks' in s).map(display));
    for (const reading of ['planning', 'coding', 'blocked', 'working']) expect(drawn, reading).toContain(reading);
  });

  it('checks the server against the numbers spec 5 gives clients', () => {
    expect({
      label: LABEL_MAX,
      activity: ACTIVITY_MAX,
      items: MAX_LIVE_ROWS + MAX_FAILED_ROWS,
      failedListed: MAX_FAILED_ROWS,
      liveListed: MAX_LIVE_ROWS,
      bytes: WIRE_SUBTASKS_MAX_BYTES,
    }).toEqual(SPEC);
  });
});

/**
 * Drives a fresh board to one captured session using only what the capture
 * shows, through the webhook as the hook posts: a turn starts; every ordinal
 * below the highest listed one is a subagent that started and finished, and
 * so counted done, as is whatever done count is left after them; the listed
 * rows start in order and are then left in their states; and the parent's
 * line goes last, its Stop when the turn is over. A line only the server
 * composes ("Needs approval: …", "… still running") is never posted: the
 * server has to arrive at it. Returns the session as the board then serves it.
 */
async function rebuild(s: Json): Promise<Json> {
  const t = makeApp();
  const token = await createWorkspace(t.app);
  let at = Date.now();
  const send = (body: Json) => request(t.app).post(`/w/${token}/webhook`).send(body).expect(200);
  const main = (status: string, message: string, turn?: Json) =>
    send({ session_id: s.id, name: s.name, status, message, project: s.project, source: s.source, ...(turn ? { turn } : {}) });
  const kind = s.source === 'codex' ? 'codex' : 'agent';
  // `status` is the compat status only older servers read; a finish carries a running class.
  const agent = (id: string, state: string, extra: Json = {}) =>
    send({
      session_id: s.id, name: s.name, status: state === 'done' || state === 'failed' ? 'planning' : state, source: s.source,
      agent: { id, state, kind, at: (at += 1), ...extra },
    });
  const finished = async (n: number): Promise<void> => {
    const id = crypto.createHash('sha256').update(`finished ${n}`).digest('hex').slice(0, 24);
    await agent(id, 'planning');
    await agent(id, 'done');
  };

  await main('idle', 'Session started', { phase: 'reset' });
  await main('planning', 'Processing prompt', { phase: 'start' });
  const st = s.subtasks;
  if (st) {
    const listed = new Map<number, Json>(st.items.map((i: Json) => [i.n, i]));
    const top = Math.max(0, ...listed.keys());
    let done = 0;
    for (let n = 1; n <= top; n += 1) {
      const item = listed.get(n);
      if (!item) {
        await finished(n);
        done += 1;
      } else {
        // A label the server would write itself is one the hook never sent.
        await agent(item.id, 'planning', item.label === `Subagent ${n}` ? {} : { label: item.label });
      }
    }
    for (let n = top + 1; done < st.done; n += 1, done += 1) await finished(n);
    for (const item of st.items) {
      if (item.state !== 'planning' || item.activity !== '') await agent(item.id, item.state, { activity: item.activity });
    }
  }
  if (st?.turnEnded) {
    const running = st.items.filter((i: Json) => i.state !== 'failed').map((i: Json) => i.id);
    await main('done', 'Turn finished', s.source === 'claude' ? { phase: 'end', running, workflows: 0 } : { phase: 'end' });
  } else if (s.message.startsWith('Needs approval: ') || RUNNING_RE.test(s.message)) {
    await main('planning', 'Waiting on subagents');
  } else {
    await main(s.status, s.message);
  }
  const served = (await request(t.app).get(`/w/${token}/api/sessions`).expect(200)).body as Json[];
  expect(served).toHaveLength(1);
  return served[0];
}

describe('subtasks: each capture is what this server sends', () => {
  it.each(Object.keys(SCENARIOS))('%s', async (scenario) => {
    const capture = session(scenario);
    const rebuilt = await rebuild(capture);
    // The clock is the only thing a rebuild cannot reproduce.
    const timeless = (s: Json) => JSON.stringify({ ...s, createdAt: 0, updatedAt: 0 });
    expect(timeless(rebuilt)).toBe(timeless(capture));
  });
});
