import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  makeApp,
  createWorkspace,
  webhookBody,
  TEST_PG_URL,
  suiteDatabaseUrl,
  resetTables,
  sql,
} from './helpers';
import {
  homeProjectFor,
  LEGACY_WS,
  MAX_SESSIONS_PER_WORKSPACE,
  normalizeProject,
  Store,
  UUID_FOLDER_RE,
} from '../src/store';

// The board grouped by project (docs/design/project-sections.md, "Wire
// contract"). Every session goes out with `homeProject`: the first usable
// folder the server heard for it ('' and bare UUIDs are not usable), held for
// the session's life, worked out here and never taken from a post. The boards
// key their sections by it, so a card whose agent runs `cd web` keeps its
// place in its section, and only its line says "in web".

type Json = Record<string, any>;

/** The UUID in the spec's shared order vector, which every client sorts. */
const UUID = '0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b';

/** 1.6.5's keys in 1.6.5's order, then the one this adds. */
const KEYS = ['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt', 'homeProject'];

/** A fresh in-memory board, posting the way the hook does. */
async function board() {
  const t = makeApp();
  await t.ready;
  const token = await createWorkspace(t.app);
  const post = async (id: string, extra: Json = {}): Promise<Json> =>
    (await request(t.app).post(`/w/${token}/webhook`).send(webhookBody(id, extra)).expect(200)).body.session;
  const list = async (): Promise<Json[]> => (await request(t.app).get(`/w/${token}/api/sessions`).expect(200)).body;
  const card = async (id: string): Promise<Json | undefined> => (await list()).find((s) => s.id === id);
  return { ...t, token, post, list, card };
}

/** Fills a board past its cap, so the card posted longest ago is evicted. */
async function evictOldest(post: (id: string, extra?: Json) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < MAX_SESSIONS_PER_WORKSPACE; i += 1) await post(`filler-${i}`, { project: 'other' });
}

describe('homeProject: which folders count', () => {
  it('turns "" and a bare UUID into "", and keeps every other name exactly as sent', () => {
    expect(normalizeProject('')).toBe('');
    expect(normalizeProject(UUID)).toBe('');
    expect(normalizeProject(UUID.toUpperCase())).toBe('');
    // Case is the folder's own: AgStatus and agstatus are two sections.
    expect(normalizeProject('AgStatus')).toBe('AgStatus');
    expect(normalizeProject('agstatus')).toBe('agstatus');
    // Names from the owner's board that only look like scratch, and names
    // that only look like a UUID: a section is a folder name, so all stay.
    for (const name of [
      'wf_0b2e3442-125-1', 'scratch-2026-10-05-47589e', 'zealous-jennings-84637b', 'is-it-a-good-idea-to',
      `${UUID}-copy`, UUID.slice(1), UUID.replace(/-/g, ''), 'codex', 'Codex', 'ios',
    ]) {
      expect(normalizeProject(name), name).toBe(name);
    }
  });

  it('files the shared order vector as every client does: the empty name and the UUID have no project', () => {
    const vector = ['zeta', '', 'Alpha', 'alpha', 'beta', 'AgStatus', 'agstatus', UUID];
    expect(vector.map(normalizeProject)).toEqual(['zeta', '', 'Alpha', 'alpha', 'beta', 'AgStatus', 'agstatus', '']);
  });

  it('keeps the home a session has, else takes its current project when that is usable', () => {
    expect(homeProjectFor('', 'acme-api')).toBe('acme-api');
    expect(homeProjectFor('acme-api', 'web')).toBe('acme-api');
    expect(homeProjectFor('acme-api', '')).toBe('acme-api');
    expect(homeProjectFor('acme-api', UUID)).toBe('acme-api');
    expect(homeProjectFor('', '')).toBe('');
    expect(homeProjectFor('', UUID)).toBe('');
    // A value read back from the database is held to the same rule.
    expect(homeProjectFor(UUID, 'acme-api')).toBe('acme-api');
  });

  it("uses the hook's own UUID pattern: a folder the hook will not name a card after is no project either", () => {
    for (const copy of ['plugin/scripts/agstatus-hook.js', 'cli/assets/agstatus-hook.js']) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', copy), 'utf8');
      const hook = /^const UUID_NAME_RE = \/(.+)\/([a-z]*);$/m.exec(text);
      expect(hook, `${copy} has no UUID_NAME_RE`).not.toBeNull();
      expect(UUID_FOLDER_RE.source, copy).toBe(hook![1]);
      expect(UUID_FOLDER_RE.flags, copy).toBe(hook![2]);
    }
  });
});

describe('homeProject on a board without a database', () => {
  it('is pinned by the first post, and a later cd does not move it', async () => {
    const b = await board();
    expect(await b.post('s', { project: 'acme-api' })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    // `project` follows the session; the home does not.
    expect(await b.post('s', { project: 'web' })).toMatchObject({ project: 'web', homeProject: 'acme-api' });
    expect(await b.post('s', { project: 'acme-api' })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    expect(await b.post('s', { project: 'docs' })).toMatchObject({ project: 'docs', homeProject: 'acme-api' });
    expect(await b.card('s')).toMatchObject({ project: 'docs', homeProject: 'acme-api' });
  });

  it('skips "" and a UUID, then lets the first real folder claim the session', async () => {
    const b = await board();
    // Codex Desktop started at /, then a scratch folder named by a UUID: the
    // live value is kept as sent, and the session has no home yet.
    expect(await b.post('s', { project: '' })).toMatchObject({ project: '', homeProject: '' });
    expect(await b.post('s', { project: UUID })).toMatchObject({ project: UUID, homeProject: '' });
    expect(await b.post('s', { project: 'acme-api' })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    // Claimed once: no placeholder takes it back, and no second folder.
    expect(await b.post('s', { project: '' })).toMatchObject({ project: '', homeProject: 'acme-api' });
    expect(await b.post('s', { project: UUID.toUpperCase() })).toMatchObject({ homeProject: 'acme-api' });
    expect(await b.post('s', { project: 'web' })).toMatchObject({ homeProject: 'acme-api' });
  });

  it('carries the home forward through a post without a project', async () => {
    const b = await board();
    await b.post('s', { project: 'acme-api' });
    // No project key at all, and one that is not a string: either way
    // `project` is carried forward, and the home with it.
    expect(await b.post('s', { message: 'Editing a.ts' })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    expect(await b.post('s', { project: 42 })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    // A raw webhook post that never names a folder has no home, until one does.
    expect(await b.post('raw', { name: 'curl' })).toMatchObject({ project: '', homeProject: '' });
    expect(await b.post('raw')).toMatchObject({ project: '', homeProject: '' });
    expect(await b.post('raw', { project: 'ops' })).toMatchObject({ project: 'ops', homeProject: 'ops' });
  });

  it("is carried by a subagent's post, which names no folder, even one that creates the card", async () => {
    const b = await board();
    const agent = (state: string): Json => ({ agent: { id: 'a1b2c3d4e5f6a7b8c9d0e1f2', state, at: Date.now() } });
    // The subagent is heard first: a card with no folder yet.
    expect(await b.post('s', agent('coding'))).toMatchObject({ project: '', homeProject: '' });
    // The parent's own post names one, and claims the card.
    expect(await b.post('s', { project: 'acme-api' })).toMatchObject({ homeProject: 'acme-api' });
    expect(await b.post('s', { project: 'web' })).toMatchObject({ homeProject: 'acme-api' });
    expect(await b.post('s', agent('testing'))).toMatchObject({ project: 'web', homeProject: 'acme-api' });
  });

  it('is never taken from a post', async () => {
    const b = await board();
    expect(await b.post('s', { project: 'acme-api', homeProject: 'evil', home_project: 'evil' }))
      .toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    expect(await b.post('s', { homeProject: 'web' })).toMatchObject({ homeProject: 'acme-api' });
    // Nor on a card that has no home yet.
    expect(await b.post('t', { homeProject: 'evil' })).toMatchObject({ project: '', homeProject: '' });
  });

  it('starts over when the board dropped the card: evicted, or dismissed, then posting again', async () => {
    const b = await board();
    await b.post('s', { project: 'acme-api' });
    await b.post('s', { project: 'web' });
    await evictOldest(b.post);
    expect(await b.card('s')).toBeUndefined();
    // The card the next post makes is new to the board, as its createdAt and
    // its timeline are, so its home is the folder it names now.
    expect(await b.post('s', { project: 'web' })).toMatchObject({ project: 'web', homeProject: 'web' });
    expect((await request(b.app).get(`/w/${b.token}/api/sessions/s/history`).expect(200)).body).toHaveLength(1);

    await request(b.app).delete(`/w/${b.token}/sessions/s`).expect(200);
    expect(await b.post('s', { project: 'docs' })).toMatchObject({ project: 'docs', homeProject: 'docs' });
  });

  it('goes out on every read: REST after updatedAt, the snapshot, a session frame, and a legacy board', async () => {
    const b = await board();
    await b.post('s', { project: 'acme-api' });
    await b.post('s', { project: 'web' });
    const rest = (await b.card('s'))!;
    expect(Object.keys(rest)).toEqual(KEYS);
    expect(rest).toMatchObject({ project: 'web', homeProject: 'acme-api' });

    const { srv, base } = await listen(b.app);
    const ac = new AbortController();
    try {
      const res = await fetch(`${base}/w/${b.token}/events`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(200);
      const next = frames(res);
      expect(await next('snapshot')).toEqual([rest]);
      await b.post('s', { project: 'docs' });
      const frame = await next('session');
      expect(Object.keys(frame)).toEqual(KEYS);
      expect(frame).toMatchObject({ id: 's', project: 'docs', homeProject: 'acme-api' });
    } finally {
      ac.abort();
      await closeServer(srv);
    }

    const legacy = makeApp({ multiTenant: false });
    await request(legacy.app).post('/webhook').send(webhookBody('s', { project: 'acme-api' })).expect(200);
    await request(legacy.app).post('/webhook').send(webhookBody('s', { project: 'web' })).expect(200);
    expect((await request(legacy.app).get('/api/sessions').expect(200)).body)
      .toEqual([expect.objectContaining({ project: 'web', homeProject: 'acme-api' })]);
  });

  it('lives on the stored session, and memory is its only copy', async () => {
    const store = new Store('');
    await store.ready;
    const up = (project?: string) => store.upsertSession(LEGACY_WS, { id: 's', status: 'coding', project }, Infinity).session!;
    expect(up('acme-api')).toMatchObject({ homeProject: 'acme-api' });
    expect(up('web')).toMatchObject({ project: 'web', homeProject: 'acme-api' });
    expect(up(undefined)).toMatchObject({ project: 'web', homeProject: 'acme-api' });
    expect(store.getSession(LEGACY_WS, 's')).toMatchObject({ homeProject: 'acme-api' });
    expect(store.getSessions(LEGACY_WS)).toEqual([expect.objectContaining({ homeProject: 'acme-api' })]);
    await store.close();

    // So a server without a database forgets it with the card when it
    // restarts: the next post makes a new card, at home where it is now.
    const first = makeApp({ multiTenant: false });
    await request(first.app).post('/webhook').send(webhookBody('s', { project: 'acme-api' })).expect(200);
    await request(first.app).post('/webhook').send(webhookBody('s', { project: 'web' })).expect(200);
    await first.shutdown();
    const second = makeApp({ multiTenant: false });
    expect((await request(second.app).get('/api/sessions').expect(200)).body).toEqual([]);
    const res = await request(second.app).post('/webhook').send(webhookBody('s', { project: 'web' })).expect(200);
    expect(res.body.session).toMatchObject({ project: 'web', homeProject: 'web' });
  });
});

describe.skipIf(!TEST_PG_URL)('homeProject on disk (PostgreSQL)', () => {
  let dbUrl = '';

  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('home_project');
  });
  beforeEach(() => resetTables(dbUrl));

  interface Row { id: string; project: string; home_project: string | null; deleted_at: string | null }
  const rows = (where = ''): Promise<Row[]> =>
    sql<Row>(dbUrl, `SELECT id, project, home_project, deleted_at FROM sessions ${where} ORDER BY id`);
  const post = (app: Express, token: string, id: string, extra: Json = {}) =>
    request(app).post(`/w/${token}/webhook`).send(webhookBody(id, extra)).expect(200).then((r) => r.body.session as Json);
  const listed = async (app: Express, token: string): Promise<Record<string, Json>> =>
    Object.fromEntries(((await request(app).get(`/w/${token}/api/sessions`).expect(200)).body as Json[]).map((s) => [s.id, s]));

  it('survives a restart after the session has moved, and a session with none still waits for a real folder', async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await post(first.app, token, 'moved', { project: 'acme-api' });
    await post(first.app, token, 'moved', { project: 'web' });
    await post(first.app, token, 'root', { project: '' });
    await post(first.app, token, 'scratch', { project: UUID });
    await first.store.flush();
    await first.shutdown();
    expect(await rows()).toEqual([
      { id: 'moved', project: 'web', home_project: 'acme-api', deleted_at: null },
      { id: 'root', project: '', home_project: '', deleted_at: null },
      { id: 'scratch', project: UUID, home_project: '', deleted_at: null },
    ]);

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const byId = await listed(second.app, token);
      expect(byId.moved).toMatchObject({ project: 'web', homeProject: 'acme-api' });
      expect(byId.root).toMatchObject({ project: '', homeProject: '' });
      expect(byId.scratch).toMatchObject({ project: UUID, homeProject: '' });
      expect(await post(second.app, token, 'moved', { project: 'docs' })).toMatchObject({ homeProject: 'acme-api' });
      expect(await post(second.app, token, 'root', { project: 'beta' })).toMatchObject({ homeProject: 'beta' });
      await second.store.flush();
    } finally {
      await second.shutdown();
    }
    expect((await rows()).map((r) => [r.id, r.project, r.home_project])).toEqual([
      ['moved', 'docs', 'acme-api'],
      ['root', 'beta', 'beta'],
      ['scratch', UUID, ''],
    ]);
  });

  it("gives a 1.6.5 database the column, files each live row under that row's own project, and loads without writing", async () => {
    // The tables as 1.6.5 created them (sessions has neither subtasks nor
    // home_project), with one board and the rows it left: a session that was
    // last seen in web/, one at /, one in a UUID folder, and one dismissed.
    await sql(dbUrl, `CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL, deleted_at BIGINT)`);
    await sql(dbUrl, `CREATE TABLE sessions (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      message TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'claude',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT, host TEXT,
      PRIMARY KEY (workspace_id, id))`);
    const token = `ags_${'h'.repeat(32)}`;
    const wsId = crypto.createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    await sql(dbUrl, 'INSERT INTO workspaces (id, created_at, last_seen_at) VALUES ($1, $2, $2)', [wsId, now]);
    const insert = (id: string, project: string, deletedAt: number | null = null) =>
      sql(dbUrl,
        `INSERT INTO sessions (workspace_id, id, name, status, message, project, source, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $2, 'coding', '', $3, 'claude', $4, $4, $5)`,
        [wsId, id, project, now, deletedAt]);
    await insert('live', 'web');
    await insert('root', '');
    await insert('scratch', UUID);
    await insert('dismissed', 'gone', now - 1000);
    const asLeft: Row[] = [
      { id: 'dismissed', project: 'gone', home_project: null, deleted_at: String(now - 1000) },
      { id: 'live', project: 'web', home_project: null, deleted_at: null },
      { id: 'root', project: '', home_project: null, deleted_at: null },
      { id: 'scratch', project: UUID, home_project: null, deleted_at: null },
    ];

    const upgraded = makeApp({ databaseUrl: dbUrl });
    await upgraded.ready;
    try {
      await upgraded.store.flush();
      // The column is there, and every row is as 1.6.5 left it.
      expect(await rows()).toEqual(asLeft);
      const byId = await listed(upgraded.app, token);
      // Derived once from the row's project, the folder the session last
      // reported: the best there is for a session this server never saw start.
      expect(byId.live).toMatchObject({ project: 'web', homeProject: 'web' });
      expect(byId.root).toMatchObject({ homeProject: '' });
      expect(byId.scratch).toMatchObject({ homeProject: '' });
      expect(byId.dismissed).toBeUndefined();
      // Its next write puts it in the column, and a cd after the deploy does not move it.
      expect(await post(upgraded.app, token, 'live', { project: 'web-tests' })).toMatchObject({ homeProject: 'web' });
      await upgraded.store.flush();
    } finally {
      await upgraded.shutdown();
    }
    expect(await rows()).toEqual([
      asLeft[0],
      { id: 'live', project: 'web-tests', home_project: 'web', deleted_at: null },
      asLeft[2],
      asLeft[3],
    ]);

    // From the column now, on the next restart.
    const again = makeApp({ databaseUrl: dbUrl });
    await again.ready;
    try {
      expect((await listed(again.app, token)).live).toMatchObject({ project: 'web-tests', homeProject: 'web' });
    } finally {
      await again.shutdown();
    }
  });

  it('keeps the home on an evicted row, flagged, and a re-post starts over on the same row', async () => {
    const t = makeApp({ databaseUrl: dbUrl });
    await t.ready;
    try {
      const token = await createWorkspace(t.app);
      await post(t.app, token, 's', { project: 'acme-api' });
      await post(t.app, token, 's', { project: 'web' });
      await evictOldest((id, extra) => post(t.app, token, id, extra));
      await t.store.flush();
      // Flagged, not erased: the row still says where the session lived.
      const [evicted] = await rows(`WHERE id = 's'`);
      expect(evicted).toMatchObject({ project: 'web', home_project: 'acme-api' });
      expect(evicted.deleted_at).not.toBeNull();

      expect(await post(t.app, token, 's', { project: 'web' })).toMatchObject({ homeProject: 'web' });
      await t.store.flush();
      expect(await rows(`WHERE id = 's'`)).toEqual([{ id: 's', project: 'web', home_project: 'web', deleted_at: null }]);
    } finally {
      await t.shutdown();
    }
  });
});

// ---- the event stream -------------------------------------------------------
// supertest does not hold a long-lived stream well, so the stream test runs
// the app on a real port and reads it with fetch, as test/sse.test.ts does.

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

/** Reads an event stream frame by frame: each call returns the data of the next frame of that event. */
function frames(res: Response): (event: string) => Promise<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return async (event: string) => {
    const deadline = Date.now() + 4000;
    for (;;) {
      let end: number;
      while ((end = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name === event && data !== undefined) return JSON.parse(data);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no ${event} frame; buffered: ${JSON.stringify(buf)}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no ${event} frame within 4 s`)), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error(`the stream ended before a ${event} frame`);
      buf += decoder.decode(chunk.value, { stream: true });
    }
  };
}
