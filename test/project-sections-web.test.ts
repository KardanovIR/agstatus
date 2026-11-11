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
  function layOut(b: Board, room: number) {
    const width = (el: Element) => {
      if (el.classList.contains('section-name')) return drawnLength(el.textContent!) * 10;
      if (el.classList.contains('section-count')) return (el as HTMLElement).hidden ? 0 : el.textContent!.length * 6;
      return 0;
    };
    const define = (proto: object, prop: string, get: (el: Element) => number) =>
      Object.defineProperty(proto, prop, { configurable: true, get() { return get(this as Element); } });
    define(b.win.Element.prototype, 'clientWidth', (el) => (el.classList.contains('section-line') ? room : 0));
    define(b.win.Element.prototype, 'scrollWidth', width);
    define(b.win.HTMLElement.prototype, 'offsetWidth', width);
    // A browser global the harness's window stub does not carry. No sheet is
    // loaded, so the gap between name and count reads as none.
    vi.stubGlobal('getComputedStyle', b.win.getComputedStyle.bind(b.win));
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
    expect(blocks.map((el) => el.querySelector('.usage-open')!.textContent!.replace('›', '').trim())).toEqual(['Claude', 'Codex']);
    const cardMark = (id: string) => meta(b, id).querySelector('svg path')!.getAttribute('d');
    expect(blocks[0].querySelector('.usage-name svg path')!.getAttribute('d')).toBe(cardMark('c'));
    expect(blocks[1].querySelector('.usage-name svg path')!.getAttribute('d')).toBe(cardMark('x'));
    expect(blocks[0].querySelector('.usage-name svg')!.getAttribute('aria-hidden')).toBe('true');
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

describe('the needs-you bar', () => {
  it('is absent while nothing is blocked, and done never counts', async () => {
    const b = await boardOf([at('a', 1, { homeProject: 'acme-api', status: 'done' }), at('c', 2, { homeProject: 'docs' })]);
    expect(bar().hidden).toBe(true);
    expect(bar().childElementCount).toBe(0);
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
    expect([...document.querySelectorAll('.usage-name')].map((el) => el.textContent)).toEqual(['Gemini', 'Constructor']);
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

  // The landing page loads card.css without board.css or shell.css, and
  // must draw exactly what it drew.
  it('keeps the sections, the mark and the bar out of the sheet the landing page loads', () => {
    const card = read('card.css');
    for (const name of ['section-', 'meta-agent', 'usage-name', 'needs', 'is-ringed']) {
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

  it('fixes the bar to the bottom edge above the safe-area inset, at least 44px tall', () => {
    const r = rule(shell, '.needs');
    expect(r).toMatch(/position:\s*fixed/);
    expect(r).toMatch(/bottom:\s*0/);
    expect(r).toMatch(/min-height:\s*44px/);
    expect(r).toMatch(/env\(safe-area-inset-bottom\)/);
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
