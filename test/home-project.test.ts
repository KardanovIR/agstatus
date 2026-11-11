import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, spawnSync } from 'child_process';
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
  DROPPED_HOME_TTL_MS,
  homeProjectFor,
  LEGACY_WS,
  MAX_DROPPED_HOMES_PER_WORKSPACE,
  MAX_SESSIONS_PER_WORKSPACE,
  normalizeProject,
  Store,
  UUID_FOLDER_RE,
} from '../src/store';

// The board grouped by project (docs/design/project-sections.md, "Wire
// contract"). Every session goes out with `homeProject`: the first usable
// folder the server heard for it (empty, white space, "/", "." and bare UUIDs
// are not usable), held for the session's life, worked out here and never
// taken from a post. The boards key their sections by it, so a card whose
// agent runs `cd web` keeps its place in its section, and only its line says
// "in web". A card the board drops on request keeps its home for its return.

type Json = Record<string, any>;

/** The UUID in the spec's shared order vector, which every client sorts. */
const UUID = '0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b';

/** 1.6.5's keys in 1.6.5's order, then the one this adds. */
const KEYS = ['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt', 'homeProject'];

const HOUR = 60 * 60 * 1000;

/**
 * One folder in the two Unicode forms it reaches the server in: composed
 * (NFC, one é), as a Linux checkout names it, and decomposed (NFD, an e and
 * then its accent), as a folder made in the macOS Finder often is.
 */
const CAFE_NFC = 'caf\u00e9';
const CAFE_NFD = 'cafe\u0301';

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

/** The store's own memory of dropped cards' homes, which nothing serves as such. */
const droppedHomes = (store: Store) =>
  (store as unknown as { droppedHomes: Map<string, Map<string, { homeProject: string; lastPostAt: number }>> })
    .droppedHomes;

describe('homeProject: which folders count', () => {
  it('turns a name that is not usable into "", testing it trimmed, and keeps every usable one exactly as sent', () => {
    // Not usable, each with the white space at its ends trimmed first: empty
    // or white space alone, "/" (the legacy shell hook's `basename /`), "."
    // and a bare UUID. A tab only reaches the rule through a direct call; a
    // posted one is stripped before (sessionName, the next describe).
    for (const name of [
      '', '   ', '/', '.', ' / ', '. ', UUID, UUID.toUpperCase(), ` ${UUID}`, `${UUID}  `, `\t${UUID}`,
    ]) {
      expect(normalizeProject(name), JSON.stringify(name)).toBe('');
    }
    // Case is the folder's own: AgStatus and agstatus are two sections.
    expect(normalizeProject('AgStatus')).toBe('AgStatus');
    expect(normalizeProject('agstatus')).toBe('agstatus');
    // Names from the owner's board that only look like scratch, names that
    // only look like a UUID, "/" or ".", and names with spaces in them: a
    // section is a folder name, so all stay, and none is trimmed.
    for (const name of [
      'wf_0b2e3442-125-1', 'scratch-2026-10-05-47589e', 'zealous-jennings-84637b', 'is-it-a-good-idea-to',
      `${UUID}-copy`, UUID.slice(1), UUID.replace(/-/g, ''), 'codex', 'Codex', 'ios',
      '..', '.github', 'my project', ' acme-api', 'acme-api ', '  acme api  ',
    ]) {
      expect(normalizeProject(name), JSON.stringify(name)).toBe(name);
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
    expect(homeProjectFor('acme-api', '/')).toBe('acme-api');
    expect(homeProjectFor('', '')).toBe('');
    expect(homeProjectFor('', UUID)).toBe('');
    expect(homeProjectFor('', '/')).toBe('');
    expect(homeProjectFor('', '   ')).toBe('');
    expect(homeProjectFor(' acme-api ', 'web')).toBe(' acme-api ');
    // A value read back from the database is held to the same rule.
    expect(homeProjectFor(UUID, 'acme-api')).toBe('acme-api');
    expect(homeProjectFor('/', 'acme-api')).toBe('acme-api');
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

  it('keeps a usable name in Unicode NFC, so a home read back from a row is in the form a post gets', () => {
    expect(normalizeProject(CAFE_NFD)).toBe(CAFE_NFC);
    expect(normalizeProject(CAFE_NFC)).toBe(CAFE_NFC);
    expect(normalizeProject(` ${CAFE_NFD}-api `)).toBe(` ${CAFE_NFC}-api `);
    expect(homeProjectFor(CAFE_NFD, 'web')).toBe(CAFE_NFC);
    expect(homeProjectFor('', CAFE_NFD)).toBe(CAFE_NFC);
    expect(homeProjectFor('', '/')).toBe('');
  });
});

describe('homeProject on a board without a database', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('files a posted "/", ".", white space and a padded UUID under no project, and a padded real name as sent', async () => {
    const b = await board();
    // The rule never sees a posted tab: sessionName strips control characters
    // from a posted project, so "\t<uuid>" arrives a bare UUID.
    const none: Array<[string, string]> = [
      ['/', '/'], ['.', '.'], ['   ', '   '], [` ${UUID}`, ` ${UUID}`], [`\t${UUID}`, UUID],
    ];
    for (const [i, [sent, kept]] of none.entries()) {
      expect(await b.post(`none-${i}`, { project: sent }), JSON.stringify(sent))
        .toMatchObject({ project: kept, homeProject: '' });
    }
    // Like '', each waits for the first real folder, which claims the session.
    expect(await b.post('none-0', { project: 'acme-api' })).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
    expect(await b.post('none-0', { project: '/' })).toMatchObject({ project: '/', homeProject: 'acme-api' });
    // A usable name is used exactly as sent, spaces and all.
    expect(await b.post('spaced', { project: 'my project' })).toMatchObject({ homeProject: 'my project' });
    expect(await b.post('padded', { project: ' acme-api ' }))
      .toMatchObject({ project: ' acme-api ', homeProject: ' acme-api ' });
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

  it('keeps the home when the board dropped the card on request: evicted, dismissed or cleared, then posting again', async () => {
    const b = await board();
    // As the hook posts: the name it pinned at the first event, every time.
    const as = (project: string): Json => ({ name: 'acme-api', project });
    await b.post('s', as('acme-api'));
    await b.post('s', as('web'));
    await evictOldest(b.post);
    expect(await b.card('s')).toBeUndefined();
    // Back in acme-api, saying where it is now, rather than filed under web.
    expect(await b.post('s', as('web'))).toMatchObject({ name: 'acme-api', project: 'web', homeProject: 'acme-api' });
    // Otherwise the card is new to the board, as its timeline shows.
    expect((await request(b.app).get(`/w/${b.token}/api/sessions/s/history`).expect(200)).body).toHaveLength(1);

    // A viewer's swipe and the hook's SessionEnd are both this DELETE.
    await request(b.app).delete(`/w/${b.token}/sessions/s`).expect(200);
    expect(await b.post('s', as('docs'))).toMatchObject({ project: 'docs', homeProject: 'acme-api' });
    // A clear drops every card at once, and each keeps its home the same way.
    await request(b.app).post(`/w/${b.token}/sessions/clear`).expect(200);
    expect(await b.list()).toEqual([]);
    expect(await b.post('s', as('web'))).toMatchObject({ homeProject: 'acme-api' });
    expect(await b.post('filler-9', { project: 'docs' })).toMatchObject({ homeProject: 'other' });
    // A subagent's post, which names no folder, brings the card back home too.
    await request(b.app).delete(`/w/${b.token}/sessions/s`).expect(200);
    expect(await b.post('s', { agent: { id: 'a1b2c3d4e5f6a7b8c9d0e1f2', state: 'coding', at: Date.now() } }))
      .toMatchObject({ project: '', homeProject: 'acme-api' });
    // Back on the board the card holds its home itself, and a cd still does not move it.
    expect(await b.post('s', as('web'))).toMatchObject({ project: 'web', homeProject: 'acme-api' });

    // A card with no home yet has none to keep: its first real folder claims it.
    await b.post('raw', { project: '' });
    await request(b.app).delete(`/w/${b.token}/sessions/raw`).expect(200);
    expect(await b.post('raw', { project: 'ops' })).toMatchObject({ homeProject: 'ops' });

    // A legacy board's DELETE, which needs no secret, keeps it as well.
    const legacy = makeApp({ multiTenant: false });
    const legacyPost = async (project: string): Promise<Json> =>
      (await request(legacy.app).post('/webhook').send(webhookBody('s', as(project))).expect(200)).body.session;
    await legacyPost('acme-api');
    await legacyPost('web');
    await request(legacy.app).delete('/sessions/s').expect(200);
    expect(await legacyPost('web')).toMatchObject({ project: 'web', homeProject: 'acme-api' });
  });

  it("starts over when the TTL expired the card, as the hook's name pin does", async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = new Store('');
    await store.ready;
    const up = (project: string) =>
      store.upsertSession(LEGACY_WS, { id: 's', status: 'coding', name: 'acme-api', project }, Infinity).session!;
    up('acme-api');
    expect(up('web')).toMatchObject({ project: 'web', homeProject: 'acme-api' });
    // A self-hosted board's hour-long TTL, well inside the day a dismissal
    // would be remembered for: an expiry is never remembered at all.
    clock += HOUR + 1;
    expect(store.sweepExpiredSessions(HOUR)).toEqual([{ wsId: LEGACY_WS, id: 's' }]);
    expect(up('web')).toMatchObject({ project: 'web', homeProject: 'web' });
    await store.close();
  });

  it("remembers a dropped card's home for 24 hours after its session's last post, however late the drop", async () => {
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = new Store('');
    await store.ready;
    const up = (id: string, project: string) =>
      store.upsertSession(LEGACY_WS, { id, status: 'coding', project }, Infinity).session!;
    for (const id of ['early', 'late', 'quiet']) {
      up(id, 'acme-api');
      up(id, 'web');
    }
    // Dismissed an hour after their last posts, and 23 hours after.
    clock = start + HOUR;
    store.deleteSession(LEGACY_WS, 'early');
    store.deleteSession(LEGACY_WS, 'quiet');
    clock = start + 23 * HOUR;
    store.deleteSession(LEGACY_WS, 'late');
    // A millisecond inside the day, the session is filed where it was.
    clock = start + DROPPED_HOME_TTL_MS - 1;
    expect(DROPPED_HOME_TTL_MS).toBe(24 * HOUR);
    expect(up('early', 'web')).toMatchObject({ homeProject: 'acme-api' });
    // At 24 hours the day is over for both, the late drop's included: it was
    // the session's last post the window ran from, as the hook's pin does.
    clock = start + DROPPED_HOME_TTL_MS;
    expect(up('late', 'web')).toMatchObject({ homeProject: 'web' });
    expect(up('quiet', 'web')).toMatchObject({ homeProject: 'web' });
    await store.close();
  });

  it('lets an aged home go from memory with the next drop, and never keeps one for a card already past the day', async () => {
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = new Store('');
    await store.ready;
    const up = (id: string, project: string) => store.upsertSession(LEGACY_WS, { id, status: 'coding', project }, Infinity);
    for (const id of ['a', 'b', 'c']) {
      up(id, `home-${id}`);
      store.deleteSession(LEGACY_WS, id);
    }
    expect([...droppedHomes(store).get(LEGACY_WS)!.keys()]).toEqual(['a', 'b', 'c']);
    // A card whose last post is a day old when it goes has nothing to keep.
    up('stale', 'home-stale');
    clock = start + DROPPED_HOME_TTL_MS;
    store.deleteSession(LEGACY_WS, 'stale');
    up('fresh', 'home-fresh');
    store.deleteSession(LEGACY_WS, 'fresh');
    expect([...droppedHomes(store).get(LEGACY_WS)!.entries()])
      .toEqual([['fresh', { homeProject: 'home-fresh', lastPostAt: start + DROPPED_HOME_TTL_MS }]]);
    // A card that comes back takes its entry with it.
    up('fresh', 'web');
    expect(droppedHomes(store).has(LEGACY_WS)).toBe(false);
    await store.close();
  });

  it("lets every board's aged homes go with the session sweep, so a board nobody drops on again keeps none", async () => {
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = new Store('');
    await store.ready;
    const a = store.resolveToken(store.createWorkspace().token)!;
    const b = store.resolveToken(store.createWorkspace().token)!;
    const drop = (ws: string, id: string) => {
      store.upsertSession(ws, { id, status: 'coding', project: `home-${id}` }, MAX_SESSIONS_PER_WORKSPACE);
      store.deleteSession(ws, id);
    };
    drop(a, 'early');
    drop(b, 'early');
    clock = start + HOUR;
    drop(b, 'late');
    // A day after the first drops, with nothing dropped on either board since.
    clock = start + DROPPED_HOME_TTL_MS;
    expect(store.sweepExpiredSessions(HOUR)).toEqual([]);
    expect(droppedHomes(store).has(a)).toBe(false);
    expect([...droppedHomes(store).get(b)!.keys()]).toEqual(['late']);
    // The late one's day ends an hour later, and the next sweep takes it.
    clock = start + DROPPED_HOME_TTL_MS + HOUR;
    store.sweepExpiredSessions(HOUR);
    expect(droppedHomes(store).size).toBe(0);
    await store.close();
  });

  it(`remembers at most ${MAX_DROPPED_HOMES_PER_WORKSPACE} dropped cards a board, letting the earliest drop go first`, async () => {
    const store = new Store('');
    await store.ready;
    const up = (id: string, project: string) =>
      store.upsertSession(LEGACY_WS, { id, status: 'coding', project }, Infinity).session!;
    const drop = (id: string, project: string) => {
      up(id, project);
      store.deleteSession(LEGACY_WS, id);
    };
    for (let i = 0; i < MAX_DROPPED_HOMES_PER_WORKSPACE; i += 1) drop(`s${i}`, `home-${i}`);
    expect(droppedHomes(store).get(LEGACY_WS)!.size).toBe(MAX_DROPPED_HOMES_PER_WORKSPACE);
    // s0 comes back and is dropped again: now the latest drop, not the earliest.
    expect(up('s0', 'elsewhere')).toMatchObject({ homeProject: 'home-0' });
    store.deleteSession(LEGACY_WS, 's0');
    // One more drop than the cap holds: the earliest, s1, makes room for it.
    drop('x', 'home-x');
    expect(droppedHomes(store).get(LEGACY_WS)!.size).toBe(MAX_DROPPED_HOMES_PER_WORKSPACE);
    expect(up('s1', 'elsewhere')).toMatchObject({ homeProject: 'elsewhere' });
    expect(up('s0', 'elsewhere')).toMatchObject({ homeProject: 'home-0' });
    expect(up('s2', 'elsewhere')).toMatchObject({ homeProject: 'home-2' });
    expect(up('x', 'elsewhere')).toMatchObject({ homeProject: 'home-x' });
    await store.close();
  });

  it("is each board's own, and goes with the board", async () => {
    const store = new Store('');
    await store.ready;
    const a = store.resolveToken(store.createWorkspace().token)!;
    const b = store.resolveToken(store.createWorkspace().token)!;
    const up = (ws: string, project: string) =>
      store.upsertSession(ws, { id: 's', status: 'coding', project }, MAX_SESSIONS_PER_WORKSPACE).session!;
    up(a, 'acme-api');
    store.deleteSession(a, 's');
    // The same session id on another board is that board's own session.
    expect(up(b, 'web')).toMatchObject({ homeProject: 'web' });
    expect(droppedHomes(store).get(a)?.get('s')).toMatchObject({ homeProject: 'acme-api' });
    // Deleting a board forgets its dropped cards with everything else it held.
    store.deleteWorkspace(a);
    expect(droppedHomes(store).has(a)).toBe(false);
    await store.close();
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

describe('a name and a folder in Unicode NFC', () => {
  it('come out composed when posted decomposed: in the reply, on REST, in the snapshot and a session frame, on both boards', async () => {
    const b = await board();
    expect(await b.post('s', { name: `Fix ${CAFE_NFD}`, project: CAFE_NFD }))
      .toMatchObject({ name: `Fix ${CAFE_NFC}`, project: CAFE_NFC, homeProject: CAFE_NFC });
    const rest = (await b.card('s'))!;
    expect([rest.name, rest.project, rest.homeProject]).toEqual([`Fix ${CAFE_NFC}`, CAFE_NFC, CAFE_NFC]);

    const { srv, base } = await listen(b.app);
    const ac = new AbortController();
    try {
      const res = await fetch(`${base}/w/${b.token}/events`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
      const next = frames(res);
      expect(await next('snapshot')).toEqual([rest]);
      await b.post('t', { name: CAFE_NFD, project: `${CAFE_NFD}-api` });
      expect(await next('session'))
        .toMatchObject({ id: 't', name: CAFE_NFC, project: `${CAFE_NFC}-api`, homeProject: `${CAFE_NFC}-api` });
    } finally {
      ac.abort();
      await closeServer(srv);
    }

    const legacy = makeApp({ multiTenant: false });
    const res = await request(legacy.app).post('/webhook').send(webhookBody('s', { name: CAFE_NFD, project: CAFE_NFD })).expect(200);
    expect(res.body.session).toMatchObject({ name: CAFE_NFC, project: CAFE_NFC, homeProject: CAFE_NFC });
    expect((await request(legacy.app).get('/api/sessions').expect(200)).body)
      .toEqual([expect.objectContaining({ name: CAFE_NFC, project: CAFE_NFC, homeProject: CAFE_NFC })]);
  });

  it('files a folder sent in both forms under one home, whichever came first, on one session or two', async () => {
    const b = await board();
    // A session on a Mac, then the same folder composed: nothing moved, so no
    // board says "in café" for it.
    expect(await b.post('mac', { project: CAFE_NFD })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
    expect(await b.post('mac', { project: CAFE_NFC })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
    // The other way round, as a Linux checkout of it would post.
    expect(await b.post('linux', { project: CAFE_NFC })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
    expect(await b.post('linux', { project: CAFE_NFD })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
    // Two sessions, one folder: one key, so one section on every board.
    expect([...new Set((await b.list()).map((s) => s.homeProject))]).toEqual([CAFE_NFC]);
  });

  it('composes before it cuts, and nothing between a letter and its accent keeps them apart', async () => {
    const b = await board();
    // 100 decomposed é are 200 UTF-16 units: composed first, all 100 stay.
    expect((await b.post('long', { name: 'e\u0301'.repeat(100) })).name).toBe('\u00e9'.repeat(100));
    // U+0958 is always decomposed, into two units: 100 of them are 200, cut at 120.
    expect((await b.post('qa', { name: '\u0958'.repeat(100) })).name).toBe('\u0915\u093c'.repeat(60));
    // A control character or a lone surrogate between the e and its accent goes, then the two compose.
    expect(await b.post('ctl', { project: 'cafe\u0007\u0301' })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
    expect(await b.post('sur', { project: 'cafe\ud800\u0301' })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
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

  it('keeps the home on an evicted row, flagged, and a re-post files the session there again, on the same row', async () => {
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

      expect(await post(t.app, token, 's', { project: 'web' })).toMatchObject({ homeProject: 'acme-api' });
      await t.store.flush();
      expect(await rows(`WHERE id = 's'`)).toEqual([{ id: 's', project: 'web', home_project: 'acme-api', deleted_at: null }]);
    } finally {
      await t.shutdown();
    }
  });

  it("forgets a dismissed card's home across a restart, so its next post starts over: the memory of it is not stored", async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await post(first.app, token, 's', { project: 'acme-api' });
    await post(first.app, token, 's', { project: 'web' });
    await request(first.app).delete(`/w/${token}/sessions/s`).expect(200);
    await first.store.flush();
    await first.shutdown();
    const [dismissed] = await rows(`WHERE id = 's'`);
    expect(dismissed).toMatchObject({ project: 'web', home_project: 'acme-api' });
    expect(dismissed.deleted_at).not.toBeNull();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      // The accepted cost (docs/api.md): the folder it is in now, as for a
      // card the TTL expired. The flagged row is revived, never a second one.
      expect(await post(second.app, token, 's', { project: 'web' })).toMatchObject({ homeProject: 'web' });
      await second.store.flush();
    } finally {
      await second.shutdown();
    }
    expect(await rows(`WHERE id = 's'`)).toEqual([{ id: 's', project: 'web', home_project: 'web', deleted_at: null }]);
  });

  it('loads a name, a folder and a home an older server stored decomposed in NFC, and writes nothing until the next post', async () => {
    // This server's tables, then rows as older servers left them: 1.6.5
    // wrote no home, and a 1.7.0 build before NFC stored what was posted.
    const schema = makeApp({ databaseUrl: dbUrl });
    await schema.ready;
    await schema.shutdown();
    const token = `ags_${'n'.repeat(32)}`;
    const wsId = crypto.createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    await sql(dbUrl, 'INSERT INTO workspaces (id, created_at, last_seen_at) VALUES ($1, $2, $2)', [wsId, now]);
    const insert = (id: string, name: string, project: string, home: string | null) =>
      sql(dbUrl,
        `INSERT INTO sessions (workspace_id, id, name, status, message, project, source, created_at, updated_at, home_project)
         VALUES ($1, $2, $3, 'coding', '', $4, 'claude', $5, $5, $6)`,
        [wsId, id, name, project, now, home]);
    await insert('old', `Fix ${CAFE_NFD}`, CAFE_NFD, null);
    await insert('tip', CAFE_NFD, 'web', CAFE_NFD);
    const asLeft = await rows();
    expect(asLeft.map((r) => [r.id, r.project, r.home_project])).toEqual([['old', CAFE_NFD, null], ['tip', 'web', CAFE_NFD]]);

    const t = makeApp({ databaseUrl: dbUrl });
    await t.ready;
    try {
      const byId = await listed(t.app, token);
      expect(byId.old).toMatchObject({ name: `Fix ${CAFE_NFC}`, project: CAFE_NFC, homeProject: CAFE_NFC });
      expect(byId.tip).toMatchObject({ name: CAFE_NFC, project: 'web', homeProject: CAFE_NFC });
      // Composed in memory only: loading wrote nothing.
      await t.store.flush();
      expect(await rows()).toEqual(asLeft);
      // The next post stores both in NFC, the Mac's form or not.
      expect(await post(t.app, token, 'old', { project: CAFE_NFD })).toMatchObject({ project: CAFE_NFC, homeProject: CAFE_NFC });
      await t.store.flush();
    } finally {
      await t.shutdown();
    }
    expect((await rows(`WHERE id = 'old'`)).map((r) => [r.project, r.home_project])).toEqual([[CAFE_NFC, CAFE_NFC]]);
  });
});

// ---- the legacy shell hook --------------------------------------------------
// hooks/claude-status-hook.sh is still shipped and still works. It names the
// project with POSIX `basename`, which prints "/" for a session started at the
// root where the Node hook's path.basename gives '', and both must mean No
// project. Run for real, so it needs bash, jq and curl; skipped without them.

const SHELL_HOOK = path.resolve(__dirname, '..', 'hooks', 'claude-status-hook.sh');
const shellHookRuns = ['bash', 'jq', 'curl'].every(
  (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0,
);

/** One hook event, as Claude Code delivers it: the payload on stdin. */
function runShellHook(url: string, payload: Json): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'bash',
      [SHELL_HOOK],
      { env: { PATH: process.env.PATH ?? '', CLAUDE_STATUS_URL: url }, timeout: 10_000 },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

describe.skipIf(!shellHookRuns)('homeProject from the legacy shell hook', () => {
  it('files a session it started at "/" under no project until a real folder claims it, and keeps it through SessionEnd', async () => {
    const t = makeApp({ multiTenant: false });
    const { srv, base } = await listen(t.app);
    try {
      const hook = (hook_event_name: string, cwd: string, extra: Json = {}) =>
        runShellHook(`${base}/webhook`, { hook_event_name, session_id: 'sh', cwd, ...extra });
      const card = async (): Promise<Json | undefined> =>
        ((await request(t.app).get('/api/sessions').expect(200)).body as Json[]).find((s) => s.id === 'sh');
      await hook('SessionStart', '/');
      expect(await card()).toMatchObject({ name: '/', project: '/', homeProject: '' });
      await hook('UserPromptSubmit', '/Users/me/acme-api', { prompt: 'Fix the login redirect' });
      expect(await card()).toMatchObject({ project: 'acme-api', homeProject: 'acme-api' });
      await hook('Stop', '/');
      expect(await card()).toMatchObject({ project: '/', homeProject: 'acme-api' });
      // SessionEnd is the hook's DELETE: the card goes, its home is kept for
      // the same session's return. (This hook pins no name; it sends the live
      // folder as both name and project on every post.)
      await hook('SessionEnd', '/Users/me/acme-api/web');
      expect(await card()).toBeUndefined();
      await hook('UserPromptSubmit', '/Users/me/acme-api/web', { prompt: 'And the tests' });
      expect(await card()).toMatchObject({ name: 'web', project: 'web', homeProject: 'acme-api' });
    } finally {
      await closeServer(srv);
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
