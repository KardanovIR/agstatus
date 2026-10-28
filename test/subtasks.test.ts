import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp, createWorkspace, sleep } from './helpers';
import { MAX_SESSIONS_PER_WORKSPACE, STATUSES } from '../src/store';
import { AGENT_FRAME_THROTTLE_MS, BLOCKED_STALE_MS, LIVE_STALE_MS, REPORT_HOLD_MS } from '../src/subtasks';

// Subtasks over HTTP: agent posts, turn hints and soft blocks through the real
// webhook, read back the way clients read them (the session JSON, SSE frames,
// the timeline). The rules themselves are tabled in subtasks-model.test.ts.

/** A 24-hex agent key, as the 1.7.0 hook sends (opaque to the server). */
const key = (seed: string): string => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
const A = key('a');
const B = key('b');
const X = key('x');
const Y = key('y');
const Z = key('z');

type Body = Record<string, unknown>;
interface Card {
  id: string; name: string; status: string; message: string; project: string; updatedAt: number;
  subtasks?: {
    turnEnded: boolean; running: number; blocked: number; failed: number; done: number;
    items: Array<{ id: string; n: number; label: string; state: string; activity: string }>;
  };
}

/** The compat status an agent post carries for older servers; this server ignores it. */
const compat = (state: string): string => (state === 'done' || state === 'failed' ? 'planning' : state);

/** One board, with the hook's two kinds of post and a way to read a card back. */
async function board(overrides: Parameters<typeof makeApp>[0] = {}) {
  const t = makeApp(overrides);
  const token = await createWorkspace(t.app);
  const wsId = t.store.resolveToken(token)!;
  let at = Date.now() - 60_000;
  const hook = (body: Body) => request(t.app).post(`/w/${token}/webhook`).send(body);
  const send = async (body: Body): Promise<Card | null> => (await hook(body).expect(200)).body.session;
  const main = (sid: string, status: string, message: string, extra: Body = {}) =>
    send({ session_id: sid, name: 'proj', status, message, project: 'proj', source: 'claude', ...extra });
  const sub = (sid: string, id: string, state: string, extra: Body = {}, top: Body = {}) =>
    send({ session_id: sid, status: compat(state), source: 'claude', name: 'proj', ...top, agent: { id, state, kind: 'agent', at: (at += 1), ...extra } });
  const cards = async (): Promise<Card[]> => (await request(t.app).get(`/w/${token}/api/sessions`).expect(200)).body;
  const card = async (sid: string): Promise<Card | undefined> => (await cards()).find((c) => c.id === sid);
  const history = async (sid: string): Promise<Array<{ status: string; message: string }>> =>
    (await request(t.app).get(`/w/${token}/api/sessions/${sid}/history`).expect(200)).body;
  return { ...t, token, wsId, hook, send, main, sub, cards, card, history };
}

const stop = (running: string[] | undefined, workflows?: number): Body =>
  ({ turn: running === undefined ? { phase: 'end' } : { phase: 'end', running, workflows } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subtasks: the scenarios', () => {
  it('S1 a foreground pair: rows while they run, the count after, nothing once the turn ends', async () => {
    const b = await board();
    await b.main('s1', 'planning', 'Run echo alpha and echo beta', { turn: { phase: 'start' } });
    await b.main('s1', 'planning', 'Run echo alpha');
    await b.main('s1', 'planning', 'Run echo beta');
    await b.sub('s1', A, 'planning', { label: 'Run echo alpha' });
    await b.sub('s1', B, 'planning', { label: 'Run echo beta' });
    await b.sub('s1', A, 'coding', { activity: 'Print alpha' });
    const s = await b.sub('s1', B, 'coding', { activity: 'Print beta' });
    expect(s).toMatchObject({ status: 'planning', message: 'Run echo beta' });
    expect(s!.subtasks).toEqual({
      turnEnded: false, running: 2, blocked: 0, failed: 0, done: 0,
      items: [
        { id: A, n: 1, label: 'Run echo alpha', state: 'coding', activity: 'Print alpha' },
        { id: B, n: 2, label: 'Run echo beta', state: 'coding', activity: 'Print beta' },
      ],
    });

    await b.sub('s1', A, 'done');
    const drained = await b.sub('s1', B, 'done');
    expect(drained!.subtasks).toEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 2, items: [] });

    const ended = await b.main('s1', 'done', 'Turn finished', stop([], 0));
    expect(ended).toMatchObject({ status: 'done', message: 'Turn finished' });
    expect(ended).not.toHaveProperty('subtasks');
    expect(await b.card('s1')).not.toHaveProperty('subtasks');
  });

  it('S2 a background agent: still running after Stop, then the report hold, then done', async () => {
    const b = await board();
    await b.main('s2', 'planning', 'Run echo bg in the background', { turn: { phase: 'start' } });
    await b.sub('s2', X, 'planning', { label: 'bg echo' });
    await b.sub('s2', X, 'coding', { activity: 'Print bg' });

    const afterStop = await b.main('s2', 'done', 'Turn finished', stop([X], 0));
    expect(afterStop).toMatchObject({ status: 'coding', message: '1 subagent still running' });
    expect(afterStop!.subtasks).toMatchObject({ turnEnded: true, running: 1 });

    const finished = await b.sub('s2', X, 'done');
    expect(finished).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    expect(finished!.subtasks).toEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] });

    // The hook's notification-only post carries the same line, so nothing flickers.
    const notified = await b.main('s2', 'planning', 'Reading subagent results');
    expect(notified).toMatchObject({ status: 'planning', message: 'Reading subagent results' });

    const reported = await b.main('s2', 'done', 'Turn finished', stop([], 0));
    expect(reported).toMatchObject({ status: 'done', message: 'Turn finished' });
    expect(reported).not.toHaveProperty('subtasks');
  });

  it('S3 blocked subagents: the first in start order names the line, and approval gives own back', async () => {
    const b = await board();
    await b.main('s3', 'coding', 'Editing app.ts');
    await b.sub('s3', Z, 'planning', { label: 'review:hook' });
    await b.sub('s3', Y, 'planning', { label: 'verify:hook' });

    expect(await b.sub('s3', Y, 'blocked', { activity: 'Approve: Run the hook suite' }))
      .toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook' });
    const both = await b.sub('s3', Z, 'blocked', { activity: 'Approve: Edit hook.js' });
    expect(both).toMatchObject({ status: 'blocked', message: 'Needs approval: review:hook +1' });
    expect(both!.subtasks).toMatchObject({ running: 0, blocked: 2 });

    expect(await b.sub('s3', Y, 'testing')).toMatchObject({ status: 'blocked', message: 'Needs approval: review:hook' });
    expect(await b.sub('s3', Z, 'coding')).toMatchObject({ status: 'coding', message: 'Editing app.ts' });
  });

  it('S4 a failed row stays listed through Stop, the hold and the report turn, and goes at the quiet Stop', async () => {
    const b = await board();
    await b.main('s4', 'planning', 'Fan out', { turn: { phase: 'start' } });
    await b.sub('s4', A, 'planning', { label: 'review:hook' });
    await b.sub('s4', A, 'failed', { activity: 'Failed: Agent type "reviewer" not found' });
    await b.sub('s4', X, 'coding', { label: 'bg echo' });
    const failedRow = { id: A, n: 1, label: 'review:hook', state: 'failed', activity: 'Failed: Agent type "reviewer" not found' };

    const afterStop = await b.main('s4', 'done', 'Turn finished', stop([X], 0));
    expect(afterStop).toMatchObject({ status: 'coding', message: '1 subagent still running' });
    expect(afterStop!.subtasks).toMatchObject({ failed: 1, items: [failedRow, expect.objectContaining({ id: X })] });

    const holding = await b.sub('s4', X, 'done');
    expect(holding).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    expect(holding!.subtasks).toMatchObject({ failed: 1, done: 1, items: [failedRow] });

    await b.main('s4', 'planning', 'Reading subagent results');
    const reporting = await b.main('s4', 'coding', 'Writing the summary');
    expect(reporting!.subtasks).toMatchObject({ failed: 1, items: [failedRow] });

    const quiet = await b.main('s4', 'done', 'Turn finished', stop([], 0));
    expect(quiet).not.toHaveProperty('subtasks');
  });

  it('S5 minimal mode: no label ever arrives, so rows and the line use the number', async () => {
    const b = await board();
    await b.main('s5', 'coding', 'Bash');
    const s = await b.sub('s5', A, 'coding', { activity: 'Bash' });
    expect(s!.subtasks!.items).toEqual([{ id: A, n: 1, label: 'Subagent 1', state: 'coding', activity: 'Bash' }]);
    expect(await b.sub('s5', A, 'blocked', { activity: 'Needs approval' }))
      .toMatchObject({ status: 'blocked', message: 'Needs approval: Subagent 1' });
  });

  it('S6 a finish for a card that is not on the board stores nothing; a running post makes a card that starts idle', async () => {
    const b = await board();
    const res = await b.hook({ session_id: 'ghost', status: 'planning', source: 'claude', name: 'proj', agent: { id: A, state: 'done', at: Date.now() } }).expect(200);
    expect(res.body).toEqual({ ok: true, session: null });
    await b.hook({ session_id: 'ghost', status: 'planning', agent: { id: A, state: 'failed', at: Date.now() } })
      .expect(200, { ok: true, session: null });
    expect(await b.cards()).toEqual([]);

    // At the card cap a finish evicts nothing.
    for (let i = 0; i < MAX_SESSIONS_PER_WORKSPACE; i++) await b.main(`c${i}`, 'coding', 'x');
    await b.hook({ session_id: 'one-too-many', status: 'planning', agent: { id: A, state: 'done', at: Date.now() } })
      .expect(200, { ok: true, session: null });
    const all = await b.cards();
    expect(all).toHaveLength(MAX_SESSIONS_PER_WORKSPACE);
    expect(all.some((c) => c.id === 'c0')).toBe(true);

    // Dismissed, then a blocked subagent: the card comes back, its own reading idle.
    await request(b.app).delete(`/w/${b.token}/sessions/c1`).expect(200);
    const back = await b.sub('c1', A, 'blocked', { label: 'verify:hook', activity: 'Approve: npm test' }, { name: 'Fresh name', message: 'Claude needs your permission to use Bash' });
    expect(back).toMatchObject({ name: 'Fresh name', status: 'blocked', message: 'Needs approval: verify:hook' });
    const unblocked = await b.sub('c1', A, 'coding');
    expect(unblocked).toMatchObject({ status: 'coding', message: '1 subagent still running' });
    const finished = await b.sub('c1', A, 'done');
    expect(finished).toMatchObject({ status: 'idle', message: '' });
  });

  it('S7 an unattributed prompt while a row is live is soft: the row\'s next progress gives the reading back', async () => {
    const b = await board();
    await b.main('s7', 'coding', 'Editing app.ts');
    await b.sub('s7', A, 'planning', { label: 'review:hook' });
    const asked = await b.main('s7', 'blocked', 'Claude needs your permission', { unattributed: true });
    expect(asked).toMatchObject({ status: 'blocked', message: 'Claude needs your permission' });
    expect(await b.sub('s7', A, 'coding')).toMatchObject({ status: 'coding', message: 'Editing app.ts' });

    // With nothing live the same prompt is an ordinary, hard block.
    const lone = await board();
    await lone.main('s7b', 'coding', 'Editing app.ts');
    await lone.main('s7b', 'blocked', 'Claude needs your permission', { unattributed: true });
    await lone.sub('s7b', A, 'coding');
    expect(await lone.card('s7b')).toMatchObject({ status: 'blocked', message: 'Claude needs your permission' });
  });

  it('S9 Stop reconciles: unlisted agent rows close once no workflow runs; blocked and listed rows stay', async () => {
    const b = await board();
    await b.main('s9', 'coding', 'Fan out', { turn: { phase: 'start' } });
    await b.sub('s9', A, 'coding', { label: 'gone' });
    await b.sub('s9', B, 'coding', { label: 'listed' });
    await b.sub('s9', X, 'planning', { label: 'echo:one', kind: 'workflow' });
    await b.sub('s9', Y, 'blocked', { label: 'waiting' });

    const withWorkflow = await b.main('s9', 'done', 'Turn finished', stop([B], 1));
    expect(withWorkflow!.subtasks!.items.map((i) => i.label)).toEqual(['gone', 'listed', 'echo:one', 'waiting']);

    const without = await b.main('s9', 'done', 'Turn finished', stop([B], 0));
    expect(without!.subtasks!.items.map((i) => i.label)).toEqual(['listed', 'waiting']);
    expect(without!.subtasks!.done).toBe(0); // reconciled closes are never counted
    expect(without).toMatchObject({ status: 'blocked', message: 'Needs approval: waiting' });

    // An absent list is unknown, not empty: nothing closes.
    const unknown = await b.main('s9', 'done', 'Turn finished', stop(undefined));
    expect(unknown!.subtasks!.items.map((i) => i.label)).toEqual(['listed', 'waiting']);
  });

  it('S10 SessionStart drops every row: a restarted process has none', async () => {
    const b = await board();
    await b.main('s10', 'coding', 'x');
    await b.sub('s10', A, 'coding');
    await b.sub('s10', B, 'blocked');
    const reset = await b.main('s10', 'idle', 'Session started', { turn: { phase: 'reset' } });
    expect(reset).toMatchObject({ status: 'idle', message: 'Session started' });
    expect(reset).not.toHaveProperty('subtasks');
    // A row that comes back starts again from 1.
    expect((await b.sub('s10', B, 'coding'))!.subtasks!.items).toEqual([expect.objectContaining({ id: B, n: 1 })]);
  });

  it('S11 the sweep: expiry, the hold\'s release, updatedAt + 1 and a timeline event when the reading moves', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const b = await board();

    // A working row silent for an hour closes; the card had only it to show.
    await b.main('w', 'done', 'Turn finished');
    await b.sub('w', A, 'coding', { label: 'quiet one' });
    expect(await b.card('w')).toMatchObject({ status: 'coding', message: '1 subagent still running' });
    const beforeW = (await b.card('w'))!.updatedAt;
    clock += LIVE_STALE_MS;
    expect(b.store.sweepSubtasks()).toEqual([]);
    clock += 1;
    const moved = b.store.sweepSubtasks();
    expect(moved.map((m) => [m.wsId, m.session.id, m.prevStatus])).toEqual([[b.wsId, 'w', 'coding']]);
    expect(moved[0].session).toMatchObject({ status: 'done', message: 'Turn finished', updatedAt: beforeW + 1 });
    expect(moved[0].session).not.toHaveProperty('subtasks');
    expect((await b.history('w'))[0]).toMatchObject({ status: 'done', message: 'Turn finished' });

    // A blocked row and a failed row last 6 hours.
    await b.main('bf', 'coding', 'Working');
    await b.sub('bf', B, 'blocked', { label: 'verify:hook' });
    await b.sub('bf', X, 'coding');
    await b.sub('bf', X, 'failed');
    clock += LIVE_STALE_MS + 1;
    b.store.sweepSubtasks();
    expect(await b.card('bf')).toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook' });
    clock += BLOCKED_STALE_MS;
    b.store.sweepSubtasks();
    const bf = await b.card('bf');
    expect(bf).toMatchObject({ status: 'coding', message: 'Working' });
    expect(bf).not.toHaveProperty('subtasks'); // the failed row went too

    // A hold nobody ended is released after 120 s.
    await b.main('h', 'planning', 'Go', { turn: { phase: 'start' } });
    await b.sub('h', Y, 'coding');
    await b.main('h', 'done', 'Turn finished', stop([Y], 0));
    await b.sub('h', Y, 'done');
    expect(await b.card('h')).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    const beforeH = (await b.card('h'))!.updatedAt;
    clock += REPORT_HOLD_MS;
    expect(b.store.sweepSubtasks()).toEqual([]);
    clock += 1;
    const released = b.store.sweepSubtasks();
    expect(released.map((m) => [m.session.id, m.prevStatus, m.session.status, m.session.updatedAt]))
      .toEqual([['h', 'planning', 'done', beforeH + 1]]);
    expect((await b.history('h')).slice(0, 2).map((e) => `${e.status} ${e.message}`))
      .toEqual(['done Turn finished', 'planning Reading subagent results']);
  });
});

describe('subtasks: validation', () => {
  it('refuses a malformed agent with a 400 and stores nothing', async () => {
    const b = await board();
    const error =
      'agent must be an object with id matching ^[A-Za-z0-9._:-]{1,64}$ ' +
      'and state one of planning, coding, testing, blocked, done, failed';
    for (const agent of ['x', 1, [], { state: 'coding' }, { id: 'no spaces', state: 'coding' }, { id: A, state: 'working' }, { id: 'x'.repeat(65), state: 'done' }]) {
      const res = await b.hook({ session_id: 'v', status: 'coding', agent }).expect(400);
      expect(res.body).toEqual({ error });
    }
    expect(await b.cards()).toEqual([]);
  });

  it('agent: null is a main-thread post, and a malformed turn is dropped with the post still applied', async () => {
    const b = await board();
    expect(await b.send({ session_id: 'v', status: 'testing', message: 'npm test', agent: null }))
      .toMatchObject({ status: 'testing', message: 'npm test' });
    for (const turn of ['end', { phase: 'stop' }, { phase: 'end', running: 'all' }, { phase: 'end', running: [1, 2] }]) {
      expect(await b.send({ session_id: 'v', status: 'coding', message: `turn ${JSON.stringify(turn)}`, turn }))
        .toMatchObject({ status: 'coding', message: `turn ${JSON.stringify(turn)}` });
    }
    expect(await b.send({ session_id: 'v', status: 'coding', message: 'x', unattributed: 'yes' })).toMatchObject({ status: 'coding' });
  });

  it('replaces an `at` outside the window with the time the post arrived', async () => {
    const b = await board();
    await b.main('v', 'coding', 'Working');
    await b.send({ session_id: 'v', status: 'coding', agent: { id: A, state: 'coding', at: 1e300 } });
    // Had 1e300 been kept, this ordinary update would count as older and be ignored.
    const s = await b.send({ session_id: 'v', status: 'testing', agent: { id: A, state: 'testing', at: Date.now() + 1000 } });
    expect(s!.subtasks!.items[0].state).toBe('testing');
  });

  it('an agent post never changes the parent\'s line, and names only a card it creates', async () => {
    const b = await board();
    await b.main('v', 'coding', 'Editing app.ts', { name: 'Keeper' });
    const s = await b.sub('v', A, 'coding', {}, { message: 'Claude needs your permission', name: 'Other', status: 'blocked' });
    expect(s).toMatchObject({ name: 'Keeper', status: 'coding', message: 'Editing app.ts' });
    // A card it creates is named by it, and starts with its own reading idle, so
    // the subagent shows as the turn's leftover work.
    const fresh = await b.sub('new', A, 'planning', {}, { name: 'Fresh' });
    expect(fresh).toMatchObject({ name: 'Fresh', status: 'planning', message: '1 subagent still running' });
    // With no name at all, the id, as for any card.
    const bare = await b.send({ session_id: 'bare', status: 'coding', agent: { id: B, state: 'coding', at: Date.now() } });
    expect(bare!.name).toBe('bare');
    // project and host still carry forward or set, as on every post.
    expect(await b.sub('v', A, 'coding', {}, { project: 'elsewhere' })).toMatchObject({ project: 'elsewhere' });
  });
});

describe('subtasks: compatibility', () => {
  it('a card without subtask state serializes exactly as before, key order included', async () => {
    const b = await board();
    const s = await b.main('plain', 'coding', 'Editing app.ts');
    const keys = ['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt'];
    expect(Object.keys(s!)).toEqual(keys);
    expect(Object.keys((await b.card('plain'))!)).toEqual(keys);
    // New fields from a new hook change nothing on a card with no subagents.
    const hinted = await b.main('plain', 'done', 'Turn finished', stop([], 0));
    expect(Object.keys(hinted!)).toEqual(keys);
    const blocked = await b.main('plain', 'blocked', 'Needs input', { unattributed: true });
    expect(Object.keys(blocked!)).toEqual(keys);
    // getSession, behind every frame and the snapshot, gives the same.
    expect(Object.keys(b.store.getSession(b.wsId, 'plain')!)).toEqual(keys);
  });

  it('tokens then subtasks follow the old keys, and nothing internal ever leaves', async () => {
    const b = await board();
    await b.main('t', 'coding', 'Working');
    await request(b.app).post(`/w/${b.token}/usage/sessions`).send({ source: 'claude', sessions: [{ session_id: 't', tokens: 1100000 }] }).expect(200);
    const s = await b.sub('t', A, 'blocked', { label: 'verify:hook' });
    expect(Object.keys(s!)).toEqual(['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt', 'tokens', 'subtasks']);

    const seen: string[] = [JSON.stringify(s)];
    seen.push(JSON.stringify(await b.sub('t', A, 'done')));
    seen.push(JSON.stringify(await b.main('t', 'done', 'Turn finished', stop([], 0))));
    seen.push(JSON.stringify(await b.cards()));
    for (const json of seen) {
      for (const internal of ['"own"', '"tombs"', '"nextN"', '"awaitReport"', '"holdSince"', '"sub"', '"soft"', '"savedAt"']) {
        expect(json).not.toContain(internal);
      }
    }
  });

  it('every wire status is one of the six, in every phase of a busy turn', async () => {
    const b = await board();
    const statuses = new Set<string>();
    const note = (s: Card | null) => { if (s) statuses.add(s.status); };
    note(await b.main('six', 'planning', 'Go', { turn: { phase: 'start' } }));
    note(await b.sub('six', A, 'planning'));
    note(await b.sub('six', B, 'testing'));
    note(await b.sub('six', A, 'blocked'));
    note(await b.sub('six', A, 'failed'));
    note(await b.main('six', 'done', 'Turn finished', stop([B], 0)));
    note(await b.sub('six', B, 'done'));
    note(await b.main('six', 'planning', 'Reading subagent results'));
    note(await b.main('six', 'done', 'Turn finished', stop([], 0)));
    for (const s of statuses) expect(STATUSES).toContain(s);
  });

  it('labels and activities are clipped without splitting a surrogate pair', async () => {
    // The webhook's own strings are checked beside the other cleaning tests (legacy.test.ts).
    const b = await board();
    await b.main('utf', 'coding', 'Working');
    const sub = await b.sub('utf', A, 'coding', { label: 'l'.repeat(63) + '\u{1F600}', activity: 'a\uDE00b' });
    expect(sub!.subtasks!.items[0]).toMatchObject({ label: 'l'.repeat(63), activity: 'ab' });
    const blocked = await b.sub('utf', A, 'blocked');
    expect(blocked!.message).toBe(`Needs approval: ${'l'.repeat(63)}`);
  });
});

// ---- SSE ------------------------------------------------------------------

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

/** An open stream, read in the background into a list of parsed frames. */
async function openFrames(base: string, token: string, signal: AbortSignal) {
  const res = await fetch(`${base}/w/${token}/events`, { signal, headers: { accept: 'text/event-stream' } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = [];
  let buf = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  const sessionFrames = (id: string) => frames.filter((f) => f.event === 'session' && f.data.id === id).map((f) => f.data);
  const until = async (fn: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  };
  await until(() => frames.some((f) => f.event === 'snapshot'), 'the snapshot');
  return { frames, sessionFrames, until };
}

describe('subtasks: agent frames are throttled per session', () => {
  it('five agent posts in quick succession make two frames, the last carrying all five', async () => {
    const { app, store } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const token = (await (await fetch(`${base}/api/workspaces`, { method: 'POST' })).json()).token as string;
      const post = (body: Body) => fetch(`${base}/w/${token}/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.json());
      await post({ session_id: 'th', status: 'coding', message: 'Working' });
      const stream = await openFrames(base, token, ac.signal);

      // A quiet window first, so the burst's first frame goes at once. Then the
      // five together, as a burst of SubagentStart hooks would arrive.
      await sleep(AGENT_FRAME_THROTTLE_MS + 50);
      const started = Date.now();
      await Promise.all([1, 2, 3, 4, 5].map((i) =>
        post({ session_id: 'th', status: 'planning', agent: { id: key(`job ${i}`), state: 'planning', label: `job ${i}`, at: Date.now() } })));
      expect(Date.now() - started).toBeLessThan(AGENT_FRAME_THROTTLE_MS); // the burst fits one window
      await sleep(AGENT_FRAME_THROTTLE_MS * 2);
      // One at once, one trailing frame for the other four. Unthrottled it was five.
      const frames = stream.sessionFrames('th');
      expect(frames).toHaveLength(2);
      expect(frames[frames.length - 1].subtasks.items.map((i: { label: string }) => i.label).sort())
        .toEqual(['job 1', 'job 2', 'job 3', 'job 4', 'job 5']);
      expect(store.getSession(store.resolveToken(token)!, 'th')!.subtasks!.items).toHaveLength(5);
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });

  it('a main-thread post between agent posts is broadcast at once, and a status change is never held', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const token = (await (await fetch(`${base}/api/workspaces`, { method: 'POST' })).json()).token as string;
      const post = (body: Body) => fetch(`${base}/w/${token}/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.json());
      await post({ session_id: 'mx', status: 'coding', message: 'Working' });
      const stream = await openFrames(base, token, ac.signal);
      await sleep(AGENT_FRAME_THROTTLE_MS + 50);

      // A goes at once; B, inside the window, leaves a trailing frame waiting.
      await post({ session_id: 'mx', status: 'planning', agent: { id: A, state: 'planning', at: Date.now() } });
      await post({ session_id: 'mx', status: 'planning', agent: { id: B, state: 'planning', at: Date.now() } });
      const sentAt = Date.now();
      await post({ session_id: 'mx', status: 'testing', message: 'npm test' });
      await stream.until(() => stream.sessionFrames('mx').some((f) => f.message === 'npm test'), 'the main-thread frame');
      expect(Date.now() - sentAt).toBeLessThan(AGENT_FRAME_THROTTLE_MS);
      // It carried both rows, and it replaced the trailing frame B had waiting:
      // A's frame and this one, and nothing after.
      await sleep(AGENT_FRAME_THROTTLE_MS * 2);
      const frames = stream.sessionFrames('mx');
      expect(frames).toHaveLength(2);
      expect(frames.at(-1)).toMatchObject({ status: 'testing', message: 'npm test' });
      expect(frames.at(-1).subtasks.items.map((i: { id: string }) => i.id)).toEqual([A, B]);

      // A blocked subagent changes the card's status: its frame is not held back either.
      const blockedAt = Date.now();
      await post({ session_id: 'mx', status: 'blocked', agent: { id: A, state: 'blocked', label: 'verify:hook', at: Date.now() } });
      await stream.until(() => stream.sessionFrames('mx').some((f) => f.status === 'blocked'), 'the blocked frame');
      expect(Date.now() - blockedAt).toBeLessThan(AGENT_FRAME_THROTTLE_MS);
      expect(stream.sessionFrames('mx').at(-1)).toMatchObject({ message: 'Needs approval: verify:hook' });
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });
});

describe('subtasks: legacy mode', () => {
  it('works on a single-tenant board, whose sweep runs although cards never expire there', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { app, store } = makeApp({ multiTenant: false });
    await request(app).post('/webhook').send({ session_id: 'leg', status: 'done', message: 'Turn finished' }).expect(200);
    const res = await request(app).post('/webhook')
      .send({ session_id: 'leg', status: 'coding', agent: { id: A, state: 'coding', label: 'bg echo', at: clock } }).expect(200);
    expect(res.body.session).toMatchObject({ status: 'coding', message: '1 subagent still running' });
    const list = await request(app).get('/api/sessions').expect(200);
    expect(list.body[0].subtasks.items).toEqual([{ id: A, n: 1, label: 'bg echo', state: 'coding', activity: '' }]);
    await request(app).post('/webhook').send({ session_id: 'gone', status: 'planning', agent: { id: B, state: 'done' } })
      .expect(200, { ok: true, session: null });

    clock += LIVE_STALE_MS + 1;
    expect(store.sweepSubtasks().map((m) => m.session.id)).toEqual(['leg']);
    expect((await request(app).get('/api/sessions').expect(200)).body[0]).toMatchObject({ status: 'done', message: 'Turn finished' });
  });
});

// ---- the golden request bodies (spec §2.7) ----------------------------------

const FIXTURES = path.join(__dirname, 'fixtures', 'subtasks');
const fixture = (name: string): { requests: Body[]; context?: Body[]; interrupt?: Body[] } =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const KEYS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8')) as {
  base: string;
  agents: Record<string, { raw: string; session: string; source: string; key: string }>;
};
const K = (name: string): string => KEYS.agents[name].key;
// The fixtures keep the probes' own clocks; replayed, they are moved to now so
// the server's 7-day window on `at` keeps them, spacing and order intact.
const FIXTURE_EPOCH = 1_793_139_300_000;

describe('subtasks: the golden request bodies', () => {
  it('every agent key is the hash the hook computes', () => {
    for (const [name, a] of Object.entries(KEYS.agents)) {
      const expected = crypto.createHash('sha256')
        .update(`${KEYS.base}\n${a.source}\n${a.session}\n${a.raw}`).digest('hex').slice(0, 24);
      expect(a.key, name).toBe(expected);
    }
    const files = fs.readdirSync(FIXTURES).filter((f) => /^G\d/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(19);
    const known = new Set(Object.values(KEYS.agents).map((a) => a.key));
    for (const file of files) {
      const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
      for (const id of text.match(/"[0-9a-f]{24}"/g) ?? []) expect(known.has(id.slice(1, -1)), `${file} ${id}`).toBe(true);
    }
  });

  /** Posts a fixture's context, then its requests, moving every `at` to now; returns the last session. */
  async function replay(b: Awaited<ReturnType<typeof board>>, name: string, part: 'requests' | 'interrupt' = 'requests'): Promise<Card | null> {
    const f = fixture(name);
    const shift = Date.now() - FIXTURE_EPOCH;
    let last: Card | null = null;
    for (const body of [...(part === 'requests' ? f.context ?? [] : []), ...(f[part] ?? [])]) {
      const copy = JSON.parse(JSON.stringify(body)) as Body & { agent?: { at: number } };
      if (copy.agent) copy.agent.at += shift;
      last = await b.send(copy);
    }
    return last;
  }

  it('run a: turn start, launch, start, tool, class change, stop, then the quiet Stop', async () => {
    const b = await board();
    const sid = KEYS.agents.a.session;
    expect(await replay(b, 'G10-turn-start')).toMatchObject({ status: 'planning', message: 'Run echo alpha and echo beta in two subagents' });
    expect(await replay(b, 'G01-parent-agent-launch')).toMatchObject({ status: 'planning', message: 'Run echo alpha' });
    const started = await replay(b, 'G02-subagent-start');
    expect(started).toMatchObject({ name: 'proj', status: 'planning', message: 'Run echo alpha' });
    expect(started!.subtasks).toEqual({
      turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
      items: [{ id: K('a'), n: 1, label: 'Run echo alpha', state: 'planning', activity: '' }],
    });
    expect((await replay(b, 'G03-subagent-tool'))!.subtasks!.items[0]).toMatchObject({ state: 'coding', activity: 'Print alpha' });
    expect((await replay(b, 'G04-class-change'))!.subtasks!.items[0]).toMatchObject({ state: 'testing', activity: 'npm test' });
    const stopped = await replay(b, 'G05-subagent-stop');
    expect(stopped).toMatchObject({ status: 'planning', message: 'Run echo alpha' });
    expect(stopped!.subtasks).toEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] });
    const ended = await b.send({ session_id: sid, name: 'proj', status: 'done', message: 'Turn finished', project: 'proj', source: 'claude', turn: { phase: 'end', running: [], workflows: 0 } });
    expect(ended).toMatchObject({ status: 'done', message: 'Turn finished' });
    expect(ended).not.toHaveProperty('subtasks');
  });

  it('run c: a background agent through Stop, its stop, the notification and the report turn', async () => {
    const b = await board();
    const sid = KEYS.agents.c.session;
    const labelled = await replay(b, 'G17-label-post');
    expect(labelled!.subtasks!.items).toEqual([{ id: K('c'), n: 1, label: 'bg echo', state: 'planning', activity: '' }]);
    const afterStop = await replay(b, 'G07-stop-background-running');
    expect(afterStop).toMatchObject({ status: 'planning', message: '1 subagent still running' });
    expect(afterStop!.subtasks!.turnEnded).toBe(true);
    // Its SubagentStop, then the notification-only prompt.
    const shift = Date.now() - FIXTURE_EPOCH;
    const done = await b.send({ session_id: sid, status: 'planning', source: 'claude', name: 'proj', agent: { id: K('c'), state: 'done', kind: 'agent', label: 'bg echo', at: 1793138847770 + shift } });
    expect(done).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    expect(await replay(b, 'G09a-notification-only')).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    const reported = await b.send({ session_id: sid, name: 'proj', status: 'done', message: 'Turn finished', project: 'proj', source: 'claude', turn: { phase: 'end', running: [], workflows: 0 } });
    expect(reported).toMatchObject({ status: 'done', message: 'Turn finished' });
    expect(reported).not.toHaveProperty('subtasks');
  });

  it('run c with its stop lost: the notification closes the row and counts it', async () => {
    const b = await board();
    await replay(b, 'G17-label-post');
    await replay(b, 'G07-stop-background-running');
    const healed = await replay(b, 'G09b-notification-lost-stop');
    expect(healed).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
    expect(healed!.subtasks).toEqual({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] });
  });

  it('run e: a workflow announced at Stop keeps its rows, and holds once they finish', async () => {
    const b = await board();
    const afterStop = await replay(b, 'G08-stop-workflow-running');
    expect(afterStop).toMatchObject({ status: 'planning', message: '1 subagent still running' });
    expect(afterStop!.subtasks!.items).toEqual([{ id: K('e1'), n: 1, label: 'echo:one', state: 'planning', activity: '' }]);
    const shift = Date.now() - FIXTURE_EPOCH;
    const done = await b.send({ session_id: KEYS.agents.e1.session, status: 'planning', source: 'claude', name: 'proj', agent: { id: K('e1'), state: 'done', kind: 'workflow', label: 'echo:one', at: 1793139064829 + shift } });
    expect(done).toMatchObject({ status: 'planning', message: 'Reading subagent results' });
  });

  it('minimal mode, failure, reset, the unknown-agent path and an unattributed prompt', async () => {
    const minimal = await board();
    const m = await replay(minimal, 'G11-minimal');
    expect(m!.subtasks!.items).toEqual([{ id: K('a'), n: 1, label: 'Subagent 1', state: 'coding', activity: 'Bash' }]);

    const failed = await board();
    const f = await replay(failed, 'G15-failed');
    expect(f!.subtasks).toMatchObject({ failed: 1, running: 0 });
    expect(f!.subtasks!.items).toEqual([{ id: K('a'), n: 1, label: 'Run echo alpha', state: 'failed', activity: 'Failed: Agent type "reviewer" not found' }]);
    const sid = KEYS.agents.a.session;
    // The interrupt variant, on a card of its own.
    const fresh = await board();
    await replay(fresh, 'G02-subagent-start');
    expect((await replay(fresh, 'G15-failed', 'interrupt'))!.subtasks!.items[0]).toMatchObject({ state: 'failed', activity: 'Stopped' });

    const reset = await replay(failed, 'G16-session-start');
    expect(reset).toMatchObject({ id: sid, status: 'idle', message: 'Session started' });
    expect(reset).not.toHaveProperty('subtasks');

    const unknown = await board();
    const u = await replay(unknown, 'G20-unknown-agent');
    expect(Object.keys(u!)).toEqual(['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt']);
    expect(u).toMatchObject({ status: 'coding', message: 'Say hi', host: null });

    const soft = await board();
    await soft.main(sid, 'coding', 'Editing app.ts');
    expect(await replay(soft, 'G21-unattributed')).toMatchObject({ status: 'blocked', message: 'Claude needs your permission' });
    const progressed = await soft.send({ session_id: sid, status: 'coding', source: 'claude', name: 'proj', agent: { id: K('a'), state: 'coding', kind: 'agent', at: Date.now() } });
    expect(progressed).toMatchObject({ status: 'coding', message: 'Editing app.ts' });
  });

  it('an attributed block, and a Codex root with its sub-agent', async () => {
    const b = await board();
    const blocked = await replay(b, 'G14-blocked-attributed');
    expect(blocked).toMatchObject({ status: 'blocked', message: 'Needs approval: try touch' });
    expect(blocked!.subtasks!.items).toEqual([{ id: K('d2'), n: 1, label: 'try touch', state: 'blocked', activity: 'Approve: Create empty file denied-probe.txt' }]);

    const codex = await board();
    expect(await replay(codex, 'G19-codex-prompt')).toMatchObject({ source: 'codex', status: 'planning', message: 'Processing prompt' });
    const started = await replay(codex, 'G12-codex-start');
    expect(started!.subtasks!.items).toEqual([{ id: K('cx'), n: 1, label: 'Feynman', state: 'planning', activity: '' }]);
    expect(await replay(codex, 'G13-codex-permission')).toMatchObject({ status: 'blocked', message: 'Needs approval: Feynman' });
  });
});
