import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { configFromEnv } from '../src/config';
import { makeApp } from './helpers';

describe('configFromEnv hardening', () => {
  it('TRUST_PROXY only enables on "1" or "true"', () => {
    expect(configFromEnv({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(configFromEnv({}).trustProxy).toBe(false);
  });

  it('invalid SESSION_TTL_MS falls back to the mode default instead of NaN', () => {
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(0);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: ' ' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '-5' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '5000' }).sessionTtlMs).toBe(5000);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '0' }).sessionTtlMs).toBe(0);
  });

  it('invalid MAX_WORKSPACES falls back to the default', () => {
    expect(configFromEnv({ MAX_WORKSPACES: 'lots' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '0' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '50' }).maxWorkspaces).toBe(50);
  });

  it('COMMAND_TTL_MS must be whole milliseconds of at least a second, else the default', () => {
    for (const bad of ['soon', '0', '1', '0.5', '999', '1500.5', '-120000']) {
      expect(configFromEnv({ COMMAND_TTL_MS: bad }).commandTtlMs, bad).toBe(120_000);
    }
    expect(configFromEnv({ COMMAND_TTL_MS: '1000' }).commandTtlMs).toBe(1000);
    expect(configFromEnv({ COMMAND_TTL_MS: '30000' }).commandTtlMs).toBe(30_000);
  });
});

describe('global workspace cap', () => {
  it('creation returns 503 once maxWorkspaces is reached', async () => {
    const { app } = makeApp({ maxWorkspaces: 2 });
    await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(201);
    const res = await request(app).post('/api/workspaces').expect(503);
    expect(res.body.error).toMatch(/capacity/);
  });

  it('deleting a workspace frees capacity', async () => {
    const { app } = makeApp({ maxWorkspaces: 1 });
    const created = await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(503);
    await request(app).delete(`/w/${created.body.token}`).expect(200);
    await request(app).post('/api/workspaces').expect(201);
  });
});

describe('/api/config legacy fields', () => {
  it('legacy mode reports requiresSecret and webhookUrl', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('legacy');
    expect(res.body.requiresSecret).toBe(true);
    expect(res.body.webhookUrl).toBe('http://test.local/webhook');
  });

  it('legacy mode without a secret reports requiresSecret false', async () => {
    const { app } = makeApp({ multiTenant: false });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.requiresSecret).toBe(false);
  });

  it('multi mode omits webhookUrl and requiresSecret', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('multi');
    expect(res.body).not.toHaveProperty('requiresSecret');
    expect(res.body).not.toHaveProperty('webhookUrl');
  });
});

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
 */

const BOARD_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
// index.html loads this before app.js, and app.js reads it at definition time.
const MARKS_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'marks.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The stream the board subscribed to, with a way to push one frame into it. */
class FakeStream {
  private listeners = new Map<string, (e: { data: string }) => void>();
  addEventListener(type: string, fn: (e: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  emit(type: string, data: unknown): void {
    const fn = this.listeners.get(type);
    if (!fn) throw new Error(`the board is not listening for "${type}"`);
    fn({ data: JSON.stringify(data) });
  }
}

const HOST = {
  machine: { id: 'm1', name: 'Studio' },
  app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
};
const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Fix the parser',
  status: 'coding',
  message: 'editing src/app.ts',
  project: 'agstatus',
  updatedAt: Date.now(),
  host: HOST,
  ...over,
});
const online = () => [{ id: 'm1', name: 'Studio', online: true, since: Date.now() }];

/** What GET /api/sessions/:id/history returns: SessionEvent[], newest first. */
const HISTORY = [
  { seq: 3, status: 'done', message: 'Turn finished', at: 1_700_000_300_000 },
  { seq: 2, status: 'blocked', message: 'May I push to master?', at: 1_700_000_200_000 },
  { seq: 1, status: 'coding', message: 'editing src/app.ts', at: 1_700_000_100_000 },
  { seq: 0, status: 'planning', message: '', at: 1_700_000_000_000 },
];

/**
 * Evaluates public/app.js against a real DOM and returns the handles a test drives it by.
 * `usageHistory` is what GET /api/usage/history answers, built when it is asked for.
 */
async function loadBoard(opts: { usageHistory?: () => unknown } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://board.test/' });
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
  vi.stubGlobal('window', {                            // marks.js writes AGSTATUS_MARKS onto this
    addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
  });
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
    if (url.includes('/history')) return reply(HISTORY);
    return reply({});
  });

  new Function(MARKS_SRC)();
  new Function(BOARD_SRC)();
  await vi.advanceTimersByTimeAsync(1);   // let init()'s /api/config settle and the stream open
  if (!stream) throw new Error('the board never opened its event stream');

  const gridEl = doc.getElementById('grid')!;
  return {
    /** The DOM's own window, for the prototypes a test has to stand in for layout on. */
    win: dom.window,
    grid: () => gridEl,
    /** Element-level reads, now that there is a real tree to query. */
    $: (sel: string) => gridEl.querySelector(sel),
    $$: (sel: string) => [...gridEl.querySelectorAll(sel)],
    emit: (type: string, data: unknown) => stream!.emit(type, data),
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
    settle: () => vi.advanceTimersByTimeAsync(1),
    lastCommandId: () => JSON.parse(calls.filter((c) => c.url.endsWith('/commands')).pop()!.body).id as string,
    calls,
  };
}

// Read off the tree rather than off a serialization of it. The old versions
// regex-matched `class="focus-status"` out of an HTML string, which meant an
// assertion could pass for the wrong reason — `not.toContain('class="focus"')`
// below was already vacuous the moment that element gained a second class.
const statusText = (root: Element) => root.querySelector('.focus-status')?.textContent?.trim() ?? '';
const noteText = (root: Element) => root.querySelector('.focus-note')?.textContent?.trim() ?? '';
const resumeShown = (root: Element) => {
  const btn = root.querySelector('[data-type="resume"]');
  return Boolean(btn) && !btn!.hasAttribute('hidden');
};

describe('board script: focus lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // The 15s mark is a warning, not a verdict: a listener that was asleep can
  // still claim and ack well inside the server's 120s TTL, and the card that
  // said "is it asleep?" must accept that answer rather than discard it.
  it('keeps waiting past the 15s mark, so a slow ack still lands on the card', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    expect(statusText(b.repaint())).toBe('Sent…');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(statusText(b.repaint())).toContain('No answer from Studio yet');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused', reach: 'window' });
    expect(statusText(b.repaint())).toBe('Brought to front on Studio');
  });

  // And the give-up that follows is still the board's own guess: COMMAND_TTL_MS
  // belongs to whoever runs the board, so an ack that beats it wins anyway.
  it('gives up only near the command TTL, and a later ack still overrides it', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await vi.advanceTimersByTimeAsync(149_000);
    expect(statusText(b.repaint())).toContain('yet');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(statusText(b.repaint())).toBe('No answer from Studio — is it asleep?');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused', reach: 'window' });
    expect(statusText(b.repaint())).toBe('Brought to front on Studio');
  });

  // The `machines` frame lists only who is online, and it arrives again on every
  // reconnect: a machine missing from it is offline, never unknown.
  it('keeps a known offline machine across a reconnect re-seed', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.emit('machine', { id: 'm1', online: false, lastSeen: Date.now() });
    expect(noteText(b.grid())).toContain('Studio is offline');

    b.emit('machines', []);
    expect(noteText(b.grid())).toContain('Studio is offline');
    expect(b.grid().textContent).not.toContain('AgStatus listener');
  });

  it('turns a machine the reconnect frame no longer lists offline, keeping its name', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.emit('machines', []);   // it dropped while the stream was down
    expect(noteText(b.grid())).toBe('Studio is offline');
    expect(b.grid().textContent).not.toContain('AgStatus listener');
  });

  // Focus off posts `host: null`, which draws no focus row — so the entry behind
  // it has to go, or re-enabling Focus brings back the old tap's Resume button.
  it('drops focus state when the machine turns Focus off', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'failed', reason: 'not-running' });
    expect(resumeShown(b.repaint())).toBe(true);

    b.emit('session', session({ host: null }));
    expect(b.$$('.focus')).toHaveLength(0);

    b.emit('session', session());
    expect(statusText(b.grid())).toBe('');
    expect(resumeShown(b.grid())).toBe(false);
  });

  // The grid is reconciled by key, and the whole of board.css's motion rests on
  // that: a card that moves is supposed to have news. Reassigning the grid's
  // innerHTML — which is what this board did for its whole life — restarted
  // every card's entrance animation and cancelled every transition in flight,
  // on a frame about some other card.
  it('leaves a card it has no news about completely alone', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session(), session({ id: 's2', name: 'Other', host: null })]);

    const before = b.$$('.card');
    expect(before).toHaveLength(2);
    const quiet = before.find((c) => (c as HTMLElement).dataset.id === 's2')!;
    const quietName = quiet.querySelector('.name');

    // A frame about s1 only.
    b.emit('session', session({ message: 'now editing src/store.ts' }));

    const after = b.$$('.card');
    expect(after).toHaveLength(2);
    // Same elements, in both cases — not rebuilt, not replaced.
    expect(after.find((c) => (c as HTMLElement).dataset.id === 's2')).toBe(quiet);
    expect(quiet.querySelector('.name')).toBe(quietName);
    // ...and the card that did have news shows it.
    expect(b.$('.card[data-id="s1"] .message')!.textContent).toBe('now editing src/store.ts');
  });

  it('swaps the status class on the card it already has, and marks the change', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    const card = b.$('.card') as HTMLElement;
    expect(card.className).toContain('status-coding');

    b.emit('session', session({ status: 'blocked', message: 'needs approval' }));
    expect(b.$('.card')).toBe(card);
    expect(card.className).toContain('status-blocked');
    expect(card.className).not.toContain('status-coding');
    // `.changed` is what board.css animates; it is cleared on animationend,
    // which jsdom never fires, so seeing it here is exactly the assertion.
    expect(card.className).toContain('changed');
    expect(card.querySelector('.badge')!.textContent).toBe('blocked');

    // ...and clears when the animation reports it is over, which is the only
    // thing that lets the NEXT change re-trigger it. jsdom runs no animations,
    // so the event is delivered by hand; what is under test is the handler.
    const end = (name: string) => {
      const e = card.ownerDocument.createEvent('Event');
      e.initEvent('animationend', true, true);
      (e as unknown as { animationName: string }).animationName = name;
      card.dispatchEvent(e);
    };
    end('state-change');
    expect(card.className).not.toContain('changed');
    end('card-in');
    expect(card.className).not.toContain('entering');

    // A second change re-arms it, which it could not do if the class had stuck.
    b.emit('session', session({ status: 'done', message: 'finished' }));
    expect(b.$('.card')).toBe(card);
    expect(card.className).toContain('changed');
  });

  // Four states that need nothing from you are quiet outlines and `blocked` is
  // solid, but the point of the marks is that there IS a second channel: the
  // board's design principle is that state is never carried by hue alone.
  it('gives every status its own mark, not just its own colour', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    const kinds = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];
    b.emit('snapshot', kinds.map((status, i) => session({ id: `s${i}`, status, host: null })));
    const marks = b.$$('.state-mark');
    expect(marks).toHaveLength(6);
    const shapes = new Set(marks.map((m) => m.innerHTML));
    expect(shapes.size).toBe(6);   // six statuses, six distinct drawings
    for (const m of marks) expect(m.getAttribute('aria-hidden')).toBe('true');
  });

  // A status this client does not know is a card that renders quietly, not a
  // render loop that stops. classList.add throws on a value with a space in
  // it, and the throw would be inside the loop that draws every other card.
  it('survives a status it has never heard of, and keeps drawing the rest', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [
      session({ id: 'a', status: 'rogue status', host: null }),
      session({ id: 'b', status: 'coding', host: null }),
    ]);

    expect(b.$$('.card')).toHaveLength(2);          // the good card still drew
    const odd = b.$('.card[data-id="a"]') as HTMLElement;
    expect(odd.className).not.toContain('status-');  // matched no rule
    expect(odd.dataset.status).toBe('rogue status'); // but the board kept the fact
    expect(odd.querySelector('.badge')!.textContent).toBe('rogue status');
    expect(odd.querySelector('.state-mark')).not.toBeNull();
    expect(b.$('.card[data-id="b"]')!.className).toContain('status-coding');
  });

  // The web board served no session timeline at all: the server has had
  // /api/sessions/:id/history since 1.2 and iOS has rendered it since, but a
  // click on a web card matched only [data-dismiss] and [data-focus] and fell
  // through. The landing page had to say "In the app, tap any session for its
  // timeline" to stay honest about it.
  describe('a card opens its own timeline', () => {
    const openCard = async (b: Awaited<ReturnType<typeof loadBoard>>) => {
      b.tap('s1', 'open');
      await b.settle();
      await b.settle();   // openSession awaits a fetch before it paints
    };

    it('makes the title a real control, not a click handler on the article', async () => {
      vi.useFakeTimers();
      const b = await loadBoard();
      b.emit('snapshot', [session()]);
      const open = b.$('[data-open]') as HTMLButtonElement;
      expect(open.tagName).toBe('BUTTON');
      // A name a screen reader can act on: what it is, then what it does.
      expect(open.getAttribute('aria-label')).toBe("Fix the parser — open this session's history");
      // The card's other controls are siblings, never inside the title, so
      // one can never swallow a press meant for another.
      expect(b.$('[data-dismiss]')!.closest('[data-open]')).toBeNull();
      expect(b.$('[data-focus]')!.closest('[data-open]')).toBeNull();
    });

    it('renders the timeline newest-first, one row per event', async () => {
      vi.useFakeTimers();
      const b = await loadBoard();
      b.emit('snapshot', [session()]);
      await openCard(b);

      const rows = [...document.querySelectorAll('.tl-row')];
      expect(rows).toHaveLength(HISTORY.length);
      expect(rows.map((r) => r.querySelector('.tl-status')!.textContent))
        .toEqual(['done', 'blocked', 'coding', 'planning']);
      // Each row carries its own state, so the dot and the word agree.
      expect(rows.map((r) => r.className)).toEqual([
        expect.stringContaining('status-done'),
        expect.stringContaining('status-blocked'),
        expect.stringContaining('status-coding'),
        expect.stringContaining('status-planning'),
      ]);
      // And its own mark, beside the word. The row used to carry the state in
      // the gutter dot and in the colour of that word, and nowhere else — two
      // carriers, both of them hue, on the one board whose second design
      // principle forbids exactly that.
      expect(rows.map((r) => Boolean(r.querySelector('.tl-status .state-mark'))))
        .toEqual([true, true, true, true]);
      // An event with no message renders no message element rather than one
      // that is empty.
      expect(rows[3].querySelector('.tl-msg')).toBeNull();
      expect(rows[0].querySelector('.tl-msg')!.textContent).toBe('Turn finished');
    });

    it('takes over the page and hands focus to Back, then gives it back', async () => {
      vi.useFakeTimers();
      const b = await loadBoard();
      b.emit('snapshot', [session()]);
      const open = b.$('[data-open]') as HTMLButtonElement;
      await openCard(b);

      expect(document.body.classList.contains('detail-open')).toBe(true);
      expect(document.activeElement).toBe(document.getElementById('dv-back'));

      (document.getElementById('dv-back') as HTMLButtonElement).click();
      await b.settle();
      expect(document.body.classList.contains('detail-open')).toBe(false);
      // Back on the control that opened it — not dumped at the top of the page.
      expect(document.activeElement).toBe(open);
    });

    it('survives a session id with the punctuation the server allows', async () => {
      // SESSION_ID_RE is [A-Za-z0-9._:-]; ':' is why the hash is not
      // encodeURIComponent'd, and '.' and ':' are why the focus-return
      // selector has to be a quoted attribute match.
      vi.useFakeTimers();
      const b = await loadBoard();
      const id = 'host:1.2-3_4';
      b.emit('snapshot', [session({ id })]);
      b.tap(id, 'open');
      await b.settle();
      await b.settle();
      expect(document.querySelectorAll('.tl-row')).toHaveLength(HISTORY.length);
      (document.getElementById('dv-back') as HTMLButtonElement).click();
      await b.settle();
      expect((document.activeElement as HTMLElement).dataset.open).toBe(id);
    });

    it('keeps the title focused across a repaint of its own card', async () => {
      // focusKey has to know about [data-open]: the button carries no
      // data-type, data-source or id, so without a branch for it the user is
      // dropped to <body> the next time anything about that card changes.
      vi.useFakeTimers();
      const b = await loadBoard();
      b.emit('snapshot', [session()]);
      const before = b.$('[data-open]') as HTMLButtonElement;
      before.focus();
      b.emit('session', session({ message: 'now editing src/store.ts' }));
      const after = b.$('[data-open]') as HTMLButtonElement;
      expect(after).not.toBe(before);          // the card really did repaint
      expect(document.activeElement).toBe(after);
    });
  });

  // paintFocus() patches the ack line in place rather than re-rendering the
  // grid, so the aria-live region keeps its identity and actually announces.
  // The old stub could not run this function at all.
  it('updates the ack line without rebuilding the card around it', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    const card = b.$('.card');
    const line = b.$('.focus-status');
    expect(line!.getAttribute('aria-live')).toBe('polite');

    b.tap('s1', 'focus');
    await b.settle();
    // Same nodes: no repaint happened, the text was written into them.
    expect(b.$('.card')).toBe(card);
    expect(b.$('.focus-status')).toBe(line);
    expect(statusText(b.grid())).toBe('Sent…');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused' });
    expect(b.$('.focus-status')).toBe(line);
    expect(line!.className).toBe('focus-status ok');
  });

  // Dismiss deletes on the spot, so it must not wait for the `remove` broadcast
  // to drop the focus entry: sessions are soft-deleted and come back.
  it('drops focus state when the card is dismissed', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'failed', reason: 'not-running' });
    expect(resumeShown(b.repaint())).toBe(true);

    b.tap('s1', 'dismiss');
    await b.settle();
    expect(b.calls.some((c) => c.method === 'DELETE')).toBe(true);

    b.emit('session', session());
    expect(statusText(b.grid())).toBe('');
    expect(resumeShown(b.grid())).toBe(false);
  });
});

describe('board script: the usage detail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const DAY = 86_400_000;
  /** The UTC day `offset` days from today, as the API keys it. */
  const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  const noon = (offset: number) => Date.parse(`${day(offset)}T12:00:00Z`);
  /** What the board prints for that day: its own dayLabel. */
  const label = (offset: number) => new Date(`${day(offset)}T00:00:00Z`)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Claude's three windows, as the server sorts them. "week" and "week_fable"
  // are the pair that used to draw as one blue line. A Codex window rides
  // along to show the chart keeps to its own agent.
  const usageHistory = () => ({
    days: 30,
    history: [
      { source: 'claude', windowId: 'session',
        points: [{ at: noon(-40), usedPct: 10 }, { at: noon(-2), usedPct: 58 }, { at: noon(0), usedPct: 34 }] },
      { source: 'claude', windowId: 'week', points: [{ at: noon(-40), usedPct: 20 }, { at: noon(0), usedPct: 62 }] },
      { source: 'claude', windowId: 'week_fable', points: [{ at: noon(-9), usedPct: 70 }, { at: noon(0), usedPct: 41 }] },
      { source: 'codex', windowId: 'week', points: [{ at: noon(-1), usedPct: 5 }] },
    ],
    projects: [
      { source: 'claude', project: 'agstatus', day: day(-3), tokens: 2_000_000 },
      { source: 'claude', project: 'docs', day: day(-3), tokens: 1_000_000 },
      { source: 'claude', project: 'agstatus', day: day(0), tokens: 500_000 },
    ],
  });
  const claudeUsage = () => [{
    source: 'claude',
    updatedAt: Date.now(),
    windows: [
      { id: 'session', label: 'Current session', usedPct: 34, resetsAt: null },
      { id: 'week', label: 'Weekly (all models)', usedPct: 62, resetsAt: null },
      { id: 'week_fable', label: 'Weekly (Fable)', usedPct: 41, resetsAt: null },
    ],
  }];

  // Theme.seriesColors' order and Theme.seriesStroke's patterns on iOS:
  // solid green, dashed blue, dotted lilac.
  const STYLES = [
    'stroke:var(--st-done)',
    'stroke:var(--st-coding);stroke-dasharray:4.25 5.25',
    'stroke:var(--st-planning);stroke-dasharray:0 4.5',
  ];

  async function openUsage(b: Awaited<ReturnType<typeof loadBoard>>) {
    location.hash = 'usage/claude';
    await b.settle();
    await b.settle();   // openDetail awaits a fetch before it paints
  }

  /**
   * jsdom lays nothing out, so the chart's box has no width, nothing can
   * measure a label, and the board draws no chart. This stands in for both,
   * the way a browser would answer.
   */
  function layOut(b: Awaited<ReturnType<typeof loadBoard>>, width: number, fontSize = 11) {
    Object.defineProperty(b.win.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.id === 'dv-plot' ? width : 0; },
    });
    b.win.HTMLCanvasElement.prototype.getContext = (() => ({
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    })) as never;
    vi.stubGlobal('getComputedStyle', () => ({
      fontSize: `${fontSize}px`, fontStyle: 'normal', fontWeight: '400', fontFamily: 'sans-serif',
    }));
  }

  it('gives each limit line its own pattern as well as its own colour, in the order iOS gives them', async () => {
    vi.useFakeTimers();
    const b = await loadBoard({ usageHistory });
    b.emit('snapshot', [session({ source: 'claude' })]);
    b.emit('usage', claudeUsage());
    layOut(b, 700);
    await openUsage(b);

    // The key is a sample of its line, pattern and all, ending on a whole
    // mark: three 6 px dashes, six dots, never a stub that reads as another
    // pattern. It is for eyes; the chart's own text names every window.
    const legend = document.querySelector('#detail .dv-legend')!;
    expect(legend.getAttribute('aria-hidden')).toBe('true');
    expect([...legend.querySelectorAll('.dv-key-id')].map((k) => k.textContent))
      .toEqual(['session', 'week', 'week_fable']);
    const samples = [...legend.querySelectorAll('.dv-swatch line')];
    expect(samples.map((l) => l.getAttribute('style'))).toEqual(STYLES);
    expect(samples.map((l) => [Number(l.getAttribute('x1')), Number(l.getAttribute('x2'))]))
      .toEqual([[0.875, 25.125], [1.375, 24.625], [1.75, 24.25]]);

    // The chart draws at its own width, one px to the px, so those are the
    // marks on screen at any width.
    const svg = document.querySelector('#dv-plot svg.dv-chart')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 700 \d+$/);

    // Each line the same as its key, and each laid over a casing of its own
    // path in the card's colour, so it holds where it crosses a bar.
    const lines = [...svg.querySelectorAll('.dv-line')];
    expect(lines.map((l) => l.getAttribute('style'))).toEqual(STYLES);
    for (const line of lines) {
      const casing = line.previousElementSibling!;
      expect(casing.getAttribute('class')).toBe('dv-case');
      expect(casing.getAttribute('d')).toBe(line.getAttribute('d'));
    }

    // The bars sit inside the plot. The last one, today's, was centred on its
    // right edge and ran half under "100%".
    const grid = svg.querySelector('.dv-grid')!;
    const left = Number(grid.getAttribute('x1'));
    const right = Number(grid.getAttribute('x2'));
    const bars = [...svg.querySelectorAll('.dv-bar')];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      const x = Number(bar.getAttribute('x'));
      expect(x).toBeGreaterThanOrEqual(left - 0.05);
      expect(x + Number(bar.getAttribute('width'))).toBeLessThanOrEqual(right + 0.05);
    }
  });

  it('marks a window with a single reading by its own shape, and keys it by that mark', async () => {
    // A board's first day of recording a window: one reading, today. Every
    // such reading sits on the same day, and a point cannot carry a pattern,
    // so a dot in the window's colour differed from the others by hue alone.
    // "week" has a second day and draws its line beside them.
    vi.useFakeTimers();
    const firstDay = () => ({
      ...usageHistory(),
      history: [
        { source: 'claude', windowId: 'session', points: [{ at: noon(0), usedPct: 34 }] },
        { source: 'claude', windowId: 'week', points: [{ at: noon(-1), usedPct: 20 }, { at: noon(0), usedPct: 62 }] },
        { source: 'claude', windowId: 'week_fable', points: [{ at: noon(0), usedPct: 41 }] },
      ],
    });
    const b = await loadBoard({ usageHistory: firstDay });
    b.emit('snapshot', [session({ source: 'claude' })]);
    b.emit('usage', claudeUsage());
    layOut(b, 700);
    await openUsage(b);

    const svg = document.querySelector('#dv-plot svg.dv-chart')!;
    expect(svg.querySelectorAll('circle')).toHaveLength(0);
    expect([...svg.querySelectorAll('.dv-line')].map((l) => l.getAttribute('style'))).toEqual([STYLES[1]]);

    // Each mark in its window's colour, over a casing of its own outline.
    const marks = [...svg.querySelectorAll('.dv-mark')];
    expect(marks.map((m) => m.getAttribute('style'))).toEqual(['fill:var(--st-done)', 'fill:var(--st-planning)']);
    for (const mark of marks) {
      const casing = mark.previousElementSibling!;
      expect(casing.getAttribute('class')).toBe('dv-mark-case');
      expect(casing.getAttribute('d')).toBe(mark.getAttribute('d'));
    }

    // A path is one absolute point and then relative steps, so with that
    // point taken off what is left is the shape alone: a circle for the
    // first window, a square for the third, and the same shape in the key.
    const shape = (d: string | null) => d!.replace(/^M[-\d.]+ [-\d.]+/, '');
    const [circle, square] = marks.map((m) => shape(m.getAttribute('d')));
    expect(circle).toBe('a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z');
    expect(square).toBe('h7.2v7.2h-7.2Z');

    // Each key is what the chart draws for its window: the mark while it has
    // a single reading, a sample of the line once it has two.
    const keys = [...document.querySelectorAll('#detail .dv-key')];
    expect(keys.map((k) => k.querySelector('.dv-key-id')!.textContent)).toEqual(['session', 'week', 'week_fable']);
    const [sessionKey, weekKey, fableKey] = keys;
    expect(shape(sessionKey.querySelector('.dv-swatch path.dv-mark')!.getAttribute('d'))).toBe(circle);
    expect(sessionKey.querySelector('.dv-swatch path')!.getAttribute('style')).toBe('fill:var(--st-done)');
    expect(weekKey.querySelector('.dv-swatch path')).toBeNull();
    expect(weekKey.querySelector('.dv-swatch line')!.getAttribute('style')).toBe(STYLES[1]);
    expect(shape(fableKey.querySelector('.dv-swatch path.dv-mark')!.getAttribute('d'))).toBe(square);
    expect(fableKey.querySelector('.dv-swatch path')!.getAttribute('style')).toBe('fill:var(--st-planning)');
  });

  it("grows a single reading's mark with the reader's text, as the plot grows", async () => {
    // At twice the board's 11 px type the plot is half as tall again, and so
    // is the mark: a reader who enlarges the text can still tell its shape.
    // The key's box grows by the same rule in CSS (.dv-swatch-mark).
    vi.useFakeTimers();
    const b = await loadBoard({
      usageHistory: () => ({
        ...usageHistory(),
        history: [{ source: 'claude', windowId: 'session', points: [{ at: noon(0), usedPct: 34 }] }],
      }),
    });
    b.emit('snapshot', [session({ source: 'claude' })]);
    layOut(b, 700, 22);
    await openUsage(b);

    const mark = document.querySelector('#dv-plot .dv-mark')!;
    expect(mark.getAttribute('d')!.replace(/^M[-\d.]+ [-\d.]+/, '')).toBe('a6 6 0 1 0 12 0a6 6 0 1 0 -12 0Z');
    expect(document.querySelector('#detail .dv-key .dv-swatch')!.getAttribute('class')).toBe('dv-swatch dv-swatch-mark');
  });

  it('says what the chart shows: the busiest day, and each window by its name', async () => {
    vi.useFakeTimers();
    const b = await loadBoard({ usageHistory });
    b.emit('snapshot', [session({ source: 'claude' })]);
    b.emit('usage', claudeUsage());
    await openUsage(b);

    expect([...document.querySelectorAll('#detail h3')].map((h) => h.textContent))
      .toEqual(['Tokens per day · 3.5M total', 'Where the tokens went']);
    expect([...document.querySelectorAll('#dv-spoken p, #dv-spoken li')].map((e) => e.textContent)).toEqual([
      `Claude tokens per day over the last 30 days. 3.5M tokens in total; the busiest day, ${label(-3)}, 3.0M.`,
      'Claude plan limit used, by day, over the last 30 days.',
      // Recorded from before the range began, so no "since".
      'Current session: 34% at the latest reading, 58% on the highest day.',
      'Weekly (all models): 62% at the latest reading, 62% on the highest day.',
      `Weekly (Fable), since ${label(-9)}: 41% at the latest reading, 70% on the highest day.`,
    ]);
  });

  /** The day table's column headers, as a screen reader names them. */
  const columns = () => [...document.querySelectorAll('#dv-days thead th')].map((th) => th.textContent!.trim());
  /** A row's cells, its day first, as a screen reader reads them across. */
  const cells = (row: Element) => [...(row as HTMLTableRowElement).cells].map((c) => c.textContent!.trim());

  it('names the windows once the usage frame lands, when the detail drew first', async () => {
    // Opened straight from its address, the detail can draw before the stream
    // has said what the board calls each window.
    vi.useFakeTimers();
    const b = await loadBoard({ usageHistory });
    await openUsage(b);
    const items = () => [...document.querySelectorAll('#dv-spoken li')].map((e) => e.textContent!.split(':')[0]);
    expect(items()).toEqual(['session', 'week', `week_fable, since ${label(-9)}`]);
    const box = document.querySelector<HTMLDetailsElement>('#detail details.dv-days')!;
    box.open = true;
    await b.settle();
    expect(columns()).toEqual(['Day', 'Tokens', 'session', 'week', 'week_fable']);

    b.emit('usage', claudeUsage());
    expect(items()).toEqual(['Current session', 'Weekly (all models)', `Weekly (Fable), since ${label(-9)}`]);
    // The table is named again too, inside a disclosure left as it was: open.
    expect(columns()).toEqual(['Day', 'Tokens', 'Current session', 'Weekly (all models)', 'Weekly (Fable)']);
    expect(document.querySelector('#detail details.dv-days')).toBe(box);
    expect(box.open).toBe(true);
  });

  it('gives every day\'s figures to a keyboard, a screen reader and a phone, not just to a mouse', async () => {
    // A bar's figure was only in its <title>, which needs a pointer to hover
    // it: no keyboard can, a phone never shows one, and the SVG is hidden from
    // screen readers. The figures are a table now, behind a disclosure.
    vi.useFakeTimers();
    const b = await loadBoard({
      usageHistory: () => {
        const h = usageHistory();
        h.history[0].points[2].usedPct = 34.5;   // as a Codex reading can be
        return h;
      },
    });
    b.emit('snapshot', [session({ source: 'claude' })]);
    b.emit('usage', claudeUsage());
    await openUsage(b);

    // Closed until asked: the chart is the reading, the table the lean-in. A
    // real <summary>, so Enter and Space open it without a handler, and it
    // follows the summaries in reading order.
    const box = document.querySelector<HTMLDetailsElement>('#detail details.dv-days')!;
    const summary = box.querySelector('summary')!;
    expect(box.open).toBe(false);
    expect(box.previousElementSibling!.id).toBe('dv-spoken');
    expect(summary.textContent!.trim()).toBe('Each day\'s figures');
    summary.dispatchEvent(new b.win.MouseEvent('click', { bubbles: true }));
    await b.settle();
    expect(box.open).toBe(true);

    const table = box.querySelector('table')!;
    expect(table.closest('[aria-hidden]')).toBeNull();
    expect(table.caption!.textContent).toBe('Claude by day over the last 30 days, newest first: '
      + 'tokens spent, and plan limit used as each day ended.');

    // Tokens and percentages in columns of their own, since they do not
    // convert. A window goes by its block's name, under its line's key.
    expect(columns()).toEqual(['Day', 'Tokens', 'Current session', 'Weekly (all models)', 'Weekly (Fable)']);
    const keys = [...table.querySelectorAll('thead svg.dv-swatch')];
    expect(keys.map((k) => k.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
    expect(keys.map((k) => k.querySelector('line')!.getAttribute('style'))).toEqual(STYLES);

    // A row a day, today first, each headed by its date.
    const rows = [...table.tBodies[0].rows];
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.cells[0].matches('th[scope="row"]'))).toBe(true);
    const row = (offset: number) => rows[-offset];
    // A reading prints as the board's block prints it, to a tenth where it
    // has one.
    expect(cells(row(0))).toEqual([label(0), '500K', '34.5%', '62%', '41%']);
    expect(cells(row(-2))).toEqual([label(-2), '0', '58%', '20%', '70%']);
    expect(cells(row(-3))).toEqual([label(-3), '3.0M', '10%', '20%', '70%']);
    // A day without a token says 0, quieter; one with tokens does not.
    expect(row(-2).cells[1].className).toBe('dv-nil');
    expect(row(-3).cells[1].className).toBe('');
    // Before the board first recorded a window, its cell is empty to the eye,
    // as its line has not started, and says why to a screen reader.
    expect(cells(row(-10))).toEqual([label(-10), '0', '10%', '20%', 'no reading']);
    expect(row(-10).cells[4].querySelector('.sr-only')!.textContent).toBe('no reading');
    expect(cells(row(-9))[4]).toBe('70%');

    // It fits here (jsdom lays nothing out), so it is no Tab stop.
    const wrap = document.getElementById('dv-days')!;
    expect(wrap.classList.contains('fits')).toBe(true);
    expect(wrap.hasAttribute('tabindex')).toBe(false);
  });

  it('scrolls a table too wide for its card inside the card, where a keyboard can reach it', async () => {
    vi.useFakeTimers();
    const b = await loadBoard({ usageHistory });
    // Six windows on a phone: the table needs 380 px and the card has 300.
    let tableWidth = 380;
    Object.defineProperty(b.win.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.id === 'dv-days' ? 300 : 0; },
    });
    Object.defineProperty(b.win.HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.id === 'dv-days' ? Math.max(300, tableWidth) : 0; },
    });
    await openUsage(b);
    const box = document.querySelector<HTMLDetailsElement>('#detail details.dv-days')!;
    const wrap = document.getElementById('dv-days')!;
    box.open = true;
    await b.settle();

    // It scrolls in its box (the box's state until measured, so it never
    // widens the page for a frame), and the box is a Tab stop named for what
    // it holds, because the table has nothing else to focus.
    expect(wrap.classList.contains('fits')).toBe(false);
    expect(wrap.getAttribute('tabindex')).toBe('0');
    expect(wrap.getAttribute('role')).toBe('region');
    expect(document.getElementById(wrap.getAttribute('aria-labelledby')!)).toBe(box.querySelector('summary'));

    // Measured again when the table changes: the usage frame renames its
    // columns. Now it fits, and stops scrolling, but a box that has focus
    // keeps its Tab stop rather than dropping the reader to <body>.
    wrap.focus();
    tableWidth = 280;
    b.emit('usage', claudeUsage());
    expect(wrap.classList.contains('fits')).toBe(true);
    expect(document.activeElement).toBe(wrap);
    expect(wrap.getAttribute('tabindex')).toBe('0');

    // Opened again without the focus, it is no Tab stop at all.
    wrap.blur();
    box.open = false;
    await b.settle();
    box.open = true;
    await b.settle();
    expect(wrap.classList.contains('fits')).toBe(true);
    expect(wrap.hasAttribute('tabindex')).toBe(false);
    expect(wrap.hasAttribute('role')).toBe(false);
  });

  it('offers no table when there is no figure to put in one', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();   // no tokens, no limit history
    await openUsage(b);
    expect(document.querySelector('#detail .dv-card')).not.toBeNull();
    expect(document.querySelector('#detail details')).toBeNull();
  });

  it('prints no tokens column for an agent that reported no tokens, rather than thirty zeros', async () => {
    // "0" would say none were spent. The card below says none were reported.
    vi.useFakeTimers();
    const b = await loadBoard({ usageHistory: () => ({ ...usageHistory(), projects: [] }) });
    b.emit('usage', claudeUsage());
    await openUsage(b);
    const box = document.querySelector<HTMLDetailsElement>('#detail details.dv-days')!;
    box.open = true;
    await b.settle();
    expect(box.querySelector('caption')!.textContent)
      .toBe('Claude by day over the last 30 days, newest first: plan limit used as each day ended.');
    expect(columns()).toEqual(['Day', 'Current session', 'Weekly (all models)', 'Weekly (Fable)']);
    expect(cells(box.querySelector('tbody tr')!)).toEqual([label(0), '34%', '62%', '41%']);
  });
});
