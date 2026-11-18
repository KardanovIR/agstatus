import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { JSDOM } from 'jsdom';

/*
 * The board script, run for real against the real shell.
 *
 * This used to drive a hand-written stub `document` whose elements held an
 * innerHTML string, on the argument that public/app.js only ever wrote whole
 * HTML strings. That stopped being true: the grid is reconciled by key now, so
 * it needs createElement, insertBefore and a live child list. The stub also
 * never exercised `paintFocus()` at all — its querySelector returned null, so
 * the function returned early every time and focus state was only ever read
 * back out of `renderFocus()`, which is the *other* producer of the same
 * markup. Half of what these tests are named for went unchecked.
 *
 * So: jsdom, seeded from public/index.html rather than a fixture, which means
 * the suite now also fails if the page stops carrying an element app.js needs.
 * `window` and `location` stay stubbed — the board assigns location.hash, and
 * jsdom treats that as navigation.
 *
 * Shared since 1.7.0: review-fixes.test.ts drives Focus with it, and
 * subtasks-web.test.ts drives the subagent rows, which also need the phone
 * breakpoint and a history fetch that can fail.
 */

const PUBLIC = path.resolve(__dirname, '..', 'public');
const BOARD_SRC = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
// index.html loads this before app.js, and app.js reads it at definition time.
const MARKS_SRC = fs.readFileSync(path.join(PUBLIC, 'marks.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

/** The stream the board subscribed to, with a way to push one frame into it. */
export class FakeStream {
  private listeners = new Map<string, (e: { data: string }) => void>();
  /** Set by the board, as on a browser's EventSource. */
  onopen: (() => void) | null = null;
  addEventListener(type: string, fn: (e: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  emit(type: string, data: unknown): void {
    const fn = this.listeners.get(type);
    if (!fn) throw new Error(`the board is not listening for "${type}"`);
    fn({ data: JSON.stringify(data) });
  }
}

export const HOST = {
  machine: { id: 'm1', name: 'Studio' },
  app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
};

export const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Fix the parser',
  status: 'coding',
  message: 'editing src/app.ts',
  project: 'agstatus',
  updatedAt: Date.now(),
  host: HOST,
  ...over,
});

export const online = () => [{ id: 'm1', name: 'Studio', online: true, since: Date.now() }];

/** What GET /api/sessions/:id/history returns: SessionEvent[], newest first. */
export const HISTORY = [
  { seq: 3, status: 'done', message: 'Turn finished', at: 1_700_000_300_000 },
  { seq: 2, status: 'blocked', message: 'May I push to master?', at: 1_700_000_200_000 },
  { seq: 1, status: 'coding', message: 'editing src/app.ts', at: 1_700_000_100_000 },
  { seq: 0, status: 'planning', message: '', at: 1_700_000_000_000 },
];

export interface BoardOptions {
  /**
   * Stubs window.matchMedia, with `(max-width: 560px)` matching when true.
   * Left undefined, the board gets no matchMedia at all — the case it has to
   * read as wide — which is also what every test before 1.7.0 ran under.
   */
  phone?: boolean;
  /** What GET …/history answers: an event list (default HISTORY), or 'fail' for a 500. */
  history?: unknown[] | 'fail';
  /** What GET /api/usage/history answers, built when it is asked for. */
  usageHistory?: () => unknown;
  /**
   * The page the board runs in, as HTML: public/index.html unless given, as
   * when a browser takes an older release's page from its cache.
   */
  page?: string;
}

export type Board = Awaited<ReturnType<typeof loadBoard>>;

/** Evaluates public/app.js against a real DOM and returns the handles a test drives it by. */
export async function loadBoard(opts: BoardOptions = {}) {
  const dom = new JSDOM(opts.page ?? INDEX_HTML, { url: 'http://board.test/' });
  const doc = dom.window.document;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let stream: FakeStream | null = null;
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  vi.stubGlobal('document', doc);
  // Not dom.window: the board assigns location.hash, which jsdom treats as a
  // navigation it then refuses to perform. Only these four members are read.
  // Captured, so a hash assignment can fire hashchange the way a browser
  // does. The previous stub swallowed both, which meant the board's two hash
  // routes were never exercised by a test at all — a click set a property on
  // a plain object and nothing downstream ran.
  const listeners: Record<string, () => void> = {};
  const win: Record<string, unknown> = {               // marks.js writes AGSTATUS_MARKS onto this
    addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
  };
  // The phone breakpoint, as a MediaQueryList that a test can flip. jsdom has
  // no matchMedia of its own.
  let phone = Boolean(opts.phone);
  const mediaListeners: Array<() => void> = [];
  if (opts.phone !== undefined) {
    win.matchMedia = (query: string) => ({
      media: query,
      get matches() { return query === '(max-width: 560px)' && phone; },
      addEventListener(_type: string, fn: () => void) { mediaListeners.push(fn); },
      removeEventListener() {},
    });
  }
  vi.stubGlobal('window', win);
  // A browser global the board uses and the plain stub above does not carry.
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  let hash = '';
  vi.stubGlobal('location', {
    pathname: '/', origin: 'http://board.test', href: '',
    get hash() { return hash; },
    set hash(v: string) {
      // A browser normalises a bare fragment to one with '#', and leaves the
      // empty string empty rather than making it '#'.
      const next = v === '' ? '' : v.startsWith('#') ? v : `#${v}`;
      if (next === hash) return;
      hash = next;
      listeners.hashchange?.();
    },
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } });
  vi.stubGlobal('EventSource', class extends FakeStream {
    constructor(_url: string) { super(); stream = this; }
  });
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body || '' });
    if (url.endsWith('/api/config')) return reply({ mode: 'legacy', webhookUrl: 'http://board.test/webhook' });
    if (url.endsWith('/commands')) return reply({ id: JSON.parse(init!.body!).id, delivered: true });
    if (url.includes('/api/usage/history')) {
      return reply(opts.usageHistory ? opts.usageHistory() : { days: 30, history: [], projects: [] });
    }
    if (url.includes('/history')) {
      if (opts.history === 'fail') return { ok: false, status: 500, json: async () => ({}) };
      return reply(opts.history ?? HISTORY);
    }
    return reply({});
  });

  new Function(MARKS_SRC)();
  new Function(BOARD_SRC)();
  await vi.advanceTimersByTimeAsync(1);   // let init()'s /api/config settle and the stream open
  if (!stream) throw new Error('the board never opened its event stream');

  const gridEl = doc.getElementById('grid')!;
  return {
    dom,
    /** The DOM's own window, for the prototypes a test has to stand in for layout on. */
    win: dom.window,
    grid: () => gridEl,
    /** Element-level reads, now that there is a real tree to query. */
    $: (sel: string) => gridEl.querySelector(sel),
    $$: (sel: string) => [...gridEl.querySelectorAll(sel)],
    emit: (type: string, data: unknown) => stream!.emit(type, data),
    /** The stream's open, as a browser reports it. */
    open: () => stream!.onopen?.(),
    /** Any session event re-renders the grid, which is where focus state is readable. */
    repaint(over: Record<string, unknown> = {}) { stream!.emit('session', session(over)); return gridEl; },
    /** A real click on the real control, so aria-disabled is honoured as it is in a browser. */
    tap(id: string, kind: 'focus' | 'resume' | 'dismiss' | 'open') {
      const sel = kind === 'dismiss'
        ? `[data-dismiss="${id}"]`
        : kind === 'open'
          ? `[data-open="${id}"]`
          : `[data-focus="${id}"][data-type="${kind}"]`;
      const btn = gridEl.querySelector(sel);
      if (!btn) throw new Error(`no ${kind} control on the card for ${id}`);
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    /** A real click on any element, for the controls `tap` does not name. */
    click(el: Element | null) {
      if (!el) throw new Error('nothing to click');
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    /** Crosses the phone breakpoint, and tells whoever subscribed to it. */
    setPhone(v: boolean) {
      phone = v;
      for (const fn of mediaListeners) fn();
    },
    hash: () => hash,
    settle: () => vi.advanceTimersByTimeAsync(1),
    lastCommandId: () => JSON.parse(calls.filter((c) => c.url.endsWith('/commands')).pop()!.body).id as string,
    calls,
  };
}
