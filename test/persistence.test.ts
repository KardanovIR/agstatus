import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import {
  makeApp,
  createWorkspace,
  webhookBody,
  TEST_PG_URL,
  suiteDatabaseUrl,
  resetTables,
  sql,
} from './helpers';

describe.skipIf(!TEST_PG_URL)('persistence (PostgreSQL)', () => {
  let dbUrl = '';

  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('persistence');
  });
  beforeEach(() => resetTables(dbUrl));

  it('workspaces and sessions survive a restart against the same database', async () => {
    // First app: create a workspace and post a session, then shut down.
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('persisted', { name: 'Keeper', message: 'still here', project: 'proj' }))
      .expect(200);
    await first.store.flush();
    first.shutdown();

    // Second app on the same database: token resolves, session is still there.
    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id: 'persisted',
        status: 'coding',
        name: 'Keeper',
        message: 'still here',
        project: 'proj',
        source: 'claude',
      });

      // Token also resolves for the dashboard route
      const html = await request(second.app).get(`/w/${token}`).expect(200);
      expect(html.headers['content-type']).toMatch(/text\/html/);
    } finally {
      second.shutdown();
    }
  });

  it('a workspace deleted before shutdown stays deleted after restart', async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('gone')).expect(200);
    await request(first.app).delete(`/w/${token}`).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const res = await request(second.app).get(`/w/${token}/api/sessions`).expect(404);
      expect(res.body).toEqual({ error: 'unknown workspace' });
    } finally {
      second.shutdown();
    }
  });

  it('a session host survives a restart, and every soft delete keeps it on the row', async () => {
    const host = {
      machine: { id: '9f2c'.repeat(8), name: 'Mac' },
      app: { slug: 'herdr', name: 'herdr', kind: 'multiplexer' },
    };
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('hosted', { host })).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('dismissed', { host })).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('bare')).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      const byId = new Map(list.body.map((s: { id: string; host: unknown }) => [s.id, s.host]));
      expect(byId.get('hosted')).toEqual(host);
      expect(byId.get('dismissed')).toEqual(host);
      expect(byId.get('bare')).toBeNull();

      // One session dismissed, then the whole workspace. Both soft deletes must
      // leave the row FLAGGED AND STILL CARRYING ITS HOST. Every one of these
      // paths used to null the column — dismiss, workspace delete, cap
      // eviction, clear, and the daily TTL sweep — which destroyed the machine
      // and app a session ran on rather than hiding it. Deleting hides; it does
      // not erase.
      await request(second.app).delete(`/w/${token}/sessions/dismissed`).expect(200);
      await request(second.app).delete(`/w/${token}`).expect(200);
      await second.store.flush();
    } finally {
      second.shutdown();
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      const rows = await pool.query(
        'SELECT id, host, deleted_at FROM sessions WHERE id IN ($1, $2) ORDER BY id',
        ['dismissed', 'hosted']
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows as Array<{ id: string; host: string | null; deleted_at: string | null }>) {
        expect(row.deleted_at, row.id).not.toBeNull();
        // Flagged AND intact. This assertion is inverted from what it was: it
        // used to require the host be gone, which is what made a delete
        // destructive. If a future change reintroduces a `host = NULL` on any
        // soft-delete path, this fails.
        expect(row.host, row.id).not.toBeNull();
      }
    } finally {
      await pool.end();
    }

    const third = makeApp({ databaseUrl: dbUrl });
    await third.ready;
    try {
      await request(third.app).get(`/w/${token}/api/sessions`).expect(404);
    } finally {
      third.shutdown();
    }
  });

  it('a malformed host column loads as null instead of failing the load', async () => {
    // Not JSON, and well-formed JSON of the wrong shape: none of it may reach
    // the board, and none of it may break the load.
    const corrupt: Record<string, string> = {
      'not-json': '{not json',
      'wrong-shape': '{"cwd":"/Users/x"}',
      'a-string': '"x"',
      'an-array': '[]',
    };
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    for (const id of Object.keys(corrupt)) {
      await request(first.app).post(`/w/${token}/webhook`).send(webhookBody(id)).expect(200);
    }
    await first.store.flush();
    first.shutdown();

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      for (const [id, host] of Object.entries(corrupt)) {
        await pool.query('UPDATE sessions SET host = $2 WHERE id = $1', [id, host]);
      }
    } finally {
      await pool.end();
    }

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body.map((s: { id: string }) => s.id).sort()).toEqual(Object.keys(corrupt).sort());
      for (const s of list.body as Array<{ id: string; host: unknown }>) {
        expect(s.host, s.id).toBeNull();
      }
    } finally {
      second.shutdown();
    }
  });

  it('write ordering holds: an upsert never resurrects a later delete', async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    // Rapid upsert → delete → upsert → delete without flushing in between:
    // the serialized write queue must replay them in order.
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('flappy')).expect(200);
    await request(first.app).delete(`/w/${token}/sessions/flappy`).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('flappy')).expect(200);
    await request(first.app).delete(`/w/${token}/sessions/flappy`).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toEqual([]);
    } finally {
      second.shutdown();
    }
  });
});

describe.skipIf(!TEST_PG_URL)('persistence: subtasks (PostgreSQL)', () => {
  let dbUrl = '';
  const agentKey = (seed: string): string => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  const A = agentKey('a');
  const B = agentKey('b');
  const C = agentKey('c');
  const X = agentKey('x');

  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('persistence_subtasks');
  });
  beforeEach(() => resetTables(dbUrl));

  /** A first app on the test database, with a board and the hook's two kinds of post. */
  async function first() {
    const t = makeApp({ databaseUrl: dbUrl });
    await t.ready;
    const token = await createWorkspace(t.app);
    let at = Date.now() - 60_000;
    const post = (body: Record<string, unknown>) => request(t.app).post(`/w/${token}/webhook`).send(body).expect(200);
    const main = (sid: string, status: string, message: string, extra: Record<string, unknown> = {}) =>
      post({ session_id: sid, status, message, ...extra });
    const sub = (sid: string, id: string, state: string, extra: Record<string, unknown> = {}) =>
      post({ session_id: sid, status: 'planning', agent: { id, state, at: (at += 1), ...extra } });
    return { ...t, token, post, main, sub };
  }
  async function restart(token: string) {
    const t = makeApp({ databaseUrl: dbUrl });
    await t.ready;
    const cards = async () => (await request(t.app).get(`/w/${token}/api/sessions`).expect(200)).body as Array<Record<string, any>>;
    const card = async (id: string) => (await cards()).find((c) => c.id === id);
    return { ...t, cards, card };
  }

  it('rows, the tally, the numbering, a report hold and a soft block survive a restart', async () => {
    const one = await first();
    await one.main('kept', 'planning', 'Go', { turn: { phase: 'start' } });
    await one.sub('kept', A, 'testing', { label: 'review:hook', activity: 'Run the hook tests' });
    await one.sub('kept', B, 'coding');
    await one.sub('kept', C, 'failed', { activity: 'Failed: boom' });
    await one.sub('kept', agentKey('d'), 'planning');
    await one.sub('kept', agentKey('d'), 'done');
    await one.main('kept', 'blocked', 'Claude needs your permission', { unattributed: true });
    await one.main('held', 'planning', 'Go', { turn: { phase: 'start' } });
    await one.sub('held', X, 'coding');
    await one.main('held', 'done', 'Turn finished', { turn: { phase: 'end', running: [X], workflows: 0 } });
    await one.sub('held', X, 'done');
    const before = await request(one.app).get(`/w/${one.token}/api/sessions`).expect(200);
    await one.store.flush();
    one.shutdown();

    const two = await restart(one.token);
    try {
      expect(await two.cards()).toEqual(before.body);
      const kept = await two.card('kept');
      expect(kept).toMatchObject({ status: 'blocked', message: 'Claude needs your permission' });
      expect(kept!.subtasks).toMatchObject({ running: 2, failed: 1, done: 1 });
      expect(await two.card('held')).toMatchObject({ status: 'planning', message: 'Reading subagent results' });

      // The soft block still knows what to give back, and the numbering carries on.
      const wsId = two.store.resolveToken(one.token)!;
      const at = Date.now();
      two.store.upsertSession(wsId, { id: 'kept', status: 'coding', agent: { id: A, state: 'coding', at } }, Infinity);
      const next = two.store.upsertSession(wsId, { id: 'kept', status: 'planning', agent: { id: X, state: 'planning', at } }, Infinity);
      expect(next.session).toMatchObject({ status: 'planning', message: 'Go' });
      expect(next.session!.subtasks!.items.map((i) => i.n)).toEqual([1, 2, 3, 5]);
    } finally {
      two.shutdown();
    }
  });

  it('a malformed, oversized or out-of-date column loads as no state, and a derived line with it', async () => {
    const one = await first();
    for (const id of ['fine', 'malformed', 'oversized', 'rolled-back']) {
      await one.main(id, 'coding', 'Editing app.ts');
      await one.sub(id, A, 'blocked', { label: 'verify:hook' });
    }
    await one.store.flush();
    one.shutdown();

    // Not JSON; valid JSON past the 65,536-character guard, which would
    // otherwise load (an unknown key is ignored); and a row a 1.6.3 server
    // wrote to after the state was saved, as a rollback would leave it.
    await sql(dbUrl, `UPDATE sessions SET subtasks = '{not json' WHERE id = 'malformed'`);
    await sql(dbUrl, `UPDATE sessions SET subtasks = left(subtasks, length(subtasks) - 1) || ',"pad":"' || repeat('x', 70000) || '"}' WHERE id = 'oversized'`);
    await sql(dbUrl, `UPDATE sessions SET status = 'testing', message = 'npm test', updated_at = updated_at + 1000 WHERE id = 'rolled-back'`);
    const [{ length }] = await sql<{ length: number }>(dbUrl, `SELECT length(subtasks) AS length FROM sessions WHERE id = 'oversized'`);
    expect(length).toBeGreaterThan(65_536);

    const two = await restart(one.token);
    try {
      expect(await two.card('fine')).toMatchObject({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: { blocked: 1 } });
      for (const id of ['malformed', 'oversized']) {
        const card = await two.card(id);
        expect(card, id).toMatchObject({ status: 'idle', message: '' });
        expect(card, id).not.toHaveProperty('subtasks');
      }
      const rolled = await two.card('rolled-back');
      expect(rolled).toMatchObject({ status: 'testing', message: 'npm test' });
      expect(rolled).not.toHaveProperty('subtasks');
    } finally {
      two.shutdown();
    }
  });

  it('every soft delete keeps the column on the flagged row', async () => {
    const one = await first();
    for (const id of ['dismissed', 'cleared']) {
      await one.main(id, 'coding', 'Working');
      await one.sub(id, A, 'coding', { label: 'review:hook' });
    }
    await request(one.app).delete(`/w/${one.token}/sessions/dismissed`).expect(200);
    await request(one.app).post(`/w/${one.token}/sessions/clear`).expect(200);
    await one.store.flush();
    one.shutdown();

    const rows = await sql<{ id: string; subtasks: string | null; deleted_at: string | null }>(
      dbUrl, `SELECT id, subtasks, deleted_at FROM sessions ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['cleared', 'dismissed']);
    for (const row of rows) {
      expect(row.deleted_at, row.id).not.toBeNull();
      expect(JSON.parse(row.subtasks!), row.id).toMatchObject({ v: 1, rows: [[A, 1, 'a', 'c', 'review:hook', '', expect.any(Number), expect.any(Number), expect.any(Number)]] });
    }
  });

  it('a sessions table from before the column gains it at boot, and its rows load as they were', async () => {
    const token = `ags_${'k'.repeat(32)}`;
    const wsId = crypto.createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    // The 1.6.3 schema, exactly.
    await sql(dbUrl, `
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL, deleted_at BIGINT);
      CREATE TABLE sessions (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        message TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'claude',
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT, host TEXT,
        PRIMARY KEY (workspace_id, id)
      );`);
    await sql(dbUrl, 'INSERT INTO workspaces (id, created_at, last_seen_at) VALUES ($1, $2, $2)', [wsId, now]);
    await sql(dbUrl,
      `INSERT INTO sessions (workspace_id, id, name, status, message, project, created_at, updated_at)
       VALUES ($1, 'old', 'Old card', 'coding', 'Editing app.ts', 'proj', $2, $2)`, [wsId, now]);

    const t = await restart(token);
    try {
      const columns = await sql<{ column_name: string; is_nullable: string }>(dbUrl,
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'subtasks'`);
      expect(columns).toEqual([{ column_name: 'subtasks', is_nullable: 'YES' }]);
      const old = await t.card('old');
      expect(old).toMatchObject({ name: 'Old card', status: 'coding', message: 'Editing app.ts' });
      expect(old).not.toHaveProperty('subtasks');

      await request(t.app).post(`/w/${token}/webhook`)
        .send({ session_id: 'old', status: 'coding', agent: { id: A, state: 'coding', at: Date.now() } }).expect(200);
      await t.store.flush();
      const [row] = await sql<{ subtasks: string }>(dbUrl, `SELECT subtasks FROM sessions WHERE id = 'old'`);
      expect(JSON.parse(row.subtasks)).toMatchObject({ v: 1, own: ['coding', 'Editing app.ts', null, null] });
    } finally {
      t.shutdown();
    }
  });
});
