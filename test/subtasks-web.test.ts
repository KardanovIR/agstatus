import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadBoard, session, online, type Board } from './board-harness';
import { PIN_TIME, pinnedSessions } from './fixtures/web/pinned-sessions';

/*
 * Subagents on the web board (1.7.0): the rows inside a card, the footer, the
 * WORKING reading, the session screen's subtasks section, and the promise
 * that a card without subagents is exactly the card 1.6.5 drew.
 *
 * Frames are the session JSON of docs/api.md: `subtasks` is optional, its
 * items are live and failed rows in start order, and its counts are exact.
 */

// 24 lowercase hex, as a 1.7.0 hook's agent keys are — and like them, a key
// can start with a digit, which is why the board cannot use SAFE for it.
const key = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(3);

type Item = { id: string; n: number; label: string; state: string; activity: string };
const item = (n: number, label: string, state: string, activity = ''): Item =>
  ({ id: key(n), n, label, state, activity });

const REVIEW: Array<[string, string, string]> = [
  ['review:hook', 'testing', 'Run hook tests with --no-file-parallelism'],
  ['review:listener', 'coding', 'Editing listener.ts'],
  ['review:product', 'planning', 'Searching: SubagentStop payload fields'],
  ['review:server', 'coding', 'Editing store.ts'],
  ['review:ios', 'coding', 'Editing SessionCardView.swift'],
  ['review:android', 'planning', 'Reading developer.android.com'],
  ['verify:hook', 'testing', 'Run the hook suite — 214 tests'],
  ['verify:server', 'testing', 'npm test -- store'],
  ['verify:web', 'coding', 'Editing card.css'],
  ['verify:privacy', 'planning', 'Search payloads for prompt text'],
];
const ten = (): Item[] => REVIEW.map(([label, state, activity], i) => item(i + 1, label, state, activity));

/** A `subtasks` block whose counts agree with its items, as the server's do. */
const block = (items: Item[], over: Record<string, unknown> = {}) => ({
  turnEnded: false,
  running: items.filter((x) => ['planning', 'coding', 'testing'].includes(x.state)).length,
  blocked: items.filter((x) => x.state === 'blocked').length,
  failed: items.filter((x) => x.state === 'failed').length,
  done: 15,
  items,
  ...over,
});

/** `items` with one subagent's fields changed. */
const set = (items: Item[], n: number, over: Partial<Item>) =>
  items.map((x) => (x.n === n ? { ...x, ...over } : x));

const card = (b: Board, id = 's1') => b.$(`.card[data-id="${id}"]`) as HTMLElement;
const rows = (b: Board, id = 's1') => b.$$(`.card[data-id="${id}"] .subs .sub`) as HTMLElement[];
const shown = (b: Board, id = 's1') => rows(b, id).map((r) => r.dataset.sub);
const slots = (b: Board, id = 's1') => rows(b, id).map((r) => `${r.dataset.slot}:${r.dataset.sub}`);
const foot = (b: Board, id = 's1') => b.$(`.card[data-id="${id}"] .sub-foot`) as HTMLElement | null;
const words = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A board showing s1 with the given block; machine m1 online, like the Focus tests. */
async function boardWith(sub: unknown, over: Record<string, unknown> = {}, opts = {}) {
  const b = await loadBoard(opts);
  b.emit('machines', online());
  b.emit('snapshot', [session({ subtasks: sub, ...over })]);
  return b;
}

/** An animation reporting it is over, delivered by hand: jsdom runs none. */
function ended(el: Element, name: string) {
  const e = el.ownerDocument.createEvent('Event');
  e.initEvent('animationend', true, true);
  (e as unknown as { animationName: string }).animationName = name;
  el.dispatchEvent(e);
}

/**
 * Every focus() the board makes from here on: on what, and with which
 * options. jsdom has no layout and so never scrolls, which leaves the
 * options as the only evidence of whether a browser would have.
 */
function focusCalls(b: Board) {
  const spy = vi.spyOn(b.dom.window.HTMLElement.prototype, 'focus');
  return () => spy.mock.calls.map(([opts], i) => ({ el: spy.mock.contexts[i] as HTMLElement, opts }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a card without subagents is the 1.6.5 card', () => {
  const PINNED = fs.readFileSync(path.join(__dirname, 'fixtures', 'web', 'cards-1.6.5.html'), 'utf8');

  async function pinnedBoard(subtasks?: unknown) {
    vi.useFakeTimers();
    vi.setSystemTime(PIN_TIME);
    const b = await loadBoard();
    b.emit('machines', [{ id: 'm1', name: 'Studio', online: true, since: PIN_TIME - 60_000 }]);
    b.emit('snapshot', pinnedSessions().map((s) => (subtasks === undefined ? s : { ...s, subtasks })));
    return b;
  }

  // cards-1.6.5.html is what master's board drew for these sessions,
  // byte for byte; see pinned-sessions.ts. Nothing about subagents may leak
  // into a card that has none: no hairline, no group, no class, no zero.
  it('draws the same markup, byte for byte', async () => {
    const b = await pinnedBoard();
    expect(b.grid().innerHTML).toBe(PINNED);
    expect(b.grid().classList.contains('has-subs')).toBe(false);
  });

  // An older server sends no key; a broken one must not cost the card.
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 42],
    ['an array', []],
    ['an object with no items', { done: 3 }],
    ['items that are not a list', { items: 'nope', done: 3 }],
    ['an empty list with nothing done', { turnEnded: true, running: 0, items: [], done: 0 }],
    ['a list of nothing usable', { items: [null, 7, { id: 'bad id!', label: 'x', state: 'coding' }, { id: key(1) }], done: 0 }],
  ])('treats %s as no subagents', async (_name, subtasks) => {
    const b = await pinnedBoard(subtasks);
    expect(b.grid().innerHTML).toBe(PINNED);
    expect(b.grid().classList.contains('has-subs')).toBe(false);
  });
});

describe('rows on a card', () => {
  it('shows three rows, oldest first, and counts the rest with the finished', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    expect(shown(b)).toEqual([key(1), key(2), key(3)]);
    expect(words(foot(b))).toBe('+7 more · 15 done');
    // Between the card's own line and its meta, under one group.
    const subs = b.$('.card[data-id="s1"] .subs')!;
    expect(subs.getAttribute('role')).toBe('group');
    expect(subs.getAttribute('aria-label')).toBe('Subagents');
    expect(subs.previousElementSibling!.className).toBe('message');
    expect(subs.nextElementSibling!.className).toBe('meta');

    // News about a row's activity moves nothing.
    b.emit('session', session({ subtasks: block(set(items, 2, { activity: 'Editing store.ts' })) }));
    expect(shown(b)).toEqual([key(1), key(2), key(3)]);
  });

  it('marks the grid while any card shows a block, and only then', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [session(), session({ id: 's2', name: 'Other', host: null })]);
    expect(b.grid().classList.contains('has-subs')).toBe(false);
    b.emit('session', session({ subtasks: block(ten().slice(0, 2)) }));
    expect(b.grid().classList.contains('has-subs')).toBe(true);
    b.emit('session', session());
    expect(b.grid().classList.contains('has-subs')).toBe(false);
  });

  it('gives a finished row\'s slot to the next hidden one, in place', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    expect(slots(b)).toEqual([`0:${key(1)}`, `1:${key(2)}`, `2:${key(3)}`]);
    b.emit('session', session({ subtasks: block(items.filter((x) => x.n !== 2), { done: 16 }) }));
    expect(slots(b)).toEqual([`0:${key(1)}`, `1:${key(4)}`, `2:${key(3)}`]);
    expect(words(foot(b))).toBe('+6 more · 16 done');
  });

  it('closes a slot nothing can take', async () => {
    vi.useFakeTimers();
    const items = ten().slice(0, 3);
    const b = await boardWith(block(items, { done: 0 }));
    expect(foot(b)).toBeNull();
    b.emit('session', session({ subtasks: block(items.filter((x) => x.n !== 1), { done: 1 }) }));
    expect(slots(b)).toEqual([`0:${key(2)}`, `1:${key(3)}`]);
    expect(words(foot(b))).toBe('1 done');
    expect(foot(b)!.tagName).toBe('DIV');   // a count, not a control
  });

  it('lets a hidden blocked subagent take the bottom-most slot that is not blocked', async () => {
    vi.useFakeTimers();
    let items = ten();
    const b = await boardWith(block(items));
    items = set(items, 7, { state: 'blocked', activity: 'Approve: npm test -- hook' });
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: block(items) }));
    expect(slots(b)).toEqual([`0:${key(1)}`, `1:${key(2)}`, `2:${key(7)}`]);

    // A second one cannot take the first's slot, so it takes the next one up.
    items = set(items, 9, { state: 'blocked', activity: 'Approve: Edit card.css' });
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook +1', subtasks: block(items) }));
    expect(slots(b)).toEqual([`0:${key(1)}`, `1:${key(9)}`, `2:${key(7)}`]);

    // Approved, a row keeps its slot until it finishes.
    items = set(items, 7, { state: 'testing', activity: 'Run the hook suite' });
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:review', subtasks: block(items) }));
    expect(slots(b)).toEqual([`0:${key(1)}`, `1:${key(9)}`, `2:${key(7)}`]);
  });

  it('draws blocked subagents first on a first drawing, in start order', async () => {
    vi.useFakeTimers();
    const items = set(ten(), 7, { state: 'blocked', activity: 'Approve: npm test -- hook' });
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:hook' });
    expect(shown(b)).toEqual([key(1), key(2), key(7)]);
    const blocked = rows(b)[2];
    expect(blocked.className).toContain('st-blocked');
    // Its mark is the card's solid blocked disc: state is never hue alone.
    expect(blocked.querySelector('.sub-st svg')!.getAttribute('fill')).toBe('currentColor');
  });

  it('is a real button per row, named for what it is doing', async () => {
    vi.useFakeTimers();
    const items = [item(1, 'Run the migration tests', 'testing', 'Run the store migration tests'), item(2, 'Draft notes', 'coding')];
    const b = await boardWith(block(items, { done: 0 }));
    const [first, second] = rows(b);
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('aria-label')).toBe('Run the migration tests, testing: Run the store migration tests');
    expect(second.getAttribute('aria-label')).toBe('Draft notes, coding');
    // Mark and word, both: the word is the row's second channel.
    expect(words(first.querySelector('.sub-st'))).toBe('testing');
    expect(first.querySelector('.sub-st svg')).not.toBeNull();
  });

  it('escapes what the hook sends, which comes from prompts', async () => {
    vi.useFakeTimers();
    const evil = '<img src=x onerror="alert(1)">';
    const b = await boardWith(block([item(1, `${evil} & "q"`, 'coding', evil)], { done: 0 }));
    const row = rows(b)[0];
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('.sub-label')!.textContent).toBe(`${evil} & "q"`);
    expect(row.querySelector('.sub-act')!.textContent).toBe(evil);
    expect(row.getAttribute('aria-label')).toBe(`${evil} & "q", coding: ${evil}`);
  });

  it('renders minimal-mode labels as sent, and an unknown state as planning', async () => {
    vi.useFakeTimers();
    const items = [item(3, 'Subagent 3', 'testing', 'Bash'), item(4, 'Subagent 4', 'researching', 'WebFetch')];
    const b = await boardWith(block(items, { done: 2 }));
    expect(rows(b).map((r) => r.querySelector('.sub-label')!.textContent)).toEqual(['Subagent 3', 'Subagent 4']);
    expect(rows(b)[1].className).toContain('st-planning');
    expect(words(rows(b)[1].querySelector('.sub-st'))).toBe('planning');
  });

  it('drops a malformed item and keeps the rest, and derives a count it lacks', async () => {
    vi.useFakeTimers();
    const good = ten().slice(0, 2);
    const b = await boardWith({
      turnEnded: false,
      items: [good[0], { id: 'has space', n: 9, label: 'x', state: 'coding' }, 'junk', { id: key(8), n: 8, state: 'coding' }, good[1]],
    });
    // The keyless item and the junk are gone; the one with a key but no label
    // takes the server's own fallback.
    expect(shown(b)).toEqual([key(1), key(8), key(2)]);
    expect(rows(b)[1].querySelector('.sub-label')!.textContent).toBe('Subagent 8');
    // No `done` sent means none to show; no `running` sent is counted.
    expect(foot(b)).toBeNull();
  });

  it('shows a count with nothing running until the turn is over', async () => {
    vi.useFakeTimers();
    const b = await boardWith({ turnEnded: false, running: 0, blocked: 0, failed: 0, done: 12, items: [] });
    expect(rows(b)).toHaveLength(0);
    expect(words(foot(b))).toBe('12 done');
    expect(b.grid().classList.contains('has-subs')).toBe(true);
  });

  it('keeps a failed row listed, then lets it go with the turn', async () => {
    vi.useFakeTimers();
    const items = [
      item(1, 'Run the migration tests', 'testing', 'Run the store migration tests'),
      item(2, 'Audit the Android strings', 'failed', 'Failed: API error (overloaded)'),
      item(3, 'Draft release notes', 'coding', 'Writing RELEASE-1.6.4.md'),
    ];
    const b = await boardWith(block(items, { done: 4 }));
    const failed = rows(b)[1];
    expect(failed.className).toContain('st-failed');
    expect(words(failed.querySelector('.sub-st'))).toBe('failed');
    expect(failed.querySelector('.sub-st svg')).not.toBeNull();

    // The parent's Stop while a background subagent runs: still listed.
    const after = [items[1], { ...items[2], state: 'testing' }];
    b.emit('session', session({ status: 'testing', message: '1 subagent still running', subtasks: block(after, { turnEnded: true, done: 5 }) }));
    expect(shown(b)).toEqual([key(2), key(3)]);

    // The turn is fully over: the server stops sending the block.
    b.emit('session', session({ status: 'done', message: 'Turn finished' }));
    expect(rows(b)).toHaveLength(0);
    expect(b.$('.card[data-id="s1"] .subs')).toBeNull();
  });
});

describe('focus on a row', () => {
  it('survives a repaint, and moves to the row that takes the slot when its own finishes', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    rows(b)[1].focus();
    b.emit('session', session({ subtasks: block(set(items, 2, { activity: 'Editing app.ts' })) }));
    expect((document.activeElement as HTMLElement).dataset.sub).toBe(key(2));

    // Subagent 2 finishes; 4 takes its slot, and focus with it rather than
    // dropping to <body>.
    b.emit('session', session({ subtasks: block(items.filter((x) => x.n !== 2), { done: 16 }) }));
    expect((document.activeElement as HTMLElement).dataset.sub).toBe(key(4));
    expect((document.activeElement as HTMLElement).dataset.slot).toBe('1');
  });

  // A frame is not the reader asking to go anywhere. The control found again
  // stands where the old one stood, so it gets focus without the scroll a
  // plain focus() brings: a reader who scrolled away from a focused row, or
  // a focused title, was pulled back to it by every frame about its card.
  it('gets focus back without moving the page', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    rows(b)[1].focus();
    const calls = focusCalls(b);
    b.emit('session', session({ subtasks: block(set(items, 2, { activity: 'Editing app.ts' })) }));
    // The heir to a finished row's slot, too.
    b.emit('session', session({ subtasks: block(items.filter((x) => x.n !== 2), { done: 16 }) }));
    expect(calls().map((c) => [c.el.dataset.sub, c.opts])).toEqual([
      [key(2), { preventScroll: true }],
      [key(4), { preventScroll: true }],
    ]);
    expect(document.activeElement).toBe(rows(b)[1]);
  });

  it('falls back to the footer, then the title, when nothing takes the slot', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    b.click(foot(b));                     // opened in place: ten rows
    rows(b)[9].focus();
    b.emit('session', session({ subtasks: block(items.slice(0, 9), { done: 16 }) }));
    expect(document.activeElement).toBe(foot(b));
    expect(foot(b)!.getAttribute('aria-expanded')).toBe('true');

    // Folded, with nothing hidden to take a closed slot and no footer
    // control: the title is always there.
    b.click(foot(b));
    b.emit('session', session({ subtasks: block(items.slice(0, 3), { done: 0 }) }));
    rows(b)[2].focus();
    b.emit('session', session({ subtasks: block(items.slice(0, 2), { done: 0 }) }));
    expect(document.activeElement).toBe(b.$('.card[data-id="s1"] [data-open]'));
  });
});

describe('the footer', () => {
  it('opens the list in place, folds it, and keeps focus through the next frame', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    const before = foot(b)!;
    expect(before.tagName).toBe('BUTTON');
    expect(before.getAttribute('aria-expanded')).toBe('false');

    before.focus();
    b.click(before);
    expect(rows(b)).toHaveLength(10);
    // The rows on show stay where they were; the rest follow in start order.
    expect(shown(b)).toEqual(items.map((x) => x.id));
    const open = foot(b)!;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(words(open)).toBe('Show less · 15 done');
    expect(document.activeElement).toBe(open);

    // A frame about this card repaints it; focus stays on the footer.
    b.emit('session', session({ message: 'Still running the workflow', subtasks: block(items) }));
    expect(foot(b)).not.toBe(open);
    expect(document.activeElement).toBe(foot(b));

    b.click(foot(b));
    expect(rows(b)).toHaveLength(3);
    expect(foot(b)!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(foot(b));
  });

  it('stays open through a list that shrinks to fit and grows again', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    b.click(foot(b));
    expect(rows(b)).toHaveLength(10);

    b.emit('session', session({ subtasks: block(items.slice(0, 3)) }));
    expect(rows(b)).toHaveLength(3);
    expect(words(foot(b))).toBe('15 done');
    expect(foot(b)!.tagName).toBe('DIV');

    b.emit('session', session({ subtasks: block(items) }));
    expect(rows(b)).toHaveLength(10);
    expect(words(foot(b))).toBe('Show less · 15 done');
  });

  it('says "Show less" alone when nothing is done', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten(), { done: 0 }));
    expect(words(foot(b))).toBe('+7 more');
    b.click(foot(b));
    expect(words(foot(b))).toBe('Show less');
  });
});

describe('WORKING: the turn is over and subagents still run', () => {
  const after = (items: Item[]) => session({
    status: 'testing', message: '2 subagents still running', subtasks: block(items, { turnEnded: true, done: 3 }),
  });
  const strip = () => [...document.querySelectorAll('#stats .stat')].map((s) => words(s));

  it('wears working, lifts its edge once, and has a strip slot only while it does', async () => {
    vi.useFakeTimers();
    const items = [item(1, 'Watch the Android CI build', 'testing', 'gh run watch 1841'), item(2, 'Sweep docs', 'coding', 'Editing docs.html')];
    const b = await boardWith(block(items, { done: 3 }), { status: 'planning', message: 'Reading the CI log' });
    expect(strip()).toEqual(['0 idle', '1 planning', '0 coding', '0 testing', '0 blocked', '0 done']);
    const el = card(b);
    ended(el, 'state-change');
    ended(el, 'card-in');

    b.emit('session', after(items));
    expect(card(b)).toBe(el);
    expect(el.className).toContain('status-working');
    expect(el.className).not.toContain('status-testing');
    expect(el.className).toContain('changed');
    expect(el.dataset.status).toBe('working');
    expect(el.querySelector('.badge')!.textContent).toBe('working');
    // Its own mark, the branch, not coding's: state is never hue alone, and
    // working has coding's colour.
    expect(el.querySelector('.card-state-row .state-mark')!.innerHTML).toContain('M2 8h4.2');
    expect(el.querySelector('.message')!.textContent).toBe('2 subagents still running');
    expect(strip()).toEqual(['0 idle', '0 planning', '0 coding', '0 testing', '1 working', '0 blocked', '0 done']);

    // The report turn's Stop: the server sends no block, the card is done.
    b.emit('session', session({ status: 'done', message: 'Turn finished' }));
    expect(el.className).toContain('status-done');
    expect(el.querySelector('.badge')!.textContent).toBe('done');
    expect(strip()).toEqual(['0 idle', '0 planning', '0 coding', '0 testing', '0 blocked', '1 done']);
  });

  it('is never worn by a blocked card, or with only blocked and failed rows', async () => {
    vi.useFakeTimers();
    const items = [item(1, 'verify:hook', 'blocked', 'Approve: npm test'), item(2, 'Sweep docs', 'coding')];
    const b = await boardWith(block(items, { turnEnded: true }), { status: 'blocked', message: 'Needs approval: verify:hook' });
    expect(card(b).dataset.status).toBe('blocked');

    const stuck = [item(1, 'verify:hook', 'failed', 'Failed'), item(2, 'Sweep docs', 'blocked', 'Approve: Edit')];
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: Sweep docs', subtasks: block(stuck, { turnEnded: true }) }));
    expect(card(b).dataset.status).toBe('blocked');
    b.emit('session', session({ status: 'done', message: 'Turn finished', subtasks: block([stuck[0]], { turnEnded: false }) }));
    expect(card(b).dataset.status).toBe('done');
  });

  it('never dims a card while a subagent runs, however long it has been quiet', async () => {
    vi.useFakeTimers();
    const old = Date.now() - 20 * 60_000;
    const items = [item(1, 'Watch the Android CI build', 'testing', 'gh run watch 1841')];
    const b = await boardWith(block(items, { turnEnded: true }), { status: 'testing', message: '1 subagent still running', updatedAt: old });
    expect(card(b).dataset.status).toBe('working');
    expect(card(b).classList.contains('stale')).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);   // the timer that dims quiet cards
    expect(card(b).classList.contains('stale')).toBe(false);

    // The same card with nothing live is a quiet active card, and dims.
    b.emit('session', session({ status: 'testing', message: 'npm test', updatedAt: old }));
    expect(card(b).classList.contains('stale')).toBe(true);
  });

  it('exempts a card whose own turn is still running too', async () => {
    vi.useFakeTimers();
    const old = Date.now() - 20 * 60_000;
    const b = await boardWith(block(ten().slice(0, 1), { done: 0 }), { status: 'planning', updatedAt: old });
    expect(card(b).dataset.status).toBe('planning');
    expect(card(b).classList.contains('stale')).toBe(false);
  });
});

describe('motion', () => {
  it('fades in a row that starts, and only that one', async () => {
    vi.useFakeTimers();
    const items = ten().slice(0, 2);
    const b = await boardWith(block(items, { done: 0 }));
    // A card's first paint has no news: nothing moves.
    expect(rows(b).some((r) => r.classList.contains('entering'))).toBe(false);

    b.emit('session', session({ subtasks: block(ten().slice(0, 3), { done: 0 }) }));
    expect(rows(b).map((r) => r.classList.contains('entering'))).toEqual([false, false, true]);

    // The class comes off when the animation says it is over.
    ended(rows(b)[2], 'row-in');
    expect(rows(b)[2].classList.contains('entering')).toBe(false);
  });

  it('moves a state cell into and out of blocked and into failed, and for nothing else', async () => {
    vi.useFakeTimers();
    let items = ten().slice(0, 3);
    const b = await boardWith(block(items, { done: 0 }));
    const changed = () => rows(b).map((r) => r.classList.contains('changed'));

    items = set(items, 3, { state: 'coding' });                 // planning → coding
    b.emit('session', session({ subtasks: block(items, { done: 0 }) }));
    expect(changed()).toEqual([false, false, false]);

    items = set(items, 2, { state: 'blocked', activity: 'Approve: Edit' });   // coding → blocked
    b.emit('session', session({ status: 'blocked', subtasks: block(items, { done: 0 }) }));
    expect(changed()).toEqual([false, true, false]);
    ended(rows(b)[1].querySelector('.sub-st')!, 'row-in');
    expect(changed()).toEqual([false, false, false]);

    items = set(items, 2, { state: 'testing', activity: 'npm test' });        // approved
    b.emit('session', session({ subtasks: block(items, { done: 0 }) }));
    expect(changed()).toEqual([false, true, false]);

    items = set(items, 1, { state: 'failed', activity: 'Stopped' });          // testing → failed
    b.emit('session', session({ subtasks: block(items, { done: 0 }) }));
    expect(changed()).toEqual([true, false, false]);
  });

  it('ticks a count that changed', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    b.emit('session', session({ subtasks: block(items.filter((x) => x.n !== 2), { done: 16 }) }));
    const done = b.$('.card[data-id="s1"] .n[data-count="done"]')!;
    const more = b.$('.card[data-id="s1"] .n[data-count="more"]')!;
    expect(done.classList.contains('ticked')).toBe(true);
    expect(more.classList.contains('ticked')).toBe(true);
    ended(done, 'tick');
    expect(done.classList.contains('ticked')).toBe(false);
  });

  it('replays nothing on a frame about another card', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [session({ subtasks: block(ten().slice(0, 1), { done: 0 }) }), session({ id: 's2', name: 'Other', host: null })]);
    b.emit('session', session({ subtasks: block(ten().slice(0, 2), { done: 0 }) }));
    const row = rows(b)[1];
    expect(row.classList.contains('entering')).toBe(true);
    ended(row, 'row-in');

    b.emit('session', session({ id: 's2', name: 'Other', host: null, message: 'something else' }));
    expect(rows(b)[1]).toBe(row);   // not repainted
    expect(row.classList.contains('entering')).toBe(false);

    // A repaint of this card about something else replays nothing either.
    b.emit('session', session({ message: 'new line', subtasks: block(ten().slice(0, 2), { done: 0 }) }));
    expect(rows(b)[1]).not.toBe(row);
    expect(rows(b).some((r) => r.classList.contains('entering'))).toBe(false);
  });
});

describe('phone rules', () => {
  it('shows two rows, and the footer opens the session screen; Back returns to it', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten()), {}, { phone: true });
    expect(rows(b)).toHaveLength(2);
    const f = foot(b)!;
    expect(words(f)).toBe('+8 more · 15 done');
    expect(f.hasAttribute('aria-expanded')).toBe(false);
    expect(f.getAttribute('title')).toBe('Opens the session screen');

    b.click(f);
    expect(b.hash()).toBe('#session/s1');
    await b.settle();
    await b.settle();
    expect(document.body.classList.contains('detail-open')).toBe(true);

    (document.getElementById('dv-back') as HTMLButtonElement).click();
    await b.settle();
    expect(document.activeElement).toBe(foot(b));
  });

  it('re-picks the rows when the window crosses the breakpoint', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten()), {}, { phone: false });
    expect(rows(b)).toHaveLength(3);
    b.click(foot(b));                       // opened in place on a wide window
    expect(rows(b)).toHaveLength(10);
    b.setPhone(true);
    expect(rows(b)).toHaveLength(2);        // never in place on a phone
    expect(foot(b)!.hasAttribute('aria-expanded')).toBe(false);
    b.setPhone(false);
    expect(rows(b)).toHaveLength(10);       // and the flag was kept
  });
});

describe('the session screen', () => {
  const blockedTen = () => set(ten(), 7, { state: 'blocked', activity: 'Approve: npm test -- hook' });
  const open = async (b: Board) => {
    await b.settle();
    await b.settle();   // openSession awaits the history fetch before the timeline
  };
  const screenRows = () => [...document.querySelectorAll('#dv-subs .sub')] as HTMLElement[];

  it('opens at a row, lit and focused, and Back returns to that row', async () => {
    vi.useFakeTimers();
    const items = blockedTen();
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:hook' });
    const row = rows(b)[2];
    expect(row.dataset.sub).toBe(key(7));
    b.click(row);
    expect(b.hash()).toBe(`#session/s1/${key(7)}`);
    await open(b);

    const arrived = document.querySelector(`#dv-subs [data-sub="${key(7)}"]`) as HTMLElement;
    expect(document.activeElement).toBe(arrived);
    expect(arrived.getAttribute('tabindex')).toBe('-1');
    expect(arrived.classList.contains('is-arrived')).toBe(true);
    expect(arrived.classList.contains('is-settled')).toBe(false);

    // A frame inside the two seconds repaints the row; it stays lit and focused.
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: block(set(items, 1, { activity: 'Rerun' })) }));
    const again = document.querySelector(`#dv-subs [data-sub="${key(7)}"]`) as HTMLElement;
    expect(again).not.toBe(arrived);
    expect(again.classList.contains('is-arrived')).toBe(true);
    expect(document.activeElement).toBe(again);

    await vi.advanceTimersByTimeAsync(2000);
    expect(again.classList.contains('is-settled')).toBe(true);
    // And a later repaint does not light it again.
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: block(set(items, 1, { activity: 'Rerun again' })) }));
    expect(document.querySelector(`#dv-subs [data-sub="${key(7)}"]`)!.classList.contains('is-arrived')).toBe(false);

    (document.getElementById('dv-back') as HTMLButtonElement).click();
    await b.settle();
    expect(document.activeElement).toBe(b.$(`.card[data-id="s1"] [data-sub="${key(7)}"]`));
  });

  // The arrived row keeps focus for the whole visit, so every frame that
  // repaints the section finds it again. A plain focus() scrolled it back
  // into view each time, and the timeline below it could not be read while
  // subagents ran.
  it('leaves the page where the reader scrolled it through the frames that follow', async () => {
    vi.useFakeTimers();
    const items = blockedTen();
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:hook' });
    b.click(rows(b)[2]);
    await open(b);
    const calls = focusCalls(b);
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: block(set(items, 1, { activity: 'Rerun' })) }));
    await vi.advanceTimersByTimeAsync(2000);
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: verify:hook', subtasks: block(set(items, 2, { activity: 'Rerun' })) }));
    expect(document.activeElement).toBe(document.querySelector(`#dv-subs [data-sub="${key(7)}"]`));
    expect(calls().map((c) => [c.el.dataset.sub, c.opts])).toEqual([
      [key(7), { preventScroll: true }],
      [key(7), { preventScroll: true }],
    ]);
  });

  it('hands focus to Back when the row it arrived at finishes', async () => {
    vi.useFakeTimers();
    const items = blockedTen();
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:hook' });
    b.click(rows(b)[2]);
    await open(b);
    expect((document.activeElement as HTMLElement).dataset.sub).toBe(key(7));

    // Approved and finished. No other row here can hold focus, so it goes
    // where a screen whose subtask had already gone opens: Back, not <body>.
    const calls = focusCalls(b);
    const after = items.filter((x) => x.n !== 7);
    b.emit('session', session({ status: 'planning', message: 'Running the review-and-verify workflow', subtasks: block(after, { done: 16 }) }));
    expect(screenRows()).toHaveLength(9);
    const back = document.getElementById('dv-back');
    expect(document.activeElement).toBe(back);
    expect(calls().map((c) => [c.el, c.opts])).toEqual([[back, { preventScroll: true }]]);

    // And stays there: the next frame is not about focus.
    b.emit('session', session({ status: 'planning', message: 'Running the review-and-verify workflow', subtasks: block(set(after, 1, { activity: 'Rerun' }), { done: 16 }) }));
    expect(document.activeElement).toBe(back);
  });

  // The news a card's rows move for moves the screen's rows too, as in the
  // approved prototype: a row that starts, a state cell into or out of
  // blocked or into failed, a done count that changed. Its first paint, like
  // a card's, has no news.
  it('moves what is news, as a card does', async () => {
    vi.useFakeTimers();
    const items = ten().slice(0, 3);
    const b = await boardWith(block(items, { done: 2 }));
    b.tap('s1', 'open');
    await open(b);
    const row = (n: number) => document.querySelector(`#dv-subs [data-sub="${key(n)}"]`) as HTMLElement;
    const moving = () => screenRows().filter((r) => /\b(entering|changed)\b/.test(r.className)).map((r) => r.dataset.sub);
    expect(moving()).toEqual([]);

    // One starts, one is blocked, one goes planning → coding, one more is done.
    let next = set(set(items, 2, { state: 'blocked', activity: 'Approve: Edit listener.ts' }), 3, { state: 'coding', activity: 'Editing hooks.json' });
    next = [...next, item(4, 'review:server', 'coding', 'Editing store.ts')];
    b.emit('session', session({ status: 'blocked', message: 'Needs approval: review:listener', subtasks: block(next, { done: 3 }) }));
    expect(row(4).classList.contains('entering')).toBe(true);
    expect(row(2).classList.contains('changed')).toBe(true);
    expect(moving()).toEqual([key(2), key(4)]);
    const done = document.querySelector('#dv-subs .ss-done .n')!;
    expect(done.classList.contains('ticked')).toBe(true);

    // Off again when the animation says it is over.
    ended(row(4), 'row-in');
    ended(row(2).querySelector('.sub-st')!, 'row-in');
    ended(done, 'tick');
    expect(moving()).toEqual([]);
    expect(done.classList.contains('ticked')).toBe(false);

    // A section that comes back while the screen is open brings its rows in.
    b.emit('session', session({ status: 'done', message: 'Turn finished' }));
    expect(screenRows()).toHaveLength(0);
    b.emit('session', session({ status: 'planning', message: 'Plan the next step', subtasks: block(items.slice(0, 2), { done: 0 }) }));
    expect(moving()).toEqual([key(1), key(2)]);
  });

  it('opens at the top when the subtask has already gone', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items.slice(1)));
    // A link, or the browser's back button, to a subtask that has finished.
    location.hash = `session/s1/${key(1)}`;
    await open(b);
    expect(document.body.classList.contains('detail-open')).toBe(true);
    expect(screenRows()).toHaveLength(9);
    expect(document.activeElement).toBe(document.getElementById('dv-back'));
    expect(document.querySelector('#dv-subs .is-arrived')).toBeNull();
    expect(document.querySelector('#dv-subs [tabindex]')).toBeNull();

    // No click recorded an opener, so Back lands on the title.
    (document.getElementById('dv-back') as HTMLButtonElement).click();
    await b.settle();
    expect(document.activeElement).toBe(b.$('.card[data-id="s1"] [data-open]'));
  });

  it('lists blocked first, counts each class apart, and heads the timeline', async () => {
    vi.useFakeTimers();
    const items = set(blockedTen(), 10, { state: 'failed', activity: 'Failed: overloaded' });
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:hook' });
    b.tap('s1', 'open');
    await open(b);

    expect(words(document.querySelector('#dv-subs .ss-label'))).toBe('Subtasks 8 running · 1 blocked · 1 failed');
    expect(words(document.querySelector('#dv-subs .ss-count'))).toBe('8 running · 1 blocked · 1 failed');
    const list = screenRows();
    expect(list.map((r) => r.dataset.sub)).toEqual([key(7), ...items.filter((x) => x.n !== 7).map((x) => x.id)]);
    // Plain list items: this is where a card's row leads, not a way onward.
    expect(list.every((r) => r.tagName === 'LI')).toBe(true);
    expect(document.querySelector('#dv-subs button')).toBeNull();
    expect(list.every((r) => !r.hasAttribute('tabindex'))).toBe(true);
    expect(list[0].getAttribute('aria-label')).toBe('verify:hook, blocked: Approve: npm test -- hook');
    expect(words(document.querySelector('#dv-subs .ss-done'))).toBe('15 done this turn');
    const head = document.getElementById('dv-tl-head')!;
    expect(head.hidden).toBe(false);
    expect(head.textContent).toBe('Timeline');
    expect(document.querySelectorAll('.tl-row')).toHaveLength(4);
    // The history and its note share the timeline part, which spaces them
    // with the detail's own gap (pages.test.ts pins the rule).
    const part = document.getElementById('dv-timeline')!;
    expect(part.className).toBe('dv-timeline');
    expect([...part.children].map((c) => c.className)).toEqual(['tl', 'dv-note']);
    // Opened from the title, focus is on Back, as before subagents.
    expect(document.activeElement).toBe(document.getElementById('dv-back'));
  });

  it('follows the live session without moving focus', async () => {
    vi.useFakeTimers();
    const items = ten();
    const b = await boardWith(block(items));
    b.tap('s1', 'open');
    await open(b);
    const back = document.getElementById('dv-back')!;
    const timeline = document.querySelector('.tl');
    expect(document.activeElement).toBe(back);

    b.emit('session', session({ subtasks: block(items.slice(0, 4), { done: 21 }) }));
    expect(screenRows()).toHaveLength(4);
    expect(words(document.querySelector('#dv-subs .ss-done'))).toBe('21 done this turn');
    expect(document.activeElement).toBe(back);
    expect(document.querySelector('.tl')).toBe(timeline);   // history is not repainted

    // The turn is over: the section goes, and the timeline's heading with it.
    b.emit('session', session({ status: 'done', message: 'Turn finished' }));
    expect(document.getElementById('dv-subs')!.innerHTML).toBe('');
    expect(document.getElementById('dv-tl-head')!.hidden).toBe(true);
    expect(document.activeElement).toBe(back);
  });

  it('shows the subtasks above a history that failed to load', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten()), {}, { history: 'fail' });
    b.tap('s1', 'open');
    await open(b);
    expect(screenRows()).toHaveLength(10);
    const error = [...document.querySelectorAll('#detail .dv-empty')].map((p) => p.textContent);
    expect(error).toEqual(["Could not load this session's history."]);
    // Back is there too: the error used to replace the whole screen.
    expect(document.getElementById('dv-back')).not.toBeNull();
    const subsAt = document.getElementById('dv-subs')!;
    const errorAt = document.querySelector('#detail .dv-empty')!;
    expect(subsAt.compareDocumentPosition(errorAt) & 4).toBe(4);   // DOCUMENT_POSITION_FOLLOWING
  });

  it('shows the subtasks above an empty history, and none for a session without them', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten().slice(0, 2), { done: 0 }), {}, { history: [] });
    b.tap('s1', 'open');
    await open(b);
    expect(screenRows()).toHaveLength(2);
    expect(document.querySelector('#dv-subs .ss-done')).toBeNull();
    expect(words(document.querySelector('#detail .dv-empty'))).toBe('No history yet. Events appear here as the agent works.');

    (document.getElementById('dv-back') as HTMLButtonElement).click();
    await b.settle();
    b.emit('session', session({ id: 's2', name: 'Plain', host: null }));
    b.tap('s2', 'open');
    await open(b);
    expect(document.getElementById('dv-subs')!.innerHTML).toBe('');
    expect(document.getElementById('dv-tl-head')!.hidden).toBe(true);
  });
});

describe('copy, as every client prints it', () => {
  it('pins the strings of the card and the screen', async () => {
    vi.useFakeTimers();
    const items = [
      ...ten().slice(0, 9),
      item(10, 'verify:privacy', 'blocked', 'Approve: Search payloads'),
      item(11, 'map:sizing', 'failed', ''),
    ];
    const b = await boardWith(block(items), { status: 'blocked', message: 'Needs approval: verify:privacy' });
    expect(words(foot(b))).toBe('+8 more · 15 done');
    b.click(foot(b));
    expect(words(foot(b))).toBe('Show less · 15 done');
    const states = rows(b).map((r) => words(r.querySelector('.sub-st')));
    expect(new Set(states)).toEqual(new Set(['planning', 'coding', 'testing', 'blocked', 'failed']));
    expect(rows(b).find((r) => r.dataset.sub === key(11))!.getAttribute('aria-label')).toBe('map:sizing, failed');

    b.tap('s1', 'open');
    await b.settle();
    await b.settle();
    expect(words(document.querySelector('#dv-subs .ss-count'))).toBe('9 running · 1 blocked · 1 failed');
    expect(words(document.querySelector('#dv-subs .ss-done'))).toBe('15 done this turn');
    expect(document.getElementById('dv-tl-head')!.textContent).toBe('Timeline');
  });

  it('counts only the classes that are present', async () => {
    vi.useFakeTimers();
    const b = await boardWith(block(ten().slice(0, 2), { done: 0 }));
    b.tap('s1', 'open');
    await b.settle();
    expect(words(document.querySelector('#dv-subs .ss-count'))).toBe('2 running');
  });
});
