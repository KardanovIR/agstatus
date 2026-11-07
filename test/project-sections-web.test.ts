import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadBoard, session, type Board } from './board-harness';

/*
 * The web board grouped by project (1.7.0, docs/design/project-sections.md):
 * cards that keep their place, project sections under sticky labels in the
 * shared order, and the needs-you bar. Driven through the real board script
 * against the real shell, as review-fixes.test.ts drives Focus.
 */

const MIN = 60_000;

/** The cards in the order the grid draws them. */
const ids = (b: Board) => (b.$$('.card') as HTMLElement[]).map((c) => c.dataset.id);
const card = (b: Board, id: string) => b.$(`.card[data-id="${id}"]`) as HTMLElement;

/** A session that last spoke `minutesAgo`, named for its id unless told otherwise. */
const at = (id: string, minutesAgo: number, over: Record<string, unknown> = {}) =>
  session({ id, name: id, host: null, updatedAt: Date.now() - minutesAgo * MIN, ...over });

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function boardOf(list: unknown[]) {
  vi.useFakeTimers();
  const b = await loadBoard();
  b.emit('snapshot', list);
  return b;
}

describe('cards keep their place', () => {
  it('draws the first frame newest first', async () => {
    const b = await boardOf([at('c', 5), at('a', 1), at('d', 9), at('b', 3)]);
    expect(ids(b)).toEqual(['a', 'b', 'c', 'd']);
  });

  // Until 1.7.0 the grid re-sorted by last update on every frame, so the
  // card that spoke jumped to the top and every card above it moved down.
  it('moves no card for a tool call, however recent', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5), at('d', 9)]);
    const bottom = card(b, 'd');
    b.emit('session', at('d', 0, { message: 'editing src/store.ts' }));
    b.emit('session', at('c', 0, { status: 'testing', message: 'npm test' }));
    expect(ids(b)).toEqual(['a', 'b', 'c', 'd']);
    // The same element, painted in place.
    expect(card(b, 'd')).toBe(bottom);
    expect(bottom.querySelector('.message')!.textContent).toBe('editing src/store.ts');
  });

  it('keeps a card that becomes blocked where it was', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    b.emit('session', at('c', 0, { status: 'blocked', message: 'May I push?' }));
    expect(ids(b)).toEqual(['a', 'b', 'c']);
    expect(card(b, 'c').dataset.status).toBe('blocked');
  });

  it('puts a session it has not seen on top, and moves nothing else', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    const els = ['a', 'b', 'c'].map((id) => card(b, id));
    // Older than every card on the board, and still on top: it is new here.
    b.emit('session', at('n', 60));
    expect(ids(b)).toEqual(['n', 'a', 'b', 'c']);
    expect(['a', 'b', 'c'].map((id) => card(b, id))).toEqual(els);
  });

  it('closes the gap a card leaves, and moves nothing else', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    b.emit('remove', { id: 'b' });
    expect(ids(b)).toEqual(['a', 'c']);
  });

  // A reconnect brings a whole snapshot: the cards still on the board keep
  // their order, the ones that left go, and any new to this page join at
  // the top, newest first among themselves.
  it('keeps its order through a reconnect, with new sessions on top, newest first', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    b.emit('session', at('c', 0, { message: 'spoke last' }));
    b.emit('snapshot', [at('x', 30), at('c', 0), at('a', 1), at('y', 20)]);
    expect(ids(b)).toEqual(['y', 'x', 'a', 'c']);
  });

  it('merges a fetch the same way, new sessions on top', async () => {
    const b = await boardOf([at('a', 1), at('b', 3)]);
    const list = [at('b', 0), at('a', 1), at('z', 40)];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return reply({}, 500);
      return url.endsWith('/api/sessions') ? reply(list) : reply({});
    });
    // A failed dismiss is what makes the board fetch the list.
    b.emit('session', at('c', 50));
    b.tap('c', 'dismiss');
    await b.settle();
    await b.settle();
    expect(ids(b)).toEqual(['z', 'a', 'b']);
  });

  // A failed dismiss puts the card back where it was, not on top as if it
  // were new: anchored to the card below it, as Android's dismiss is, so a
  // frame that arrives while the DELETE is out cannot shift it.
  it('puts a card back where it was when its dismiss fails', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5), at('d', 9)]);
    // The latest to speak, which a board sorted by recency would draw on top.
    b.emit('session', at('c', 0, { message: 'spoke last' }));
    let answer!: (r: unknown) => void;
    const list = () => [at('a', 1), at('b', 3), at('c', 0), at('d', 9), at('e', 0)];
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Promise((r) => { answer = r; });
      return Promise.resolve(url.endsWith('/api/sessions') ? reply(list()) : reply({}));
    });
    b.tap('c', 'dismiss');
    expect(ids(b)).toEqual(['a', 'b', 'd']);
    b.emit('session', at('e', 0));   // arrives while the DELETE is out
    expect(ids(b)).toEqual(['e', 'a', 'b', 'd']);
    answer(reply({ error: 'nope' }, 500));
    await b.settle();
    await b.settle();
    expect(ids(b)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('puts the bottom card back at the bottom when its dismiss fails', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    b.emit('session', at('c', 0, { message: 'spoke last' }));
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') throw new Error('offline');
      return url.endsWith('/api/sessions') ? reply([at('a', 1), at('b', 3), at('c', 0)]) : reply({});
    });
    b.tap('c', 'dismiss');
    await b.settle();
    await b.settle();
    expect(ids(b)).toEqual(['a', 'b', 'c']);
  });

  // Dismissed for good, a session that posts again is a new card.
  it('puts a dismissed session that comes back later on top', async () => {
    const b = await boardOf([at('a', 1), at('b', 3), at('c', 5)]);
    b.tap('b', 'dismiss');
    await b.settle();
    b.emit('remove', { id: 'b' });
    b.emit('session', at('b', 0));
    expect(ids(b)).toEqual(['b', 'a', 'c']);
  });
});
