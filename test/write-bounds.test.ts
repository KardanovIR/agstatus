import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import {
  makeApp,
  createWorkspace,
  webhookBody,
  TEST_PG_URL,
  suiteDatabaseUrl,
  resetTables,
  sql,
  type TestApp,
} from './helpers';
import {
  dayKey,
  DEVICE_RETIRED_WINDOW_DAYS,
  LEGACY_WS,
  MAX_PROJECT_DAYS_PER_WORKSPACE,
  MAX_SESSIONS_PER_WORKSPACE,
  MAX_USAGE_SOURCES_PER_WORKSPACE,
  MAX_USAGE_WINDOWS,
  type Store,
} from '../src/store';

/*
 * What one token can make the server hold. Every cap here REFUSES the new
 * thing rather than evicting an old one: an eviction only flags its row, so it
 * bounds memory and leaves Postgres to grow, while a refusal bounds both. The
 * in-memory store has no load path, so everything about a restart is in the
 * Postgres block at the bottom (CI runs it; locally it needs TEST_DATABASE_URL).
 */

const DAY = 24 * 60 * 60 * 1000;
// Noon UTC today, so no assertion about "today ± n" can straddle a midnight.
const NOON = Date.parse(`${dayKey(Date.now())}T12:00:00Z`);
const day = (offset: number): string => dayKey(NOON + offset * DAY);

/** Freezes Date.now() for the duration of fn — the store's only clock. */
async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(ms);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

/**
 * Impossible days that sort INSIDE the window as strings, so only the
 * calendar check can keep them out: day 45 of a month in the window (does not
 * parse), and day 31 of a shorter month in it (parses, and V8 rolls it over
 * into the next month).
 */
function impossibleInWindow(): string[] {
  const out = [`${day(-30).slice(0, 8)}45`];
  for (let offset = -85; offset <= -5; offset += 5) {
    const [y, m] = day(offset).split('-').map(Number);
    const candidate = `${day(offset).slice(0, 7)}-31`;
    if (new Date(Date.UTC(y, m, 0)).getUTCDate() < 31 && candidate > day(-90) && candidate < day(0)) {
      out.push(candidate);
      break;
    }
  }
  return out;
}

const rows = (prefix: string, n: number, d: string, tokens = 1) =>
  Array.from({ length: n }, (_, i) => ({ project: `${prefix}-${i}`, day: d, tokens }));

const postDays = (app: Express, token: string, body: unknown) =>
  request(app).post(`/w/${token}/usage/projects`).send(body as object);

const windowsOf = (ids: string[], usedPct = 1) => ids.map((id) => ({ id, usedPct }));

describe('project days: only real days inside the history window are held', () => {
  it('drops impossible, far-future and too-old days — and says how many', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    const kept = [day(-90), day(0), day(1)]; // both ends of the window are inside it
    const junk = [
      '9999-99-99', // the tester's: matched the old shape check, sorted after every real day
      '2026-13-45',
      '0000-00-00',
      '2026-02-30', // parses — V8 rolls it into March — so only the round trip catches it
      day(2), // past tomorrow: no one's logs can have it yet
      '2999-01-01',
      day(-91), // older than the window
      ...impossibleInWindow(),
    ];
    expect(junk).toHaveLength(9); // both in-window impossibles were found
    const res = await at(NOON, () =>
      postDays(app, token, {
        source: 'claude',
        days: [...kept, ...junk].map((d, i) => ({ project: `p${i}`, day: d, tokens: 10 })),
      }).expect(200));
    // Dropped, not 400: --backfill legitimately sends days the window no longer holds.
    expect(res.body).toEqual({ ok: true, days: kept.length, dropped: junk.length, refused: 0 });
    expect(store.getProjectDays(wsId, '0000-00-00').map((r) => r.day)).toEqual(kept);
  });

  it('still 400s a malformed shape, and a token count past MAX_SAFE_INTEGER', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const one = (d: unknown, tokens: unknown = 1) => ({ source: 'claude', days: [{ project: 'p', day: d, tokens }] });

    for (const bad of ['2026-9-7', '20261019', 'today', '', 20261019]) {
      await postDays(app, token, one(bad)).expect(400);
    }
    // The same bound /usage/sessions has: past it a double is not an exact integer.
    await postDays(app, token, one(day(0), 1e300)).expect(400);
    await postDays(app, token, one(day(0), Number.MAX_SAFE_INTEGER + 2)).expect(400);
    await postDays(app, token, one(day(0), Number.MAX_SAFE_INTEGER))
      .expect(200, { ok: true, days: 1, dropped: 0, refused: 0 });
  });

  it('a flood of distinct projects stops at the cap; held keys still update', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    let stored = 0;
    let refused = 0;
    const posts = Math.ceil(MAX_PROJECT_DAYS_PER_WORKSPACE / 200) + 2;
    for (let i = 0; i < posts; i++) {
      const res = await postDays(app, token, { source: 'claude', days: rows(`flood${i}`, 200, day(0)) }).expect(200);
      stored += res.body.days;
      refused += res.body.refused;
    }
    expect(stored).toBe(MAX_PROJECT_DAYS_PER_WORKSPACE);
    expect(refused).toBe(posts * 200 - MAX_PROJECT_DAYS_PER_WORKSPACE);
    expect(store.getProjectDays(wsId, '0000-00-00')).toHaveLength(MAX_PROJECT_DAYS_PER_WORKSPACE);

    // At the cap: a held key is replaced as always, a new one is refused.
    await postDays(app, token, {
      source: 'claude',
      days: [{ project: 'flood0-7', day: day(0), tokens: 999 }, { project: 'brand-new', day: day(0), tokens: 1 }],
    }).expect(200, { ok: true, days: 1, dropped: 0, refused: 1 });
    const held = store.getProjectDays(wsId, '0000-00-00');
    expect(held).toHaveLength(MAX_PROJECT_DAYS_PER_WORKSPACE);
    expect(held.find((r) => r.project === 'flood0-7')?.tokens).toBe(999);
    expect(held.find((r) => r.project === 'brand-new')).toBeUndefined();

    // The cap is per workspace: another board is untouched by this one.
    const other = await createWorkspace(app);
    await postDays(app, other, { source: 'claude', days: rows('x', 3, day(0)) })
      .expect(200, { ok: true, days: 3, dropped: 0, refused: 0 });
  });

  it('days that age out of the window leave memory and free their slots', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    // Fill the board 95 days ago, with that day's rows (inside the window then).
    const then = NOON - 95 * DAY;
    await at(then, async () => {
      for (let i = 0; i * 200 < MAX_PROJECT_DAYS_PER_WORKSPACE; i++) {
        await postDays(app, token, { source: 'claude', days: rows(`old${i}`, 200, dayKey(then)) }).expect(200);
      }
      await postDays(app, token, { source: 'claude', days: rows('then', 1, dayKey(then)) })
        .expect(200, { ok: true, days: 0, dropped: 0, refused: 1 });
    });

    // Today the whole lot is past the window: pruned before the new rows are
    // admitted, so they all fit.
    await at(NOON, () =>
      postDays(app, token, { source: 'claude', days: rows('now', 5, day(0)) })
        .expect(200, { ok: true, days: 5, dropped: 0, refused: 0 }));
    expect(store.getProjectDays(wsId, '0000-00-00').map((r) => r.project)).toEqual(
      ['now-0', 'now-1', 'now-2', 'now-3', 'now-4'],
    );
  });
});

describe('usage sources: at most MAX_USAGE_SOURCES_PER_WORKSPACE per board, across all three endpoints', () => {
  const usage = (app: Express, token: string, source: string) =>
    request(app).post(`/w/${token}/usage`).send({ source, windows: windowsOf(['week']) });
  const projects = (app: Express, token: string, source: string) =>
    postDays(app, token, { source, days: rows('p', 1, day(0)) });
  const sessions = (app: Express, token: string, source: string) =>
    request(app).post(`/w/${token}/usage/sessions`).send({ source, sessions: [{ session_id: 's-1', tokens: 1 }] });

  it('a ninth source is refused on every usage endpoint; the eight held keep reporting', async () => {
    expect(MAX_USAGE_SOURCES_PER_WORKSPACE).toBe(8);
    const { app, store } = makeApp();
    const token = await createWorkspace(app);

    // Spread over the three endpoints: the cap counts them together.
    for (const s of ['claude', 'codex', 'a', 'b']) await usage(app, token, s).expect(200);
    for (const s of ['c', 'd', 'e']) await projects(app, token, s).expect(200);
    await sessions(app, token, 'f').expect(200);

    for (const send of [usage, projects, sessions]) {
      const res = await send(app, token, 'ninth').expect(429);
      expect(res.body.error).toMatch(/too many usage sources/);
    }
    // Held sources are unaffected, on any endpoint — including one they never used.
    for (const send of [usage, projects, sessions]) {
      await send(app, token, 'claude').expect(200);
      await send(app, token, 'f').expect(200);
    }
    expect(store.getUsage(store.resolveToken(token)!).map((u) => u.source)).toEqual(['a', 'b', 'claude', 'codex', 'f']);

    // Per workspace: another board starts with every slot free.
    const other = await createWorkspace(app);
    await usage(app, other, 'ninth').expect(200);
  });

  it('a malformed report does not take a slot', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    for (let i = 0; i < MAX_USAGE_SOURCES_PER_WORKSPACE - 1; i++) await usage(app, token, `s${i}`).expect(200);

    await request(app).post(`/w/${token}/usage`).send({ source: 'late', windows: [] }).expect(400);
    await postDays(app, token, { source: 'late', days: [{ project: 'p', day: 'x', tokens: 1 }] }).expect(400);
    await usage(app, token, 'last').expect(200); // the eighth slot was still free
    await usage(app, token, 'late').expect(429);
  });
});

describe('limit history: bounded series, at most one point a minute', () => {
  it('records at most one point per series per minute; the live bar still moves', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    const t0 = Date.now() - 60 * 60 * 1000;
    const report = (ms: number, pct: number) =>
      at(ms, () => request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows: windowsOf(['week'], pct) }).expect(200));

    await report(t0, 10);
    await report(t0 + 30_000, 20); // inside the minute: the bar moves, the history does not
    expect(store.getUsage(wsId)[0].windows[0].usedPct).toBe(20);
    await report(t0 + 45_000, 30);
    await report(t0 + 61_000, 40);

    const series = store.getUsageHistory(wsId, 0);
    expect(series).toHaveLength(1);
    expect(series[0].points).toEqual([{ at: t0, usedPct: 10 }, { at: t0 + 61_000, usedPct: 40 }]);
  });

  it('past the series cap a new window id keeps no history, but its bar still shows', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    const cap = MAX_USAGE_SOURCES_PER_WORKSPACE * MAX_USAGE_WINDOWS;

    // One source, six fresh window ids a post: the source cap alone would let
    // this mint 720 series a minute.
    const posts = Math.ceil(cap / MAX_USAGE_WINDOWS) + 3;
    let last: string[] = [];
    for (let p = 0; p < posts; p++) {
      last = Array.from({ length: MAX_USAGE_WINDOWS }, (_, i) => `w${p}x${i}`);
      await request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows: windowsOf(last) }).expect(200);
    }
    const series = store.getUsageHistory(wsId, 0);
    expect(series).toHaveLength(cap);
    expect(series.some((s) => s.windowId === last[0])).toBe(false);
    expect(store.getUsage(wsId)[0].windows.map((w) => w.id)).toEqual(last);
  });

  it('a series silent for the whole history window gives its slot back', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    const cap = MAX_USAGE_SOURCES_PER_WORKSPACE * MAX_USAGE_WINDOWS;

    await at(NOON - 91 * DAY, async () => {
      for (let p = 0; p * MAX_USAGE_WINDOWS < cap; p++) {
        const ids = Array.from({ length: MAX_USAGE_WINDOWS }, (_, i) => `old${p}x${i}`);
        await request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows: windowsOf(ids) }).expect(200);
      }
    });
    await request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows: windowsOf(['week']) }).expect(200);
    // The old series are what a restart would not load either; only the new one is left.
    expect(store.getUsageHistory(wsId, 0).map((s) => s.windowId)).toEqual(['week']);
  });
});

describe('session totals: the live-card exception has a ceiling of its own', () => {
  // The cap (500) plus one board's worth of cards. Not exported: the test
  // states the number a reader of docs/api.md is promised.
  const CEILING = 550;
  // The store keeps no count, so ask for every id the test ever posted.
  const held = (store: Store, wsId: string, ids: string[]): number =>
    ids.filter((id) => store.getSessionTokens(wsId, 'claude', id) !== null).length;

  it.each([
    ['a hosted board, whose cards turn over at 50', MAX_SESSIONS_PER_WORKSPACE],
    ['a legacy board, which has no card cap at all', Infinity],
  ])('cards turning over cannot carry the map past 550: %s', async (_name, maxCards) => {
    // What the review reproduced: fifty fresh webhooks, then one post naming
    // them, over and over. The exception used to be checked against whatever
    // cards were live at that moment, so every cycle admitted fifty more —
    // 2,000 held after 40 cycles, with nothing refused.
    const { app, store } = makeApp();
    const wsId = store.resolveToken(await createWorkspace(app))!;
    const ids: string[] = [];
    for (let chunk = 0; chunk < 5; chunk++) {
      const filler = Array.from({ length: 100 }, (_, i) => ({ sessionId: `filler-${chunk}-${i}`, tokens: 1 }));
      ids.push(...filler.map((r) => r.sessionId));
      expect(store.setSessionTotals(wsId, 'claude', filler).refused).toBe(0);
    }

    const refusedPerCycle: number[] = [];
    for (let cycle = 0; cycle < 25; cycle++) {
      const fresh = Array.from({ length: 50 }, (_, i) => `card-${cycle}-${i}`);
      for (const id of fresh) store.upsertSession(wsId, { id, status: 'coding', source: 'claude' }, maxCards);
      ids.push(...fresh);
      const { refused } = store.setSessionTotals(wsId, 'claude', fresh.map((id) => ({ sessionId: id, tokens: 7 })));
      refusedPerCycle.push(refused);
      expect(held(store, wsId, ids), `cycle ${cycle}`).toBeLessThanOrEqual(CEILING);
    }
    // The first fifty live cards fit under the ceiling; after that it is full.
    expect(refusedPerCycle[0]).toBe(0);
    expect(refusedPerCycle.slice(1).every((n) => n === 50)).toBe(true);
    expect(held(store, wsId, ids)).toBe(CEILING);

    // At the ceiling a held total still updates, and nothing was evicted to
    // make room: the first filler and the first live cards are all still there.
    expect(store.setSessionTotals(wsId, 'claude', [{ sessionId: 'filler-0-0', tokens: 9 }]))
      .toEqual({ changed: ['filler-0-0'], stored: 1, refused: 0 });
    expect(store.getSessionTokens(wsId, 'claude', 'filler-0-0')).toBe(9);
    expect(store.getSessionTokens(wsId, 'claude', 'card-0-49')).toBe(7);
  });
});

describe('devices: a register/delete loop cannot add rows without end', () => {
  const register = (app: Express, token: string, device: string) =>
    request(app).post(`/w/${token}/devices`).send({ device_token: device, platform: 'ios' });
  const unregister = (app: Express, token: string, device: string) =>
    request(app).delete(`/w/${token}/devices/${device}`);
  const device = (i: number) => i.toString(16).padStart(64, '0');

  it('registration and removal share a per-workspace window (rateLimit: true)', async () => {
    const { app } = makeApp({ rateLimit: true });
    const token = await createWorkspace(app);
    for (let i = 0; i < 5; i++) {
      await register(app, token, device(i)).expect(200);
      await unregister(app, token, device(i)).expect(200);
    }
    const blocked = await register(app, token, device(99)).expect(429);
    expect(blocked.body).toEqual({ error: 'rate limit exceeded' });
    await unregister(app, token, device(0)).expect(429);

    // Per workspace.
    const other = await createWorkspace(app);
    await register(app, other, device(1)).expect(200);
  });

  const TURNOVER_ERROR =
    `too many device tokens have been registered to this workspace in the last ${DEVICE_RETIRED_WINDOW_DAYS} days`;

  it('a device-token cap counts flagged rows; a token coming back is not new', async () => {
    const { app, store } = makeApp(); // rateLimit off: this is the cap, not the window
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    for (let i = 0; i < 100; i++) {
      await register(app, token, device(i)).expect(200);
      await unregister(app, token, device(i)).expect(200, { ok: true });
    }
    expect(store.deviceCount(wsId)).toBe(0); // the live cap of 10 never saw any of this

    const res = await register(app, token, device(100)).expect(429);
    expect(res.body).toEqual({ error: TURNOVER_ERROR });
    // Re-registering a flagged token revives its row and adds none.
    await register(app, token, device(7)).expect(200, { ok: true });
    expect(store.devices(wsId).map((d) => d.deviceToken)).toEqual([device(7)]);
    // And removing it again leaves it countable, not forgotten.
    await unregister(app, token, device(7)).expect(200, { ok: true });
    await register(app, token, device(101)).expect(429);
  });

  it(`a flagged token stops counting ${DEVICE_RETIRED_WINDOW_DAYS} days after it was flagged`, async () => {
    // It used to count forever. push.ts flags every token APNs disowns, so a
    // board's reinstalls, restores and builds used the cap up for good, and
    // the only way back was a new board.
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    const cycle = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i++) {
        await register(app, token, device(i)).expect(200);
        await unregister(app, token, device(i)).expect(200, { ok: true });
      }
    };
    // Sixty tokens flagged a day more than the window ago, forty well inside it.
    await at(NOON - (DEVICE_RETIRED_WINDOW_DAYS + 1) * DAY, () => cycle(0, 60));
    await at(NOON - 10 * DAY, async () => {
      await cycle(60, 100);
      // Back then all hundred counted.
      await register(app, token, device(100)).expect(429, { error: TURNOVER_ERROR });
    });

    await at(NOON, async () => {
      // An aged-out token comes back like any other: its row is revived.
      await register(app, token, device(0)).expect(200, { ok: true });
      expect(store.devices(wsId).map((d) => d.deviceToken)).toEqual([device(0)]);
      await unregister(app, token, device(0)).expect(200);
      // The sixty old slots are free again — that one plus 59 more, and no more:
      // the forty from ten days ago still count.
      await cycle(100, 159);
      await register(app, token, device(159)).expect(429, { error: TURNOVER_ERROR });
    });
  });
});

describe('event seq: one counter per workspace', () => {
  it('counts only its own board: another tenant\'s transitions leave no gap', async () => {
    // A process-wide counter handed every token holder a reading of every
    // other tenant's activity: the gap between two of your own events was
    // exactly the number of transitions the rest of the server recorded.
    const { app } = makeApp();
    const mine = await createWorkspace(app);
    const theirs = await createWorkspace(app);
    const post = (token: string, id: string, status: string) =>
      request(app).post(`/w/${token}/webhook`).send(webhookBody(id, { status })).expect(200);
    const busy = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) await post(theirs, 'theirs', i % 2 === 0 ? 'testing' : 'coding');
    };

    await post(mine, 'a1', 'planning');
    await busy(12);
    await post(mine, 'a1', 'coding');
    await busy(26);
    await post(mine, 'a1', 'testing');

    const history = (await request(app).get(`/w/${mine}/api/sessions/a1/history`).expect(200)).body;
    expect(history.map((e: { seq: number }) => e.seq)).toEqual([2, 1, 0]);
    // Their own board numbers its own transitions, from zero as well.
    const theirSeqs = (await request(app).get(`/w/${theirs}/api/sessions/theirs/history`).expect(200)).body
      .map((e: { seq: number }) => e.seq);
    expect(theirSeqs[theirSeqs.length - 1]).toBe(0);
  });

  it('is unique across a board\'s sessions, and a returning session continues above its old rows', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (id: string, status: string) =>
      request(app).post(`/w/${token}/webhook`).send(webhookBody(id, { status })).expect(200);
    const seqs = async (id: string): Promise<number[]> =>
      (await request(app).get(`/w/${token}/api/sessions/${id}/history`).expect(200)).body
        .map((e: { seq: number }) => e.seq);

    await post('s1', 'planning');
    await post('s2', 'planning');
    await post('s1', 'coding');
    const before = await seqs('s1');
    const other = await seqs('s2');
    expect(new Set([...before, ...other]).size).toBe(3);

    // Dismissed, then back: its old rows are flagged and the per-session
    // counter that used to guard them is gone. The global one must still land
    // above them, or the upsert would overwrite and un-delete a flagged row.
    await request(app).delete(`/w/${token}/sessions/s1`).expect(200);
    await post('s1', 'testing');
    const after = await seqs('s1');
    expect(after).toHaveLength(1);
    expect(after[0]).toBeGreaterThan(Math.max(...before, ...other));
  });
});

describe('usage history reads have their own budget (rateLimit: true)', () => {
  it('allows 30 reads a minute per workspace, 429s the 31st, and spares the write budget', async () => {
    const { app } = makeApp({ rateLimit: true });
    const token = await createWorkspace(app);
    for (let i = 1; i <= 30; i++) {
      const res = await request(app).get(`/w/${token}/api/usage/history`);
      expect(res.status, `read #${i}`).toBe(200);
    }
    const blocked = await request(app).get(`/w/${token}/api/usage/history`).expect(429);
    expect(blocked.body).toEqual({ error: 'rate limit exceeded' });
    await request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows: windowsOf(['week']) }).expect(200);
    const other = await createWorkspace(app);
    await request(app).get(`/w/${other}/api/usage/history`).expect(200);
  });
});

// ---- on disk, and across a restart -------------------------------------------

describe.skipIf(!TEST_PG_URL)('write bounds (PostgreSQL)', () => {
  let dbUrl = '';
  const live: TestApp[] = [];
  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('write_bounds');
  });
  beforeEach(() => resetTables(dbUrl));
  afterEach(() => {
    while (live.length > 0) live.pop()!.shutdown();
  });

  async function boot(): Promise<TestApp> {
    const created = makeApp({ databaseUrl: dbUrl });
    await created.ready;
    live.push(created);
    return created;
  }

  /** Writes everything out and stops, so the next boot() is a restart. */
  async function stop(created: TestApp): Promise<void> {
    await created.store.flush();
    created.shutdown();
  }

  it('a refused project day never reaches the table, and an aged-out one is flagged, not deleted', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    for (let i = 0; i * 200 < MAX_PROJECT_DAYS_PER_WORKSPACE; i++) {
      await postDays(first.app, token, { source: 'claude', days: rows(`f${i}`, 200, day(0)) }).expect(200);
    }
    await postDays(first.app, token, { source: 'claude', days: rows('over', 50, day(0)) })
      .expect(200, { ok: true, days: 0, dropped: 0, refused: 50 });

    const aging = await createWorkspace(first.app);
    const agingId = first.store.resolveToken(aging)!;
    await at(NOON - 95 * DAY, () =>
      postDays(first.app, aging, { source: 'claude', days: rows('old', 10, dayKey(NOON - 95 * DAY)) }).expect(200));
    await at(NOON, () => postDays(first.app, aging, { source: 'claude', days: rows('new', 1, day(0)) }).expect(200));
    await first.store.flush();

    const counts = await sql<{ workspace_id: string; total: string; flagged: string }>(
      dbUrl,
      `SELECT workspace_id, COUNT(*) AS total, COUNT(deleted_at) AS flagged
       FROM usage_project_days GROUP BY workspace_id`,
    );
    const byWs = new Map(counts.map((r) => [r.workspace_id, { total: Number(r.total), flagged: Number(r.flagged) }]));
    expect(byWs.get(wsId)).toEqual({ total: MAX_PROJECT_DAYS_PER_WORKSPACE, flagged: 0 });
    expect(byWs.get(agingId)).toEqual({ total: 11, flagged: 10 });
  });

  it('a restart loads only real, in-window days, and at most the cap per board, newest first', async () => {
    const first = await boot();
    const full = await createWorkspace(first.app);
    const junk = await createWorkspace(first.app);
    const fullId = first.store.resolveToken(full)!;
    const junkId = first.store.resolveToken(junk)!;
    await stop(first);

    // What a flood from before the caps can have left on disk: 5,100 valid
    // rows over 51 days on one board...
    const valid = Array.from({ length: 51 }, (_, i) => day(-i));
    await sql(dbUrl,
      `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
       SELECT $1, 'claude', 'p' || p, d, 1, 0 FROM unnest($2::text[]) AS d, generate_series(1, 100) AS p`,
      [fullId, valid]);
    // ...and on another, rows the write path would never have taken, beside
    // two it would. The last is inside the window as a string, so only the
    // calendar check keeps it out.
    const bad = ['9999-99-99', day(5), day(-100), `${day(-30).slice(0, 8)}45`];
    await sql(dbUrl,
      `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
       SELECT $1, 'claude', 'p-' || d, d, 1, 0 FROM unnest($2::text[]) AS d`,
      [junkId, [...bad, day(0), day(-90)]]);

    const second = await boot();
    const held = second.store.getProjectDays(fullId, '0000-00-00');
    expect(held).toHaveLength(MAX_PROJECT_DAYS_PER_WORKSPACE);
    // The newest 50 days whole; the oldest day is the one that did not fit.
    expect(held[0].day).toBe(day(-49));
    // Full on arrival: a new key is refused, the way it was before the restart.
    await postDays(second.app, full, { source: 'claude', days: rows('n', 1, day(0)) })
      .expect(200, { ok: true, days: 0, dropped: 0, refused: 1 });

    expect(second.store.getProjectDays(junkId, '0000-00-00').map((r) => r.day)).toEqual([day(-90), day(0)]);
  });

  it('a restart loads usage within its TTL and at most the source cap per board', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const stale = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    const staleId = first.store.resolveToken(stale)!;
    await stop(first);

    const windows = JSON.stringify([{ id: 'week', label: 'week', usedPct: 1, resetsAt: null }]);
    const now = Date.now();
    // Twelve fresh sources (a flood from before the cap), and one past the TTL.
    await sql(dbUrl,
      `INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
       SELECT $1, 's' || lpad(i::text, 2, '0'), $2, $3::bigint - i * 1000 FROM generate_series(1, 12) AS i`,
      [wsId, windows, now]);
    await sql(dbUrl,
      `INSERT INTO usage_limits (workspace_id, source, windows, updated_at) VALUES ($1, 'old', $2, $3)`,
      [wsId, windows, now - 2 * DAY]);
    // A board whose every source is past the TTL.
    await sql(dbUrl,
      `INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
       SELECT $1, 'gone' || i, $2, $3 FROM generate_series(1, 8) AS i`,
      [staleId, windows, now - 2 * DAY]);

    const second = await boot();
    expect(second.store.getUsage(wsId).map((u) => u.source)).toEqual(
      ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'],
    );
    await request(second.app).post(`/w/${token}/usage`).send({ source: 's09', windows: windowsOf(['week']) }).expect(429);
    // Expired rows hold no slot: all eight are free on the other board.
    for (let i = 0; i < MAX_USAGE_SOURCES_PER_WORKSPACE; i++) {
      await request(second.app).post(`/w/${stale}/usage`).send({ source: `new${i}`, windows: windowsOf(['week']) }).expect(200);
    }
  });

  it('a restart loads at most the newest points of a series, and the most recent series', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    await stop(first);

    const now = Date.now();
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
       SELECT $1, 'claude', 'week', $2::bigint - i * 60000, i % 100 FROM generate_series(0, 2099) AS i`,
      [wsId, now]);
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
       SELECT $1, 'claude', 'w' || lpad(i::text, 2, '0'), $2::bigint - 3600000 - i * 1000, 1
       FROM generate_series(1, 60) AS i`,
      [wsId, now]);

    const second = await boot();
    const series = second.store.getUsageHistory(wsId, 0);
    const cap = MAX_USAGE_SOURCES_PER_WORKSPACE * MAX_USAGE_WINDOWS;
    expect(series).toHaveLength(cap);
    const week = series.find((s) => s.windowId === 'week')!;
    expect(week.points).toHaveLength(2000);
    expect(week.points[week.points.length - 1].at).toBe(now);
    // The 47 others kept are the 47 heard from most recently.
    const ids = series.map((s) => s.windowId);
    expect(ids).toContain(`w${String(cap - 1).padStart(2, '0')}`);
    expect(ids).not.toContain(`w${String(cap).padStart(2, '0')}`);
  });

  it('past the session-total cap the table stops growing: nothing refused is written, nothing is evicted', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    let refused = 0;
    for (let chunk = 0; chunk < 7; chunk++) {
      const res = await request(first.app).post(`/w/${token}/usage/sessions`).send({
        source: 'claude',
        sessions: Array.from({ length: 100 }, (_, i) => ({ session_id: `id-${chunk}-${i}`, tokens: 1 })),
      }).expect(200);
      refused += res.body.refused;
    }
    expect(refused).toBe(200);
    await first.store.flush();
    const [row] = await sql<{ total: string; flagged: string }>(dbUrl,
      `SELECT COUNT(*) AS total, COUNT(deleted_at) AS flagged FROM usage_session_totals WHERE workspace_id = $1`,
      [wsId]);
    // It used to be 700 rows with 200 of them flagged: memory bounded, disk not.
    expect({ total: Number(row.total), flagged: Number(row.flagged) }).toEqual({ total: 500, flagged: 0 });
  });

  it('a restart loads at most 550 session totals per board, the newest, and the board is full on arrival', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const small = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    const smallId = first.store.resolveToken(small)!;
    await stop(first);

    // More unflagged rows inside the week than the write path lets a board
    // hold — what the uncapped live-card exception left behind — and some past it.
    const now = Date.now();
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at)
       SELECT $1, 'claude', 'id-' || i, i, $2::bigint - i * 1000 FROM generate_series(0, 699) AS i`,
      [wsId, now]);
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at)
       SELECT $1, 'claude', 'stale-' || i, 1, $2 FROM generate_series(0, 9) AS i`,
      [wsId, now - 8 * DAY]);
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at)
       SELECT $1, 'claude', 'small-' || i, 1, $2 FROM generate_series(0, 2) AS i`,
      [smallId, now]);

    const second = await boot();
    const ids = Array.from({ length: 700 }, (_, i) => `id-${i}`);
    const kept = ids.filter((id) => second.store.getSessionTokens(wsId, 'claude', id) !== null);
    // The newest 550 (id-0 is the newest), none of the stale ones.
    expect(kept).toEqual(ids.slice(0, 550));
    expect(second.store.getSessionTokens(wsId, 'claude', 'stale-0')).toBeNull();
    expect(second.store.getSessionTokens(smallId, 'claude', 'small-2')).toBe(1);

    // At the ceiling, even a session with a card on the board is refused.
    await request(second.app).post(`/w/${token}/webhook`).send(webhookBody('live')).expect(200);
    await request(second.app).post(`/w/${token}/usage/sessions`)
      .send({ source: 'claude', sessions: [{ session_id: 'live', tokens: 1 }] })
      .expect(200, { ok: true, sessions: 0, refused: 1 });
  });

  it('the device-token count survives a restart', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const device = (i: number) => i.toString(16).padStart(64, '0');
    for (let i = 0; i < 100; i++) {
      await request(first.app).post(`/w/${token}/devices`).send({ device_token: device(i), platform: 'ios' }).expect(200);
      await request(first.app).delete(`/w/${token}/devices/${device(i)}`).expect(200);
    }
    await stop(first);

    const second = await boot();
    await request(second.app).post(`/w/${token}/devices`).send({ device_token: device(100), platform: 'ios' }).expect(429);
    await request(second.app).post(`/w/${token}/devices`).send({ device_token: device(3), platform: 'ios' }).expect(200);
    await second.store.flush();
    const [row] = await sql<{ total: string; live: string }>(dbUrl,
      'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS live FROM devices');
    expect({ total: Number(row.total), live: Number(row.live) }).toEqual({ total: 100, live: 1 });
  });

  it(`a restart does not count device tokens flagged more than ${DEVICE_RETIRED_WINDOW_DAYS} days ago`, async () => {
    const first = await boot();
    const old = await createWorkspace(first.app);
    const recent = await createWorkspace(first.app);
    const oldId = first.store.resolveToken(old)!;
    const recentId = first.store.resolveToken(recent)!;
    await stop(first);

    // A hundred flagged rows on each board: what every token APNs pruned
    // since soft deletes began has left. On one they are all past the window.
    const now = Date.now();
    const flag = (wsId: string, deletedAt: number) => sql(dbUrl,
      `INSERT INTO devices (workspace_id, device_token, platform, notify_done, created_at, updated_at, deleted_at)
       SELECT $1, lpad(to_hex(i), 64, '0'), 'ios', 0, 0, 0, $2 FROM generate_series(0, 99) AS i`,
      [wsId, deletedAt]);
    await flag(oldId, now - (DEVICE_RETIRED_WINDOW_DAYS + 1) * DAY);
    await flag(recentId, now - DAY);

    const second = await boot();
    const fresh = 'f'.repeat(64);
    await request(second.app).post(`/w/${recent}/devices`).send({ device_token: fresh, platform: 'ios' }).expect(429);
    await request(second.app).post(`/w/${old}/devices`).send({ device_token: fresh, platform: 'ios' }).expect(200);
    // An aged-out token still revives its own row rather than adding one.
    const back = (5).toString(16).padStart(64, '0');
    await request(second.app).post(`/w/${old}/devices`).send({ device_token: back, platform: 'ios' }).expect(200);
    await second.store.flush();
    const [row] = await sql<{ total: string; live: string }>(dbUrl,
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS live
       FROM devices WHERE workspace_id = $1`, [oldId]);
    expect({ total: Number(row.total), live: Number(row.live) }).toEqual({ total: 101, live: 2 });
  });

  it('a restart seeds seq past every row, flagged ones included, and never revives one', async () => {
    const first = await boot();
    const token = await createWorkspace(first.app);
    const wsId = first.store.resolveToken(token)!;
    for (const status of ['planning', 'coding', 'testing']) {
      await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('s1', { status })).expect(200);
    }
    await request(first.app).delete(`/w/${token}/sessions/s1`).expect(200); // flags all three
    await stop(first);
    const [{ max }] = await sql<{ max: string }>(dbUrl, 'SELECT MAX(seq) AS max FROM session_events');

    const second = await boot();
    await request(second.app).post(`/w/${token}/webhook`).send(webhookBody('s1', { status: 'done' })).expect(200);
    const history = (await request(second.app).get(`/w/${token}/api/sessions/s1/history`).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0].seq).toBeGreaterThan(Number(max));
    await second.store.flush();

    const events = await sql<{ seq: string; deleted_at: string | null }>(dbUrl,
      'SELECT seq, deleted_at FROM session_events WHERE workspace_id = $1 AND session_id = $2 ORDER BY seq',
      [wsId, 's1']);
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).every((e) => e.deleted_at !== null)).toBe(true);
    expect(events[3].deleted_at).toBeNull();
  });

  it('a restart seeds each board from its own rows, and another board\'s count never shows', async () => {
    const first = await boot();
    const quiet = await createWorkspace(first.app);
    const busy = await createWorkspace(first.app);
    const post = (app: Express, token: string, id: string, status: string) =>
      request(app).post(`/w/${token}/webhook`).send(webhookBody(id, { status })).expect(200);
    for (const status of ['planning', 'coding', 'testing']) await post(first.app, quiet, 'q1', status);
    for (let i = 0; i < 30; i++) await post(first.app, busy, 'b1', i % 2 === 0 ? 'coding' : 'testing');
    await request(first.app).delete(`/w/${quiet}/sessions/q1`).expect(200); // flags 0, 1, 2
    await stop(first);

    const second = await boot();
    await post(second.app, quiet, 'q1', 'done');
    await post(second.app, busy, 'b1', 'done');
    const seqOf = async (token: string, id: string): Promise<number> =>
      (await request(second.app).get(`/w/${token}/api/sessions/${id}/history`).expect(200)).body[0].seq;
    // Past its own flagged rows, and not past the other board's thirty.
    expect(await seqOf(quiet, 'q1')).toBe(3);
    expect(await seqOf(busy, 'b1')).toBe(30);
  });

  it('a legacy board is seeded even when its workspace row is flagged, and never revives a flagged event', async () => {
    // LEGACY_WS is a constant, not a token hash: a multi-tenant idle sweep can
    // flag its row and events, and legacy mode's next post writes to the same
    // keys again. Seeding only live boards would restart it at 0 and the
    // upsert would overwrite and un-delete seq 0.
    const legacy = () => {
      const created = makeApp({ multiTenant: false, databaseUrl: dbUrl });
      live.push(created);
      return created;
    };
    const first = legacy();
    await first.ready;
    for (const status of ['planning', 'coding', 'testing']) {
      await request(first.app).post('/webhook').send(webhookBody('s1', { status })).expect(200);
    }
    await stop(first);
    // What deleteWorkspace(LEGACY_WS) writes.
    await sql(dbUrl, 'UPDATE workspaces SET deleted_at = 1 WHERE id = $1', [LEGACY_WS]);
    await sql(dbUrl, 'UPDATE session_events SET deleted_at = 1 WHERE workspace_id = $1', [LEGACY_WS]);
    await sql(dbUrl, 'UPDATE sessions SET deleted_at = 1 WHERE workspace_id = $1', [LEGACY_WS]);

    const second = legacy();
    await second.ready;
    await request(second.app).post('/webhook').send(webhookBody('s1', { status: 'done' })).expect(200);
    const history = (await request(second.app).get('/api/sessions/s1/history').expect(200)).body;
    expect(history.map((e: { seq: number }) => e.seq)).toEqual([3]);
    await second.store.flush();
    const events = await sql<{ seq: string; deleted_at: string | null }>(dbUrl,
      'SELECT seq, deleted_at FROM session_events WHERE workspace_id = $1 ORDER BY seq', [LEGACY_WS]);
    expect(events.map((e) => [Number(e.seq), e.deleted_at === null])).toEqual(
      [[0, false], [1, false], [2, false], [3, true]],
    );
  });
});
