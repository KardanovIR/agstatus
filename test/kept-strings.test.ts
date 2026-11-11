import { describe, it, expect } from 'vitest';
import v8 from 'v8';
import vm from 'vm';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp } from './helpers';
import { LEGACY_WS, normalizeHost, type Store } from '../src/store';
import { cleanLabel, safeClip } from '../src/subtasks';

/*
 * What the board keeps of a long post. Every posted string is cut to a
 * length limit, and V8 keeps a slice or a trim of a string as a view into the
 * whole: a 120-character cut of a 15,000-character project held all 15,000
 * for as long as the cut was kept, on a card, in a dropped card's home, in a
 * timeline or a project day. The store's sizes (MAX_DROPPED_HOMES_PER_WORKSPACE,
 * MAX_PROJECT_DAYS_PER_WORKSPACE, and the per-board allowance beside
 * WORKSPACE_CREATIONS_PER_HOUR) count the cut, which is what a copy of it holds.
 *
 * Measured as the V8 heap a structure frees: after the event loop has turned
 * a few times, each turn with a full GC, so what the last requests leave to be
 * collected late is gone first; then the structure is dropped and the heap
 * measured again. A view held whole posts, 10 to 15 KB apiece; a copy holds a
 * few hundred bytes, under 1 KB in every run. Each test allows 2 KB an item,
 * five times under the smallest view; a live card, which holds four cuts and
 * the card around them, 4 KB; a cleaner's result on its own, 512 B. Bytecode
 * flushing is off: with it, the many GCs here age out the bytecode of
 * functions the test stopped calling, and that freed heap would be counted
 * as the structure's. Something else is still freed late now and then, up to
 * 130 KB in one run of ten, so every measure spreads over hundreds of items.
 *
 * About 2 s a test here, posting over a thousand times through a real port
 * with a dozen full GCs a measure; each gets a minute, for CI's machines and
 * the files running beside it there.
 */

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');
const gc = vm.runInNewContext('gc') as () => void;
const heap = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

async function settle(): Promise<number> {
  for (let k = 0; k < 5; k += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    heap();
  }
  return heap();
}

/**
 * The heap `drop` frees. Nothing measured may be reachable from the caller's
 * locals, or dropping it frees nothing: `drop` has to be its only way there.
 */
async function freedBy(drop: () => void): Promise<number> {
  await settle();
  await settle();
  const before = await settle();
  drop();
  return before - (await settle());
}

/** Each test's allowance: a cut and what holds it, never the post it came from. */
const PER_ITEM = 2048;

type Json = Record<string, unknown>;
/** The store's maps, which nothing serves as such: wsId → key → value. */
type Held = Map<string, Map<string, unknown>>;
const held = (store: Store, name: 'sessions' | 'droppedHomes' | 'events' | 'projectDays'): Held =>
  (store as unknown as Record<string, Held>)[name];

/**
 * A board on a real port, posted to with fetch, as the hook posts: a
 * multi-tenant one, or a legacy one, which has no 50-card cap.
 */
async function board(legacy = false) {
  const t = makeApp({ multiTenant: !legacy });
  await t.ready;
  const srv: Server = await new Promise((resolve) => {
    const s = t.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const send = async (method: string, path: string, body?: Json): Promise<void> => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    // Under express.json's 16 KB, so every post lands.
    if (text !== undefined) expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: text });
    expect(res.status, `${method} ${path}`).toBe(200);
    await res.arrayBuffer();
  };
  let token = '';
  let wsId = LEGACY_WS;
  if (!legacy) {
    const created = await fetch(`${base}/api/workspaces`, { method: 'POST' });
    token = ((await created.json()) as { token: string }).token;
    wsId = t.store.resolveToken(token)!;
  }
  const close = async (): Promise<void> => {
    (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
    await t.shutdown();
  };
  /** The board's webhook path. */
  const webhook = legacy ? '/webhook' : `/w/${token}/webhook`;
  return { store: t.store, wsId, token, webhook, send, close };
}

/**
 * How many things a board's map holds for it, in a function of its own: a
 * local of the test's would keep what it reached alive through the measure.
 */
function count(store: Store, name: 'sessions' | 'droppedHomes' | 'events' | 'projectDays', wsId: string): number {
  const map = held(store, name).get(wsId)!;
  return name === 'events' ? [...map.values()].reduce((n, list) => n + (list as unknown[]).length, 0) : map.size;
}

/** A 128-character session id, SESSION_ID_RE's longest, unique to i. */
const longId = (i: number): string => `${'s'.repeat(120)}${String(i).padStart(8, '0')}`;
/** A string of n units unique to i, filled with `fill`. */
const long = (i: number, n: number, fill = 'x'): string => `${i}-`.padEnd(n, fill);

describe('a long post keeps only the copy of its cut', () => {
  it("in a dropped card's home: 15,000 ASCII characters or 5,000 three-byte ones, dismissed or evicted", async () => {
    const cases: Array<{ label: string; project: (i: number) => string; evict: boolean }> = [
      { label: '15,000 ASCII, dismissed', project: (i) => long(i, 15_000), evict: false },
      { label: '5,000 x 项, dismissed', project: (i) => long(i, 5_000, '项'), evict: false },
      { label: '15,000 ASCII, evicted', project: (i) => long(i, 15_000), evict: true },
    ];
    const n = 500;
    for (const c of cases) {
      const b = await board();
      try {
        if (c.evict) {
          // The 50-card cap drops the oldest card for each new one.
          for (let i = 0; i < n + 50; i += 1) {
            await b.send('POST', b.webhook, { session_id: longId(i), status: 'coding', project: c.project(i) });
          }
        } else {
          for (let i = 0; i < n; i += 1) {
            await b.send('POST', b.webhook, { session_id: longId(i), status: 'coding', project: c.project(i) });
            await b.send('DELETE', `/w/${b.token}/sessions/${longId(i)}`);
          }
        }
        expect(count(b.store, 'droppedHomes', b.wsId), c.label).toBe(n);
        const freed = await freedBy(() => held(b.store, 'droppedHomes').delete(b.wsId));
        expect(freed / n, c.label).toBeLessThan(PER_ITEM);
      } finally {
        await b.close();
      }
    }
  }, 60_000);

  it('on a live card: two folders, the home the first claimed, its name and its host\'s names', async () => {
    // 300 cards, more than a multi-tenant board's 50, so a legacy board.
    const b = await board(true);
    try {
      const cards = 300;
      for (let i = 0; i < cards; i += 1) {
        const post = (extra: Json) =>
          b.send('POST', b.webhook, { session_id: longId(i), status: 'coding', ...extra });
        // The first folder becomes the home and stays; the second is `project`.
        await post({ project: long(i, 15_000) });
        await post({ project: long(i + 1000, 15_000) });
        await post({ name: long(i + 2000, 15_000) });
        // A host name is trimmed before it is cut: 20 characters kept of 7,000.
        await post({
          host: {
            machine: { id: 'ab'.repeat(16), name: `machine-${i}`.padEnd(20, 'x').padEnd(7_000, ' ') },
            app: { slug: 'iterm2', name: `app-${i}`.padEnd(20, 'x').padEnd(7_000, ' '), kind: 'terminal' },
          },
        });
      }
      expect(count(b.store, 'sessions', b.wsId)).toBe(cards);
      expect(b.store.getSession(b.wsId, longId(0))).toMatchObject({
        project: long(1000, 120),
        homeProject: long(0, 120),
        name: long(2000, 120),
        host: { machine: { name: 'machine-0'.padEnd(20, 'x') }, app: { name: 'app-0'.padEnd(20, 'x') } },
      });
      const freed = await freedBy(() => held(b.store, 'sessions').delete(b.wsId));
      expect(freed / cards).toBeLessThan(2 * PER_ITEM);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("in a card's timeline and in a project day", async () => {
    const b = await board();
    try {
      // 10 cards of 100 events, each a 15,000-character message cut to 300.
      for (let i = 0; i < 10; i += 1) {
        for (let k = 0; k < 100; k += 1) {
          await b.send('POST', b.webhook, { session_id: longId(i), status: 'coding', message: long(i * 1000 + k, 15_000) });
        }
      }
      expect(count(b.store, 'events', b.wsId)).toBe(1000);
      const freedEvents = await freedBy(() => held(b.store, 'events').delete(b.wsId));
      expect(freedEvents / 1000).toBeLessThan(PER_ITEM);

      const day = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 500; i += 1) {
        await b.send('POST', `/w/${b.token}/usage/projects`, { source: 'claude', days: [{ project: long(i, 15_000), day, tokens: 1 }] });
      }
      expect(count(b.store, 'projectDays', b.wsId)).toBe(500);
      const freedDays = await freedBy(() => held(b.store, 'projectDays').delete(b.wsId));
      expect(freedDays / 500).toBeLessThan(PER_ITEM);
    } finally {
      await b.close();
    }
  }, 60_000);

  it('from each cleaning step: a cut, a trimmed label and a trimmed host name', async () => {
    const n = 1000;
    // Each input is built fresh, as a parsed post is, and only the result is kept.
    const steps: Array<{ label: string; keep: (i: number) => string }> = [
      { label: 'safeClip', keep: (i) => safeClip(long(i, 15_000), 120) },
      // White space collapses before the control characters go, so the spaces
      // left between them survive to the end, where the trim takes them off.
      { label: 'cleanLabel', keep: (i) => cleanLabel(`${long(i, 16)}${' \u0001'.repeat(7_000)}`, 64)! },
      { label: 'host name', keep: (i) => normalizeHost({ machine: { id: 'ab'.repeat(16), name: long(i, 20).padEnd(15_000, ' ') } })!.machine.name },
    ];
    for (const step of steps) {
      const kept: string[][] = [Array.from({ length: n }, (_, i) => step.keep(i))];
      expect(kept[0][7].length, step.label).toBeLessThanOrEqual(120);
      const freed = await freedBy(() => kept.pop());
      expect(freed / n, step.label).toBeLessThan(PER_ITEM / 4);
    }
  }, 60_000);
});
