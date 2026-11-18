import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { makeApp, createWorkspace, TEST_DEFAULTS } from './helpers';
import { byCodeUnit, dayKey, LEGACY_WS, MAX_PROJECT_DAYS_PER_WORKSPACE } from '../src/store';

const w = (id: string, usedPct: number) => ({ id, label: id, usedPct });

// Relative, not literal: the store only holds days inside the 90-day history
// window, so a hard-coded date is a test that starts failing on its own one
// quarter after it was written.
const daysAgo = (n: number): string => dayKey(Date.now() - n * 24 * 60 * 60 * 1000);
const D1 = daysAgo(2);
const D2 = daysAgo(1);

/** Both series behind the usage detail screen. */
describe('usage history', () => {
  it('records a point per window only when the value moves', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    // Three reports, but the middle one repeats: a plan limit is a step
    // function and reports arrive far more often than it changes. Five
    // minutes apart, the hook's own cadence — a series records at most one
    // point a minute (see the write-bounds suite).
    const start = Date.now() - 60 * 60 * 1000;
    for (const [i, pct] of [10, 10, 25].entries()) {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start + i * 5 * 60 * 1000);
      try {
        await request(app)
          .post(`/w/${token}/usage`)
          .send({ source: 'claude', windows: [w('week', pct)] })
          .expect(200);
      } finally {
        clock.mockRestore();
      }
    }

    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    const series = res.body.history.find((h: { windowId: string }) => h.windowId === 'week');
    expect(series.source).toBe('claude');
    expect(series.points.map((p: { usedPct: number }) => p.usedPct)).toEqual([10, 25]);
    expect(series.points[0].at).toBeTypeOf('number');
  });

  it('keeps each source and window in its own series', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows: [w('session', 5), w('week', 50)] })
      .expect(200);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'codex', windows: [w('week', 80)] })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    expect(res.body.history.map((h: { source: string; windowId: string }) => `${h.source}/${h.windowId}`))
      .toEqual(['claude/session', 'claude/week', 'codex/week']);
  });

  it('clamps the requested range and defaults to 30 days', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    expect((await request(app).get(`/w/${token}/api/usage/history`)).body.days).toBe(30);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=7`)).body.days).toBe(7);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=9999`)).body.days).toBe(90);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=0`)).body.days).toBe(30);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=junk`)).body.days).toBe(30);
  });

  it('is empty for a board that has never reported', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    expect(res.body).toEqual({ days: 30, history: [], projects: [] });
  });
});

describe('per-project token spend', () => {
  const days = [
    { project: 'jobsearch', day: D1, tokens: 2_000_000 },
    { project: 'claude-status', day: D1, tokens: 500_000 },
    { project: 'jobsearch', day: D2, tokens: 1_000_000 },
  ];

  it('stores days and returns them with the history', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days })
      .expect(200, { ok: true, days: 3, dropped: 0, refused: 0 });

    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.projects[0]).toEqual({
      source: 'claude', project: 'claude-status', day: D1, tokens: 500_000,
    });
  });

  it('replaces a day rather than accumulating, so a re-run converges', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const one = [{ project: 'p', day: D2, tokens: 100 }];
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: one }).expect(200);
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: one }).expect(200);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: [{ project: 'p', day: D2, tokens: 250 }] })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects).toEqual([
      { source: 'claude', project: 'p', day: D2, tokens: 250 },
    ]);
  });

  it('keeps the same project separate per source', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const d = [{ project: 'shared', day: D2, tokens: 10 }];
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: d }).expect(200);
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'codex', days: d }).expect(200);
    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects.map((p: { source: string }) => p.source)).toEqual(['claude', 'codex']);
  });

  it('rejects a malformed report', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (body: unknown) => request(app).post(`/w/${token}/usage/projects`).send(body as object);

    await post({ source: 'Claude!', days: [{ project: 'p', day: D2, tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [] }).expect(400);
    await post({ source: 'claude', days: 'nope' }).expect(400);
    await post({ source: 'claude', days: [{ project: 'p', day: '07-09-2026', tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [{ project: '', day: D2, tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [{ project: 'p', day: D2 }] }).expect(400);
    await post({ source: 'claude', days: [null] }).expect(400);
  });

  it('clamps a negative token count rather than rejecting the whole report', async () => {
    // Matches how usedPct is handled: one bad number must not lose the batch.
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: [{ project: 'p', day: D2, tokens: -5 }] })
      .expect(200);
    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects[0].tokens).toBe(0);
  });

  it('caps how much one report may carry', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const many = Array.from({ length: 201 }, (_, i) => ({
      project: `p${i}`, day: D2, tokens: 1,
    }));
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: many }).expect(400);
  });

  it('accepts a report right at the cap, inside the JSON body limit', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const many = Array.from({ length: 200 }, (_, i) => ({
      project: `project-name-${i}`, day: D2, tokens: 123_456_789,
    }));
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: many })
      .expect(200, { ok: true, days: 200, dropped: 0, refused: 0 });
  });
});

// Everything a usage read lists comes by UTF-16 code unit (byCodeUnit in
// src/store.ts), never by a locale's collation, whose order follows the
// server's locale and calls some different names equal. The clients list a
// folder's spend biggest first and keep this order between folders that
// spent the same, and draw each limit's line in the place its series comes.
describe('the order a usage read lists things in', () => {
  it('lists project days by day, then source, then project, each by UTF-16 code unit', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (source: string, days: Array<{ project: string; day: string }>) =>
      request(app)
        .post(`/w/${token}/usage/projects`)
        .send({ source, days: days.map((d) => ({ ...d, tokens: 1 })) })
        .expect(200);
    await post('codex', [{ project: 'Zeta', day: D1 }]);
    // Sent in an order other than the read's. Each pair of names a collation
    // calls equal comes first in its other form.
    await post('claude', [
      { project: 'aardvark', day: D2 },
      { project: 'caf\u00e9', day: D1 },
      { project: 'cafe\u0301', day: D1 },
      { project: 'a\u00adb', day: D1 },
      { project: 'ab', day: D1 },
      { project: 'claude_status', day: D1 },
      { project: 'claude2', day: D1 },
      { project: 'claude-status', day: D1 },
      { project: '\uff5e tilde', day: D1 },
      { project: '\u{1f600} smile', day: D1 },
      { project: 'z', day: D1 },
      { project: 'alpha', day: D1 },
      { project: 'Zeta', day: D1 },
    ]);
    for (const source of ['claude_x', 'claude2', 'claude-x']) await post(source, [{ project: 'p', day: D1 }]);

    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects.map((p: { day: string; source: string; project: string }) =>
      [p.day === D1 ? 'D1' : 'D2', p.source, p.project])).toEqual([
      // A capital's unit is lower than every small letter's: a collation
      // puts Zeta after ab and alpha.
      ['D1', 'claude', 'Zeta'],
      ['D1', 'claude', 'ab'],
      ['D1', 'claude', 'alpha'],
      // b (U+0062) before the soft hyphen (U+00AD): a collation calls the
      // two equal and keeps the one it was sent first.
      ['D1', 'claude', 'a\u00adb'],
      // e (U+0065) before é (U+00E9): one folder in two Unicode forms, which
      // a collation calls equal.
      ['D1', 'claude', 'cafe\u0301'],
      ['D1', 'claude', 'caf\u00e9'],
      // '-' (U+002D), '2' (U+0032), '_' (U+005F): a collation puts the
      // underscore first.
      ['D1', 'claude', 'claude-status'],
      ['D1', 'claude', 'claude2'],
      ['D1', 'claude', 'claude_status'],
      ['D1', 'claude', 'z'],
      // Units, not code points: an emoji's first unit, U+D83D, comes before
      // U+FF5E, while the emoji's code point, U+1F600, comes after it.
      ['D1', 'claude', '\u{1f600} smile'],
      ['D1', 'claude', '\uff5e tilde'],
      ['D1', 'claude-x', 'p'],
      ['D1', 'claude2', 'p'],
      ['D1', 'claude_x', 'p'],
      ['D1', 'codex', 'Zeta'],
      // The later day after every row of the earlier one.
      ['D2', 'claude', 'aardvark'],
    ]);
  });

  it('lists plan usage by source, and limit series by source, then window id, each by UTF-16 code unit', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const ids = ['week_opus', 'week-opus', 'week2', 'week'];
    for (const [source, windows] of [['claude_x', ids], ['claude', ids], ['claude2', ['week']], ['claude-x', ['week']]] as const) {
      await request(app).post(`/w/${token}/usage`).send({ source, windows: windows.map((id) => w(id, 10)) }).expect(200);
    }

    const usage = await request(app).get(`/w/${token}/api/usage`).expect(200);
    expect(usage.body.map((u: { source: string }) => u.source)).toEqual(['claude', 'claude-x', 'claude2', 'claude_x']);
    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    expect(res.body.history.map((h: { source: string; windowId: string }) => `${h.source}/${h.windowId}`)).toEqual([
      'claude/week',
      'claude/week-opus',
      'claude/week2',
      'claude/week_opus',
      'claude-x/week',
      'claude2/week',
      'claude_x/week',
      'claude_x/week-opus',
      'claude_x/week2',
      'claude_x/week_opus',
    ]);
  });
});

// One board's history read used to sort its project days with localeCompare.
// A collation composes and reorders a name's combining marks on every
// comparison, so 5,000 names of marks in the worst order took 1.6 s of the
// thread every board shares, a read, and 30 reads at once held it for 45 s
// while other boards' hook posts timed out. Nothing here times anything,
// which would flake on a loaded machine. The test counts calls instead, while
// the read is served: of localeCompare, normalize and new Intl.Collator, and
// of a collator's compare, each read of it and each run. The spies go in
// first and the server's own modules (src/) load again under them, so a
// localeCompare or a compare the server took when a module loaded, when the
// app was made or during the read is counted each time it runs. What a module
// from node_modules took when it loaded, before the spies, is not seen. The
// order of the rows is checked as well, one pair at a time.

/**
 * One combining mark for each of 37 canonical combining classes, from 240
 * down to 1, as in test/home-project.test.ts: every mark has to pass every
 * mark of a higher class before it, the most a collation has to reorder.
 */
const WORST_ORDER = [
  0x0345, 0x035d, 0x035c, 0x0315, 0x0300, 0x05ae, 0x059a, 0x0316, 0x031b, 0x0321,
  0x0711, 0x0670, 0x0652, 0x0651, 0x061a, 0x0619, 0x0618, 0x064d, 0x064c, 0x064b,
  0x05c2, 0x05c1, 0x05bf, 0x05bd, 0x05bc, 0x05bb, 0x05b9, 0x05b8, 0x05b7, 0x05b6,
  0x05b5, 0x05b4, 0x05b3, 0x05b2, 0x05b1, 0x05b0, 0x0334,
].map((unit) => String.fromCharCode(unit));

/**
 * The i-th of 37³ distinct folder names of 120 units, the most a name is
 * kept to: an underscore, 116 marks in the worst order, the same in every
 * name, then three that tell the names apart.
 */
const worstName = (i: number): string =>
  '_' +
  WORST_ORDER.flatMap((mark, k) => Array<string>(k < 5 ? 4 : 3).fill(mark)).join('').slice(0, 116) +
  WORST_ORDER[i % 37] + WORST_ORDER[Math.floor(i / 37) % 37] + WORST_ORDER[Math.floor(i / 1369) % 37];

describe('a history read of a board full of project days named in the worst order', () => {
  it.each([
    ['/w/:token/api/usage/history', true],
    ['/api/usage/history', false],
  ])('sorts all of them on %s by code unit, with no collation and no composing', async (_route, multiTenant) => {
    // Held as the store holds what 88 reports of 16 KB would bring, in an
    // order other than the read's.
    const today = dayKey(Date.now());
    const rows = Array.from({ length: MAX_PROJECT_DAYS_PER_WORKSPACE }, (_, i) => ({
      project: worstName(MAX_PROJECT_DAYS_PER_WORKSPACE - 1 - i), day: today, tokens: 1,
    }));
    expect(new Set(rows.map((r) => r.project)).size).toBe(MAX_PROJECT_DAYS_PER_WORKSPACE);
    for (const r of rows) expect(r.project).toHaveLength(120);

    // The collators' own prototype and its compare getter, taken before
    // Intl.Collator is replaced: the spy that replaces it has a prototype of
    // its own, which no collator inherits from.
    const collators = Intl.Collator.prototype;
    const compareOf = Object.getOwnPropertyDescriptor(collators, 'compare')!.get!;
    // A collator's compare, read while the spies are in, is its own behind a
    // counter, so one read once and kept is counted each time it runs.
    const runs = vi.fn();
    const spies = [
      vi.spyOn(String.prototype, 'localeCompare'),
      vi.spyOn(String.prototype, 'normalize'),
      vi.spyOn(collators, 'compare', 'get').mockImplementation(function (this: Intl.Collator) {
        const compare = compareOf.call(this) as (a: string, b: string) => number;
        return (a: string, b: string) => {
          runs();
          return compare(a, b);
        };
      }),
      vi.spyOn(Intl, 'Collator'),
      runs,
    ];
    let seen: number[] = [];
    let loadedAgain = false;
    let projects: Array<{ project: string }> = [];
    let calls: number[] = [];
    let shutdown = (): Promise<void> => Promise.resolve();
    try {
      // Each spy sees its own kind of call, and a compare read before the
      // count starts is counted when it runs, so a zero below means none ran.
      const kept = new Intl.Collator().compare;
      for (const spy of spies) spy.mockClear();
      'a'.localeCompare('b');
      'a'.normalize('NFC');
      void new Intl.Collator().compare;
      kept('a', 'b');
      seen = spies.map((spy) => spy.mock.calls.length);

      // The server's own modules load again, under the spies, and the app is
      // made from them.
      vi.resetModules();
      const { createApp } = await import('../src/app');
      loadedAgain = (await import('../src/store')).byCodeUnit !== byCodeUnit;
      const t = createApp({ ...TEST_DEFAULTS, multiTenant });
      shutdown = t.shutdown;
      await t.ready;
      const token = multiTenant ? await createWorkspace(t.app) : '';
      const wsId = multiTenant ? t.store.resolveToken(token)! : LEGACY_WS;
      expect(t.store.admitUsageSource(wsId, 'claude')).toBe(true);
      expect(t.store.setProjectDays(wsId, 'claude', rows))
        .toEqual({ stored: MAX_PROJECT_DAYS_PER_WORKSPACE, dropped: 0, refused: 0 });

      const root = multiTenant ? `/w/${token}` : '';
      for (const spy of spies) spy.mockClear();
      projects = (await request(t.app).get(`${root}/api/usage/history?days=1`).expect(200)).body.projects;
    } finally {
      calls = spies.map((spy) => spy.mock.calls.length);
      for (const spy of spies) spy.mockRestore();
      await shutdown();
    }
    expect(loadedAgain, 'src/store.ts loaded again under the spies').toBe(true);
    // localeCompare, normalize, a read of a collator's compare, new
    // Intl.Collator, a run of a collator's compare.
    expect(seen).toEqual([1, 1, 1, 1, 1]);
    expect(calls).toEqual([0, 0, 0, 0, 0]);
    expect(projects).toHaveLength(MAX_PROJECT_DAYS_PER_WORKSPACE);
    for (let i = 1; i < projects.length; i += 1) {
      expect(byCodeUnit(projects[i - 1].project, projects[i].project), `row ${i}`).toBe(-1);
    }
  });
});
