import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import { spawnSync } from 'child_process';
import request from 'supertest';
import { makeApp, createWorkspace, TEST_PG_URL, suiteDatabaseUrl, resetTables, sql, type TestApp } from './helpers';
import { dayKey, isCalendarDay } from '../src/store';

/*
 * scripts/flag-flood-rows.sql is run by hand on production, so this is the one
 * place that checks it against the Store it has to agree with. A board is
 * seeded with honest data through the 1.6.2 handlers, and with what servers
 * before 1.6.2 left on disk by direct INSERTs shaped like theirs; a 1.6.2
 * restart is captured before the script runs and after, and the two must
 * serve the same thing. If load() changes (a cap, a window, a ranking), this
 * is what notices that the script no longer matches it.
 *
 * Needs TEST_DATABASE_URL and a psql binary (PSQL=… to point at one).
 */

const PSQL = process.env.PSQL || 'psql';
const HAVE_PSQL = spawnSync(PSQL, ['--version']).status === 0;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'flag-flood-rows.sql');

const DAY = 24 * 60 * 60 * 1000;
const NOON = Date.parse(`${dayKey(Date.now())}T12:00:00Z`);
const day = (offset: number): string => dayKey(NOON + offset * DAY);
// psql's own session runs where noon UTC is already tomorrow, so a script
// that took its dates from the session's time zone would be off by a day.
const PSQL_ENV = { ...process.env, PGOPTIONS: '-c TimeZone=Pacific/Kiritimati' };

const wsIdOf = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

function runScript(dbUrl: string, vars: Record<string, string>, after: string[] = []): { status: number; out: string } {
  const args = [dbUrl, '-X', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', SCRIPT];
  for (const c of after) args.push('-c', c);
  const r = spawnSync(PSQL, args, { encoding: 'utf8', env: PSQL_ENV });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** "table | fate | n" lines from the flag step. */
function flagged(out: string): Record<string, number> {
  const section = out.split('== Flagging')[1]?.split('== Post-check')[0] ?? '';
  const counts: Record<string, number> = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*(usage_\w+)\s*\|\s*(\w+)\s*\|\s*(\d+)\s*$/);
    if (m) counts[`${m[1]}.${m[2]}`] = Number(m[3]);
  }
  return counts;
}

const TABLES = ['workspaces', 'sessions', 'session_events', 'devices', 'usage_limits', 'usage_history',
  'usage_project_days', 'usage_session_totals'];

/** Every row of every table, deleted_at apart, keyed by table and primary key. */
async function snapshot(dbUrl: string): Promise<Map<string, { rest: string; deletedAt: string | null; ws: string }>> {
  const pk: Record<string, string> = {
    workspaces: 'id', sessions: 'workspace_id, id', session_events: 'workspace_id, session_id, seq',
    devices: 'workspace_id, device_token', usage_limits: 'workspace_id, source',
    usage_history: 'workspace_id, source, window_id, at', usage_project_days: 'workspace_id, source, project, day',
    usage_session_totals: 'workspace_id, source, session_id',
  };
  const out = new Map<string, { rest: string; deletedAt: string | null; ws: string }>();
  for (const t of TABLES) {
    const rows = await sql<{ rest: unknown; d: string | null; ws: string; k: string }>(dbUrl,
      `SELECT row_to_json(x)::jsonb - 'deleted_at' AS rest, deleted_at::text AS d,
              ${t === 'workspaces' ? 'id' : 'workspace_id'} AS ws, concat_ws('|', ${pk[t]}) AS k
       FROM ${t} x`);
    for (const r of rows) out.set(`${t}|${r.k}`, { rest: JSON.stringify(r.rest), deletedAt: r.d, ws: r.ws });
  }
  return out;
}

describe.skipIf(!TEST_PG_URL || !HAVE_PSQL)('scripts/flag-flood-rows.sql (PostgreSQL)', () => {
  let dbUrl = '';
  let clock = NOON;
  const live: TestApp[] = [];
  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('flag_flood_rows');
  });
  afterEach(() => {
    while (live.length > 0) live.pop()!.shutdown();
    vi.restoreAllMocks();
  });

  async function boot(): Promise<TestApp> {
    const created = makeApp({ databaseUrl: dbUrl });
    await created.ready;
    live.push(created);
    return created;
  }

  async function stop(created: TestApp): Promise<void> {
    await created.store.flush();
    created.shutdown();
  }

  /** What a 1.6.2 restart serves for each board: its API, and the maps load() filled. */
  async function capture(boards: Record<string, string>): Promise<Record<string, any>> {
    clock = NOON;
    const created = await boot();
    const st = created.store as any;
    const sorted = (m: Map<string, unknown> | undefined) =>
      m ? Array.from(m.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [];
    const out: Record<string, any> = {};
    for (const [name, token] of Object.entries(boards)) {
      const ws = wsIdOf(token);
      const sessions = (await request(created.app).get(`/w/${token}/api/sessions`).expect(200)).body;
      const timelines: Record<string, unknown> = {};
      for (const s of sessions) {
        timelines[s.id] = (await request(created.app).get(`/w/${token}/api/sessions/${s.id}/history`).expect(200)).body;
      }
      out[name] = {
        sessions,
        timelines,
        usage: (await request(created.app).get(`/w/${token}/api/usage`).expect(200)).body,
        history: (await request(created.app).get(`/w/${token}/api/usage/history?days=90`).expect(200)).body,
        store: {
          projectDays: sorted(st.projectDays.get(ws)),
          sessionTotals: sorted(st.sessionTotals.get(ws)),
          usageBySource: sorted(st.usageBySource.get(ws)),
          usagePoints: sorted(st.usagePoints.get(ws)),
          usageSources: Array.from(st.usageSources.get(ws) ?? []).sort(),
          devices: sorted(st.deviceTokens.get(ws)),
          nextSeq: st.nextSeq.get(ws) ?? null,
        },
      };
    }
    await stop(created);
    return out;
  }

  it('flags only what a 1.6.2 restart cannot load, and the restart serves every board the same', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const first = await boot();
    const names = ['H', 'H2', 'F', 'G', 'K', 'N', 'S', 'W', 'E'] as const;
    const boards: Record<string, string> = {};
    clock = NOON - 120 * DAY;
    for (const n of names) boards[n] = await createWorkspace(first.app);
    const ws = (n: string) => wsIdOf(boards[n]);
    const post = (n: string, route: string, body: object) =>
      request(first.app).post(`/w/${boards[n]}${route}`).send(body).expect(200);

    // H, honest: both agents, a month of project days, limits that move, cards
    // with totals, a phone. Plus a codex report from three days ago (aged).
    for (let d = 30; d >= 0; d--) {
      clock = NOON - d * DAY;
      await post('H', '/usage/projects', { source: 'claude', days: [
        { project: 'agstatus', day: day(-d), tokens: 1000 + d }, { project: 'site', day: day(-d), tokens: 10 + d }] });
      await post('H', '/usage/projects', { source: 'codex', days: [{ project: 'agstatus', day: day(-d), tokens: 700 + d }] });
      await post('H', '/usage', { source: 'claude', windows: [
        { id: 'five_hour', label: '5h', usedPct: (d * 7) % 100 }, { id: 'seven_day', label: '7d', usedPct: d }] });
    }
    clock = NOON - 3 * DAY;
    await post('H', '/usage', { source: 'codex', windows: [{ id: 'five_hour', label: '5h', usedPct: 40 }] });
    // Just inside each bound, so that a bound drawn a day, an hour or a row
    // too tight shows up as a row a restart loads being flagged.
    clock = NOON - 23 * 3_600_000;
    await post('H2', '/usage', { source: 'claude', windows: [{ id: 'five_hour', label: '5h', usedPct: 9 }] });
    clock = NOON - 60_000;
    await post('H', '/usage/projects', { source: 'claude', days: [{ project: 'agstatus', day: day(1), tokens: 3 }] });
    clock = NOON - 60_000;
    await post('H', '/webhook', { session_id: 'h-a', status: 'planning', name: 'A', project: 'agstatus', message: 'r', source: 'claude' });
    clock = NOON - 50_000;
    await post('H', '/webhook', { session_id: 'h-a', status: 'coding', message: 'editing' });
    await post('H', '/webhook', { session_id: 'h-b', status: 'blocked', name: 'B', project: 'site', message: '?', source: 'codex' });
    await post('H', '/usage/sessions', { source: 'claude', sessions: [{ session_id: 'h-a', tokens: 1234 }] });
    await post('H', '/usage/sessions', { source: 'codex', sessions: [{ session_id: 'h-b', tokens: 77 }] });
    await post('H', '/devices', { device_token: 'ab'.repeat(32), platform: 'ios', notify_done: true });
    // H2, honest and light.
    await post('H2', '/usage/projects', { source: 'claude', days: [{ project: 'blog', day: day(0), tokens: 5 }] });
    await post('H2', '/webhook', { session_id: 'h2', status: 'coding', name: 'C', project: 'blog', message: 'm', source: 'claude' });
    // W's two real series, after its flood below.
    await post('W', '/usage', { source: 'claude', windows: [
      { id: 'five_hour', label: '5h', usedPct: 30 }, { id: 'seven_day', label: '7d', usedPct: 40 }] });
    await post('E', '/webhook', { session_id: 'e0599', status: 'coding', name: 'E', project: 'e', message: 'm', source: 'claude' });
    await stop(first);

    // What servers before 1.6.2 accepted and 1.6.2 does not, written the way
    // their upserts wrote it. Every report is one updated_at.
    const pd = (w: string, source: string, prefix: string, n: number, dayText: string, updatedAt: number) => sql(dbUrl,
      `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
       SELECT $1, $2, $3 || lpad(i::text, 3, '0'), $4, i, $5::bigint FROM generate_series(0, $6::int - 1) i`,
      [w, source, prefix, dayText, updatedAt, n]);
    const year = Number(day(0).slice(0, 4));
    // H, honest: a series past its newest 2000 points, and three points from
    // before the window (both aged). H2: a backfill of days older than the window.
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
       SELECT $1, 'claude', 'opus_week', $2::bigint + i * 120000, i % 100 FROM generate_series(0, 2099) i`,
      [ws('H'), NOON - 5 * DAY]);
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
       SELECT $1, 'claude', 'five_hour', $2::bigint + i * 60000, i FROM generate_series(0, 2) i`,
      [ws('H'), NOON - 100 * DAY]);
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct) VALUES ($1, 'claude', 'five_hour', $2, 55)`,
      [ws('H'), NOON - 89 * DAY - 12 * 3_600_000]);
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at) VALUES ($1, 'claude', 'h-week', 9, $2)`,
      [ws('H'), NOON - 6 * DAY - 12 * 3_600_000]);
    for (let k = 91; k <= 110; k++) await pd(ws('H2'), 'claude', 'blog', 1, day(-k), NOON - 2 * DAY);
    // F, the tester's flood: 45 reports of 200 days in the window, one a day,
    // so its 5000th place falls cleanly between two of them; plus days after
    // the window, before it, and impossible on either side.
    for (let j = 0; j < 45; j++) await pd(ws('F'), 'claude', 'f', 200, day(-j), NOON - 2 * DAY + j * 1000);
    await pd(ws('F'), 'claude', 'f', 200, '9999-99-99', NOON - DAY);
    await pd(ws('F'), 'claude', 'f', 1, day(2), NOON - DAY);
    await pd(ws('F'), 'claude', 'f', 200, `${year + 70}-01-01`, NOON - DAY + 1);
    await pd(ws('F'), 'claude', 'f', 100, `${year}-13-45`, NOON - DAY + 2);
    await pd(ws('F'), 'claude', 'f', 200, '2000-01-01', NOON - DAY + 3);
    await pd(ws('F'), 'claude', 'f', 100, '2000-02-30', NOON - DAY + 4);
    // K: 5001 rows, each its own place: the 5000th is loaded, the 5001st is not.
    await sql(dbUrl,
      `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
       SELECT $1, 'claude', 'k' || i, $2, 1, $3::bigint + i FROM generate_series(0, 5000) i`,
      [ws('K'), day(-3), NOON - DAY]);
    // N: a few real days and one impossible day inside the window.
    const notADay = `${day(-60).slice(0, 8)}45`;
    for (let k = 0; k < 10; k++) await pd(ws('N'), 'claude', `n${k}-`, 1, day(-k), NOON - DAY);
    await pd(ws('N'), 'claude', 'nx', 1, notADay, NOON - DAY);
    // G: its 5000th place falls inside one report's 200 rows, with an
    // impossible day ahead of it. Which of the tied rows a restart loads is
    // Postgres's choice; flagging must not change how many, or anything else.
    await pd(ws('G'), 'claude', 'g', 100, day(0), NOON - DAY);
    for (let k = 1; k <= 24; k++) await pd(ws('G'), 'claude', 'g', 200, day(-k), NOON - DAY + k);
    await pd(ws('G'), 'claude', 'gx', 1, notADay, NOON - DAY);
    await pd(ws('G'), 'claude', 'g', 200, day(-89), NOON - DAY + 100);
    await pd(ws('G'), 'claude', 'g', 200, day(-90), NOON - DAY + 101);
    // S: ten sources in the last day, six windows each, and a project day each.
    for (let i = 0; i < 10; i++) {
      await sql(dbUrl, `INSERT INTO usage_limits (workspace_id, source, windows, updated_at) VALUES ($1, $2, '[]', $3)`,
        [ws('S'), `src${i}`, NOON - 3_600_000 + i * 1000]);
      await sql(dbUrl,
        `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
         SELECT $1, $2, 'w' || k, $3, 5 FROM generate_series(1, 6) k`,
        [ws('S'), `src${i}`, NOON - 3_600_000 + i * 1000]);
      await pd(ws('S'), `src${i}`, 'p', 1, day(0), NOON - 3_600_000 + i * 1000);
    }
    // W: sixty fresh window ids under one source, older than its two real ones.
    await sql(dbUrl,
      `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
       SELECT $1, 'claude', 'wid_' || i, $2::bigint + (i / 6) * 60000, 5 FROM generate_series(0, 59) i`,
      [ws('W'), NOON - 3 * 3_600_000]);
    // E: 600 totals in the week (its card's among them), and ten from before it.
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at)
       SELECT $1, 'claude', 'e' || lpad(i::text, 4, '0'), 1000 + i, $2::bigint + i * 1000 FROM generate_series(0, 599) i`,
      [ws('E'), NOON - DAY]);
    await sql(dbUrl,
      `INSERT INTO usage_session_totals (workspace_id, source, session_id, tokens, updated_at)
       SELECT $1, 'claude', 'old' || i, 1, $2::bigint + i FROM generate_series(0, 9) i`,
      [ws('E'), NOON - 8 * DAY]);

    const before = await capture(boards);
    const rows0 = await snapshot(dbUrl);
    const nowArg = { now_ms: String(NOON) };

    const diagnose = runScript(dbUrl, { mode: 'diagnose', ...nowArg });
    expect(diagnose.status, diagnose.out).toBe(0);
    expect(diagnose.out).toContain('Diagnose only: nothing was written');
    expect(await snapshot(dbUrl)).toEqual(rows0);

    const dry = runScript(dbUrl, nowArg); // no mode: a dry run
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain('Dry run: rolled back');
    expect(dry.out).toContain('post-check passed: 5089 rows flagged');
    expect(await snapshot(dbUrl)).toEqual(rows0);

    const commit = runScript(dbUrl, { mode: 'commit', ...nowArg });
    expect(commit.status, commit.out).toBe(0);
    expect(flagged(commit.out)).toEqual({
      'usage_project_days.after_window': 501, // F
      'usage_project_days.before_window': 320, // F 300, and H2's 20 backfilled days
      'usage_project_days.not_a_day': 1, // N
      'usage_project_days.over_cap': 4201, // F 4000, G 200, K 1
      'usage_session_totals.over_cap': 50, // E
      'usage_limits.over_cap': 2, // S
      'usage_history.series_over_cap': 14, // W; S is over 8 sources, so its series are left
    });

    // Row by row: only deleted_at moved, only from NULL to this run's instant.
    const rows1 = await snapshot(dbUrl);
    expect(rows1.size).toBe(rows0.size);
    const byBoard: Record<string, number> = {};
    const nameOf = Object.fromEntries(names.map((n) => [ws(n), n]));
    for (const [k, r0] of rows0) {
      const r1 = rows1.get(k)!;
      expect(r1.rest).toBe(r0.rest);
      if (r1.deletedAt !== r0.deletedAt) {
        expect([r0.deletedAt, r1.deletedAt]).toEqual([null, String(NOON)]);
        byBoard[nameOf[r0.ws]] = (byBoard[nameOf[r0.ws]] ?? 0) + 1;
      }
    }
    expect(byBoard).toEqual({ H2: 20, F: 4801, G: 200, K: 1, N: 1, S: 2, W: 14, E: 50 });

    const after = await capture(boards);
    for (const n of names) {
      if (n === 'G') continue;
      expect(after[n], `board ${n}`).toEqual(before[n]);
    }
    // G: identical except which of the 200 rows tied at its cap fill the
    // last places, and exactly as many of them.
    const tieDay = day(-89);
    const outsideTie = (g: any) => ({
      ...g,
      history: { ...g.history, projects: g.history.projects.filter((r: any) => r.day !== tieDay) },
      store: { ...g.store, projectDays: g.store.projectDays.filter(([k]: [string]) => !k.endsWith(tieDay)) },
    });
    expect(outsideTie(after.G)).toEqual(outsideTie(before.G));
    const tied = (g: any) => g.store.projectDays.filter(([k]: [string]) => k.endsWith(tieDay)).length;
    expect(after.G.store.projectDays).toHaveLength(before.G.store.projectDays.length);
    expect(tied(after.G)).toBe(tied(before.G));
    expect(tied(before.G)).toBe(99); // 5000 places, 4901 ahead of the tie (one of them the impossible day)

    // Idempotent, at the same instant and a minute on; nothing more moves.
    const again = runScript(dbUrl, { mode: 'commit', ...nowArg });
    expect(again.out).toContain('post-check passed: 0 rows flagged');
    const later = runScript(dbUrl, { mode: 'commit', now_ms: String(NOON + 60_000) });
    expect(later.out).toContain('post-check passed: 0 rows flagged');
    expect(await snapshot(dbUrl)).toEqual(rows1);

    // aged=flag takes the retention rows too, and still changes nothing served.
    const aged = runScript(dbUrl, { mode: 'commit', aged: 'flag', ...nowArg });
    expect(aged.status, aged.out).toBe(0);
    expect(flagged(aged.out)).toEqual({
      'usage_session_totals.aged': 10, // E
      'usage_limits.aged': 1, // H's codex report
      'usage_history.aged': 3, // H, before the window
      'usage_history.points_over_cap': 100, // H's opus_week, past its newest 2000
    });
    const agedAfter = await capture(boards);
    for (const n of names) if (n !== 'G') expect(agedAfter[n], `board ${n}`).toEqual(before[n]);
  }, 120_000);

  it('a mistyped mode stops before anything runs', async () => {
    const r = runScript(dbUrl, { mode: 'comit' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('mode must be diagnose, dryrun or commit, not comit');
    expect(r.out).not.toContain('== Run');
  });

  it('says a string is a calendar day exactly when isCalendarDay does', async () => {
    await resetTables(dbUrl);
    const created = await boot();
    await stop(created);
    const strings = new Set<string>(['9999-99-99', '0000-01-01', '0000-02-29', '1900-02-29', '2000-02-29',
      '2100-02-29', '2024-02-29', '2025-02-29', '2026-1-01', '2026-01-1', '2026-01-01 ', ' 2026-01-01',
      '2026-01-01\n', '20260101', '2026/01/01', '2026-01-0a', '+02026-01-01', '', '2026-٠١-01']);
    for (const y of ['0000', '0004', '1900', '2000', '2023', '2024', '2100', '9999']) {
      for (let m = 0; m <= 13; m++) {
        for (let d = 0; d <= 32; d++) strings.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      }
    }
    const list = Array.from(strings);
    await sql(dbUrl,
      `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
       SELECT 'c', 'claude', 'p' || n, d, 1, 1 FROM unnest($1::text[]) WITH ORDINALITY AS u(d, n)`,
      [list]);
    // Committed, so the plan's temporary tables outlive the transaction and
    // the -c after the script can read them in the same session.
    const r = runScript(dbUrl, { mode: 'commit', now_ms: String(NOON) },
      ["COPY (SELECT day, is_day FROM flag_pd WHERE workspace_id = 'c') TO STDOUT WITH (FORMAT csv)"]);
    expect(r.status, r.out).toBe(0);
    const verdict = new Map<string, boolean>();
    const csv = r.out.split('Committed.')[1] ?? '';
    for (const m of csv.matchAll(/^("(?:[^"]|"")*"|[^,\n]*),([tf])$/gm)) {
      const raw = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
      verdict.set(raw, m[2] === 't');
    }
    const disagree = list.filter((s) => verdict.get(s) !== isCalendarDay(s));
    expect(verdict.size).toBe(list.length);
    expect(disagree).toEqual([]);
  });
});
