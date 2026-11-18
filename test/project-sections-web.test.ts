import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadBoard, session, type Board } from './board-harness';

/*
 * The web board grouped by project (1.7.0, docs/design/project-sections.md):
 * cards that keep their place, project sections under sticky labels in the
 * shared order, and the needs-you bar. Driven through the real board script
 * against the real shell, as review-fixes.test.ts drives Focus.
 */

// A browser's FontFaceSet, which jsdom lacks: the board fits its labels and
// its bar again when the webfonts arrive ('loadingdone'). Every board in this
// file gets one, already loaded; only the font tests fire it.
vi.mock('jsdom', async (importOriginal) => {
  const real = await importOriginal<typeof import('jsdom')>();
  class JSDOM extends real.JSDOM {
    constructor(...args: ConstructorParameters<typeof real.JSDOM>) {
      super(...args);
      const fonts = Object.assign(new this.window.EventTarget(), { status: 'loaded', ready: Promise.resolve() });
      Object.defineProperty(this.window.document, 'fonts', { configurable: true, value: fonts });
    }
  }
  return { ...real, JSDOM };
});
/** The webfonts arriving, as a browser reports it. */
const fontsArrive = (b: Board) => (document as unknown as { fonts: EventTarget }).fonts
  .dispatchEvent(new b.win.Event('loadingdone'));

/**
 * A ResizeObserver a test can fire, as a browser does once layout has
 * changed an observed box: for every element it observes. The board makes
 * its observers as it loads, so this goes in before loadBoard.
 */
class FakeResizeObserver {
  static made: FakeResizeObserver[] = [];
  readonly seen = new Set<Element>();
  constructor(private readonly cb: (entries: Array<{ target: Element }>) => void) { FakeResizeObserver.made.push(this); }
  observe(el: Element) { this.seen.add(el); }
  unobserve(el: Element) { this.seen.delete(el); }
  disconnect() { this.seen.clear(); }
  static fire() {
    for (const ro of FakeResizeObserver.made) if (ro.seen.size) ro.cb([...ro.seen].map((target) => ({ target })));
  }
}
const observeSizes = () => {
  FakeResizeObserver.made = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
};

const MIN = 60_000;

/** The cards in the order the grid draws them. */
const ids = (b: Board) => (b.$$('.card') as HTMLElement[]).map((c) => c.dataset.id);
const card = (b: Board, id: string) => b.$(`.card[data-id="${id}"]`) as HTMLElement;

/** A session that last spoke `minutesAgo`, named for its id unless told otherwise. */
const at = (id: string, minutesAgo: number, over: Record<string, unknown> = {}) =>
  session({ id, name: id, host: null, updatedAt: Date.now() - minutesAgo * MIN, ...over });

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

/**
 * jsdom lays nothing out, so this stands in for a browser's widths: what an
 * element's contents are drawn as (`drawn`, which a Range over them reads)
 * and the box they have (`box`, which getBoundingClientRect reads), both in
 * fractions of a pixel, and the whole-pixel readings a browser rounds them
 * to, scrollWidth, clientWidth and offsetWidth. Where a test needs to say
 * which line a box is on, `rows` gives its top and bottom; otherwise every
 * box is at the top, and nothing high.
 */
function standIn(b: Board, drawn: (el: Element) => number, box: (el: Element) => number,
  rows: (el: Element) => [top: number, bottom: number] = () => [0, 0]) {
  const rect = (width: number, [top, bottom]: [number, number] = [0, 0]) =>
    ({ x: 0, y: top, top, left: 0, right: width, bottom, width, height: bottom - top });
  const define = (proto: object, prop: string, get: (el: Element) => number) =>
    Object.defineProperty(proto, prop, { configurable: true, get() { return get(this as Element); } });
  define(b.win.Element.prototype, 'clientWidth', (el) => Math.round(box(el)));
  define(b.win.Element.prototype, 'scrollWidth', (el) => Math.round(Math.max(drawn(el), box(el))));
  define(b.win.HTMLElement.prototype, 'offsetWidth', (el) => Math.round(box(el)));
  b.win.Element.prototype.getBoundingClientRect = function (this: Element) { return rect(box(this), rows(this)); } as never;
  // A Range over an element's contents (selectNodeContents) starts in it.
  (b.win.Range.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect =
    function (this: Range) { return rect(drawn(this.startContainer as Element)); };
  // A browser global the harness's window stub does not carry. No sheet is
  // loaded, so a gap between two pieces reads as none.
  vi.stubGlobal('getComputedStyle', b.win.getComputedStyle.bind(b.win));
}

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

// ---- Project sections -------------------------------------------------------

const UUID = '0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b';

/** The labels in the order drawn, by the name each one shows. */
const sections = (b: Board) => (b.$$('h2.section-label') as HTMLElement[])
  .map((h) => h.querySelector('.section-name')!.textContent);
/** What a screen reader hears for each label. */
const headings = (b: Board) => (b.$$('h2.section-label') as HTMLElement[])
  .map((h) => [...h.childNodes].filter((n) => !(n as HTMLElement).hasAttribute?.('aria-hidden'))
    .map((n) => n.textContent).join(''));
/** The grid as read top to bottom: '# name' for a label, the id for a card. */
const layout = (b: Board) => [...b.grid().children].map((el) => (el.matches('h2.section-label')
  ? `# ${el.querySelector('.section-name')!.textContent}`
  : (el as HTMLElement).dataset.id));
const meta = (b: Board, id: string) => card(b, id).querySelector('.meta') as HTMLElement;
const place = (b: Board, id: string) => meta(b, id).querySelector('.proj')?.textContent ?? null;

describe('project sections', () => {
  // The shared vector: every client's tests assert this exact order. These
  // are live folders on a server too old to send homeProject; the empty
  // name and the UUID both fall into No project, which is always last.
  it('orders sections as every client does: by name, case breaking ties, No project last', async () => {
    const names = ['zeta', '', 'Alpha', 'alpha', 'beta', 'AgStatus', 'agstatus', UUID];
    const b = await boardOf(names.map((project, i) => at(`s${i}`, i, { project })));
    expect(sections(b)).toEqual(['AgStatus', 'agstatus', 'Alpha', 'alpha', 'beta', 'zeta', 'No project']);
  });

  it('orders the same names the same way when the server pins them as homeProject', async () => {
    const names = ['zeta', 'Alpha', 'alpha', 'beta', 'AgStatus', 'agstatus'];
    const b = await boardOf(names.map((homeProject, i) => at(`s${i}`, i, { homeProject, project: 'elsewhere' })));
    expect(sections(b)).toEqual(['AgStatus', 'agstatus', 'Alpha', 'alpha', 'beta', 'zeta']);
  });

  // U3's two pairs, which every client's order tests also assert. Lowercasing
  // applies Unicode's final sigma, so ΝΟΜΟΣ lowercases to νομος and comes
  // before νομος-api. A folder an old server sends both composed and
  // decomposed stays two sections, by code unit, the decomposed one first:
  // e (U+0065) sorts before é (U+00E9).
  it.each([
    ['ΝΟΜΟΣ', ['ΝΟΜΟΣ', 'νομος-api']],
    ['νομος-api', ['νομος-api', 'ΝΟΜΟΣ']],
  ])('orders the final-sigma pair [ΝΟΜΟΣ, νομος-api] whichever comes first (%s)', async (_first, given) => {
    const b = await boardOf(given.map((project, i) => at(`s${i}`, i, { project })));
    expect(sections(b)).toEqual(['ΝΟΜΟΣ', 'νομος-api']);
  });

  it.each([
    ['composed', ['caf\u00e9', 'cafe\u0301']],
    ['decomposed', ['cafe\u0301', 'caf\u00e9']],
  ])('keeps café composed and decomposed as two sections, the decomposed one first (%s first)', async (_first, given) => {
    const b = await boardOf(given.map((project, i) => at(`s${i}`, i, { project })));
    expect(sections(b)).toEqual(['cafe\u0301', 'caf\u00e9']);
  });

  // The rule the server and every client hold a folder name to: trimmed, it
  // is not empty, not '/' or '.', and not shaped like a UUID. Anything else
  // names no section, pinned or live, and no place.
  it.each([
    ['empty', ''], ['blank', '   '], ['the root', '/'], ['the root, padded', ' / '], ['here', '.'],
    ['here, padded', '  . '], ['a UUID', UUID], ['a UUID in capitals', UUID.toUpperCase()],
    ['a UUID, padded', `  ${UUID} `],
  ])('puts a session whose folder is %s in No project, pinned or live', async (_what, name) => {
    const b = await boardOf([
      at('h', 1, { homeProject: name, project: name }), at('l', 2, { project: name }),
      at('a', 3, { homeProject: 'acme-api', project: name }),
    ]);
    expect(layout(b)).toEqual(['# acme-api', 'a', '# No project', 'h', 'l']);
    for (const id of ['h', 'l', 'a']) expect(place(b, id), id).toBe(null);
  });

  // A pinned folder the rule turns down is no pin: the live folder stands in,
  // as it does on a server too old to pin one.
  it('holds a pinned folder to the same rule, and falls back to the live one', async () => {
    const b = await boardOf([
      at('u', 1, { homeProject: UUID, project: 'web' }), at('r', 2, { homeProject: '/', project: 'web' }),
      at('d', 3, { homeProject: ' . ', project: 'acme-api' }), at('n', 4, { homeProject: '  ', project: '.' }),
    ]);
    expect(layout(b)).toEqual(['# acme-api', 'd', '# web', 'u', 'r', '# No project', 'n']);
  });

  // Only the test trims: a name that passes is the folder's own, spaces and all.
  it('uses a usable name exactly as it was sent', async () => {
    const b = await boardOf([at('p', 1, { homeProject: ' api ' }), at('q', 2, { homeProject: 'api' })]);
    expect((b.$$('h2.section-label') as HTMLElement[]).map((h) => h.dataset.section)).toEqual([' api ', 'api']);
    expect(headings(b)).toEqual([' api , 1 session', 'api, 1 session']);
  });

  it('draws each section as its label and then its cards, in the board\'s own order', async () => {
    const b = await boardOf([
      at('a1', 1, { homeProject: 'acme-api' }), at('c1', 2, { homeProject: 'claude-status' }),
      at('a2', 3, { homeProject: 'acme-api' }), at('n1', 4, { homeProject: '', project: '' }),
      at('c2', 5, { homeProject: 'claude-status' }),
    ]);
    expect(layout(b)).toEqual(['# acme-api', 'a1', 'a2', '# claude-status', 'c1', 'c2', '# No project', 'n1']);
  });

  // homeProject is the folder a session started in, pinned by the server.
  it('groups by homeProject, so a cd never moves a card, and says where it went', async () => {
    const b = await boardOf([at('a1', 1, { homeProject: 'acme-api', project: 'acme-api' }), at('b1', 2, { homeProject: 'billing' })]);
    const el = card(b, 'a1');
    b.emit('session', at('a1', 0, { homeProject: 'acme-api', project: 'web', message: 'cd web' }));
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# billing', 'b1']);
    expect(card(b, 'a1')).toBe(el);
    expect(place(b, 'a1')).toBe('in web');
  });

  // A server too old to send it leaves the live folder, where a cd moves the card.
  it('falls back to the live folder on a server that sends no homeProject', async () => {
    const b = await boardOf([at('x1', 1, { project: 'api' }), at('y1', 2, { project: 'docs' })]);
    expect(layout(b)).toEqual(['# api', 'x1', '# docs', 'y1']);
    const el = card(b, 'x1');
    b.emit('session', at('x1', 0, { project: 'docs' }));
    expect(layout(b)).toEqual(['# docs', 'x1', 'y1']);
    expect(card(b, 'x1')).toBe(el);   // moved, not rebuilt
    expect(place(b, 'x1')).toBe(null);
  });

  // Moving a node takes focus out of the document with it, and a reader on
  // that card would be dropped back to the top of the page.
  it('keeps focus on a card that changes section, and on one moved past', async () => {
    // Every frame at one instant, so the cards are moved and not repainted:
    // a repaint hands focus on by itself (paint), a move does not.
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [at('x1', 1, { project: 'api' }), at('y1', 2, { project: 'docs' })]);
    const title = card(b, 'x1').querySelector('[data-open]') as HTMLElement;
    title.focus();
    b.emit('session', at('x1', 1, { project: 'docs' }));
    expect(layout(b)).toEqual(['# docs', 'x1', 'y1']);
    expect(document.activeElement).toBe(title);
    const other = card(b, 'y1').querySelector('[data-open]') as HTMLElement;
    other.focus();
    b.emit('session', at('x1', 1, { project: 'zoo' }));
    expect(layout(b)).toEqual(['# docs', 'y1', '# zoo', 'x1']);
    expect(document.activeElement).toBe(other);
  });

  // A card or a label leaving takes itself out of the grid and nothing
  // else. The ordering pass used to meet them still in place, before every
  // node that stays below them, and put each of those back after them:
  // the top card of eight leaving took the other seven and three labels
  // out and back, which cleared a reader's text selection in them,
  // restarted an animation in flight and rebuilt each one for a screen
  // reader. Every frame at one instant, so cards are moved, not repainted.
  it('takes only what leaves out of the grid, and moves nothing that stays', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(`c${i}`, 1, { homeProject: `proj-${Math.floor(i / 2)}` })));
    const before = layout(b);
    expect(before).toEqual(['# proj-0', 'c0', 'c1', '# proj-1', 'c2', 'c3', '# proj-2', 'c4', 'c5', '# proj-3', 'c6', 'c7']);
    const name = (n: Node) => {
      const el = n as HTMLElement;
      return el.matches('h2.section-label') ? `# ${el.querySelector('.section-name')!.textContent}` : el.dataset.id;
    };
    const watch = () => {
      const seen = new b.win.MutationObserver(() => {});
      seen.observe(b.grid(), { childList: true });
      return () => {
        const records = seen.takeRecords();
        seen.disconnect();
        return {
          removed: records.flatMap((r) => [...r.removedNodes].map(name)),
          added: records.flatMap((r) => [...r.addedNodes].map(name)),
        };
      };
    };
    const title = card(b, 'c6').querySelector('[data-open]') as HTMLElement;
    title.focus();
    // The top card's session ends.
    let moves = watch();
    b.emit('remove', { id: 'c0' });
    expect(moves()).toEqual({ removed: ['c0'], added: [] });
    expect(layout(b)).toEqual(before.filter((x) => x !== 'c0'));
    // Its section's last card goes, and the label with it.
    moves = watch();
    b.emit('remove', { id: 'c1' });
    expect(moves()).toEqual({ removed: ['# proj-0', 'c1'], added: [] });
    // A snapshot that drops a card from the middle of each of two sections.
    moves = watch();
    b.emit('snapshot', ['c2', 'c4', 'c5', 'c6', 'c7'].map((id) => at(id, 1, { homeProject: `proj-${Math.floor(Number(id[1]) / 2)}` })));
    expect(moves()).toEqual({ removed: ['c3'], added: [] });
    expect(layout(b)).toEqual(['# proj-1', 'c2', '# proj-2', 'c4', 'c5', '# proj-3', 'c6', 'c7']);
    // Focus below them was never disturbed.
    expect(document.activeElement).toBe(title);
  });

  it('moves a card out of No project once, when its first real folder arrives', async () => {
    const b = await boardOf([at('n1', 1, { homeProject: '', project: '' }), at('a1', 2, { homeProject: 'acme-api' })]);
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# No project', 'n1']);
    b.emit('session', at('n1', 0, { homeProject: 'acme-api', project: 'acme-api' }));
    // It keeps its place in the board's order: above a1, which it was above.
    expect(layout(b)).toEqual(['# acme-api', 'n1', 'a1']);
  });

  // The one move between sections, out of No project, is drawn, not
  // animated: the card moves as it stands, and so does the label it opens
  // its new section with. A label rises in only beside a card that is new.
  it('draws a label in place when a card that moved opens its section', async () => {
    const b = await boardOf([at('n1', 1, { homeProject: '', project: '' }), at('a1', 2, { homeProject: 'acme-api' })]);
    for (const label of b.$$('h2.section-label')) expect(label.classList.contains('entering')).toBe(true);
    b.emit('session', at('n1', 0, { homeProject: 'web', project: 'web' }));
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# web', 'n1']);
    expect(b.$('h2[data-section="web"]')!.classList.contains('entering')).toBe(false);
    // On a server too old to pin a folder a cd moves a card, and the same holds.
    b.emit('session', at('o1', 0, { project: 'api' }));
    expect(b.$('h2[data-section="api"]')!.classList.contains('entering')).toBe(true);
    b.emit('session', at('o1', 0, { project: 'zoo' }));
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# web', 'n1', '# zoo', 'o1']);
    expect(b.$('h2[data-section="zoo"]')!.classList.contains('entering')).toBe(false);
  });

  it('puts a new session on top of its own section, and moves no other card', async () => {
    const b = await boardOf([
      at('a1', 1, { homeProject: 'acme-api' }), at('a2', 2, { homeProject: 'acme-api' }),
      at('b1', 3, { homeProject: 'billing' }), at('b2', 4, { homeProject: 'billing' }),
    ]);
    b.emit('session', at('b0', 30, { homeProject: 'billing' }));
    b.emit('session', at('a3', 1, { homeProject: 'acme-api', message: 'a tool call' }));
    b.emit('session', at('b2', 0, { homeProject: 'billing', status: 'blocked' }));
    expect(layout(b)).toEqual(['# acme-api', 'a3', 'a1', 'a2', '# billing', 'b0', 'b1', 'b2']);
  });

  it('adds a label with its section\'s first card, in its place, and takes it away with the last', async () => {
    const b = await boardOf([at('a1', 1, { homeProject: 'acme-api' }), at('z1', 2, { homeProject: 'zeta' })]);
    b.emit('session', at('m1', 0, { homeProject: 'Middle' }));
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# Middle', 'm1', '# zeta', 'z1']);
    const label = b.$('h2[data-section="Middle"]');
    expect(label!.classList.contains('entering')).toBe(true);   // arrives as its card does
    b.emit('session', at('m2', 0, { homeProject: 'Middle' }));
    expect(b.$('h2[data-section="Middle"]')).toBe(label);         // the same heading, counted again
    expect(headings(b)[1]).toBe('Middle, 2 sessions');
    b.emit('remove', { id: 'm1' });
    expect(headings(b)[1]).toBe('Middle, 1 session');
    b.emit('remove', { id: 'm2' });
    expect(layout(b)).toEqual(['# acme-api', 'a1', '# zeta', 'z1']);
    expect(label!.isConnected).toBe(false);
  });

  it('gives every section a label, a lone project and a lone card included', async () => {
    const b = await boardOf([at('a1', 1, { homeProject: 'acme-api' })]);
    expect(layout(b)).toEqual(['# acme-api', 'a1']);
  });

  // One heading per project, so a screen reader's headings list walks them:
  // the name and the count, one line, and nothing else.
  it('makes each label one heading, "acme-api, 3 sessions"', async () => {
    const b = await boardOf([
      at('a1', 1, { homeProject: 'acme-api' }), at('a2', 2, { homeProject: 'acme-api' }),
      at('a3', 3, { homeProject: 'acme-api' }), at('n1', 4, { project: UUID }),
    ]);
    expect(headings(b)).toEqual(['acme-api, 3 sessions', 'No project, 1 session']);
    const h = b.$('h2.section-label') as HTMLElement;
    expect(h.tagName).toBe('H2');
    // What is drawn for the eye is hidden from the ear, which hears the line
    // above: the name is drawn in two pieces, so it can be cut in the middle.
    expect(h.querySelector('.section-line')!.getAttribute('aria-hidden')).toBe('true');
    expect(h.querySelector('.section-line')!.contains(h.querySelector('.section-count'))).toBe(true);
    expect(h.querySelector('.section-count')!.textContent).toBe('3 sessions');
    // Not a control, and no mark: a label is a name and a count.
    expect(h.querySelector('button, a, svg, [tabindex]')).toBe(null);
    expect(b.$('h2.section-label.is-none')!.querySelector('.section-name')!.textContent).toBe('No project');
  });

  // Where room runs short the count goes first, then the name is cut in the
  // middle, keeping both ends. jsdom lays nothing out, so this stands in for
  // the browser: a character of the name is 10px, of the count 6px, and the
  // label's line is `room` px wide. A character is what a browser draws as
  // one: a grapheme, so an accent costs its letter nothing more and a family
  // emoji is one glyph.
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const drawnLength = (text: string) => [...segmenter.segment(text)].length;
  function layOut(b: Board, room: number, char = 10) {
    const drawn = (el: Element) => {
      if (el.classList.contains('section-name')) return drawnLength(el.textContent!) * char;
      if (el.classList.contains('section-count')) return (el as HTMLElement).hidden ? 0 : el.textContent!.length * 6;
      if (el.classList.contains('section-line')) return room;
      return 0;
    };
    // A name's box is never wider than its line; its text can be.
    standIn(b, drawn, (el) => (el.classList.contains('section-name') ? Math.min(drawn(el), room) : drawn(el)));
  }
  const shown = (b: Board, key: string) => {
    const h = b.$(`h2[data-section="${key}"]`)!;
    return [h.querySelector('.section-name')!.textContent, (h.querySelector('.section-count') as HTMLElement).hidden];
  };
  const LONG = 'agstatus-listener-windows-terminal-focus-and-presence';
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';   // seven code points, one glyph

  it.each([
    ['both, where both fit', 'acme-api', 200, ['acme-api', false]],
    ['the name alone, where only it fits', 'acme-api', 100, ['acme-api', true]],
    ['the name cut in the middle, where even it does not', LONG, 200, ['agstatus-l\u2026-presence', true]],
    ['whole characters, never half of one', '😀😀😀😀😀😀', 40, ['😀😀\u2026😀', true]],
    // macOS file names often spell 'é' as 'e' and a combining accent. A cut
    // by code point kept the 'e' and dropped its accent ("cafe…"), or began
    // the tail with the accent, which then sat on the ellipsis.
    ['an accent kept on its letter, ending the head', 'cafe\u0301-reservations-2026', 80, ['cafe\u0301\u2026026', true]],
    ['an accent kept on its letter, starting the tail', 'reservations-at-the-cafe\u0301-terrasse', 210,
      ['reservatio\u2026e\u0301-terrasse', true]],
    // A cut by code point drew two of the family's four people.
    ['a family emoji kept whole', `our-${FAMILY}-holiday-photos`, 120, [`our-${FAMILY}-\u2026hotos`, true]],
  ])('fits a label to its line: %s', async (_what, name, room, expected) => {
    vi.useFakeTimers();
    const b = await loadBoard();
    layOut(b, room as number);
    b.emit('snapshot', [at('a', 1, { homeProject: name }), at('b', 2, { homeProject: name }), at('c', 3, { homeProject: name })]);
    expect(shown(b, name as string)).toEqual(expected);
    // Heard whole, whatever is drawn.
    expect(headings(b)).toEqual([`${name}, 3 sessions`]);
    // The tooltip keeps the whole name too.
    expect(b.$('.section-name')!.getAttribute('title')).toBe(name);
  });

  // In fractions of a pixel, as a browser draws them. Whole pixels passed a
  // line 0.4px too narrow for a name and its count, and a cut 0.4px too
  // wide for its line, which CSS then cut at its end as well.
  it.each([
    ['the count goes from a line it overflows by 0.4px', 'acme-api', 140, 10.05, ['acme-api', true]],
    ['a cut 0.4px too wide is a character shorter', LONG, 200, 10.02, ['agstatus-\u2026-presence', true]],
  ])('fits a label in fractions of a pixel: %s', async (_what, name, room, char, expected) => {
    vi.useFakeTimers();
    const b = await loadBoard();
    layOut(b, room as number, char as number);
    b.emit('snapshot', [at('a', 1, { homeProject: name }), at('b', 2, { homeProject: name }), at('c', 3, { homeProject: name })]);
    expect(shown(b, name as string)).toEqual(expected);
    // Measured, so the cut is the script's alone, and CSS adds no ellipsis
    // of its own (board.css).
    expect(b.$(`h2[data-section="${name}"]`)!.classList.contains('fitted')).toBe(true);
  });

  // A label is one line as tall as its line height, which a reader can set
  // for themselves (WCAG 1.4.12: 1.5). What a stuck label takes at the top
  // is measured, as the bar's height is, and the root's scroll padding
  // reads it, so focus and the bar's jump land clear of a taller label.
  it('measures what a label takes at the top, for the scroll padding', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    let height = 34;
    b.win.Element.prototype.getBoundingClientRect = function (this: Element) {
      const h = this.matches('h2.section-label') ? height : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h };
    } as never;
    b.emit('snapshot', [at('a', 1, { homeProject: 'acme-api' }), at('b', 2, { homeProject: 'billing' })]);
    const labelH = () => document.documentElement.style.getPropertyValue('--label-h');
    FakeResizeObserver.fire();
    expect(labelH()).toBe('34px');
    height = 38.5;   // the reader's line height, 1.5
    FakeResizeObserver.fire();
    expect(labelH()).toBe('38.5px');
    // Not laid out, under a screen over the board: the last height stands.
    height = 0;
    FakeResizeObserver.fire();
    expect(labelH()).toBe('38.5px');
  });

  it('fits a label again when its count changes', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    layOut(b, 140);
    b.emit('snapshot', [at('a', 1, { homeProject: 'acme-api' })]);
    expect(shown(b, 'acme-api')).toEqual(['acme-api', false]);      // 80 + 54 = 134
    b.emit('session', at('b', 0, { homeProject: 'acme-api' }));
    expect(shown(b, 'acme-api')).toEqual(['acme-api', false]);      // 80 + 60 = 140
    for (const id of 'cdefghij') b.emit('session', at(id, 0, { homeProject: 'acme-api' }));
    expect(shown(b, 'acme-api')).toEqual(['acme-api', true]);       // "10 sessions": 80 + 66
  });

  // And when its room changes with nothing drawn again: the window's width
  // or the reader's text size (its ResizeObserver), or the webfonts
  // arriving, which a cold load draws without, in a wider face. Here the
  // label's line narrows under it each time.
  it('fits a label again when it changes size or the webfonts arrive', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    let room = 200;
    const drawn = (el: Element) => {
      if (el.classList.contains('section-name')) return drawnLength(el.textContent!) * 10;
      if (el.classList.contains('section-count')) return (el as HTMLElement).hidden ? 0 : el.textContent!.length * 6;
      if (el.classList.contains('section-line')) return room;
      return 0;
    };
    standIn(b, drawn, (el) => (el.classList.contains('section-name') ? Math.min(drawn(el), room) : drawn(el)));
    b.emit('snapshot', [at('a', 1, { homeProject: 'acme-api' }), at('b', 2, { homeProject: 'acme-api' })]);
    expect(shown(b, 'acme-api')).toEqual(['acme-api', false]);      // 80 + 60 in 200
    room = 100;                                                       // the window narrows
    FakeResizeObserver.fire();
    expect(shown(b, 'acme-api')).toEqual(['acme-api', true]);
    room = 200;                                                       // and widens
    FakeResizeObserver.fire();
    expect(shown(b, 'acme-api')).toEqual(['acme-api', false]);
    room = 60;                                                        // the fonts come in
    fontsArrive(b);
    expect(shown(b, 'acme-api')).toEqual(['acm…pi', true]);
    room = 200;
    fontsArrive(b);
    expect(shown(b, 'acme-api')).toEqual(['acme-api', false]);
  });

  // Where a browser cannot find graphemes the cut falls back to code points:
  // there an accent can part from its letter, and a surrogate pair still
  // cannot be halved.
  it('cuts by code point where the browser has no Intl.Segmenter', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }));
    const b = await loadBoard();
    layOut(b, 80);
    const names = ['cafe\u0301-reservations-2026', '😀😀😀😀😀😀😀😀😀😀'];
    b.emit('snapshot', names.map((homeProject, i) => at(`s${i}`, i, { homeProject })));
    expect(shown(b, names[0])).toEqual(['cafe\u2026026', true]);
    expect(shown(b, names[1])).toEqual(['😀😀😀😀\u2026😀😀😀', true]);
  });

  it('escapes a folder name, which comes from the machine', async () => {
    const b = await boardOf([at('x', 1, { homeProject: '<b>"a&b"</b>' })]);
    const h = b.$('h2.section-label') as HTMLElement;
    expect(h.querySelector('b')).toBe(null);
    expect(h.querySelector('.section-name')!.textContent).toBe('<b>"a&b"</b>');
    expect(h.dataset.section).toBe('<b>"a&b"</b>');
  });

  it('keeps a folder called like a session id apart from the card with that id', async () => {
    const b = await boardOf([at('s1', 1, { homeProject: 's1' }), at('s2', 2, { homeProject: 's1' })]);
    expect(layout(b)).toEqual(['# s1', 's1', 's2']);
    b.emit('remove', { id: 's1' });
    expect(layout(b)).toEqual(['# s1', 's2']);
  });

  it('clears its labels with its cards when the board empties, and starts again', async () => {
    const b = await boardOf([at('a1', 1, { homeProject: 'acme-api' })]);
    b.emit('snapshot', []);
    expect(b.$$('h2.section-label')).toHaveLength(0);
    expect(b.grid().textContent).toContain('No sessions yet');
    b.emit('session', at('a1', 0, { homeProject: 'acme-api' }));
    expect(layout(b)).toEqual(['# acme-api', 'a1']);
  });

  // 'in <folder>' only when the live folder is real and differs from both
  // the section and the name: when the session has moved.
  it.each([
    ['its own section', { homeProject: 'acme-api', project: 'acme-api', name: 'Fix it' }, null],
    ['a folder it moved to', { homeProject: 'acme-api', project: 'web', name: 'Fix it' }, 'in web'],
    ['a folder that is its name', { homeProject: 'acme-api', project: 'web', name: 'web' }, null],
    ['no folder', { homeProject: 'acme-api', project: '', name: 'Fix it' }, null],
    ['a UUID folder', { homeProject: 'acme-api', project: UUID, name: 'Fix it' }, null],
    ['the root', { homeProject: 'acme-api', project: '/', name: 'Fix it' }, null],
    ['a blank folder', { homeProject: 'acme-api', project: '  ', name: 'Fix it' }, null],
    ['a live folder that is its section (an old server)', { project: 'acme-api', name: 'Fix it' }, null],
    ['a worktree root before its section knows the repo', { homeProject: 'feature-x', project: 'my-repo', name: 'feature-x' }, 'in my-repo'],
  ])('shows the place for %s as %s', async (_what, over, expected) => {
    const b = await boardOf([at('s1', 1, over)]);
    expect(place(b, 's1')).toBe(expected);
  });

  // The bordered CLAUDE chip goes: each card's first fact is its agent's
  // mark, plain, the name in hidden text and a tooltip, and an agent that is
  // neither Claude nor Codex gets the diamond rather than Claude's asterisk,
  // and its own name with a capital, as every board names it.
  it('leads every meta line with its agent\'s mark, named for a screen reader and a pointer', async () => {
    const b = await boardOf([
      at('c', 1, { source: 'claude' }),
      at('x', 2, { source: 'codex', host: { machine: { id: 'm1', name: 'Studio' } }, tokens: 1200 }),
      at('g', 3, { source: 'gemini' }), at('o', 4, { source: undefined }),
    ]);
    // marks.js, as the board read it: it writes onto the harness's window.
    const marks = (window as unknown as { AGSTATUS_MARKS: { ICON: Record<string, string> } }).AGSTATUS_MARKS.ICON;
    const lead = (id: string) => meta(b, id).firstElementChild as HTMLElement;
    const path = (svg: string) => /<path d="([^"]+)"/.exec(svg)![1];
    expect(b.$$('.source')).toHaveLength(0);
    for (const [id, name, icon] of [['c', 'Claude', 'claude'], ['x', 'Codex', 'codex'], ['g', 'Gemini', 'agent'], ['o', 'Claude', 'claude']]) {
      expect(lead(id).className, id).toBe('meta-agent');
      expect(lead(id).title, id).toBe(name);
      expect(lead(id).querySelector('.sr-only')!.textContent, id).toBe(`${name},`);
      expect(lead(id).querySelector('svg path')!.getAttribute('d'), id).toBe(path(marks[icon]));
      expect(lead(id).querySelector('svg')!.getAttribute('aria-hidden'), id).toBe('true');
    }
    // Three different marks, the diamond its own.
    expect(new Set(['claude', 'codex', 'agent'].map((k) => path(marks[k]))).size).toBe(3);
    // No separator between the mark and the first fact; one between facts:
    // the machine, the time and the tokens.
    expect(lead('x').nextElementSibling!.className).toBe('host');
    expect(meta(b, 'x').querySelectorAll('.meta-sep')).toHaveLength(2);
    expect(lead('c').nextElementSibling!.className).toBe('ts');
  });

  it('gives each usage block\'s name its agent\'s mark, the legend for the cards', async () => {
    const b = await boardOf([at('c', 1, { source: 'claude' }), at('x', 2, { source: 'codex' })]);
    b.emit('usage', [
      { source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] },
      { source: 'codex', windows: [{ id: 'primary', label: '5-hour', usedPct: 20 }] },
    ]);
    const blocks = [...document.querySelectorAll('.usage-block')] as HTMLElement[];
    expect(blocks.map((el) => el.querySelector('.usage-name')!.textContent)).toEqual(['Claude', 'Codex']);
    const cardMark = (id: string) => meta(b, id).querySelector('svg path')!.getAttribute('d');
    expect(blocks[0].querySelector('.usage-name svg path')!.getAttribute('d')).toBe(cardMark('c'));
    expect(blocks[1].querySelector('.usage-name svg path')!.getAttribute('d')).toBe(cardMark('x'));
    expect(blocks[0].querySelector('.usage-name svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  // Each usage block's name carries how many sessions its agent has on the
  // board, every card of the agent's, done included, as each client's head
  // does: "7 sessions", in a label count's quiet ink, and in the button's
  // name, "Claude, 7 sessions", which holds every word the button shows.
  it('gives each usage block\'s name its agent\'s session count, done included', async () => {
    const b = await boardOf([
      at('c1', 1, { source: 'claude' }), at('c2', 2, { source: 'claude', status: 'done' }),
      at('c3', 3, { source: 'claude', status: 'blocked' }), at('x1', 4, { source: 'codex' }), at('o1', 5, { source: undefined }),
    ]);
    b.emit('usage', [
      { source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] },
      { source: 'codex', windows: [{ id: 'primary', label: '5-hour', usedPct: 20 }] },
    ]);
    const heads = [...document.querySelectorAll('.usage-open')] as HTMLElement[];
    expect(heads.map((h) => h.querySelector('.usage-count')!.textContent)).toEqual(['4 sessions', '1 session']);
    expect(heads.map((h) => h.getAttribute('aria-label'))).toEqual(['Claude, 4 sessions', 'Codex, 1 session']);
    // Beside the name, on its line: name, then count.
    expect([...heads[0].querySelector('.usage-line')!.children].map((el) => el.className)).toEqual(['usage-name', 'usage-count']);
    // The count follows the board: a card that leaves takes itself off it.
    b.emit('remove', { id: 'c2' });
    expect(document.querySelector('.usage-count')!.textContent).toBe('3 sessions');
    expect(document.querySelector('.usage-open')!.getAttribute('aria-label')).toBe('Claude, 3 sessions');
  });

  // An empty board shows every agent's limits, and no agent has a session
  // to count: the name alone, as before.
  it('counts nothing on a board with no sessions', async () => {
    const b = await boardOf([]);
    b.emit('usage', [{ source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] }]);
    const head = document.querySelector('.usage-open') as HTMLElement;
    expect(head.querySelector('.usage-count')).toBe(null);
    expect(head.hasAttribute('aria-label')).toBe(false);
    expect(head.querySelector('.usage-name')!.textContent).toBe('Claude');
  });

  // Where room runs short the count goes first, before any letter of the
  // name, and comes back where it fits again; it is heard either way. The
  // stand-in: a head's line is `room` px wide, the name draws `name` px and
  // the count 60, measured in fractions of a pixel.
  it.each([
    ['both, where both fit', 300, 70, false],
    ['the name alone, where both do not', 120, 70, true],
    ['the name alone, for a line 0.4px short', 137.6, 78, true],
    ['both, where they fit to the pixel', 138, 78, false],
  ])('fits a usage block\'s head: %s', async (_what, room, name, hidden) => {
    vi.useFakeTimers();
    const b = await loadBoard();
    const drawn = (el: Element) => (el.classList.contains('usage-name') ? (name as number)
      : el.classList.contains('usage-count') ? ((el as HTMLElement).hidden ? 0 : 60)
        : el.classList.contains('usage-line') ? (room as number) : 0);
    standIn(b, drawn, drawn);
    b.emit('snapshot', [at('c1', 1, { source: 'claude' })]);
    b.emit('usage', [{ source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] }]);
    const head = document.querySelector('.usage-open') as HTMLElement;
    expect((head.querySelector('.usage-count') as HTMLElement).hidden).toBe(hidden);
    expect(head.getAttribute('aria-label')).toBe('Claude, 1 session');
  });

  it('fits a usage block\'s head again when it changes size or the webfonts arrive', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    let room = 300;
    const drawn = (el: Element) => (el.classList.contains('usage-name') ? 70
      : el.classList.contains('usage-count') ? ((el as HTMLElement).hidden ? 0 : 60)
        : el.classList.contains('usage-line') ? room : 0);
    standIn(b, drawn, drawn);
    b.emit('snapshot', [at('c1', 1, { source: 'claude' })]);
    b.emit('usage', [{ source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] }]);
    const count = () => (document.querySelector('.usage-count') as HTMLElement).hidden;
    expect(count()).toBe(false);
    room = 120;                       // the window narrows
    FakeResizeObserver.fire();
    expect(count()).toBe(true);
    room = 300;                       // and widens
    FakeResizeObserver.fire();
    expect(count()).toBe(false);
    room = 120;                       // the same width, with Barlow in
    fontsArrive(b);
    expect(count()).toBe(true);
  });

  // The usage area is painted again whenever a head's count changes, as a
  // session arrives or leaves, and whenever a "resets in" countdown moves,
  // which the board checks every 15 s. Focus on a head comes back to it.
  // The block around the head carries the same source, came first in the
  // search for it, and takes no focus, so focus fell to <body> and the
  // next Tab started again from the top of the page.
  const usageHead = () => document.querySelector('.usage-open') as HTMLButtonElement;
  const usageReset = () => document.querySelector('.usage-reset')!.textContent;
  it.each([
    ['a session arrives', async (b: Board) => b.emit('session', at('c3', 0, { source: 'claude' })), 'Claude, 3 sessions'],
    ['a session leaves', async (b: Board) => b.emit('remove', { id: 'c2' }), 'Claude, 1 session'],
    ['the countdown moves on', async () => {
      const shown = usageReset();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(usageReset()).not.toBe(shown);
    }, 'Claude, 2 sessions'],
  ])('keeps a usage head focused while the usage area is painted again: %s', async (_what, change, named) => {
    const b = await boardOf([at('c1', 1, { source: 'claude' }), at('c2', 2, { source: 'claude' })]);
    b.emit('usage', [{ source: 'claude', windows: [
      { id: 'five_hour', label: 'Current session', usedPct: 10, resetsAt: Date.now() + 2 * 3_600_000 },
    ] }]);
    usageHead().focus();
    const was = usageHead();
    await change(b);
    expect(usageHead()).not.toBe(was);   // the head really was painted again
    expect(usageHead().getAttribute('aria-label')).toBe(named);
    expect(document.activeElement).toBe(usageHead());
  });

  // H2: every agent with sessions has a block, whether or not it reports
  // plan limits, as iOS gives each a head. An agent run on an API key, with
  // AGSTATUS_USAGE=off, from the shell hook or any source such as gemini
  // reports none, and had no block: its cards' mark had no legend and its
  // session count showed nowhere. Such a block is its mark, its name and
  // its count like any other, and in place of meters iOS's words.
  describe('a usage block for every agent with sessions', () => {
    /** Each usage block as drawn: its name, count and button name, and what stands under its head. */
    const usageBlocks = () => ([...document.querySelectorAll('.usage-block')] as HTMLElement[]).map((el) => ({
      name: el.querySelector('.usage-name')!.textContent,
      count: el.querySelector('.usage-count')?.textContent ?? null,
      label: el.querySelector('.usage-open')!.getAttribute('aria-label'),
      meters: el.querySelectorAll('.meter').length,
      none: el.querySelector('.usage-none')?.textContent ?? null,
    }));
    const head = (source: string) => document.querySelector(`.usage-block[data-source="${source}"] .usage-open`) as HTMLButtonElement;
    const usageShown = () => !document.getElementById('usage')!.hidden;
    const NONE = 'No plan limits reported';

    // board.mjs's sessions and then edge.mjs's, with each one's agent, folder
    // and state: Claude 9, Codex 5, Gemini 2 and Claude-work 1.
    const EDGE_BOARD: Array<[id: string, source: string, project: string, status: string]> = [
      ['s-acme-done', 'claude', 'acme-api', 'done'], ['s-zeta', 'claude', 'zeta', 'coding'],
      ['s-alpha-cap', 'claude', 'Alpha', 'idle'], ['s-space', 'claude', '   ', 'idle'],
      ['s-uuid', 'codex', UUID, 'coding'], ['s-agstatus-low', 'codex', 'agstatus', 'coding'],
      ['s-moved', 'claude', 'web', 'coding'], ['s-root-shell', 'codex', '/', 'blocked'],
      ['s-beta', 'claude', 'beta', 'blocked'], ['s-alpha-low', 'codex', 'alpha', 'blocked'],
      ['s-agstatus-cap', 'claude', 'AgStatus', 'blocked'],
      ['s-cafe-nfc', 'claude', 'café', 'coding'], ['s-cafe-nfd', 'codex', 'café', 'idle'],
      ['usage', 'claude', 'zeta', 'idle'], ['s-gemini', 'gemini', 'beta', 'coding'],
      ['s-claude-work', 'claude-work', '/', 'idle'], ['s-gemini-root', 'gemini', '/', 'blocked'],
    ];
    const edgeBoard = () => EDGE_BOARD.map(([id, source, project, status], i) =>
      at(id, EDGE_BOARD.length - i, { source, project, status, homeProject: id === 's-moved' ? 'acme-api' : undefined }));
    // The limits board.mjs posts for Claude and Codex, as the hooks post them.
    const limits = () => [
      { source: 'claude', windows: [
        { id: 'five_hour', label: 'Current session', usedPct: 42, resetsAt: Date.now() + 3 * 3_600_000 },
        { id: 'seven_day', label: 'Current week (all models)', usedPct: 18, resetsAt: Date.now() + 4 * 86_400_000 },
      ] },
      { source: 'codex', windows: [
        { id: 'five_hour', label: '5-hour', usedPct: 7, resetsAt: Date.now() + 2 * 3_600_000 },
        { id: 'weekly', label: 'Weekly', usedPct: 40, resetsAt: Date.now() + 6 * 86_400_000 },
      ] },
    ];

    it('gives edge.mjs\'s board, with limits for Claude and Codex only, a block for each of its four agents', async () => {
      const b = await boardOf(edgeBoard());
      b.emit('usage', limits());
      expect(usageShown()).toBe(true);
      // In iOS's order of heads, by key: claude, claude-work, codex, gemini.
      expect(usageBlocks()).toEqual([
        { name: 'Claude', count: '9 sessions', label: 'Claude, 9 sessions', meters: 2, none: null },
        { name: 'Claude-work', count: '1 session', label: 'Claude-work, 1 session', meters: 0, none: NONE },
        { name: 'Codex', count: '5 sessions', label: 'Codex, 5 sessions', meters: 2, none: null },
        { name: 'Gemini', count: '2 sessions', label: 'Gemini, 2 sessions', meters: 0, none: NONE },
      ]);
      // The legend for every mark on the cards: Claude-work's asterisk and
      // Gemini's diamond, drawn as each of its cards draws it.
      const mark = (el: Element | null) => el!.querySelector('svg path')!.getAttribute('d');
      expect(mark(head('claude-work'))).toBe(mark(meta(b, 's-claude-work')));
      expect(mark(head('gemini'))).toBe(mark(meta(b, 's-gemini')));
      expect(mark(head('gemini'))).not.toBe(mark(head('claude')));
      // The same button as any block's, and the line under it is content.
      const gemini = head('gemini');
      expect(gemini.tagName).toBe('BUTTON');
      expect(gemini.closest('h2')).not.toBe(null);
      expect(gemini.contains(document.querySelector('.usage-block[data-source="gemini"] .usage-none'))).toBe(false);
    });

    it('gives one block per agent with sessions to a board that reports no limits at all', async () => {
      const b = await boardOf([
        at('c1', 1, { source: 'claude' }), at('g1', 2, { source: 'gemini' }), at('c2', 3, { source: 'claude', status: 'done' }),
      ]);
      const expected = [
        { name: 'Claude', count: '2 sessions', label: 'Claude, 2 sessions', meters: 0, none: NONE },
        { name: 'Gemini', count: '1 session', label: 'Gemini, 1 session', meters: 0, none: NONE },
      ];
      expect(usageShown()).toBe(true);
      expect(usageBlocks()).toEqual(expected);
      // A report with no windows is no report, as on iOS, and limits for an
      // agent with no sessions on the board still draw nothing.
      b.emit('usage', [{ source: 'claude', windows: [] }, { source: 'codex', windows: [{ id: 'weekly', label: 'Weekly', usedPct: 40 }] }]);
      expect(usageBlocks()).toEqual(expected);
      // Limits that arrive take the place of the words.
      b.emit('usage', [{ source: 'gemini', windows: [{ id: 'daily', label: 'Daily', usedPct: 12 }] }]);
      expect(usageBlocks()[1]).toEqual({ name: 'Gemini', count: '1 session', label: 'Gemini, 1 session', meters: 1, none: null });
    });

    // On a board with no sessions nothing changes: every agent that reports
    // limits, by its name alone, and nothing for one that reports none.
    it('leaves the idle board as it was', async () => {
      const b = await boardOf([]);
      expect(usageShown()).toBe(false);
      b.emit('usage', [
        { source: 'claude', windows: [{ id: 'five_hour', label: 'Current session', usedPct: 10 }] },
        { source: 'codex', windows: [{ id: 'weekly', label: 'Weekly', usedPct: 40 }] },
        { source: 'gemini', windows: [] },
      ]);
      expect(usageShown()).toBe(true);
      expect(usageBlocks()).toEqual([
        { name: 'Claude', count: null, label: null, meters: 1, none: null },
        { name: 'Codex', count: null, label: null, meters: 1, none: null },
      ]);
      b.emit('usage', []);
      expect(usageShown()).toBe(false);
      expect(b.grid().textContent).toContain('No sessions yet');
    });

    // By key, by code unit, as iOS's AgentSummary.make sorts them, and not
    // in the order the usage arrives: the server sorts it with
    // localeCompare, which puts claude_x before claude-x, and an agent with
    // no report has no place in it.
    it('orders the blocks as iOS orders its heads, by agent and by code unit', async () => {
      const W = [{ id: 'daily', label: 'Daily', usedPct: 12 }];
      const b = await boardOf([
        at('a', 1, { source: 'claude_x' }), at('b', 2, { source: 'gemini' }), at('c', 3, { source: 'claude-x' }), at('d', 4, { source: 'claude' }),
      ]);
      b.emit('usage', [{ source: 'claude', windows: W }, { source: 'claude_x', windows: W }, { source: 'claude-x', windows: W }]);
      expect(usageBlocks().map((x) => x.name)).toEqual(['Claude', 'Claude-x', 'Claude_x', 'Gemini']);
      // The idle board too.
      b.emit('snapshot', []);
      expect(usageBlocks().map((x) => x.name)).toEqual(['Claude', 'Claude-x', 'Claude_x']);
    });

    // The count goes first where room runs short, as on any head, and is
    // heard either way.
    it('fits a limits-less head as any head: the count goes before the name', async () => {
      vi.useFakeTimers();
      const b = await loadBoard();
      const drawn = (el: Element) => (el.classList.contains('usage-name') ? 70
        : el.classList.contains('usage-count') ? ((el as HTMLElement).hidden ? 0 : 60)
          : el.classList.contains('usage-line') ? 120 : 0);
      standIn(b, drawn, drawn);
      b.emit('snapshot', [at('g1', 1, { source: 'gemini' })]);
      expect((head('gemini').querySelector('.usage-count') as HTMLElement).hidden).toBe(true);
      expect(head('gemini').getAttribute('aria-label')).toBe('Gemini, 1 session');
      expect(head('gemini').querySelector('.usage-name')!.textContent).toBe('Gemini');
    });

    // The usage area is painted again for a count, a reading or a
    // countdown, and focus on a head without limits comes back to it too.
    it.each([
      ['its agent gains a session', async (b: Board) => b.emit('session', at('g2', 0, { source: 'gemini' })), 'Gemini, 2 sessions'],
      ['another agent\'s countdown moves on', async () => { await vi.advanceTimersByTimeAsync(45_000); }, 'Gemini, 1 session'],
      ['another agent\'s reading changes', async (b: Board) => b.emit('usage', [{ source: 'claude', windows: [
        { id: 'five_hour', label: 'Current session', usedPct: 55, resetsAt: Date.now() + 2 * 3_600_000 },
      ] }]), 'Gemini, 1 session'],
    ])('keeps a limits-less head focused while the usage area is painted again: %s', async (_what, change, named) => {
      const b = await boardOf([at('c1', 1, { source: 'claude' }), at('g1', 2, { source: 'gemini' })]);
      b.emit('usage', [{ source: 'claude', windows: [
        { id: 'five_hour', label: 'Current session', usedPct: 10, resetsAt: Date.now() + 2 * 3_600_000 },
      ] }]);
      head('gemini').focus();
      const was = head('gemini');
      await change(b);
      expect(head('gemini')).not.toBe(was);   // painted again
      expect(head('gemini').getAttribute('aria-label')).toBe(named);
      expect(document.activeElement).toBe(head('gemini'));
    });

    // When the head itself goes, with its agent's last session, there is
    // nothing to put focus back on.
    it('lets focus on a limits-less head fall to the page when it goes with its agent\'s last session', async () => {
      const b = await boardOf([at('c1', 1, { source: 'claude' }), at('g1', 2, { source: 'gemini' })]);
      head('gemini').focus();
      b.emit('remove', { id: 'g1' });
      expect(head('gemini')).toBe(null);
      expect(usageBlocks().map((x) => x.name)).toEqual(['Claude']);
      expect(document.activeElement).toBe(document.body);
    });

    // A press opens the agent's thirty days, as any block's does, and that
    // page says plainly what it has not been told, as iOS's says it.
    it('opens a limits-less agent\'s thirty days, which say what has not been reported', async () => {
      const b = await boardOf([at('g1', 1, { source: 'gemini' })]);
      b.click(head('gemini'));
      await b.settle();
      await b.settle();   // openDetail awaits a fetch before it paints
      expect(b.hash()).toBe('#usage/gemini');
      const detail = document.getElementById('detail')!;
      expect(detail.querySelector('.dv-title')!.textContent).toBe('Gemini · last 30 days');
      expect(detail.querySelector('.dv-sub')!.textContent).toBe('· 0 total');
      expect(detail.querySelector('.dv-key-none')!.textContent).toBe('limit history starts once reported');
      expect(detail.querySelector('.dv-empty')!.textContent).toBe('No per-project token data reported yet.');
      // And Back lands on the block it was opened from.
      b.click(document.getElementById('dv-back'));
      await b.settle();
      expect(document.activeElement).toBe(head('gemini'));
    });
  });

  // Focus, the history route and the reconciler find cards where they
  // always were: in the one grid, never re-parented under a label.
  it('keeps every card a child of the grid, so Focus and the way back from history still find it', async () => {
    const b = await boardOf([at('a1', 1, { homeProject: 'acme-api', host: { machine: { id: 'm1', name: 'Studio' } } }), at('b1', 2, { homeProject: 'billing' })]);
    for (const el of b.$$('.card')) expect(el.parentElement).toBe(b.grid());
    b.tap('a1', 'open');
    await b.settle();
    expect(b.hash()).toBe('#session/a1');
    b.click(document.getElementById('dv-back'));
    await b.settle();
    expect(document.activeElement).toBe(card(b, 'a1').querySelector('[data-open]'));
  });
});

// ---- The needs-you bar ------------------------------------------------------

const bar = () => document.getElementById('needs') as HTMLButtonElement;
const said = () => document.getElementById('needs-said')!.textContent;
/** What the bar shows, part by part, as drawn. */
const barShows = () => ({
  count: bar().querySelector('.needs-n')?.textContent,
  name: bar().querySelector('.needs-name')?.textContent,
  where: bar().querySelector('.needs-where')?.textContent ?? null,
  verb: bar().querySelector('.needs-verb')?.textContent,
});
const titleOf = (b: Board, id: string) => card(b, id).querySelector('[data-open]');
const blocked = (id: string, minutesAgo: number, homeProject: string, over: Record<string, unknown> = {}) =>
  at(id, minutesAgo, { homeProject, status: 'blocked', message: 'Approve: git push', ...over });
/** What the bar draws, its ground, edge and words, inside the button. */
const face = () => document.getElementById('needs-face') as HTMLElement;
/** An animation's end, as a browser reports it once the animation has run (or is cut short): jsdom runs none. */
const ended = (b: Board, el: Element, name: string, type: 'animationend' | 'animationcancel' = 'animationend') => {
  const e = new b.win.Event(type, { bubbles: true });
  Object.assign(e, { animationName: name });
  el.dispatchEvent(e);
};

describe('the needs-you bar', () => {
  it('is absent while nothing is blocked, and done never counts', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', status: 'done' }), at('c', 2, { homeProject: 'docs' })]);
    expect(bar().hidden).toBe(true);
    expect(face().childElementCount).toBe(0);
    expect(bar().textContent).toBe('');
    expect(document.body.classList.contains('needs-up')).toBe(false);
  });

  it('appears with the first block, naming it and its project, as one button', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', name: 'Fix the login redirect' }), at('c', 2, { homeProject: 'docs' })]);
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix the login redirect' }));
    expect(bar().hidden).toBe(false);
    expect(bar().classList.contains('entering')).toBe(true);   // from the bottom edge (shell.css)
    expect(document.body.classList.contains('needs-up')).toBe(true);   // the page padded
    expect(barShows()).toEqual({ count: '1', name: 'Fix the login redirect', where: '·in acme-api', verb: 'Show' });
    expect(bar().querySelector('.needs-word')!.textContent).toBe('blocked');
    expect(bar().querySelector('.needs-alarm svg.state-mark')).not.toBe(null);
    // One button, named as iOS names it and then by the verb it shows, so
    // its name holds every word of its label (WCAG 2.5.3), with the hint as
    // its description.
    expect(bar().tagName).toBe('BUTTON');
    expect(bar().type).toBe('button');
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Fix the login redirect, in acme-api, Show');
    expect(document.getElementById(bar().getAttribute('aria-describedby')!)!.textContent).toBe('Shows that session');
    expect(bar().querySelector('button, a, [tabindex]')).toBe(null);
  });

  it('names a session in No project by its agent, and never repeats its name', async () => {
    const b = await boardOf([
      blocked('n', 1, '', { project: '', name: 'Reading the brief', source: 'codex' }),
    ]);
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Reading the brief, Codex, Show');
    expect(barShows().where).toBe('·Codex');
    b.emit('session', blocked('n', 0, '', { project: '', name: 'Codex', source: 'codex' }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Codex, Show');
    expect(barShows().where).toBe(null);
    b.emit('session', blocked('n', 0, 'acme-api', { name: 'acme-api', source: 'codex' }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: acme-api, Show');
  });

  // Reading order is the grid's: sections in order, then cards in order.
  it('names the first blocked card in reading order, and counts every blocked card', async () => {
    const b = await boardOf([
      blocked('z', 1, 'zeta', { name: 'In zeta' }), at('a1', 2, { homeProject: 'alpha' }),
      blocked('a2', 3, 'alpha', { name: 'In alpha' }), at('d', 4, { homeProject: 'docs', status: 'done' }),
    ]);
    expect(barShows()).toEqual({ count: '2', name: 'In alpha', where: '·in alpha', verb: 'Show' });
  });

  it('brings the card it names, focuses its title and rings it, then names the next, round to the first', async () => {
    const b = await boardOf([
      blocked('a', 1, 'acme-api', { name: 'Fix the login redirect' }), at('c', 2, { homeProject: 'claude-status' }),
      blocked('e', 3, 'etl-jobs', { name: 'Nightly backfill' }),
    ]);
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    expect(card(b, 'a').classList.contains('is-ringed')).toBe(true);
    expect(barShows()).toEqual({ count: '2', name: 'Nightly backfill', where: '·in etl-jobs', verb: 'Next' });
    expect(bar().getAttribute('aria-label')).toBe('2 blocked: Nightly backfill, in etl-jobs, Next');
    await vi.advanceTimersByTimeAsync(2000);
    expect(card(b, 'a').classList.contains('is-ringed')).toBe(false);   // two seconds
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'e'));
    expect(card(b, 'e').classList.contains('is-ringed')).toBe(true);
    expect(barShows().name).toBe('Fix the login redirect');            // round to the first
    expect(barShows().verb).toBe('Next');
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    // One ring at a time.
    expect(card(b, 'e').classList.contains('is-ringed')).toBe(false);
  });

  it('keeps naming a lone blocked card after a press, and says Show', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    expect(barShows().verb).toBe('Show');
    expect(barShows().count).toBe('1');
  });

  // Until a press it names the first blocked card in reading order, worked
  // out on every render as iOS and Android do, so a block earlier in that
  // order changes what it names. (Until this was fixed the web kept naming
  // the card it named first.)
  it('names the first blocked card until pressed, so a block earlier in reading order changes what it names', async () => {
    const b = await boardOf([blocked('m', 1, 'middle', { name: 'In middle' }), at('a', 2, { homeProject: 'alpha' })]);
    expect(barShows().name).toBe('In middle');
    b.emit('session', blocked('a', 0, 'alpha', { name: 'In alpha' }));
    expect(barShows()).toEqual({ count: '2', name: 'In alpha', where: '·in alpha', verb: 'Show' });
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    expect(barShows()).toEqual({ count: '2', name: 'In middle', where: '·in middle', verb: 'Next' });
  });

  // After a press it names the first blocked card after the one it brought,
  // as drawn now: a card that blocks between them mid-walk is the next one,
  // where the web used to keep naming the card it had picked and reached
  // the new one only a whole round later.
  it('walks A, B, C and round to A when B blocks between them mid-walk', async () => {
    const b = await boardOf([
      blocked('a', 1, 'alpha', { name: 'A' }), at('b', 2, { homeProject: 'bravo', name: 'B' }),
      blocked('c', 3, 'charlie', { name: 'C' }),
    ]);
    const walk: string[] = [];
    const press = () => {
      b.click(bar());
      walk.push((document.activeElement as HTMLElement).closest('.card')!.getAttribute('data-id')!);
    };
    press();
    expect(barShows()).toEqual({ count: '2', name: 'C', where: '·in charlie', verb: 'Next' });
    b.emit('session', blocked('b', 0, 'bravo', { name: 'B' }));
    expect(barShows()).toEqual({ count: '3', name: 'B', where: '·in bravo', verb: 'Next' });
    press();
    press();
    press();
    expect(walk).toEqual(['a', 'b', 'c', 'a']);
  });

  it('walks on from the card it brought once that card is unblocked', async () => {
    const b = await boardOf([
      blocked('a', 1, 'alpha', { name: 'A' }), blocked('b', 2, 'bravo', { name: 'B' }),
      blocked('c', 3, 'charlie', { name: 'C' }),
    ]);
    b.click(bar());
    b.click(bar());                                   // brings B
    b.emit('session', at('b', 0, { homeProject: 'bravo', name: 'B', status: 'coding' }));
    expect(barShows()).toEqual({ count: '2', name: 'C', where: '·in charlie', verb: 'Next' });
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'c'));
    expect(barShows()).toEqual({ count: '2', name: 'A', where: '·in alpha', verb: 'Next' });
  });

  // Once the card a press brought is off the board there is nothing to walk
  // on from: the first blocked card again, and Show, as on a fresh bar.
  it('names the first blocked card again, with Show, once the card it brought has left the board', async () => {
    const b = await boardOf([
      blocked('a', 1, 'alpha', { name: 'A' }), blocked('c', 2, 'charlie', { name: 'C' }),
      blocked('d', 3, 'delta', { name: 'D' }),
    ]);
    b.click(bar());
    expect(barShows()).toEqual({ count: '3', name: 'C', where: '·in charlie', verb: 'Next' });
    b.emit('remove', { id: 'a' });
    expect(barShows()).toEqual({ count: '2', name: 'C', where: '·in charlie', verb: 'Show' });
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'c'));
    expect(barShows()).toEqual({ count: '2', name: 'D', where: '·in delta', verb: 'Next' });
  });

  it('starts from the first blocked card, with Show, each time it comes back', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), blocked('e', 2, 'etl')]);
    b.click(bar());
    expect(barShows().verb).toBe('Next');
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    b.emit('session', at('e', 0, { homeProject: 'etl', status: 'coding' }));
    await vi.advanceTimersByTimeAsync(500);
    b.emit('session', blocked('a', 0, 'acme-api'));
    b.emit('session', blocked('e', 0, 'etl'));
    expect(barShows()).toEqual({ count: '2', name: 'a', where: '·in acme-api', verb: 'Show' });
  });

  // The words every client says: the session's name, or its agent's where
  // it has none, and the place, compared exactly.
  it('names an untitled session by its agent, in the bar and aloud', async () => {
    const b = await boardOf([at('x', 1, { homeProject: 'acme-api', name: '', source: 'codex' })]);
    b.emit('session', blocked('x', 0, 'acme-api', { name: '', source: 'codex' }));
    expect(barShows()).toEqual({ count: '1', name: 'Codex', where: '·in acme-api', verb: 'Show' });
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Codex, in acme-api, Show');
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Codex, in acme-api, needs you');
    // In No project the agent is its name already, and is not said twice.
    b.emit('session', blocked('x', 0, '', { project: '', name: '', source: 'codex' }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Codex, Show');
    // A session sent with no name, from before `source` existed, is Claude's.
    b.emit('session', blocked('x', 0, 'acme-api', { name: undefined, source: undefined }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Claude, in acme-api, Show');
    // Exactly: a name that differs from its section only in case keeps the place.
    b.emit('session', blocked('x', 0, 'acme-api', { name: 'ACME-API' }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: ACME-API, in acme-api, Show');
  });

  // A press reads the board as last drawn.
  it('passes over a card unblocked or gone since it was named', async () => {
    const b = await boardOf([
      blocked('a', 1, 'acme-api', { name: 'A' }), blocked('b', 2, 'billing', { name: 'B' }),
      blocked('c', 3, 'claude-status', { name: 'C' }),
    ]);
    b.click(bar());                                   // brings A, names B
    expect(barShows().name).toBe('B');
    b.emit('session', at('b', 0, { homeProject: 'billing', name: 'B', status: 'coding' }));
    expect(barShows()).toEqual({ count: '2', name: 'C', where: '·in claude-status', verb: 'Next' });
    b.emit('remove', { id: 'c' });
    expect(barShows()).toEqual({ count: '1', name: 'A', where: '·in acme-api', verb: 'Show' });
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
  });

  it('takes the ring away sooner when its card is unblocked', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), blocked('e', 2, 'etl-jobs')]);
    b.click(bar());
    expect(card(b, 'a').classList.contains('is-ringed')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    expect(card(b, 'a').classList.contains('is-ringed')).toBe(false);
  });

  it('keeps the ring through a repaint of its card', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api')]);
    b.click(bar());
    b.emit('session', blocked('a', 1, 'acme-api', { message: 'Approve: git push --force' }));
    expect(card(b, 'a').querySelector('.message')!.textContent).toBe('Approve: git push --force');
    expect(card(b, 'a').classList.contains('is-ringed')).toBe(true);
    expect(document.activeElement).toBe(titleOf(b, 'a'));
  });

  it('leaves when the last block clears, inert while it goes, and hands its focus to the card it brought', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    b.click(bar());
    bar().focus();
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    expect(bar().classList.contains('leaving')).toBe(true);
    expect(bar().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    await vi.advanceTimersByTimeAsync(400);
    expect(bar().hidden).toBe(true);
    expect(bar().hasAttribute('aria-label')).toBe(false);
    expect(document.body.classList.contains('needs-up')).toBe(false);
    // And a block after that is a new bar: Show, from the top.
    b.emit('session', blocked('c', 0, 'docs', { name: 'Docs' }));
    expect(bar().hidden).toBe(false);
    expect(barShows()).toEqual({ count: '1', name: 'Docs', where: '·in docs', verb: 'Show' });
  });

  it('hands its focus to the card it named, if it was never pressed', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    bar().focus();
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    expect(document.activeElement).toBe(titleOf(b, 'a'));
  });

  // Where the reader can see it, focus is handed on and the page stays
  // still. Where they cannot, under the stuck label or the bar, or off the
  // window, it is brought into view as it lands: the least way, so the
  // root's scroll padding stops it clear of the label or the bar, and in
  // one step under reduced motion (WCAG 2.4.11). A 375x812 window: the
  // label stuck at the top is 34px tall, the bar's top edge is at 756.
  describe('a focus it hands on is never hidden', () => {
    function layOutWindow(b: Board, title: { top: number; bottom: number }, reduced = false) {
      const at = (top: number, bottom: number) => ({ x: 0, y: top, top, left: 0, right: 343, bottom, width: 343, height: bottom - top });
      b.win.Element.prototype.getBoundingClientRect = function (this: Element) {
        if (this.matches('h2.section-label')) return this.matches(':first-of-type') ? at(0, 34) : at(900, 934);
        if (this.id === 'needs') return at(756, 812);
        if (this.matches('[data-open], h1')) return at(title.top, title.bottom);
        return at(0, 0);
      } as never;
      const scrolled: Array<{ el: Element; how: unknown }> = [];
      b.win.Element.prototype.scrollIntoView = function (this: Element, how: unknown) { scrolled.push({ el: this, how }); } as never;
      Object.assign(window, {
        innerHeight: 812,
        matchMedia: (q: string) => ({ media: q, matches: reduced && q === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }),
      });
      return scrolled;
    }
    async function leave(title: { top: number; bottom: number }, reduced = false) {
      const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
      const scrolled = layOutWindow(b, title, reduced);
      bar().focus();
      b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
      expect(document.activeElement).toBe(titleOf(b, 'a'));
      return scrolled.map(({ el, how }) => [el === titleOf(b, 'a') ? 'title' : el, how]);
    }

    it('leaves the page still where the title shows whole', async () => {
      expect(await leave({ top: 300, bottom: 326 })).toEqual([]);
      expect(await leave({ top: 34, bottom: 60 })).toEqual([]);
    });

    it.each([
      ['wholly under the stuck label', { top: 4, bottom: 30 }],
      ['partly under the stuck label', { top: 20, bottom: 46 }],
      ['under the bar', { top: 740, bottom: 766 }],
      ['below the window', { top: 1709, bottom: 1735 }],
      ['above the window', { top: -400, bottom: -374 }],
    ])('brings a title %s into view as focus lands', async (_where, title) => {
      expect(await leave(title)).toEqual([['title', { block: 'nearest', behavior: 'smooth' }]]);
    });

    it('brings it in one step under reduced motion', async () => {
      expect(await leave({ top: 4, bottom: 30 }, true)).toEqual([['title', { block: 'nearest', behavior: 'auto' }]]);
    });

    it('brings the board\'s heading into view when no card is left', async () => {
      const b = await boardOf([blocked('a', 1, 'acme-api')]);
      const scrolled = layOutWindow(b, { top: -500, bottom: -474 });
      bar().focus();
      b.emit('remove', { id: 'a' });
      const heading = document.querySelector('h1');
      expect(document.activeElement).toBe(heading);
      expect(scrolled.map(({ el }) => el)).toEqual([heading]);
    });
  });

  // Leaving with focus, the bar hands it to the first of these still on the
  // board: the card it brought in this life, the card it named last, the
  // first card's title, the board's heading. Never <body>, where a reader
  // starts again from the top, and never a card an earlier bar brought.
  it('hands its focus to the card it names, not one an earlier bar brought that has gone since', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    b.click(bar());                                                     // brings a
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));   // the bar leaves
    await vi.advanceTimersByTimeAsync(500);
    b.emit('remove', { id: 'a' });
    b.emit('session', blocked('c', 0, 'docs', { name: 'Docs' }));       // a bar of its own for c
    bar().focus();
    b.emit('session', at('c', 0, { homeProject: 'docs', name: 'Docs', status: 'coding' }));
    expect(document.activeElement).toBe(titleOf(b, 'c'));
  });

  it('hands its focus to the card it names, not one an earlier bar brought that is still here', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    b.click(bar());
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    await vi.advanceTimersByTimeAsync(500);
    b.emit('session', blocked('c', 0, 'docs', { name: 'Docs' }));
    bar().focus();
    b.emit('session', at('c', 0, { homeProject: 'docs', name: 'Docs', status: 'coding' }));
    expect(document.activeElement).toBe(titleOf(b, 'c'));
  });

  it('hands its focus to the card it brought in this life, over the one it named after', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), blocked('c', 2, 'docs'), at('z', 3, { homeProject: 'zeta' })]);
    b.click(bar());                                   // brings a, names c
    bar().focus();
    b.emit('snapshot', [at('a', 1, { homeProject: 'acme-api' }), at('c', 2, { homeProject: 'docs' }), at('z', 3, { homeProject: 'zeta' })]);
    expect(document.activeElement).toBe(titleOf(b, 'a'));
  });

  // Dismissed on another device, or evicted, while the bar has focus.
  it('hands its focus to the first card\'s title when the card it names is taken off the board', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' }), at('z', 3, { homeProject: 'zeta' })]);
    bar().focus();
    b.emit('remove', { id: 'a' });
    expect(document.activeElement).toBe(titleOf(b, 'c'));
    expect(bar().hasAttribute('inert')).toBe(true);
  });

  it('hands its focus to the board\'s heading when no card is left, for as long as it holds it', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api')]);
    b.click(bar());
    bar().focus();
    b.emit('remove', { id: 'a' });
    const heading = document.querySelector('h1') as HTMLElement;
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');   // focusable from a script, never a Tab stop
    heading.blur();
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it('comes back at once for a block that lands while it leaves', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    expect(bar().classList.contains('leaving')).toBe(true);
    b.emit('session', blocked('c', 0, 'docs'));
    expect(bar().classList.contains('leaving')).toBe(false);
    expect(bar().hasAttribute('inert')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(bar().hidden).toBe(false);
  });

  it('goes with the board, when a snapshot empties it', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api')]);
    b.emit('snapshot', []);
    await vi.advanceTimersByTimeAsync(400);
    expect(bar().hidden).toBe(true);
  });

  // Where room runs out the bar gives way in the spec's order, measured as
  // a browser draws it. The stand-in's bar: `line` is what the name and its
  // place share, less the word where it shares their line (one line, as on
  // a wide board); on a phone the alarm has a line of its own, `alarmRoom`,
  // and the session has the line under it. The name shrinks as a flex item
  // with no minimum width does: to nothing, and no further, so a place
  // wider than the line leaves it no box at all.
  //
  // A hidden bar has no width, as in a browser. The bar is painted before
  // it is shown, so the first fit of a bar that has just appeared comes
  // from its ResizeObserver once layout gives it a size: these tests watch
  // sizes and fire it as it shows (`showBar`). A stand-in that gave the
  // hidden bar a width fitted it at paint time, which a browser never does,
  // and so the observer's fit could be deleted with every test still green.
  function layOutBar(b: Board, o: { name: number; where: number; word: number; line: number; alarm?: number; alarmRoom?: number; twoLines?: boolean }) {
    const has = (cls: string) => bar().classList.contains(cls);
    const alarm = () => (o.alarm ?? 40) + (has('drop-word') ? 0 : o.word);
    const drawn = (el: Element) => (el.classList.contains('needs-name') ? o.name
      : el.classList.contains('needs-alarm') ? alarm() : el.id === 'needs' ? ((el as HTMLElement).hidden ? 0 : 1000) : 0);
    standIn(b, drawn, (el) => {
      if (el.classList.contains('needs-name')) {
        return Math.max(0, Math.min(o.name, o.line - (has('drop-where') ? 0 : o.where) - (o.twoLines || has('drop-word') ? 0 : o.word)));
      }
      if (el.classList.contains('needs-alarm')) return o.twoLines ? Math.min(alarm(), o.alarmRoom ?? 1000) : alarm();
      return drawn(el);
    }, (el) => {
      // On one line the session sits beside the alarm, both centred on it;
      // on two it has the line under the alarm's.
      if (el.classList.contains('needs-alarm')) return o.twoLines ? [8, 22] : [10, 24];
      if (el.classList.contains('needs-what')) return o.twoLines ? [26, 44] : [8, 26];
      return [0, 0];
    });
  }
  const gaveWay = () => ['drop-word', 'drop-where'].filter((c) => bar().classList.contains(c));
  /** A board laid out as the bar shows: its observers fire, as a browser's do once layout has sized what they watch. */
  const showBar = (b: Board, list: unknown[]) => {
    b.emit('snapshot', list);
    FakeResizeObserver.fire();
  };

  it.each([
    // A name 0.3px too wide: whole pixels saw none of it, and CSS cut the
    // name with the word and the project still showing.
    ['one line, a name 0.3px too wide: the word goes', { name: 160.3, where: 80, word: 60, line: 300 }, ['drop-word']],
    ['one line, still too wide without the word: the project goes too', { name: 230, where: 80, word: 60, line: 300 }, ['drop-word', 'drop-where']],
    ['one line, a name that fits keeps every word', { name: 160, where: 80, word: 60, line: 300 }, []],
    // On a phone the word is on the alarm's line, where dropping it gives the
    // name no room: the session line drops its place, and the word stays.
    ['two lines, a name 0.3px too wide: the place goes, the word stays', { name: 220.3, where: 80, word: 60, line: 300, twoLines: true }, ['drop-where']],
    ['two lines, an alarm line too narrow for the word: the word goes', { name: 100, where: 80, word: 60, line: 300, twoLines: true, alarmRoom: 99.6 }, ['drop-word']],
    // So too where the place is wider than the session's whole line, as
    // Chrome draws the spec's folder at 375px with 200% text: the name has
    // no box with the place, and its line under the alarm's either way.
    ['two lines, a place wider than the session\'s line: the place goes, the word stays',
      { name: 699.03, where: 735.44, word: 101.54, alarm: 47.38, line: 351, twoLines: true, alarmRoom: 267.78 }, ['drop-where']],
  ])('gives way as the spec orders it: %s', async (_what, o, expected) => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    layOutBar(b, o);
    showBar(b, [blocked('a', 1, 'acme-api', { name: 'Fix the login redirect' })]);
    expect(gaveWay()).toEqual(expected);
  });

  // On one line a place wider than the room the name and the place share,
  // with the word and without it, left the name no box either way. Dropping
  // the word gave it no more room, which the bar took for the phone's two
  // lines, so it kept BLOCKED and dropped only the place: '(!) 1 BLOCKED
  // Fix the login redirect a… Show'. On one line the word goes first (B1),
  // as on iOS, and then the place: '(!) 1 Fix the login redirect after th…
  // Show'. Widths as headless Chrome draws them.
  it.each([
    ['600px wide at 200% text, with the spec\'s long folder', {
      folder: 'agstatus-listener-windows-terminal-focus-and-presence', title: 'Fix the login redirect after the OAuth callback returns',
      name: 699.03, where: 735.44, word: 101.54, alarm: 47.38, line: 421.41,
    }],
    ['568px wide at the default size, with a 60-character folder', {
      folder: 'AgStatusWindowsTerminalFocusAndPresenceListenerWorkerMonitor', title: 'Fix the login redirect',
      name: 135.98, where: 453.42, word: 52.78, alarm: 25.69, line: 444.7,
    }],
  ])('drops the word before the place on one line, where the place leaves the name no room: %s', async (_what, o) => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    layOutBar(b, o);
    showBar(b, [blocked('a', 1, o.folder, { name: o.title })]);
    expect(gaveWay()).toEqual(['drop-word', 'drop-where']);
  });

  // The usual way a bar appears: a card on a board already drawn becomes
  // blocked. It is painted while still hidden, with no width to fit to, and
  // fitted once layout gives it one. A bar that showed unfitted kept a
  // project wider than a phone, and left the name no box at all.
  it('fits a bar that has just appeared, once layout gives it a size', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    layOutBar(b, { name: 220.3, where: 80, word: 60, line: 300, twoLines: true });
    showBar(b, [at('a', 1, { homeProject: 'acme-api', name: 'Fix the login redirect' }), at('c', 2, { homeProject: 'docs' })]);
    expect(bar().hidden).toBe(true);
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix the login redirect' }));
    FakeResizeObserver.fire();   // the bar laid out, as it shows
    expect(bar().hidden).toBe(false);
    expect(gaveWay()).toEqual(['drop-where']);
  });

  // While the bar shows, its words change and its size does not: a press
  // names the next card, a frame renames the card it names, a block arrives
  // between the card a press brought and the next. The bar is as wide as the
  // window, and its session line is one line box (shell.css), so no observer
  // fires, and the fit as its words are painted is the only one. Without it
  // the bar kept the give-way of the card it named first: Chrome at 375px
  // dropped 'in alpha' and 'in beta', which fit, at 568px BLOCKED as well,
  // and the other way round it kept a folder wider than the line and left
  // the name no box. The stand-in measures each card's name and place by
  // the words the bar shows, as headless Chrome draws them.
  it.each([
    ['two lines, at 375x812', { word: 52.78, alarm: 25.69, line: 351, twoLines: true, alarmRoom: 306.27 }, {
      'Fix the login redirect': [135.98, 375.72], 'Fix flaky test': [84.69, 66.41],
      'Fix the flaky integration test in the nightly pipeline': [328.63, 66.41], 'Ship it': [41.73, 59.97],
    }, [['drop-where'], [], ['drop-where'], ['drop-where'], []]],
    ['one line, at 568x320', { word: 52.78, alarm: 25.69, line: 449.58 }, {
      'Fix the login redirect': [135.98, 375.72], 'Fix flaky test': [84.69, 66.41],
      'Fix the flaky integration test in the nightly pipeline': [328.63, 66.41], 'Ship it': [41.73, 59.97],
    }, [['drop-word', 'drop-where'], [], [], ['drop-word', 'drop-where'], []]],
    ['one line, at 600x800 with 200% text', { word: 101.55, alarm: 47.38, line: 431.17 }, {
      'Fix the login redirect': [271.95, 735.44], 'Fix flaky test': [169.36, 116.81],
      'Fix the flaky integration test in the nightly pipeline': [657.25, 116.81], 'Ship it': [83.47, 103.94],
    }, [['drop-word', 'drop-where'], [], ['drop-word', 'drop-where'], ['drop-word', 'drop-where'], []]],
  ])('fits itself again whenever its words change and its size does not: %s', async (_what, layout, words, gave) => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    const shown = () => (words as Record<string, number[]>)[bar().querySelector('.needs-name')!.textContent!];
    layOutBar(b, { ...layout, get name() { return shown()[0]; }, get where() { return shown()[1]; } });
    showBar(b, [
      blocked('a', 1, 'agstatus-listener-windows-terminal-focus-and-presence', { name: 'Fix the login redirect' }),
      blocked('c', 2, 'alpha', { name: 'Fix flaky test' }),
    ]);
    expect(gaveWay()).toEqual(gave[0]);
    b.click(bar());                                   // brings a, names c
    expect(barShows().where).toBe('·in alpha');
    expect(gaveWay()).toEqual(gave[1]);
    b.emit('session', blocked('c', 0, 'alpha', { name: 'Fix the flaky integration test in the nightly pipeline' }));
    expect(gaveWay()).toEqual(gave[2]);
    b.click(bar());                                   // brings c, names a, round to the first
    expect(barShows().name).toBe('Fix the login redirect');
    expect(gaveWay()).toEqual(gave[3]);
    b.emit('session', blocked('d', 0, 'beta', { name: 'Ship it' }));   // after c, so the next
    expect(barShows()).toEqual({ count: '3', name: 'Ship it', where: '·in beta', verb: 'Next' });
    expect(gaveWay()).toEqual(gave[4]);
    b.click(bar());                                   // brings d, names a: from words that fit to the long folder
    expect(barShows().name).toBe('Fix the login redirect');
    expect(gaveWay()).toEqual(gave[3]);
  });

  // A cold load draws the bar in the fallback face, which is wider. Barlow
  // arriving changes neither its markup nor its size, which is all that
  // fitted it again, so it kept dropping words that would now fit.
  it('fits itself again when the webfonts arrive', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    const o = { name: 165, where: 80, word: 60, line: 300 };
    layOutBar(b, o);
    showBar(b, [blocked('a', 1, 'acme-api', { name: 'Fix the login redirect' })]);
    expect(gaveWay()).toEqual(['drop-word']);
    o.name = 150;
    fontsArrive(b);
    expect(gaveWay()).toEqual([]);
    o.name = 240;
    fontsArrive(b);
    expect(gaveWay()).toEqual(['drop-word', 'drop-where']);
  });

  // While it shows, the page is padded by the bar's height, so nothing ends
  // under it, and whatever is scrolled into view stops clear of it: both
  // read --needs-h on the root (shell.css). Measured, as it shows and
  // whenever it changes size, since it takes one line or two and grows with
  // the reader's text.
  it('pads the page by the bar\'s measured height while it shows', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    let height = 55;
    Object.defineProperty(b.win.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.id === 'needs' && !this.hidden ? height : 0; },
    });
    const needsH = () => document.documentElement.style.getPropertyValue('--needs-h');
    b.emit('snapshot', [at('a', 1, { homeProject: 'acme-api' }), at('c', 2, { homeProject: 'docs' })]);
    expect(needsH()).toBe('');
    b.emit('session', blocked('a', 0, 'acme-api'));
    expect(needsH()).toBe('55px');                  // as it shows
    expect(document.body.classList.contains('needs-up')).toBe(true);
    height = 88;                                     // the reader's text grows
    FakeResizeObserver.fire();
    expect(needsH()).toBe('88px');
    // Gone, it measures nothing: its last height stands, and the padding
    // goes with the class that reads it.
    b.emit('session', at('a', 0, { homeProject: 'acme-api' }));
    await vi.advanceTimersByTimeAsync(400);
    expect(bar().hidden).toBe(true);
    FakeResizeObserver.fire();
    expect(needsH()).toBe('88px');
    expect(document.body.classList.contains('needs-up')).toBe(false);
  });

  // A press scrolls only for a card that does not show whole below the
  // stuck label and above the bar, and then brings it to the root's scroll
  // padding under its label, in one step under reduced motion. jsdom has no
  // scrollIntoView, so the stand-in records each call: a 375x812 window,
  // the stuck label 34px tall, the bar 56.
  describe('a press scrolls only for a card out of view', () => {
    function layOutPress(b: Board, top: number, reduced = false) {
      const scrolled: Array<[string | undefined, unknown]> = [];
      b.win.Element.prototype.scrollIntoView = function (this: Element, how: unknown) {
        scrolled.push([(this as HTMLElement).dataset.id, how]);
      } as never;
      b.win.Element.prototype.getBoundingClientRect = function (this: Element) {
        const [t, h] = this.matches('.card[data-id="a"]') ? [top, 120] : [0, 0];
        return { x: 0, y: t, top: t, left: 0, right: 343, bottom: t + h, width: 343, height: h };
      } as never;
      Object.defineProperty(b.win.HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.matches('h2.section-label') ? 34 : this.id === 'needs' && !this.hidden ? 56 : 0; },
      });
      Object.assign(window, {
        innerHeight: 812,
        matchMedia: (q: string) => ({ media: q, matches: reduced && q === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }),
      });
      return scrolled;
    }
    async function press(top: number, reduced = false) {
      const b = await boardOf([blocked('a', 1, 'acme-api'), at('c', 2, { homeProject: 'docs' })]);
      const scrolled = layOutPress(b, top, reduced);
      b.click(bar());
      expect(document.activeElement).toBe(titleOf(b, 'a'));
      expect(card(b, 'a').classList.contains('is-ringed')).toBe(true);
      return scrolled;
    }

    it.each([
      ['whole between the label and the bar', 300],
      ['just clear of the label', 34],
      ['just clear of the bar', 812 - 56 - 120],
    ])('leaves the page still for a card %s', async (_where, top) => {
      expect(await press(top)).toEqual([]);
    });

    it.each([
      ['partly under the stuck label', 20],
      ['partly under the bar', 700],
      ['below the window', 1500],
      ['above the window', -400],
    ])('brings a card %s to the top of its section', async (_where, top) => {
      expect(await press(top)).toEqual([['a', { block: 'start', behavior: 'smooth' }]]);
    });

    it('brings it in one step under reduced motion', async () => {
      expect(await press(1500, true)).toEqual([['a', { block: 'start', behavior: 'auto' }]]);
    });
  });

  // A keyboard reaches the bar before the cards it leads to, as a real
  // button, which answers Enter and Space itself.
  it('is a stop on the keyboard\'s way, ahead of the grid, only while it shows', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    expect(bar().hidden).toBe(true);   // not focusable while hidden
    b.emit('session', blocked('a', 0, 'acme-api'));
    expect(bar().tabIndex).toBe(0);
    expect(bar().compareDocumentPosition(b.grid()) & 4).toBe(4);   // the grid follows it
    bar().focus();
    expect(document.activeElement).toBe(bar());
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
  });
});

describe('a new block, aloud', () => {
  it('says a block that lands while the board watches, after half a second', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', name: 'Fix the login redirect' })]);
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix the login redirect' }));
    expect(said()).toBe('');
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Fix the login redirect, in acme-api, needs you');
    const region = document.getElementById('needs-said')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('says nothing on load, or for the blocks a reconnect brings', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api')]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(said()).toBe('');
    b.emit('snapshot', [blocked('a', 1, 'acme-api'), blocked('b', 1, 'billing')]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(said()).toBe('');
  });

  it('says a block with no place to name as a plain sentence, as iOS does', async () => {
    // Untitled in No project: named by its agent, which is then no place.
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    b.emit('session', blocked('n', 0, '', { name: '', source: 'codex', project: '/' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Codex needs you');
    // Named after its folder: the place would only repeat the name.
    b.emit('session', blocked('m', 0, 'acme-api', { name: 'acme-api' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('acme-api needs you');
  });

  it('says a new session that arrives blocked', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    b.emit('session', blocked('n', 0, 'billing', { name: 'Charge the card' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Charge the card, in billing, needs you');
  });

  it('says blocks that land together as one sentence', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' }), at('b', 2, { homeProject: 'billing' })]);
    b.emit('session', blocked('a', 0, 'acme-api'));
    await vi.advanceTimersByTimeAsync(15);
    b.emit('session', blocked('b', 0, 'billing'));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('2 sessions need you');
  });

  it('says nothing for a block answered within the half second', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    b.emit('session', blocked('a', 0, 'acme-api'));
    b.emit('session', at('a', 0, { homeProject: 'acme-api', status: 'coding' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('');
  });

  it('says one session at most once a minute', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', name: 'Fix it' })]);
    const region = document.getElementById('needs-said')!;
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix it' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Fix it, in acme-api, needs you');
    region.textContent = '';
    b.emit('session', at('a', 0, { homeProject: 'acme-api', name: 'Fix it', status: 'coding' }));
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix it' }));   // again, 0.7 s on
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('');
    await vi.advanceTimersByTimeAsync(60_000);
    b.emit('session', at('a', 0, { homeProject: 'acme-api', name: 'Fix it', status: 'coding' }));
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix it' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Fix it, in acme-api, needs you');
  });

  it('says nothing for a frame about a card that was blocked already', async () => {
    const b = await boardOf([blocked('a', 1, 'acme-api')]);
    b.emit('session', blocked('a', 0, 'acme-api', { message: 'Approve: something else' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('');
  });

  // The region is read with the page, so a sentence left in it would meet
  // someone reading from the top an hour later, about a block long answered.
  // Cleared a few seconds after it is written, which a screen reader does not
  // say: a polite region speaks what is added.
  it('clears what it said five seconds after saying it', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', name: 'Fix it' })]);
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix it' }));
    await vi.advanceTimersByTimeAsync(600);                // written at 0.6 s
    expect(said()).toBe('Fix it, in acme-api, needs you');
    await vi.advanceTimersByTimeAsync(4900);               // 5.5 s
    expect(said()).toBe('Fix it, in acme-api, needs you');
    await vi.advanceTimersByTimeAsync(200);                // 5.7 s
    expect(said()).toBe('');
  });

  it('gives a newer sentence its own five seconds', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', name: 'Fix it' }), at('c', 2, { homeProject: 'docs', name: 'Docs' })]);
    b.emit('session', blocked('a', 0, 'acme-api', { name: 'Fix it' }));   // written at 0.6 s
    await vi.advanceTimersByTimeAsync(4500);
    b.emit('session', blocked('c', 0, 'docs', { name: 'Docs' }));         // written at 5.1 s
    await vi.advanceTimersByTimeAsync(1200);                               // 5.7 s, past the first one's five
    expect(said()).toBe('Docs, in docs, needs you');
    await vi.advanceTimersByTimeAsync(4300);                               // 10.0 s
    expect(said()).toBe('Docs, in docs, needs you');
    await vi.advanceTimersByTimeAsync(200);                                // 10.2 s
    expect(said()).toBe('');
  });
});

// ---- The needs-you bar's beat -----------------------------------------------
//
// A second block changed one figure on the bar, too small for the corner of
// the eye. When the count rises while the bar shows, the bar comes in from
// the bottom edge again, once, with the new count in it (the owner's call of
// 2026-11-16): its face replays the bar's arrival (shell.css). It hears what
// the voice hears, after the voice's half second, and beats by the rule iOS
// keeps (BarBeat).

/** The tab showing, which jsdom's never is: its document is hidden unless it pretends to be drawn. */
const tabShows = (b: Board, showing = true) =>
  Object.defineProperty(b.win.document, 'hidden', { configurable: true, get: () => !showing });

/** Reduced motion asked for, or not, through the matchMedia the board reads. */
const reduceMotion = (on: boolean) => Object.assign(window, {
  matchMedia: (q: string) => ({ media: q, matches: on && q === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }),
});

/**
 * The bar's beats as they start, each as the count the bar shows then. Each
 * one's end is heard straight away, as a browser reports it 420 ms on, so the
 * next can start.
 */
function watchBeats(b: Board) {
  const beats: string[] = [];
  new b.win.MutationObserver((records) => {
    for (const r of records) {
      if ((r.oldValue || '').split(/\s+/).includes('beat') || !face().classList.contains('beat')) continue;
      beats.push(bar().querySelector('.needs-n')!.textContent!);
      ended(b, face(), 'needs-in');
    }
  }).observe(face(), { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  return beats;
}

/**
 * A board drawn from its first snapshot with its bar up and arrived, the tab
 * showing, and ten seconds gone by, so the count its blocks make is the one
 * the bar rests on.
 */
async function barUp(list: unknown[]) {
  const b = await boardOf(list);
  tabShows(b);
  ended(b, bar(), 'needs-in');
  await vi.advanceTimersByTimeAsync(10_000);
  return b;
}

const unblocked = (id: string, homeProject: string) => at(id, 0, { homeProject, status: 'coding' });

describe('the needs-you bar\'s beat', () => {
  it('comes in again once when the count rises while it shows, with the new count already in it', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('w', 2, { homeProject: 'web', name: 'Write the docs' })]);
    const beats = watchBeats(b);
    b.emit('session', blocked('w', 0, 'web', { name: 'Write the docs' }));
    expect(barShows().count).toBe('2');                    // in place, at once
    await vi.advanceTimersByTimeAsync(400);
    expect(beats).toEqual([]);                             // nothing until the half second is over
    await vi.advanceTimersByTimeAsync(300);
    expect(beats).toEqual(['2']);
    expect(said()).toBe('Write the docs, in web, needs you');   // the voice, said once, as before
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats).toEqual(['2']);                          // never a loop, nor a reminder while it stands
  });

  it('beats once for blocks that land together, and again for a later rise', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), ...['w1', 'w2', 'w3'].map((id, i) => at(id, i + 2, { homeProject: 'web' }))]);
    const beats = watchBeats(b);
    b.emit('session', blocked('w1', 0, 'web'));
    await vi.advanceTimersByTimeAsync(15);                 // two hook events posted at once
    b.emit('session', blocked('w2', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['3']);
    await vi.advanceTimersByTimeAsync(5000);
    b.emit('session', blocked('w3', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['3', '4']);
  });

  // The count a half second ends on is a count the bar rests on, though it
  // has not stood for half a second: so one block in place of another just
  // after a beat is no second beat. iOS (verifyBarBeat) and Android
  // (BarBeatTest) check the same case.
  it('never beats again for one block in place of another just after a beat', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), ...['w1', 'w2', 'w3'].map((id, i) => at(id, i + 2, { homeProject: 'web' }))]);
    const beats = watchBeats(b);
    b.emit('session', blocked('w1', 0, 'web'));            // 0 s
    await vi.advanceTimersByTimeAsync(300);
    b.emit('session', blocked('w2', 0, 'web'));            // 0.3 s, in the same half second
    await vi.advanceTimersByTimeAsync(300);
    expect(beats).toEqual(['3']);                          // one beat, at 0.5 s, with 3
    b.emit('session', unblocked('a', 'acme-api'));          // 0.6 s
    await vi.advanceTimersByTimeAsync(300);
    b.emit('session', blocked('w3', 0, 'web'));            // 0.9 s: one in place of another
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('3');
    expect(beats).toEqual(['3']);
  });

  it('never beats for the first block, whose arrival is the beat, nor for one that lands as it arrives', async () => {
    const b = await boardOf([at('w1', 1, { homeProject: 'web' }), at('w2', 2, { homeProject: 'web' })]);
    tabShows(b);
    await vi.advanceTimersByTimeAsync(10_000);
    const beats = watchBeats(b);
    b.emit('session', blocked('w1', 0, 'web'));
    expect(bar().classList.contains('entering')).toBe(true);   // its arrival, from the bottom edge
    await vi.advanceTimersByTimeAsync(300);
    b.emit('session', blocked('w2', 0, 'web'));
    await vi.advanceTimersByTimeAsync(120);
    ended(b, bar(), 'needs-in');                           // arrived, 420 ms on
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('2');
    expect(beats).toEqual([]);
  });

  it('never beats for a fall: an unblock or a dismissal', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), blocked('b', 2, 'billing'), blocked('c', 3, 'claude-status')]);
    const beats = watchBeats(b);
    b.emit('session', unblocked('b', 'billing'));
    await vi.advanceTimersByTimeAsync(1000);
    b.tap('c', 'dismiss');
    await vi.advanceTimersByTimeAsync(1000);
    b.emit('remove', { id: 'c' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('1');
    expect(beats).toEqual([]);
  });

  // The count the bar rests on is one that stood for half a second, so one
  // block in place of another is no rise whichever comes first.
  it.each([
    ['the new block first', ['w', 'a']],
    ['the answered block first', ['a', 'w']],
  ])('never beats for one block in place of another, %s', async (_first, order) => {
    const b = await barUp([blocked('a', 1, 'acme-api'), blocked('b', 2, 'billing'), at('w', 3, { homeProject: 'web' })]);
    const beats = watchBeats(b);
    for (const id of order) {
      b.emit('session', id === 'w' ? blocked('w', 0, 'web') : unblocked('a', 'acme-api'));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('2');
    expect(beats).toEqual([]);
  });

  // The bar went, and came back with the next block: that is its arrival.
  it('never beats when the bar empties and comes back within the half second', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('w1', 2, { homeProject: 'web' }), at('w2', 3, { homeProject: 'web' })]);
    const beats = watchBeats(b);
    b.emit('session', blocked('w1', 0, 'web'));
    await vi.advanceTimersByTimeAsync(100);
    b.emit('session', unblocked('a', 'acme-api'));
    b.emit('session', unblocked('w1', 'web'));          // none blocked: the bar leaves
    await vi.advanceTimersByTimeAsync(100);
    b.emit('session', blocked('w1', 0, 'web'));
    b.emit('session', blocked('w2', 0, 'web'));          // and comes back at once
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('2');
    expect(bar().hidden).toBe(false);
    expect(beats).toEqual([]);
  });

  // None of the half second's blocks stands at its end: nothing it heard is
  // news, whatever else moved the count meanwhile (here a session already
  // said within its minute, which is no news of its own).
  it('never beats when the half second\'s own blocks were answered within it', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('x', 2, { homeProject: 'docs' }), at('w', 3, { homeProject: 'web' })]);
    const beats = watchBeats(b);
    b.emit('session', blocked('x', 0, 'docs'));
    await vi.advanceTimersByTimeAsync(1000);
    b.emit('session', unblocked('x', 'docs'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(beats).toEqual(['2']);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(100);
    b.emit('session', blocked('x', 0, 'docs'));          // said within its minute
    b.emit('session', unblocked('w', 'web'));           // answered within the half second
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('2');
    expect(beats).toEqual(['2']);
  });

  // Seconds apart, the count the reader saw fell and then rose.
  it('beats for a block seconds after another was answered', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), blocked('b', 2, 'billing'), at('w', 3, { homeProject: 'web' })]);
    const beats = watchBeats(b);
    b.emit('session', unblocked('a', 'acme-api'));
    await vi.advanceTimersByTimeAsync(5000);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['2']);
  });

  // Blocks that were standing before the board looked: no frame brought them.
  it('never beats for the blocks a snapshot, a reconnect or a refetch brings', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('b', 2, { homeProject: 'billing' }),
      at('c', 3, { homeProject: 'docs' }), at('d', 4, { homeProject: 'etl' })]);
    const beats = watchBeats(b);
    // What a reconnect sends: a snapshot, with a block that landed while the stream was down.
    b.emit('snapshot', [blocked('a', 1, 'acme-api'), blocked('b', 0, 'billing'), at('c', 3, { homeProject: 'docs' }),
      at('d', 4, { homeProject: 'etl' })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('2');
    // A refused dismissal: the fetch after it puts the card back, and brings another blocked.
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return reply({ error: 'nope' }, 500);
      return url.endsWith('/api/sessions')
        ? reply([blocked('a', 1, 'acme-api'), blocked('b', 0, 'billing'), blocked('c', 0, 'docs'), at('d', 4, { homeProject: 'etl' })])
        : reply({});
    });
    b.tap('b', 'dismiss');
    await b.settle();
    await b.settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('3');
    // ...and that block's own frame, when it comes.
    b.emit('session', blocked('c', 0, 'docs', { message: 'Approve: deploy' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual([]);
  });

  it('never beats for a session said within its minute, and beats for it after', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('w', 2, { homeProject: 'web' })]);
    const beats = watchBeats(b);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    b.emit('session', unblocked('w', 'web'));
    await vi.advanceTimersByTimeAsync(20_000);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['2']);
    await vi.advanceTimersByTimeAsync(60_000);
    b.emit('session', unblocked('w', 'web'));
    await vi.advanceTimersByTimeAsync(5000);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['2', '2']);
  });

  it('keeps still under reduced motion: the count changes in place, and the voice still says it', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('w', 2, { homeProject: 'web', name: 'Write the docs' })]);
    reduceMotion(true);
    const beats = watchBeats(b);
    b.emit('session', blocked('w', 0, 'web', { name: 'Write the docs' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(barShows().count).toBe('2');
    expect(said()).toBe('Write the docs, in web, needs you');
    expect(beats).toEqual([]);
  });

  it('keeps still while the tab is hidden or a detail screen covers the board, and on the way back', async () => {
    const ws = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const b = await barUp([blocked('a', 1, 'acme-api'), ...ws.map((id, i) => at(id, i + 2, { homeProject: 'web' }))]);
    const beats = watchBeats(b);
    const land = (id: string) => b.emit('session', blocked(id, 0, 'web'));
    tabShows(b, false);
    land('w1');                                            // hidden as it lands
    await vi.advanceTimersByTimeAsync(1000);
    land('w2');                                            // hidden as it lands, showing again within its half second
    await vi.advanceTimersByTimeAsync(200);
    tabShows(b, true);
    await vi.advanceTimersByTimeAsync(1000);
    land('w3');                                            // showing as it lands, hidden within its half second
    await vi.advanceTimersByTimeAsync(200);
    tabShows(b, false);
    await vi.advanceTimersByTimeAsync(1000);
    tabShows(b, true);
    location.hash = 'usage/claude';                       // a detail screen over the board
    await b.settle();
    land('w4');
    await vi.advanceTimersByTimeAsync(1000);
    location.hash = '';
    await b.settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(barShows().count).toBe('5');
    expect(beats).toEqual([]);
    land('w5');                                            // in front again: a rise beats
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['6']);
  });

  // A bar that appeared under a detail screen has run no arrival yet: it
  // runs when the board shows again, and nothing beats until it is over.
  it('keeps still while the bar is still arriving', async () => {
    const b = await boardOf([at('w1', 1, { homeProject: 'web' }), at('w2', 2, { homeProject: 'web' }), at('w3', 3, { homeProject: 'web' })]);
    tabShows(b);
    const beats = watchBeats(b);
    location.hash = 'usage/claude';
    await b.settle();
    b.emit('session', blocked('w1', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    location.hash = '';
    await b.settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bar().classList.contains('entering')).toBe(true);
    b.emit('session', blocked('w2', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual([]);
    ended(b, bar(), 'needs-in');
    b.emit('session', blocked('w3', 0, 'web'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(beats).toEqual(['3']);
  });

  // A detail screen opened mid-beat hides the bar, which cancels the face's
  // animation rather than ending it. Left with its class, the face would
  // beat again the moment the board came back, with no news.
  it('forgets a beat cut short, so nothing replays when the board comes back', async () => {
    const b = await barUp([blocked('a', 1, 'acme-api'), at('w', 2, { homeProject: 'web' })]);
    b.emit('session', blocked('w', 0, 'web'));
    await vi.advanceTimersByTimeAsync(600);
    expect(face().classList.contains('beat')).toBe(true);
    ended(b, face(), 'needs-in', 'animationcancel');
    expect(face().classList.contains('beat')).toBe(false);
    expect(bar().classList.contains('entering')).toBe(false);
  });

  // Only its face moves. The button keeps its box, so the page's padding and
  // scroll padding measured from it stay where they are, and so do focus and
  // the scroll; a press while the face rises lands on the bar and brings its
  // card, and the beat carries on through the repaint the press makes.
  it('moves only its face: the bar keeps its place, the page its padding, the reader focus and the scroll', async () => {
    vi.useFakeTimers();
    observeSizes();
    const b = await loadBoard();
    tabShows(b);
    b.emit('snapshot', [blocked('a', 1, 'acme-api'), at('w', 2, { homeProject: 'web' })]);
    ended(b, bar(), 'needs-in');
    Object.defineProperty(b.win.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.id === 'needs' && !this.hidden ? 55 : 0; },
    });
    FakeResizeObserver.fire();
    await vi.advanceTimersByTimeAsync(10_000);
    const scrolled: Element[] = [];
    b.win.Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); } as never;
    const needsH = () => document.documentElement.style.getPropertyValue('--needs-h');
    const place = () => ({ bar: bar().className, inert: bar().hasAttribute('inert'), h: needsH(), up: document.body.className });
    const drawn = face();
    bar().focus();
    b.emit('session', blocked('w', 0, 'web'));
    const before = { ...place(), label: bar().getAttribute('aria-label') };
    expect(before.h).toBe('55px');
    await vi.advanceTimersByTimeAsync(500);
    expect(face().classList.contains('beat')).toBe(true);   // mid-beat
    expect(face()).toBe(drawn);
    expect({ ...place(), label: bar().getAttribute('aria-label') }).toEqual(before);
    expect(document.activeElement).toBe(bar());
    expect(scrolled).toEqual([]);
    b.click(bar());
    expect(document.activeElement).toBe(titleOf(b, 'a'));
    expect(face()).toBe(drawn);
    expect(face().classList.contains('beat')).toBe(true);
    ended(b, face(), 'needs-in');
    expect(face().classList.contains('beat')).toBe(false);
    // The press renamed the bar; nothing else about its place changed.
    const { label: _renamed, ...kept } = before;
    expect(place()).toEqual(kept);
  });
});

// ---- An agent, named and marked as every board does -------------------------

describe('an agent, named and marked as every board does', () => {
  /** What a card says of its agent: the tooltip on its mark, and the hidden words before its facts. */
  const lead = (b: Board, id: string) => {
    const agent = meta(b, id).querySelector('.meta-agent') as HTMLElement;
    return [agent.title, agent.querySelector('.sr-only')!.textContent];
  };

  // Claude and Codex by name; any other source in its own spelling with its
  // first letter upper-cased, as the hook names a session after its agent
  // (agentLabel), so the bar and its voice say what iOS and Android say. The
  // server takes any lowercase word as a source, 'constructor' included,
  // which a plain object index answers with Object's own function.
  it.each([
    ['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['codex-cli', 'Codex-cli'],
    ['claude-work', 'Claude-work'], ['my_agent', 'My_agent'], ['constructor', 'Constructor'],
  ])('names %s "%s" on its card, in the bar and aloud', async (source, name) => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    b.emit('session', blocked('n', 0, '', { project: '', name: 'Port the parser', source }));
    expect(lead(b, 'n')).toEqual([name, `${name},`]);
    // In No project the bar's place is the agent's name.
    expect(bar().getAttribute('aria-label')).toBe(`1 blocked: Port the parser, ${name}, Show`);
    expect(barShows().where).toBe(`·${name}`);
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe(`Port the parser, ${name}, needs you`);
  });

  // The hook names an untitled session with no folder after its agent, and
  // the bar leaves out a place that would only say the name again. Spelt
  // in lower case, the web said it twice: "Gemini, gemini, needs you".
  it('says an untitled session named after its agent once, as iOS and Android do', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api' })]);
    b.emit('session', blocked('g', 0, '', { project: '/', name: 'Gemini', source: 'gemini' }));
    expect(bar().getAttribute('aria-label')).toBe('1 blocked: Gemini, Show');
    expect(barShows().where).toBe(null);
    await vi.advanceTimersByTimeAsync(700);
    expect(said()).toBe('Gemini needs you');
  });

  // A card is read "<agent>, <name>" now that Claude and Codex share
  // sections, and "<name>" alone where the name is its agent's own,
  // compared exactly, as iOS and Android read it. On the title, whose name
  // keeps every word it shows (WCAG 2.5.3) and says what a press does.
  it.each([
    ['claude', 'Fix the login redirect', 'Claude, Fix the login redirect'],
    ['codex', 'Fix flaky test', 'Codex, Fix flaky test'],
    ['codex', 'Codex', 'Codex'],
    ['codex', 'codex', 'Codex, codex'],
    ['gemini', 'Gemini', 'Gemini'],
    [undefined, 'Claude', 'Claude'],
    ['claude', 'agstatus', 'Claude, agstatus'],
  ])('reads a %s card named "%s" as "%s"', async (source, name, lead) => {
    const b = await boardOf([at('s', 1, { source, name })]);
    const title = titleOf(b, 's') as HTMLElement;
    const label = title.getAttribute('aria-label')!;
    expect(label).toBe(`${lead} — open this session's history`);
    expect(title.querySelector('.name')!.textContent).toBe(name);
    expect(label).toContain(name);
  });

  // By the source's start, for Claude as for Codex, as iOS and Android mark
  // them: a second Claude account tagged claude-work is Claude's.
  it.each([
    ['claude', 'claude'], ['claude-work', 'claude'], ['claude-code', 'claude'], ['codex', 'codex'],
    ['codex-cli', 'codex'], ['gemini', 'agent'], ['my-claude', 'agent'], ['constructor', 'agent'],
  ])('marks %s with the %s mark, on its card and its usage block', async (source, icon) => {
    const b = await boardOf([at('s', 1, { source })]);
    b.emit('usage', [{ source, windows: [{ id: 'daily', label: 'Daily', usedPct: 10 }] }]);
    const marks = (window as unknown as { AGSTATUS_MARKS: { ICON: Record<string, string> } }).AGSTATUS_MARKS.ICON;
    const path = (svg: string) => /<path d="([^"]+)"/.exec(svg)![1];
    expect(meta(b, 's').querySelector('.meta-agent svg path')!.getAttribute('d')).toBe(path(marks[icon]));
    expect(document.querySelector('.usage-name svg path')!.getAttribute('d')).toBe(path(marks[icon]));
  });

  it('names a usage block and its thirty days by the same rule', async () => {
    const b = await boardOf([at('g', 1, { source: 'gemini' }), at('k', 2, { source: 'constructor' })]);
    b.emit('usage', [
      { source: 'gemini', windows: [{ id: 'daily', label: 'Daily', usedPct: 10 }] },
      { source: 'constructor', windows: [{ id: 'daily', label: 'Daily', usedPct: 20 }] },
    ]);
    // By key, as iOS orders its heads, whatever order the usage came in.
    expect([...document.querySelectorAll('.usage-name')].map((el) => el.textContent)).toEqual(['Constructor', 'Gemini']);
    location.hash = 'usage/constructor';
    await b.settle();
    await b.settle();   // openDetail awaits a fetch before it paints
    expect(document.querySelector('#detail .dv-title')!.textContent).toBe('Constructor · last 30 days');
  });
});

// jsdom lays nothing out, so the stylesheets are held to what the browser
// needs from them, as pages.test.ts holds the card's.
describe('the stylesheets behind the sections and the bar', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', 'public', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (css: string, selector: string) => {
    const m = new RegExp(`\\n${selector.replace(/[.()[\]:>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`no rule for ${selector}`);
    return m[1];
  };
  const board = read('board.css');
  const shell = read('shell.css');

  it('sticks each label to the top on the page\'s own opaque ground, over the cards', () => {
    const r = rule(board, '.section-label');
    expect(r).toMatch(/position:\s*sticky/);
    expect(r).toMatch(/top:\s*0/);
    expect(r).toMatch(/background:\s*var\(--ink-950\)/);
    expect(r).toMatch(/z-index:\s*1\b/);
    expect(r).toMatch(/grid-column:\s*1 \/ -1/);
  });

  // A label's line is one line by its own line height, so a reader's own
  // (WCAG 1.4.12) gives the name a taller box rather than cutting off the
  // bottom of every letter; the token stays for a browser without lh.
  it('makes a label\'s line as tall as its own line height, so a reader\'s spacing cuts no letter', () => {
    const r = rule(board, '.section-line');
    expect(r).toMatch(/height:\s*var\(--label-line\);\s*height:\s*1lh;/);
    expect(r).toMatch(/overflow:\s*hidden/);
  });

  // A usage block's head is one line by its own line height, as a label's
  // is, so its count wraps out of sight until fitUsage takes it away, and a
  // reader's own spacing cuts no letter; the count is a label count, quiet.
  it('keeps a usage block\'s head to one line by its own line height, its count in the quiet ink', () => {
    const r = rule(board, '.usage-line');
    expect(r).toMatch(/flex-wrap:\s*wrap/);
    expect(r).toMatch(/height:\s*1lh;/);
    expect(r).toMatch(/overflow:\s*hidden/);
    const count = rule(board, '.usage-count');
    expect(count).toMatch(/color:\s*var\(--text-3\)/);
    expect(count).toMatch(/text-transform:\s*none/);
    expect(rule(board, '.section-count')).toMatch(/color:\s*var\(--text-3\)/);
  });

  // An agent with no plan limits says so where the meters would be, in the
  // count's face and quiet ink, and never in the landing page's sheet.
  it('sets "No plan limits reported" in the count\'s face and quiet ink', () => {
    const r = rule(board, '.usage-none');
    expect(r).toMatch(/color:\s*var\(--text-3\)/);
    expect(r).toMatch(/font-family:\s*var\(--font-ui\)/);
    expect(r).toMatch(/font-size:\s*var\(--t-xs\)/);
    expect(r).toMatch(/margin:\s*0/);
    expect(read('card.css')).not.toContain('usage-none');
  });

  // A name fitLabel has measured is cut by the script alone, in the middle:
  // CSS's own ellipsis, which only covers the moment before anything is
  // measured, put a second one at the end of a cut a fraction too wide.
  it('leaves a fitted label\'s cut to the script, with no ellipsis of CSS\'s own', () => {
    expect(rule(board, '.section-name')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(board, '.section-label.fitted .section-name')).toMatch(/text-overflow:\s*clip/);
  });

  // The landing page loads card.css without board.css or shell.css, and
  // must draw exactly what it drew.
  it('keeps the sections, the mark and the bar out of the sheet the landing page loads', () => {
    const card = read('card.css');
    for (const name of ['section-', 'meta-agent', 'usage-name', 'usage-line', 'usage-count', 'needs', 'is-ringed']) {
      expect(card, name).not.toContain(name);
    }
    const landing = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'landing.html'), 'utf8');
    expect(landing).not.toContain('board.css');
    expect(landing).not.toContain('shell.css');
  });

  // Focus that lands under the stuck label or the fixed bar is hidden from
  // the reader who moved it there (WCAG 2.4.11).
  it('keeps whatever is scrolled into view clear of the stuck label and the bar', () => {
    expect(rule(board, 'html:has(body:not(.detail-open) .section-label)')).toMatch(/scroll-padding-top:\s*calc\(var\(--label-h\)/);
    expect(rule(shell, 'html:has(body.needs-up:not(.detail-open))')).toMatch(/scroll-padding-bottom:\s*calc\(var\(--needs-h/);
    expect(rule(shell, 'body.needs-up:not(.detail-open)')).toMatch(/padding-bottom:\s*calc\(var\(--needs-h/);
  });

  // The chevron leans 2px in on focus (card.css), which put it on the ring's
  // edge. The rule outranks the lean by coming later at the same weight:
  // shell.css loads after card.css (index.html).
  it('rests the title\'s chevron while the title is ringed', () => {
    expect(rule(shell, '.card.is-ringed .name-more')).toMatch(/transform:\s*none/);
    expect(rule(read('card.css'), '.name-open:hover .name-more,\n.name-open:focus-visible .name-more'))
      .toMatch(/transform:\s*translateX\(2px\)/);
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(html.indexOf('/shell.css')).toBeGreaterThan(html.indexOf('/card.css'));
  });

  // The bar's session line is one line box, the name's, as a label's line
  // is. Left to its contents it ended where the deeper of its two boxes
  // did, and the place's, in the smaller face, ends 0.6px below the name's,
  // so a press that added or dropped the place moved the bar's top edge on
  // a phone. By its own line height, so a reader's own (WCAG 1.4.12) makes
  // it taller rather than cutting the name; the token for a browser without
  // lh. Nothing clips it.
  it('holds the bar\'s session line to the name\'s one line box, by its own line height', () => {
    const r = rule(shell, '.needs-what');
    expect(r).toMatch(/font-size:\s*var\(--t-md\)/);
    expect(r).toMatch(/height:\s*calc\(var\(--t-md\) \* var\(--lh-tight\)\);\s*height:\s*1lh;/);
    expect(r).not.toMatch(/overflow/);
    // The name is set at that size, and the place keeps its own smaller one.
    expect(rule(shell, '.needs-name')).toMatch(/font-size:\s*var\(--t-md\)/);
    expect(rule(shell, '.needs-where')).toMatch(/font-size:\s*var\(--t-sm\)/);
    expect(rule(shell, '.needs')).toMatch(/line-height:\s*var\(--lh-tight\)/);
  });

  // The button is the bar's place, and its face draws it: the words above
  // the safe-area inset, the ground running under it to the edge.
  it('fixes the bar to the bottom edge above the safe-area inset, at least 44px tall', () => {
    const r = rule(shell, '.needs');
    expect(r).toMatch(/position:\s*fixed/);
    expect(r).toMatch(/bottom:\s*0/);
    expect(r).toMatch(/min-height:\s*44px/);
    expect(r).toMatch(/padding:\s*0/);
    expect(r).toMatch(/background:\s*none/);
    expect(rule(shell, '.needs-face')).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  // One bar on every client: at rest it wears a blocked card's own surface
  // under a blocked card's own edge, as iOS's and Android's do. On a card's
  // neutral ground, 1.07:1 against the page, it was a line of text found by
  // reading it. Written as card.css writes them, against the bar's own
  // --state, and held to card.css's text here, so the two never drift.
  it('grounds the bar on a blocked card\'s own surface under its own edge, at either contrast', () => {
    const card = read('card.css');
    const r = rule(shell, '.needs');
    const drawn = rule(shell, '.needs-face');   // what the bar draws, inside it
    expect(r).toMatch(/--state:\s*var\(--st-blocked\);/);
    // card.css sets a blocked card's --state in one rule and draws it in another.
    const blocked = [...card.matchAll(/\n\.card\.status-blocked \{([^}]*)\}/g)].map((m) => m[1]).join('');
    const surface = /background:\s*([^;]+);/.exec(blocked)![1];
    expect(surface).toBe('color-mix(in oklab, var(--ink-900) 86%, var(--state))');
    expect(drawn).toContain(`background: ${surface};`);
    expect(blocked).toMatch(/border-color:\s*var\(--state-line\)/);
    const line = /--state-line:\s*([^;]+);/.exec(rule(card, '.card'))![1];
    expect(r).toContain(`--state-line: ${line};`);
    expect(drawn).toMatch(/border-top:\s*1px solid var\(--state-line\);/);
    // Increased contrast raises the edge as it raises a card's.
    const more = (css: string, selector: string) => new RegExp(
      `@media \\(prefers-contrast: more\\) \\{\\s*${selector.replace(/\./g, '\\.')} \\{\\s*--state-line:\\s*([^;]+);\\s*\\}`).exec(css)?.[1];
    expect(more(card, '.card')).toBe('oklch(from var(--state) l c h / 0.70)');
    expect(more(shell, '.needs')).toBe(more(card, '.card'));
  });

  // Under the pointer the verb lights and the ground holds: a ground a step
  // lighter takes the 12px red word under AA (4.27:1). And no glow, at rest
  // or under the pointer.
  it('answers the pointer with its verb, never a lighter ground or a glow', () => {
    for (const m of shell.matchAll(/([^{}]*\.needs[^{}]*)\{([^}]*)\}/g)) {
      expect(m[2], m[1].trim()).not.toMatch(/box-shadow|text-shadow|filter|blur/);
      if (m[1].includes(':hover')) expect(m[2], m[1].trim()).not.toMatch(/background|border/);
    }
    expect(rule(shell, '.needs:hover .needs-verb')).toMatch(/color:\s*var\(--text-1\)/);
  });

  // The beat is the bar's own arrival, run on its face alone: the button
  // keeps its box, and with it the page's padding and a press.
  it('beats by replaying the bar\'s arrival on its face, and on nothing else', () => {
    const arrival = /animation:\s*needs-in var\(--d-slow\) var\(--ease\) both/;
    expect(rule(shell, '.needs.entering')).toMatch(arrival);
    expect(rule(shell, '.needs-face.beat')).toMatch(arrival);
    const beating = [...shell.matchAll(/([^{}]*\.beat\b[^{}]*)\{/g)].map((m) => m[1].trim());
    expect(beating).toEqual(['.needs-face.beat']);
  });

  // The bar's focus ring is the button's outline, and a face in motion is a
  // layer of its own, which drew over it: with focus on the bar, the ring
  // went wherever the face rose over it, and from a quarter of a second into
  // a beat until its end it was gone (headless Chrome). Behind the button's
  // own paint, in the stacking context the fixed button makes, the face
  // stays over the page and under the ring.
  it('keeps the bar\'s focus ring over its face through a beat', () => {
    const face = rule(shell, '.needs-face');
    expect(face).toMatch(/position:\s*relative/);
    expect(face).toMatch(/z-index:\s*-1/);
    const button = rule(shell, '.needs');
    expect(button).toMatch(/position:\s*fixed/);
    expect(button).toMatch(/z-index:\s*2/);
    expect(button).toMatch(/background:\s*none/);
    expect(rule(shell, '.needs:focus-visible')).toMatch(/outline-offset:\s*-4px/);
  });

  // Motion for news only, and only on the compositor.
  it('moves the bar by transform alone, and the board stills it under reduced motion', () => {
    for (const name of ['needs-in', 'needs-out']) {
      const frames = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(shell)![1];
      expect(frames, name).toMatch(/transform/);
      expect(frames, name).not.toMatch(/\b(top|bottom|height|margin|padding)\s*:/);
    }
    expect(board).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*0\.01ms/);
  });
});
