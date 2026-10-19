import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { MemoryStore } from 'express-rate-limit';
import { configFromEnv, newWorkspaceLimitLine } from '../src/config';
import { LEGACY_WS, WORKSPACE_CREATIONS_PER_HOUR, type Store } from '../src/store';
import { makeApp, TEST_PG_URL, suiteDatabaseUrl, resetTables, sql } from './helpers';

/*
 * The server-wide budget on new workspaces. Every other bound is per board,
 * and a board costs one request, so the per-IP limiter (20 an hour) was all
 * that stood between an address-rotating sender and every per-board cap
 * multiplied by as many boards as it liked. These pin the window's shape: a
 * sliding hour that counts creations, refuses with 503 and an exact
 * Retry-After, and carries across a restart.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

/** Freezes Date.now() for the duration of fn: the store's only clock, and the per-IP limiter's. */
async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(ms);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

const recentCreations = (store: Store): number[] =>
  (store as unknown as { recentCreations: number[] }).recentCreations;

describe('MAX_NEW_WORKSPACES_PER_HOUR', () => {
  it('defaults to the store constant, and takes only a whole number of at least one', () => {
    expect(WORKSPACE_CREATIONS_PER_HOUR).toBe(200);
    expect(configFromEnv({}).maxNewWorkspacesPerHour).toBe(200);
    expect(configFromEnv({ MAX_NEW_WORKSPACES_PER_HOUR: '' }).maxNewWorkspacesPerHour).toBe(200);
    for (const bad of ['lots', '0', '-5', '1.5', 'Infinity', '1e400']) {
      expect(configFromEnv({ MAX_NEW_WORKSPACES_PER_HOUR: bad }).maxNewWorkspacesPerHour, bad).toBe(200);
    }
    expect(configFromEnv({ MAX_NEW_WORKSPACES_PER_HOUR: '1' }).maxNewWorkspacesPerHour).toBe(1);
    expect(configFromEnv({ MAX_NEW_WORKSPACES_PER_HOUR: '1000' }).maxNewWorkspacesPerHour).toBe(1000);
  });

  it('names the number in force in the startup line, including when the setting never arrived', () => {
    // docker compose passes an empty string when its .env has no value, which
    // falls back without a warning: the log line is the only sign.
    const line = (env: NodeJS.ProcessEnv) => newWorkspaceLimitLine(configFromEnv({ MULTI_TENANT: 'true', ...env }));
    expect(line({ MAX_NEW_WORKSPACES_PER_HOUR: '' })).toBe(
      'Limit:     200 new workspaces in any 60 minutes, server-wide (MAX_NEW_WORKSPACES_PER_HOUR)'
    );
    expect(line({ MAX_NEW_WORKSPACES_PER_HOUR: '0' })).toContain(' 200 new workspaces ');
    expect(line({ MAX_NEW_WORKSPACES_PER_HOUR: '350' })).toContain(' 350 new workspaces ');
  });

  it('is printed by the server at startup in multi-tenant mode', async () => {
    const root = path.join(__dirname, '..');
    const child = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], {
      cwd: root,
      // PORT 0 because nothing here connects; DATABASE_URL empty keeps it in memory.
      env: { PATH: process.env.PATH, MULTI_TENANT: 'true', MAX_NEW_WORKSPACES_PER_HOUR: '7', PORT: '0', HOST: '127.0.0.1', DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const out = await new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`no banner within 8 s:\n${text}`)), 8000);
        const take = (chunk: Buffer) => {
          text += chunk.toString();
          // Storage is the banner's last line, so everything before it has arrived.
          if (text.includes('Storage:')) {
            clearTimeout(timer);
            resolve(text);
          }
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited (${code}) before its banner:\n${text}`));
        });
      });
      expect(out.split('\n')).toContain(
        'Limit:     7 new workspaces in any 60 minutes, server-wide (MAX_NEW_WORKSPACES_PER_HOUR)'
      );
    } finally {
      child.kill();
    }
  }, 10000);
});

describe('server-wide workspace creation window', () => {
  it('refuses past the budget with 503, an exact Retry-After, and the wait in the message', async () => {
    const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      await at(T0 + i * 10 * MIN, () => request(app).post('/api/workspaces').expect(201));
    }
    const refused = await at(T0 + 30 * MIN, () => request(app).post('/api/workspaces').expect(503));
    expect(refused.headers['retry-after']).toBe(String(30 * 60));
    expect(refused.body).toEqual({
      error: 'too many workspaces were created on this server in the last hour, try again in 30 minutes',
    });
    expect(refused.body.token).toBeUndefined();
  });

  it('slides: a slot frees an hour after its own creation, not at a boundary', async () => {
    const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      await at(T0 + i * 10 * MIN, () => request(app).post('/api/workspaces').expect(201));
    }

    const last = await at(T0 + HOUR - 1, () => request(app).post('/api/workspaces').expect(503));
    expect(last.headers['retry-after']).toBe('1');
    expect(last.body.error).toMatch(/try again in 1 minute$/);

    // The first creation is an hour old: exactly one slot, and only one.
    await at(T0 + HOUR, () => request(app).post('/api/workspaces').expect(201));
    // A fixed window would have reopened all three here.
    const next = await at(T0 + HOUR + 1, () => request(app).post('/api/workspaces').expect(503));
    expect(next.headers['retry-after']).toBe(String(10 * 60));
    await at(T0 + HOUR + 10 * MIN, () => request(app).post('/api/workspaces').expect(201));
  });

  it('counts creations, not attempts: refusals neither hold it shut nor spend the per-IP budget', async () => {
    const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 1 });
    await at(T0, () => request(app).post('/api/workspaces').expect(201));
    // Past the per-IP limiter's 20: had these reached it, the 20th would be a 429.
    for (let i = 1; i <= 25; i++) {
      const res = await at(T0 + MIN, () => request(app).post('/api/workspaces'));
      expect(res.status, `refused attempt #${i}`).toBe(503);
    }
    // Counted as attempts, the last refusal would keep the window shut until T0 + 1 min + 1 h.
    await at(T0 + HOUR, () => request(app).post('/api/workspaces').expect(201));
  });

  it('the per-IP limiter still answers for its own budget', async () => {
    const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 200 });
    for (let i = 1; i <= 20; i++) {
      await at(T0, () => request(app).post('/api/workspaces').expect(201));
    }
    const res = await at(T0, () => request(app).post('/api/workspaces'));
    expect(res.status).toBe(429);
  });

  it('is enforced only while rate limiting is on', async () => {
    const { app } = makeApp({ rateLimit: false, maxNewWorkspacesPerHour: 2 });
    for (let i = 1; i <= 5; i++) {
      const res = await at(T0, () => request(app).post('/api/workspaces'));
      expect(res.status, `creation #${i}`).toBe(201);
    }
  });

  it('MAX_WORKSPACES answers first, as before, and with no Retry-After', async () => {
    const { app } = makeApp({ rateLimit: true, maxWorkspaces: 1, maxNewWorkspacesPerHour: 1 });
    await at(T0, () => request(app).post('/api/workspaces').expect(201));
    const res = await at(T0 + MIN, () => request(app).post('/api/workspaces').expect(503));
    expect(res.body).toEqual({ error: 'server at capacity, try again later' });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('a board created and deleted inside the hour still counts', async () => {
    const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 2 });
    const first = await at(T0, () => request(app).post('/api/workspaces').expect(201));
    await at(T0 + MIN, () => request(app).delete(`/w/${first.body.token}`).expect(200));
    await at(T0 + 2 * MIN, () => request(app).post('/api/workspaces').expect(201));
    const res = await at(T0 + 3 * MIN, () => request(app).post('/api/workspaces').expect(503));
    expect(res.headers['retry-after']).toBe(String(57 * 60));
  });

  // The in-memory store the per-IP limiter uses settles its await before any
  // other request runs, so it never opens a gap between the early check and
  // the creation; a store that answers later (Redis, or anything over the
  // network) does. Slowed here to be one, all ten pass the early check
  // together, and only the check beside the creation holds the line.
  it('cannot be overshot by requests waiting in the per-IP limiter together', async () => {
    const increment = MemoryStore.prototype.increment;
    const slow = vi
      .spyOn(MemoryStore.prototype, 'increment')
      .mockImplementation(async function (this: MemoryStore, key: string) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return increment.call(this, key);
      });
    try {
      const { app } = makeApp({ rateLimit: true, maxNewWorkspacesPerHour: 3 });
      const statuses = await at(T0, () =>
        Promise.all(Array.from({ length: 10 }, () => request(app).post('/api/workspaces').then((r) => r.status))),
      );
      expect(slow).toHaveBeenCalled();
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 503)).toHaveLength(7);
    } finally {
      slow.mockRestore();
    }
  });

  it('keeps one timestamp per slot, however many boards it is not enforcing', async () => {
    const { app, store } = makeApp({ rateLimit: false, maxNewWorkspacesPerHour: 3 });
    for (let i = 0; i < 50; i++) {
      await at(T0 + i, () => request(app).post('/api/workspaces').expect(201));
    }
    expect(recentCreations(store)).toEqual([T0 + 47, T0 + 48, T0 + 49]);
    // And an hour later none of them is still held.
    expect(store.workspaceCreationWaitMs(T0 + 49 + HOUR)).toBe(0);
    expect(recentCreations(store)).toEqual([]);
  });
});

// ---- the web pages' answer to a refusal -------------------------------------

const PUBLIC = path.resolve(__dirname, '..', 'public');
const BOARD_SRC = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const MARKS_SRC = fs.readFileSync(path.join(PUBLIC, 'marks.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const LANDING_HTML = fs.readFileSync(path.join(PUBLIC, 'landing.html'), 'utf8');

/** The createBoardError function as written in one page, two-space indented in both. */
function createBoardErrorSource(src: string): string {
  const match = src.match(/function createBoardError\(res\) \{[\s\S]*?\n {2}\}\n/);
  if (!match) throw new Error('no createBoardError in this page');
  return match[0];
}

/** A real Response built from what the real server answered. */
async function serverRefusal(overrides: Parameters<typeof makeApp>[0]): Promise<Response> {
  const { app } = makeApp({ rateLimit: true, ...overrides });
  await request(app).post('/api/workspaces').expect(201);
  const res = await request(app).post('/api/workspaces');
  const headers: Record<string, string> = {};
  if (res.headers['retry-after']) headers['Retry-After'] = res.headers['retry-after'];
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}

/** public/app.js on "/" of a multi-tenant server: the welcome screen, with its Create button. */
async function loadWelcome(createResponse: Response) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://board.test/' });
  const doc = dom.window.document;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { addEventListener() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('location', { pathname: '/', origin: 'http://board.test', href: '', hash: '' });
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } });
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/config') return new Response(JSON.stringify({ mode: 'multi' }), { status: 200 });
    if (url === '/api/workspaces') return createResponse;
    throw new Error(`unexpected fetch ${url}`);
  });
  new Function(MARKS_SRC)();
  new Function(BOARD_SRC)();
  await vi.advanceTimersByTimeAsync(1);
  const button = doc.getElementById('create-board') as HTMLButtonElement | null;
  if (!button) throw new Error('the welcome screen has no Create button');
  return {
    button,
    async create() {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      return doc.getElementById('welcome-error')!.textContent;
    },
  };
}

describe('the web pages tell a refused creation apart', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("names the wait when the server's window is full", async () => {
    const refusal = await serverRefusal({ maxNewWorkspacesPerHour: 1 });
    expect(refusal.status).toBe(503);
    vi.useFakeTimers();
    const welcome = await loadWelcome(refusal);
    expect(await welcome.create()).toBe("This server isn't taking new boards right now. Try again in 60 minutes.");
    expect(welcome.button.disabled).toBe(false);
  });

  it('says "later" at MAX_WORKSPACES, which has no Retry-After', async () => {
    const refusal = await serverRefusal({ maxWorkspaces: 1 });
    expect(refusal.headers.get('Retry-After')).toBeNull();
    vi.useFakeTimers();
    const welcome = await loadWelcome(refusal);
    expect(await welcome.create()).toBe("This server isn't taking new boards right now. Try again later.");
  });

  it("keeps the per-address wording for the limiter's 429", async () => {
    vi.useFakeTimers();
    const welcome = await loadWelcome(new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }));
    expect(await welcome.create()).toBe('Too many boards created from this address. Try again later.');
  });

  it('the landing page carries the same function, and it reads the same', () => {
    const board = createBoardErrorSource(BOARD_SRC);
    expect(createBoardErrorSource(LANDING_HTML)).toBe(board);
    const createBoardError = new Function(`${board}; return createBoardError;`)() as (r: Response) => string;
    const wait = (s: string) => createBoardError(new Response('{}', { status: 503, headers: { 'Retry-After': s } }));
    expect(wait('1')).toBe("This server isn't taking new boards right now. Try again in 1 minute.");
    expect(wait('61')).toBe("This server isn't taking new boards right now. Try again in 2 minutes.");
    // An HTTP-date, or nonsense, is not a number of seconds: "later", never "NaN minutes".
    expect(wait('Wed, 21 Oct 2026 07:28:00 GMT')).toBe("This server isn't taking new boards right now. Try again later.");
    expect(wait('0')).toBe("This server isn't taking new boards right now. Try again later.");
    expect(createBoardError(new Response('{}', { status: 500 }))).toBe('Could not create a board. Please try again.');
  });
});

// ---- across a restart ---------------------------------------------------------

describe.skipIf(!TEST_PG_URL)('workspace creation window (PostgreSQL)', () => {
  let dbUrl = '';

  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('workspace_creation');
  });
  beforeEach(() => resetTables(dbUrl));

  it('carries across a restart, flagged boards included and legacy and aged-out rows not', async () => {
    const first = makeApp({ databaseUrl: dbUrl, rateLimit: true, maxNewWorkspacesPerHour: 3 });
    await first.ready;
    // Two hours old by the time the second process starts: outside the window.
    await at(T0 - 2 * HOUR, () => request(first.app).post('/api/workspaces').expect(201));
    await at(T0, () => request(first.app).post('/api/workspaces').expect(201));
    const deleted = await at(T0 + MIN, () => request(first.app).post('/api/workspaces').expect(201));
    await at(T0 + 2 * MIN, () => request(first.app).delete(`/w/${deleted.body.token}`).expect(200));
    await first.store.flush();
    first.shutdown();
    // Legacy mode writes this row itself; it is never a creation.
    await sql(dbUrl, 'INSERT INTO workspaces (id, created_at, last_seen_at) VALUES ($1, $2, $2)', [LEGACY_WS, T0]);

    await at(T0 + 5 * MIN, async () => {
      const second = makeApp({ databaseUrl: dbUrl, rateLimit: true, maxNewWorkspacesPerHour: 3 });
      await second.ready;
      expect(recentCreations(second.store)).toEqual([T0, T0 + MIN]);
      // T0 and the deleted T0 + 1 min hold two of the three slots.
      await request(second.app).post('/api/workspaces').expect(201);
      const res = await request(second.app).post('/api/workspaces').expect(503);
      expect(res.headers['retry-after']).toBe(String(55 * 60));
    });
  });

  it('loads no more rows than the window has slots', async () => {
    const first = makeApp({ databaseUrl: dbUrl, maxNewWorkspacesPerHour: 10 });
    await first.ready;
    for (let i = 0; i < 6; i++) {
      await at(T0 + i * MIN, () => request(first.app).post('/api/workspaces').expect(201));
    }
    await first.store.flush();
    first.shutdown();

    await at(T0 + 10 * MIN, async () => {
      const second = makeApp({ databaseUrl: dbUrl, maxNewWorkspacesPerHour: 2 });
      await second.ready;
      expect(recentCreations(second.store)).toEqual([T0 + 4 * MIN, T0 + 5 * MIN]);
    });
  });
});
