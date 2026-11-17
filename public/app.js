(() => {
  'use strict';

  const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];
  // What a card can wear, as against what the server sends. `working` is a
  // reading this page works out from a card's subagents (display(), below):
  // it never arrives as a status, in a frame or in history, because a shipped
  // app would draw a seventh status as idle.
  const DISPLAY_STATUSES = [...STATUSES, 'working'];
  // A subagent row's states. `failed` exists only on a row: a subagent that
  // finished without success stays listed until its parent's turn is over.
  const ROW_STATES = ['planning', 'coding', 'testing', 'blocked', 'failed'];
  const WORKING_STATES = new Set(['planning', 'coding', 'testing']);
  const ACTIVE_STATUSES = new Set(['planning', 'coding', 'testing', 'working']);
  // A working card that has heard nothing for this long is stale: most likely
  // a dead agent — killed mid-turn, an interrupted turn (which fires no Stop
  // hook), a machine gone to sleep — and sometimes one very long tool call. The
  // board cannot tell which, but it knows exactly how long it has heard
  // nothing, and the card says so (card.css, "Stale"). The iOS and Android
  // cards keep the same rule.
  const STALE_MS = 10 * 60 * 1000;
  // Phone rules for subagent rows: two of them, and a footer that opens the
  // session screen instead of expanding in place. The same breakpoint as
  // card.css's phone rules, so the two change together.
  const PHONE_QUERY = '(max-width: 560px)';
  // How long a row you arrived at stays lit on the session screen.
  const ARRIVAL_MS = 2000;

  // Workspace-aware base path: on /w/<token> (or a sub-path), all API calls
  // are prefixed with /w/<token>. Otherwise base is '' (legacy mode).
  const wsMatch = location.pathname.match(/^\/w\/(ags_[A-Za-z0-9_-]{32})(?:\/|$)/);
  const BASE = wsMatch ? `/w/${wsMatch[1]}` : '';

  const gridEl = document.getElementById('grid');
  const usageEl = document.getElementById('usage');
  const statsEl = document.getElementById('stats');
  const connEl = document.getElementById('conn');
  const footerEl = document.getElementById('footer');
  const urlEl = document.getElementById('webhook-url');
  const copyBtn = document.getElementById('copy-btn');
  const authEl = document.getElementById('auth-note');
  const detailEl = document.getElementById('detail');
  const needsEl = document.getElementById('needs');
  // What the bar draws, its ground, edge and words: the part that beats.
  const faceEl = document.getElementById('needs-face');
  const saidEl = document.getElementById('needs-said');

  let webhookUrl = '';
  const state = new Map();
  // Focus: listeners currently online (machine id → presence frame), and the
  // latest command each card is showing (session id → status). Both live
  // outside the DOM because the grid is re-rendered wholesale on every event.
  const machines = new Map();
  const focus = new Map();
  // Legacy boards can require X-Webhook-Secret on writes; this page never sends it.
  let requiresSecret = false;

  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const relTime = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  /** relTime's span without "ago": "14m", "2h", "1d" — what a stale card's "no update for" is followed by. */
  const age = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };

  /** The same span in words, "14 minutes", for a screen reader: "14m" can be read as a length. */
  const spokenAge = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    const [n, unit] = s < 3600 ? [Math.max(1, Math.floor(s / 60)), 'minute']
      : s < 86400 ? [Math.floor(s / 3600), 'hour']
        : [Math.floor(s / 86400), 'day'];
    return `${n} ${unit}${n === 1 ? '' : 's'}`;
  };

  const fmtTokens = (n) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  };

  /** A plan limit's reading as the board prints it: whole, or to a tenth where it has one. */
  const fmtPct = (pct) => `${pct % 1 ? pct.toFixed(1) : String(pct)}%`;

  /**
   * Every [data-ts] on the page, or inside one element, retimed: "14m ago", or
   * with data-form="age" "14m", or with data-form="spoken" "14 minutes".
   */
  function paintTimes(root) {
    (root || document).querySelectorAll('[data-ts]').forEach((el) => {
      const ts = Number(el.dataset.ts);
      const form = el.dataset.form;
      el.textContent = form === 'age' ? age(ts) : form === 'spoken' ? spokenAge(ts) : relTime(ts);
    });
  }

  // ---- Icons ----------------------------------------------------------------
  //
  // Defined in marks.js, which the landing page loads too — it draws the same
  // cards, and a second hand-drawn copy of these is exactly how public/ ended
  // up with two palettes. index.html loads marks.js before this file.
  //
  // The fallback is not decoration: if that script fails, every card still
  // renders and still names its state in the badge. It loses the second,
  // non-colour channel, which is worth a blank rather than a broken board.
  const { STATE_MARK = {}, STALE_MARK = '', ICON = {} } = window.AGSTATUS_MARKS || {};

  // Only a known status becomes a class or picks a mark. The server validates
  // the enum, but this is a string off the network going into classList.add,
  // which throws on anything containing a space — and a throw in the render
  // loop would take every card after this one down with it. The old code
  // interpolated it into a class attribute and could not throw; this can.
  //
  // An unrecognised status keeps its card, shows its own word in the badge and
  // simply matches no rule, which is the fallback tokens.css already describes:
  // an unknown should sit quiet rather than claim a state it is not in.
  //
  // Both take a display status, so `working` is a class and a mark too.
  const statusClass = (v) => (DISPLAY_STATUSES.includes(v) ? `status-${v}` : '');
  const stateMark = (v) => STATE_MARK[DISPLAY_STATUSES.includes(v) ? v : 'idle'] || '';

  // The agent behind a session or a usage block: its name, and its neutral
  // mark, the asterisk for Claude, the hexagon for Codex and the diamond for
  // any other (marks.js). A session from before `source` existed is Claude's.
  // Until 1.7.0 every agent that was not Codex wore Claude's asterisk.
  //
  // Named and marked by the rule every board keeps, so the bar, its voice and
  // a card's lead say the same words on each. Claude and Codex by name; any
  // other source keeps its own spelling with its first letter upper-cased,
  // "Gemini", "Codex-cli", as the hook names a session after its agent
  // (agentLabel), where the web used to print the bare lowercase id. Looked
  // up as the table's own key: a source is any lowercase word the server
  // accepts, and SOURCE_NAMES['constructor'] is Object's function, which the
  // bar printed. The mark goes by the source's start, for Claude as for
  // Codex, as on iOS and Android: a second Claude account tagged claude-work
  // is still Claude, where an exact match gave it the diamond.
  const SOURCE_NAMES = { claude: 'Claude', codex: 'Codex' };
  const agentKey = (source) => String(source || 'claude').toLowerCase();
  const agentName = (source) => {
    const key = agentKey(source);
    return Object.hasOwn(SOURCE_NAMES, key) ? SOURCE_NAMES[key] : key.charAt(0).toUpperCase() + key.slice(1);
  };
  const agentMark = (source) => {
    const key = agentKey(source);
    return (key.startsWith('claude') ? ICON.claude : key.startsWith('codex') ? ICON.codex : ICON.agent) || '';
  };
  /** A session's name, or its agent's where it has none: what the bar, its voice and a card's lead call it. */
  const sessionName = (s) => (typeof s.name === 'string' && s.name !== '' ? s.name : agentName(s.source));

  /**
   * What a screen reader calls a card: "Claude, Fix the login redirect", its
   * agent and then its name, now that Claude and Codex share sections; the
   * name alone where it is its agent's own name, compared exactly, so the
   * untitled Codex session at / is "Codex", never "Codex, Codex". The rule
   * iOS and Android read a card by.
   */
  const cardLead = (s) => {
    const agent = agentName(s.source);
    const name = sessionName(s);
    return name === agent ? name : `${agent}, ${name}`;
  };

  // ---- Painting -------------------------------------------------------------
  //
  // Nothing on this page assigns innerHTML directly any more. The board
  // repaints on every SSE frame and on a 15-second timer, and a repaint that
  // reports no change is a cancelled transition, a restarted entrance animation
  // and a dropped focus ring — paid for a frame about something else. The guard
  // is the rendered markup itself rather than a hand-kept signature: a
  // signature that forgets a field is a card that silently stops updating.

  const painted = new WeakMap();

  // Enough to find the same control again once its markup has been replaced.
  // Values that are not plainly safe in a selector get no key, and focus is
  // simply not restored — never an unescaped interpolation.
  const SAFE = /^[A-Za-z][\w-]*$/;
  // A subagent's key, as the server validates it, and a session id as the
  // server accepts one (SESSION_ID_RE in src/app.ts). Not SAFE: a key is hex
  // and can start with a digit. Every character either allows is safe inside
  // a quoted attribute selector, and none of them is a quote.
  const SUB_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
  const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  function focusKey(node) {
    const d = node.dataset || {};
    if (SAFE.test(d.type || '')) return `[data-type="${d.type}"]`;
    if (d.dismiss !== undefined) return '[data-dismiss]';
    if (d.open !== undefined) return '[data-open]';
    if (SUB_ID_RE.test(d.sub || '')) return `[data-sub="${d.sub}"]`;
    if (SESSION_ID_RE.test(d.foot || '')) return `[data-foot="${d.foot}"]`;
    // A usage head's button and the block it heads both carry the agent,
    // and the block, which takes no focus, comes first: so this key names
    // the element as well, or focus on a head fell to <body> whenever the
    // usage area was painted again (a count, a countdown).
    if (SAFE.test(d.source || '') && SAFE.test(node.localName)) return `${node.localName}[data-source="${d.source}"]`;
    if (SAFE.test(node.id || '')) return `#${node.id}`;
    return null;
  }

  // Where focus goes when its own control did not survive the repaint, in
  // order. A subagent row is often gone — finished, or displaced by a blocked
  // one — and focus left on a row nobody can see drops to <body>, which for a
  // keyboard user means starting again from the top of the page. So a row
  // falls back to whichever row holds its slot now, then the footer, then
  // the title; a footer that stopped being a control falls back to the title.
  function focusKeys(node) {
    const key = focusKey(node);
    if (!key) return [];
    const d = node.dataset;
    if (key === `[data-sub="${d.sub}"]`) {
      const slot = /^\d{1,2}$/.test(d.slot || '') ? [`.sub[data-slot="${d.slot}"]`] : [];
      return [key, ...slot, '[data-foot]', '[data-open]'];
    }
    if (key === `[data-foot="${d.foot}"]`) return [key, '[data-open]'];
    return [key];
  }

  function paint(el, html) {
    if (painted.get(el) === html) return false;
    const keys = el.contains(document.activeElement) ? focusKeys(document.activeElement) : [];
    el.innerHTML = html;
    painted.set(el, html);
    paintTimes(el);
    // The control found again stands where the old one stood, or beside it,
    // so getting focus back must not move the page. A plain focus() scrolls
    // the new node into view: a reader who had scrolled away from a focused
    // title was pulled back to it by every frame about its card, and on the
    // session screen, where the arrived row keeps focus for the whole visit,
    // by every frame at all.
    for (const key of keys) {
      const again = el.querySelector(key);
      if (again) { again.focus({ preventScroll: true }); break; }
    }
    return true;
  }

  // Live cards, keyed by session id: { el, inner }.
  const cards = new Map();

  // ---- The board's order ----------------------------------------------------
  //
  // Cards keep their place. The first paint is newest first; after that a
  // session the board has not seen goes on top, and every other card stays
  // where it was whatever it reports, blocked included. Until 1.7.0 the grid
  // re-sorted by last update on every frame, so the card under the reader's
  // eye jumped to the top on each tool call its agent made, and every card
  // above it moved down one. Android's SessionStore.stableOrder, ported:
  // the ids on show keep their order with fresh data, and the unseen ones
  // join at the top, newest first among themselves.
  //
  // Worked out from `state` on every render rather than kept in step with
  // each handler, so nothing that adds, replaces or drops a session can
  // leave the two disagreeing.
  let order = [];                  // session ids, top first
  // A card being dismissed: the card below it, and its index, so a DELETE
  // that fails puts it back where it was rather than on top as if new. The
  // card below, not the index, because frames arriving during the DELETE
  // shift indexes (Android's dismiss does the same).
  const returning = new Map();     // session id → { below: id | null, at }

  /** `state` in the board's order, which this brings up to date. */
  function arrange() {
    const kept = order.filter((id) => state.has(id));
    const known = new Set(kept);
    const unseen = [...state.values()].filter((s) => !known.has(s.id));
    const added = unseen.filter((s) => !returning.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    const next = [...added.map((s) => s.id), ...kept];
    for (const s of unseen) {
      const back = returning.get(s.id);
      if (!back) continue;
      returning.delete(s.id);
      const below = back.below === null ? next.length : next.indexOf(back.below);
      next.splice(below >= 0 ? below : Math.min(back.at, next.length), 0, s.id);
    }
    order = next;
    return order.map((id) => state.get(id));
  }

  // ---- Project sections -----------------------------------------------------
  //
  // The board is grouped by project (docs/design/project-sections.md): a
  // section per project under a label that sticks while its cards pass, the
  // sections in one fixed order, and inside each the board's own order,
  // filtered and never re-sorted, so a new session goes on top of its section.
  //
  // A project is the folder a session started in, which the server pins for
  // the session's life as `homeProject`, so a later cd never moves a card. A
  // server too old to send it leaves the live folder, `project`. A session
  // with no usable folder (realFolder) goes in No project, always last.
  //
  // The labels are full-row headings inside the one grid, not containers, so
  // no card ever changes parent: Focus (paintFocus), the history route's
  // focus return (sessionOpener) and the reconciler all keep finding cards
  // where they always were.

  // The hook's own test for a name nobody chose (plugin/scripts/agstatus-hook.js).
  const UUID_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // No usable folder name is '', so it cannot collide with a real section.
  const NO_PROJECT = '';

  /**
   * Whether a string can name a folder: a section, or the place a card says
   * it is. The rule the server's normalizeProject and every client hold a
   * name to: trimmed, it is not empty, not '/' or '.', and not a bare UUID.
   * Only the test trims. A name that passes is used exactly as it was sent,
   * so ' api' and 'api' are two folders, as they are on the disk.
   */
  const realFolder = (v) => {
    if (typeof v !== 'string') return false;
    const name = v.trim();
    return name !== '' && name !== '/' && name !== '.' && !UUID_NAME_RE.test(name);
  };

  /**
   * Which section a session's card is in, the wire contract's section key:
   * its pinned folder, else its live folder (a server too old to pin one),
   * else No project. The pinned one is held to the same rule as the live
   * one, so a value no client would draw cannot open a section here alone.
   */
  const sectionKey = (s) => (realFolder(s.homeProject) ? s.homeProject
    : realFolder(s.project) ? s.project : NO_PROJECT);

  /**
   * The order every client draws sections in: by name ignoring case, exact
   * case breaking a tie (AgStatus before agstatus), No project last. Never by
   * activity, state or arrival. Code-unit comparisons of the names lowered,
   * then of the names themselves, rather than localeCompare, whose answers
   * vary with the browser's locale and ICU: iOS and Android must reach the
   * same order from the same names.
   */
  function compareSections(a, b) {
    if (a === b) return 0;
    if (a === NO_PROJECT) return 1;
    if (b === NO_PROJECT) return -1;
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a < b ? -1 : 1;
  }

  /** The board's sessions as sections, in order: [{ key, sessions }]. */
  function sectionsOf(list) {
    const by = new Map();
    for (const s of list) {
      const key = sectionKey(s);
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(s);
    }
    return [...by.keys()].sort(compareSections).map((key) => ({ key, sessions: by.get(key) }));
  }

  // Live labels, keyed by section: { el }. Beside `cards`, never in it, so
  // no folder name can be taken for a session id.
  const labels = new Map();

  /**
   * A label's inside: the name in exact case and the count, on one line, and
   * nothing else, since a label is not a control (no mark, colour, limit,
   * token total or alarm). Heard as one heading, "acme-api, 3 sessions", so
   * a screen reader's headings list walks the projects. The line drawn for
   * the eye is hidden from it, because fitLabel may cut what it shows.
   */
  function labelHTML(key, count) {
    const sessions = `${count} session${count === 1 ? '' : 's'}`;
    const name = key === NO_PROJECT ? 'No project' : key;
    return `<span class="section-line" aria-hidden="true">`
      + `<span class="section-name" title="${escape(name)}">${escape(name)}</span>`
      + `<span class="section-count">${sessions}</span></span>`
      + `<span class="sr-only">${escape(name)}, ${sessions}</span>`;
  }

  // A name as the characters a reader sees: grapheme clusters, so a cut
  // never parts an accent from its letter (macOS often stores 'é' as 'e' and
  // a combining mark) or a family emoji into its people. Code points where a
  // browser has no Intl.Segmenter, which at least never halves a surrogate
  // pair.
  const graphemeSegmenter = (() => {
    try { return new Intl.Segmenter('und', { granularity: 'grapheme' }); } catch { return null; }
  })();
  const graphemes = (text) => (graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (g) => g.segment)
    : Array.from(text));

  // Widths as drawn, in fractions of a pixel. scrollWidth, clientWidth and
  // offsetWidth round to whole pixels, so a cut 278.42px wide passed for one
  // that fits a 278px line, and CSS then cut its end as well, a second
  // ellipsis on a name already cut in the middle.
  /** How wide an element's contents are drawn, unclipped: its text and boxes, end to end. */
  function drawnWidth(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  }
  /** How much width an element has for them: its own box, on the boxes measured here, which have no padding or border. */
  const roomOf = (el) => el.getBoundingClientRect().width;

  /**
   * Fits a label to its one line, as iOS fits its own: where room runs short
   * the count goes first, before any letter of the name, and then the name is
   * cut in the middle, "agstatus-list…and-presence", keeping both ends, where
   * a folder's distinguishing part often is. Measured, because CSS can cut
   * text only at an end; cut between graphemes, never inside one. Once
   * measured, a label is `fitted`, and CSS no longer adds an ellipsis of its
   * own (board.css).
   *
   * Asked whenever a label is painted, and again when it changes size (the
   * window's width, or the reader's text size, which a label's height
   * follows) and when the webfonts arrive. Where nothing is laid out it has
   * no room to measure, and leaves the name whole for CSS to end-cut.
   */
  function fitLabel(el) {
    const line = el.querySelector('.section-line');
    const name = el.querySelector('.section-name');
    const count = el.querySelector('.section-count');
    const room = line ? roomOf(line) : 0;
    if (!room || !name || !count) return;
    el.classList.add('fitted');
    const full = name.getAttribute('title') || '';
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    const fits = (withCount) => drawnWidth(name) + (withCount ? gap + roomOf(count) : 0) <= room;
    // Read first: a label drawn whole that still fits needs no write, so a
    // window being resized lays the page out once for all of them, not once
    // for each.
    const whole = name.textContent === full && !count.hidden;
    if (whole && fits(true)) return;
    if (!whole) {
      name.textContent = full;
      count.hidden = false;
      if (fits(true)) return;
    }
    count.hidden = true;
    if (fits(false)) return;
    const chars = graphemes(full);
    const cut = (k) => `${chars.slice(0, Math.ceil(k / 2)).join('')}\u2026${
      chars.slice(chars.length - Math.floor(k / 2)).join('')}`;
    // The most characters that fit around the ellipsis, by halving.
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const k = Math.ceil((lo + hi) / 2);
      name.textContent = cut(k);
      if (fits(false)) lo = k; else hi = k - 1;
    }
    name.textContent = cut(lo);
  }

  /**
   * What a stuck label takes at the top of the window, measured as the bar's
   * height is (padForNeeds) and set on the root, whose scroll padding
   * (board.css) keeps whatever is scrolled into view clear of it: a control
   * taking focus, and the card the bar brings. A label is one line as tall
   * as its line height, and a reader's own line height (WCAG 1.4.12) makes
   * it taller than any token can say. Every label is as tall as the next;
   * the tallest of those that changed size is taken, from the observer
   * below, so a frame that draws no label measures none.
   */
  function padForLabels(els) {
    let h = 0;
    for (const el of els) h = Math.max(h, el.getBoundingClientRect().height);
    if (!h) return;   // not laid out: a screen over the board, say
    const root = document.documentElement;
    if (root.style.getPropertyValue('--label-h') !== `${h}px`) root.style.setProperty('--label-h', `${h}px`);
  }

  const labelSizes = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      padForLabels(entries.map((e) => e.target));
      for (const e of entries) fitLabel(e.target);
    })
    : null;
  // The webfonts change every width the fits measured, and on a cold load
  // they arrive after the board has drawn in the fallback face, which is
  // wider. Neither the labels', the bar's nor the usage heads' markup or
  // size changes with them, so nothing else would ask any to fit again:
  // the bar kept dropping its word and its project when both would fit.
  if (document.fonts && typeof document.fonts.addEventListener === 'function') {
    document.fonts.addEventListener('loadingdone', () => {
      for (const { el } of labels.values()) fitLabel(el);
      fitNeeds();
      for (const line of usageEl.querySelectorAll('.usage-line')) fitUsage(line);
    });
  }

  /**
   * The label for a section, made the first time it is drawn; and whether it
   * was painted. It arrives with its section's first card, and as that card
   * does: `arriving` when the card is new on the board, so the two rise in
   * together, and drawn in place when the card has moved here, out of No
   * project or, on a server too old to pin a folder, after a cd. The spec
   * draws that move without motion, and a label that rose over a card that
   * did not would be motion reporting nothing.
   */
  function labelFor(key, count, arriving) {
    let label = labels.get(key);
    if (!label) {
      const el = document.createElement('h2');
      el.className = `section-label${key === NO_PROJECT ? ' is-none' : ''}${arriving ? ' entering' : ''}`;
      if (key !== NO_PROJECT) el.dataset.section = key;
      const settle = (e) => { if (e.animationName === 'card-in') el.classList.remove('entering'); };
      el.addEventListener('animationend', settle);
      el.addEventListener('animationcancel', settle);
      if (labelSizes) labelSizes.observe(el);
      label = { el };
      labels.set(key, label);
    }
    return { el: label.el, painted: paint(label.el, labelHTML(key, count)) };
  }

  /** A label leaving the board, by section; or every one, with no key. */
  function dropLabels(key) {
    for (const [k, { el }] of labels) {
      if (key !== undefined && k !== key) continue;
      if (labelSizes) labelSizes.unobserve(el);
      el.remove();
      labels.delete(k);
    }
  }

  /** A message in place of the grid; clears the reconciler with it. */
  function setGridMessage(html) {
    cards.clear();
    dropLabels();
    gridEl.classList.remove('has-subs');
    paint(gridEl, html);
    renderNeeds();   // nothing blocked on a board with no cards
  }

  // ---- plan usage limit bars ------------------------------------------------

  let usage = [];

  const fmtReset = (ts) => {
    const s = Math.floor((ts - Date.now()) / 1000);
    if (s <= 0) return '';        // already reset — a countdown would be a lie
    if (s <= 60) return 'resets soon';
    // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
    const minutes = Math.round(s / 60);
    if (minutes < 60) return `resets in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const m = minutes % 60;
      return `resets in ${hours}h${m ? ` ${m}m` : ''}`;
    }
    const d = Math.floor(hours / 24);
    const h = hours % 24;
    return `resets in ${d}d${h ? ` ${h}h` : ''}`;
  };

  const usageLevel = (pct) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low');

  // On the board a limit's name and its reading wrap (shell.css), and these
  // are the two places they must not. A model name is one name: left to the
  // line breaker, a 320px phone read "SESSION (GPT-" over "6-ASTRA)". A
  // countdown is one reading: "resets in 2h" over "17m" says two hours, and
  // before narrow blocks stacked, a 640px window read "resets in 2d" over "5h"
  // at the default size.
  //
  // Held by the characters typesetting keeps for it, a non-breaking hyphen
  // and a no-break space, which draw exactly as the hyphen and space they
  // stand in for. A span around each run moved the glyphs after it by a
  // fraction of a pixel, at every width, wrapped or not.
  const meterName = (text) => escape(text).replace(/(\S)-(?=\S)/g, '$1\u2011');
  const meterReset = (text) => escape(text).replace(/(\d+[dhm]) (\d+[dhm])$/, '$1\u00a0$2');

  // The order iOS gives its heads (AgentSummary.make): by the agent's key,
  // compared by UTF-16 code unit, and never by activity, so a block stays
  // where it is while the same agents are on the board. Not the order the
  // usage arrives in: the server sorts it with localeCompare, which puts
  // claude_x before claude-x, and a block for an agent with no report has
  // no place in it at all.
  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function renderUsage() {
    // A block for every agent with sessions on the board, whether or not it
    // reports plan limits, as iOS gives each a head. An agent run on an API
    // key, with AGSTATUS_USAGE=off, from the shell hook or a raw post, or
    // any source such as gemini, reports none, and used to get no block: the
    // mark its cards wear explained nothing, and its session count showed
    // nowhere. Only agents with sessions, though: a Claude-only evening
    // doesn't need Codex bars. With no sessions there is nothing to
    // disambiguate, and the limits still matter between runs, so every
    // agent that reports limits gets one rather than nothing.
    //
    // Counted as well: every card an agent has on the board, done included,
    // which its block's name carries, as each client's head does.
    const sessions = new Map();
    for (const s of state.values()) {
      const source = s.source || 'claude';
      sessions.set(source, (sessions.get(source) || 0) + 1);
    }
    // Each agent's limits, from its report. A report with no windows, which
    // a tolerant reader lets through, is no report, as on iOS.
    const reports = new Map();
    for (const u of usage) {
      if (!reports.has(u.source) && Array.isArray(u.windows) && u.windows.length > 0) reports.set(u.source, u.windows);
    }
    const blocks = [];
    for (const source of [...(sessions.size > 0 ? sessions.keys() : reports.keys())].sort(byKey)) {
      const bars = (reports.get(source) || []).map((w) => {
        const pct = Math.min(100, Math.max(0, Number(w.usedPct) || 0));
        const reset = w.resetsAt ? fmtReset(w.resetsAt) : '';
        // board.css's .meter, which is what it was written for: "a percentage
        // of an unknown quota — never a token count". scaleX rather than width,
        // because width is a layout property and animating it relayouts the
        // block on every frame of the transition.
        return `
          <div class="meter">
            <div class="meter-head">
              <span class="meter-label">${meterName(w.label || w.id)}</span>
              <span class="meter-value">${fmtPct(pct)}${
                reset ? ` <span class="usage-reset">· ${meterReset(reset)}</span>` : ''
              }</span>
            </div>
            <div class="meter-track">
              <div class="meter-fill ${usageLevel(pct)}" style="transform:scaleX(${(pct / 100).toFixed(4)})"></div>
            </div>
          </div>`;
      });
      // One block per agent; the block header carries the source name, so the
      // rows inside it don't repeat it.
      // A REAL button inside the block, not role="button" on the block.
      // `button` is a children-presentational role in ARIA: putting it on the
      // section removed every descendant from the accessibility tree and
      // replaced the lot with the aria-label — so a screen reader got
      // "Claude usage detail, button" and not one of the percentages that are
      // the entire point of the block. The button stretches over the block
      // with an ::after overlay, so the whole card is still one big target and
      // the numbers stay readable as content.
      //
      // The name carries the agent's mark, the legend for the marks that lead
      // every card's meta line now that Claude and Codex share sections, and
      // beside it how many sessions the agent has on the board, "7
      // sessions", where that fits (fitUsage). The button is named for both,
      // "Claude, 7 sessions", as iOS names its head, so the count is heard
      // even where it is not drawn: one string, which no box can come
      // between, holding every word the button shows.
      //
      // An agent that reports no limits has the same block and the same
      // button, which opens its thirty days as any does, and in place of
      // the meters one line in the quiet ink, iOS's words for such a head.
      const name = agentName(source);
      const n = sessions.get(source) || 0;
      const count = n ? `${n} session${n === 1 ? '' : 's'}` : '';
      blocks.push(`
        <section class="usage-block" data-source="${escape(source)}">
          <h2 class="usage-src"><button class="usage-open" type="button" data-source="${escape(source)}"${
            count ? ` aria-label="${escape(`${name}, ${count}`)}"` : ''}
            ><span class="usage-line"><span class="usage-name">${agentMark(source)}${escape(name)}</span>${
              count ? `<span class="usage-count">${count}</span>` : ''}</span><span class="usage-more" aria-hidden="true">›</span></button></h2>
          ${bars.length > 0 ? bars.join('') : '<p class="usage-none">No plan limits reported</p>'}
        </section>`);
    }
    usageEl.hidden = blocks.length === 0;
    if (paint(usageEl, blocks.join(''))) {
      if (usageSizes) usageSizes.disconnect();
      for (const line of usageEl.querySelectorAll('.usage-line')) {
        if (usageSizes) usageSizes.observe(line);
        fitUsage(line);
      }
    }
  }

  /**
   * Fits a usage block's head to its one line, as a label is fitted: where
   * the agent's name and its session count do not both fit, the count goes
   * first, before any letter of the name, which CSS cuts at its end only
   * where the name alone does not fit (board.css), as iOS cuts it. Measured
   * as fitLabel measures, in fractions of a pixel, whenever the head is
   * painted, changes size, or the webfonts arrive.
   */
  function fitUsage(line) {
    const name = line.querySelector('.usage-name');
    const count = line.querySelector('.usage-count');
    const room = roomOf(line);
    if (!room || !name || !count) return;
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    const fits = () => drawnWidth(name) + gap + roomOf(count) <= room;
    if (!count.hidden && fits()) return;   // read first: no write for a head that fits
    count.hidden = false;
    count.hidden = !fits();
  }

  // A head's line keeps one line's height whatever the count does, so the
  // fit below never changes the size it answers to.
  const usageSizes = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => { for (const e of entries) fitUsage(e.target); })
    : null;

  // The six statuses always, even at zero. A legend that reflows every time a
  // count changes is movement reporting nothing, and this board animates only
  // when something actually happened — so the zeros recede instead of leaving.
  //
  // It counts what the cards WEAR, so one exception: `working`, a reading this
  // page works out rather than a status the server sends, has a slot only
  // while some card wears it. Without one the strip would stop summing to the
  // board; with a permanent one it would carry a seventh zero that no frame
  // can ever fill. It reshapes the row only when a card enters or leaves
  // WORKING, which is news.
  //
  // It also has to be unhidden. The markup carries `hidden` for the moment
  // before the first frame, and the old stylesheet's `.stats { display: flex }`
  // quietly outranked the UA's [hidden] rule, so it showed anyway. board.css
  // makes [hidden] `!important`, which is correct and would have hidden this
  // row for good.
  const STRIP = ['idle', 'planning', 'coding', 'testing', 'working', 'blocked', 'done'];
  function renderStats(list) {
    const counts = Object.fromEntries(DISPLAY_STATUSES.map((s) => [s, 0]));
    for (const s of list) {
      const shown = display(s);
      counts[shown] = (counts[shown] || 0) + 1;
    }
    paint(statsEl, STRIP
      .filter((st) => st !== 'working' || counts.working)
      .map((st) => `<span class="stat${counts[st] ? '' : ' zero'}">`
        + `<span class="dot status-${st}"></span><b>${counts[st]}</b> ${st}</span>`)
      .join(''));
    statsEl.hidden = list.length === 0;
  }

  function renderEmpty() {
    const example = webhookUrl || '/webhook';
    setGridMessage(`
      <div class="empty">
        <strong>No sessions yet</strong>
        Send a POST to <code>${escape(example)}</code> with JSON:<br><br>
        <code>{ "session_id": "abc", "name": "My task", "status": "coding", "message": "editing server.ts", "project": "dashboard" }</code>
      </div>`);
  }

  // ---- Subagents ------------------------------------------------------------
  //
  // A session's running subagents, listed inside its card (`subtasks` in the
  // session JSON, docs/api.md). The server keeps them and derives the card's
  // status and line from them; this page draws the rows, picks which fit, and
  // works out one reading of its own, WORKING.

  // Read once per session object: every frame replaces the session whole, so
  // the object is the cache key and an update can never be served stale.
  const subtaskCache = new WeakMap();

  /**
   * The session's subagent block, or null for "draw today's card".
   *
   * Tolerant per element, as both native apps are: a snapshot decodes as one
   * value, and a single bad item must never cost the board. A malformed item
   * is dropped and the others kept; a state this page does not know reads as
   * planning; a missing or malformed count falls back to the count of the
   * items it describes (0 for done, which no list can show). Absent, null, a
   * non-object, no item list, or an empty list with nothing done all mean
   * there is nothing to show.
   */
  function subtasksOf(s) {
    if (!s || typeof s !== 'object') return null;
    if (subtaskCache.has(s)) return subtaskCache.get(s);
    const raw = s.subtasks;
    let sub = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.items)) {
      const items = [];
      const seen = new Set();
      for (const x of raw.items) {
        // The key goes into a selector and keys the slot ledger, so it must
        // be well formed and unique; the label falls back as the server's own
        // does, and an item with neither has nothing to say.
        if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !SUB_ID_RE.test(x.id) || seen.has(x.id)) continue;
        const n = Number.isInteger(x.n) && x.n >= 1 ? x.n : 0;
        const label = typeof x.label === 'string' && x.label ? x.label : n ? `Subagent ${n}` : '';
        if (!label) continue;
        seen.add(x.id);
        items.push({
          id: x.id,
          label,
          state: ROW_STATES.includes(x.state) ? x.state : 'planning',
          activity: typeof x.activity === 'string' ? x.activity : '',
        });
      }
      const count = (v, derived) => (Number.isInteger(v) && v >= 0 ? v : derived);
      const done = count(raw.done, 0);
      if (items.length > 0 || done > 0) {
        sub = {
          turnEnded: raw.turnEnded === true,
          running: count(raw.running, items.filter((x) => WORKING_STATES.has(x.state)).length),
          blocked: count(raw.blocked, items.filter((x) => x.state === 'blocked').length),
          failed: count(raw.failed, items.filter((x) => x.state === 'failed').length),
          done,
          items,
        };
      }
    }
    subtaskCache.set(s, sub);
    return sub;
  }

  /**
   * What the card wears. The server's status, except one reading it never
   * sends: the parent's turn is over and its subagents still work, which is
   * not DONE (your turn) and not the parent coding either. A blocked card
   * stays blocked; the server already chose that over everything.
   */
  function display(s) {
    const sub = subtasksOf(s);
    return sub && sub.turnEnded && s.status !== 'blocked' && sub.running > 0 ? 'working' : s.status;
  }

  // Read through matchMedia, and wide when the browser has none to offer.
  const phoneQuery = typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
  const phoneRules = () => Boolean(phoneQuery && phoneQuery.matches);
  if (phoneQuery) {
    // Only a board with cards has rows to re-pick; before the first frame the
    // grid holds the welcome or "Connecting…", which this must not replace.
    const onPhone = () => { if (cards.size > 0) renderGrid(); };
    if (typeof phoneQuery.addEventListener === 'function') phoneQuery.addEventListener('change', onPhone);
    else if (typeof phoneQuery.addListener === 'function') phoneQuery.addListener(onPhone);
  }

  // Per card, outside the DOM because every frame replaces the session whole:
  // which rows hold which slots, and the rows and counts last drawn, which is
  // what tells a repaint what is news. Plus the cards opened in place.
  const subs = new Map();       // session id → { ledger, rows: Map(id → state), counts }
  const expanded = new Set();   // session ids

  /** A card that lost its subagents, or left the board, forgets them. */
  function forgetSubs(id) {
    subs.delete(id);
    expanded.delete(id);
  }

  /**
   * The rows that fit, slot by slot: the oldest, and each keeps its slot
   * until it finishes. "Keep their place" wins over exact start order, so a
   * row that takes a freed slot can stand above one that started before it.
   *
   *   · First drawing: blocked rows, then the first to start, in start order.
   *   · A slot freed by a finish is taken in place by the next hidden row.
   *     No other row moves.
   *   · A blocked subagent always takes a slot: a free one, else the
   *     bottom-most slot whose row is not blocked. The row it displaces comes
   *     back only into a slot freed by a finish; once approved, the row it
   *     became keeps the slot until it finishes.
   *   · Opened in place: the rows on show stay where they are and the rest
   *     follow in start order. Folded again, the first `slots` keep theirs.
   *
   * `ledger` is { slots, shown: [id] }, and a new one is returned rather
   * than the old one changed. It is idempotent — asked again with what it
   * returned, it returns the same — so it can be asked on every repaint.
   */
  function pick(ledger, items, slots, open) {
    const live = new Map(items.map((x) => [x.id, x]));
    let shown;
    if (!ledger || ledger.slots !== slots) {
      const blocked = items.filter((x) => x.state === 'blocked').slice(0, slots);
      const rest = items.filter((x) => x.state !== 'blocked').slice(0, slots - blocked.length);
      const chosen = new Set([...blocked, ...rest].map((x) => x.id));
      shown = items.filter((x) => chosen.has(x.id)).map((x) => x.id);
    } else {
      shown = ledger.shown;
    }
    if (open) {
      const kept = shown.filter((id) => live.has(id));
      const keep = new Set(kept);
      shown = [...kept, ...items.filter((x) => !keep.has(x.id)).map((x) => x.id)];
      return { ledger: { slots, shown }, rows: shown.map((id) => live.get(id)) };
    }
    // A finished row leaves a hole in ITS slot.
    const at = shown.slice(0, slots).map((id) => (live.has(id) ? id : null));
    for (const x of items) {
      if (x.state !== 'blocked' || at.includes(x.id)) continue;
      let i = at.indexOf(null);
      if (i < 0 && at.length < slots) i = at.length;
      if (i < 0) {
        for (let j = at.length - 1; j >= 0; j -= 1) {
          if (live.get(at[j]).state !== 'blocked') { i = j; break; }
        }
      }
      if (i >= 0) at[i] = x.id;   // the displaced row goes hidden
    }
    const onShow = new Set(at.filter(Boolean));
    const hidden = items.filter((x) => !onShow.has(x.id));
    for (let i = 0; i < slots && hidden.length > 0; i += 1) {
      if (i === at.length) at.push(null);
      if (at[i] === null) at[i] = hidden.shift().id;   // in place
    }
    shown = at.filter(Boolean);   // a slot nothing could take closes
    return { ledger: { slots, shown }, rows: shown.map((id) => live.get(id)) };
  }

  const rowMark = (state) => STATE_MARK[state] || '';
  const rowName = (x) => (x.activity ? `${x.label}, ${x.state}: ${x.activity}` : `${x.label}, ${x.state}`);

  // The row's inside, shared by the card and the session screen. A real
  // button on the card; the state word is its mark's second channel.
  const rowInner = (x) => `<span class="sub-text"><span class="sub-label">${escape(x.label)}</span>`
    + `<span class="sub-act">${escape(x.activity)}</span></span>`
    + `<span class="sub-st">${rowMark(x.state)}<span>${x.state}</span></span>`;

  // Motion-free on purpose, like everything paint() compares: the classes
  // that move a row are added after the paint, from the card's memory, so a
  // repaint about something else replays nothing.
  function subRowHTML(x, slot) {
    return `<button class="sub st-${x.state}" type="button" data-sub="${escape(x.id)}" data-slot="${slot}"`
      + ` aria-label="${escape(rowName(x))}">${rowInner(x)}</button>`;
  }

  /**
   * "+7 more · 15 done": a control where it leads somewhere, else a count.
   * Under phone rules it opens the session screen; elsewhere it opens the
   * list in place, and folds it again as "Show less".
   */
  function footHTML(id, { hidden, done, open, canExpand, phone }) {
    // The dot is hidden from a screen reader, the spaces around it are not:
    // the name reads "+7 more 15 done", never "+7 more15 done".
    const sep = ' <span class="foot-sep" aria-hidden="true">·</span> ';
    const more = hidden > 0 ? `+<span class="n" data-count="more">${hidden}</span> more` : '';
    const dn = done > 0 ? `<span class="n" data-count="done">${done}</span> done` : '';
    // One span for the words: left loose in the flex row, "+" and the number
    // would each become an item and take the row's gap between them.
    const words = (html) => `<span class="foot-words">${html}</span>`;
    const text = [more, dn].filter(Boolean).join(sep);
    const key = `data-foot="${escape(id)}"`;
    if (phone && hidden > 0) {
      return `<button class="sub-foot is-control" type="button" ${key} title="Opens the session screen">`
        + `${words(text)}${ICON.chevronRight || ''}</button>`;
    }
    if (!phone && open && canExpand) {
      return `<button class="sub-foot is-control" type="button" ${key} aria-expanded="true">`
        + `${words(`Show less${dn ? sep + dn : ''}`)}${ICON.chevronUp || ''}</button>`;
    }
    if (!phone && hidden > 0) {
      return `<button class="sub-foot is-control" type="button" ${key} aria-expanded="false">`
        + `${words(text)}${ICON.chevronDown || ''}</button>`;
    }
    return text ? `<div class="sub-foot">${words(text)}</div>` : '';
  }

  /** The card's block: its markup, and what a repaint compares to find news. */
  function subsBlock(s, sub) {
    const phone = phoneRules();
    const slots = phone ? 2 : 3;
    // Never in place under phone rules, where the footer opens the screen;
    // the flag is kept, so a card opened on a wide window opens again there.
    const open = !phone && expanded.has(s.id);
    const mem = subs.get(s.id);
    const { ledger, rows } = pick(mem ? mem.ledger : null, sub.items, slots, open);
    const hidden = sub.items.length - rows.length;
    const html = '<div class="subs" role="group" aria-label="Subagents">'
      + rows.map((x, i) => subRowHTML(x, i)).join('')
      + footHTML(s.id, { hidden, done: sub.done, open, canExpand: sub.items.length > slots, phone })
      + '</div>';
    return {
      html,
      ledger,
      rows: new Map(rows.map((x) => [x.id, x.state])),
      counts: { more: hidden, done: sub.done },
    };
  }

  /**
   * After a repaint, and only then: the rows and counts that are news get
   * their motion on the nodes the paint just made. A row moves when it
   * starts (a key not on show before), and its state cell when it becomes
   * blocked, stops being blocked or fails. Activity, label and the ordinary
   * planning ↔ coding ↔ testing changes are written in place. A card's
   * block and the session screen's subtasks both come through here.
   */
  function moveSubs(el, before, block) {
    const was = before ? before.rows : new Map();
    el.querySelectorAll('.sub[data-sub]').forEach((row) => {
      const id = row.dataset.sub;
      if (!was.has(id)) { row.classList.add('entering'); return; }
      const then = was.get(id);
      const now = block.rows.get(id);
      if (then !== now && (then === 'blocked' || now === 'blocked' || now === 'failed')) row.classList.add('changed');
    });
    for (const key of ['more', 'done']) {
      const then = before ? before.counts[key] : 0;
      const now = block.counts[key];
      if (!then || !now || then === now) continue;
      const n = el.querySelector(`.n[data-count="${key}"]`);
      if (n) n.classList.add('ticked');
    }
  }

  // The facts under the title, in the order you would ask for them: which
  // agent, which machine, where, how long ago, how much.
  //
  // The agent is a mark, plain, leading the line: Claude and Codex share
  // sections since 1.7.0, and the mark tells their cards apart where the
  // bordered CLAUDE chip used to. It is the legend the usage blocks above
  // give it. Its name is there for a screen reader, with the comma that
  // parts it from the machine inside the same hidden text (Chrome sets a
  // detached one apart as a word of its own), and for the pointer, as a
  // tooltip. Never a colour: colour on this board means state.
  //
  // The place, "in <folder>", shows only once a session has moved: when its
  // live folder is a usable name (realFolder) and differs from both its
  // section, which the label above already names, and its name. `name` is
  // the session's title when the agent has one and the folder it started in
  // otherwise, and `project` follows the live directory, a Claude worktree
  // root reported as its repository. So a session that ran `cd web` reads
  // "in web", and an untitled one at a worktree root, named for the
  // worktree's folder, reads "in <repo>" until its section knows the repo.
  // On a server too old to send `homeProject` the section is the live
  // folder, and no card says it.
  function cardMeta(s) {
    const name = agentName(s.source);
    const agent = `<span class="meta-agent" title="${escape(name)}">${agentMark(s.source)}`
      + `<span class="sr-only">${escape(name)},</span></span>`;
    const facts = [];
    if (s.host && s.host.machine) {
      const host = machineLabel(s.host);
      facts.push(`<span class="host" title="${escape(host)}">${escape(host)}</span>`);
    }
    if (realFolder(s.project) && s.project !== sectionKey(s) && s.project !== s.name) {
      facts.push(`<span class="proj" title="${escape(s.project)}">in ${escape(s.project)}</span>`);
    }
    // Left empty on purpose: paintTimes fills it, here and on the 15s tick, so
    // the markup this card is compared against does not change every minute
    // purely because a label aged.
    //
    // A working card also carries its stale form, "no update for 14m", which
    // .card.stale shows in place of the time (card.css, "Stale"): both are here
    // from the first paint, so the clock crossing the line flips a class and
    // repaints nothing. The words are hidden from a screen reader, which hears
    // them in words straight after the state instead (cardInner).
    const ts = Number(s.updatedAt);
    facts.push(ACTIVE_STATUSES.has(s.status)
      ? `<span class="ts"><span class="ts-stale" aria-hidden="true">no update for <span data-ts="${ts}" data-form="age"></span></span>`
        + `<span class="ts-ago" data-ts="${ts}"></span></span>`
      : `<span class="ts" data-ts="${ts}"></span>`);
    // Absent, not zero, when nothing was reported — a card must never claim a
    // session spent nothing. These are tokens the agent's own logs attribute to
    // it, and they are NOT a share of a plan limit: the two measures do not
    // convert, so this carries its unit and no denominator.
    if (typeof s.tokens === 'number') {
      facts.push(`<span class="tok">${escape(fmtTokens(s.tokens))} tokens</span>`);
    }
    // The mark is set apart from the first fact by the line's gap, as the
    // mockups draw it ("✳ MacBook Pro · 2m ago"), not by a separator.
    return `<div class="meta">${agent}`
      + facts.map((f, i) => `${i ? '<span class="meta-sep">·</span>' : ''}${f}`).join('')
      + '</div>';
  }

  // On a working card, what a screen reader hears straight after the state once
  // the card is stale: "Coding, no update for 14 minutes.", the units in words.
  // Hidden from everyone until .card.stale shows it (card.css), and then only to
  // the accessibility tree, inside the state's hidden sentence (cardInner); the
  // eye reads the "?" and the meta line.
  const staleSaid = (s) => `<span class="stale-said">, no update for <span data-ts="${
    Number(s.updatedAt)}" data-form="spoken"></span></span>`;

  /** A state's word as a sentence starts with it: "Coding", as iOS and Android say it. */
  const stateWord = (shown) => String(shown).charAt(0).toUpperCase() + String(shown).slice(1);

  // The name is first and largest — it is how you know WHICH session this is,
  // and the state only matters once you have found the right card. They were on
  // one line before, competing for width, and the name was what truncated.
  //
  // A working card's state row carries a "?" mark beside its state's own, for
  // when it goes stale; .card.stale swaps one for the other.
  //
  // The title is the card's first control, and a reader moving from control
  // to control heard only its name — "api-server — open this session's
  // history" — on every card: no state, and on a stale card nothing of how
  // long it had been quiet. That lived in the row beneath, reached only by
  // reading on. So the button is described by the row's state and by what
  // the session last said, the reading iOS's card gives as its one element's
  // value ("Coding, no update for 14 minutes. Editing src/auth/token.ts").
  // Described, not labelled: the name stays the words on the button (WCAG
  // 2.5.3), and a description is computed from the live row when it is read,
  // so a stale card's age stays current without its markup changing every
  // minute.
  //
  // What it is described by is one hidden sentence in the row, every word of
  // it inline, "Coding." or "Coding, no update for 14 minutes.", its full
  // stop the pause before the message; the badge and the marks the eye reads
  // are hidden from the tree. Chrome sets each box of a description apart
  // with a space (a flex item, an element taken out of the flow), so the row
  // itself, described as its boxes, read "CODING , no update for 14 minutes
  // ." and NVDA, at its default punctuation, said "dot". The word is in
  // sentence case, as iOS and Android say it, where the badge's capitals
  // came through as the description's.
  //
  // The name leads with the card's agent (cardLead), "Claude, Fix the login
  // redirect — open this session's history": since 1.7.0 Claude and Codex
  // share a section, and a reader moving from title to title heard which
  // agent a card was only in its meta line, after the state and the message.
  // One string on the button, so no box can come between its words, and it
  // holds the visible name whole.
  //
  // `shown` is the display status; `rows` the subagent block, which sits
  // between the card's own line and its meta, and is '' for a card without
  // one — whose markup is then exactly what it was before subagents existed.
  // The stale form is keyed on the session's own status, as it was: whether
  // the card is stale is patchCard's call, and never while a subagent runs.
  function cardInner(s, shown, rows) {
    const working = ACTIVE_STATUSES.has(s.status);
    const stateId = `card-${s.id}-state`;
    const msgId = `card-${s.id}-msg`;
    return `<div class="card-head">
        <div class="card-title-row">
          <button class="name-open" type="button" data-open="${escape(s.id)}"
                  aria-label="${escape(`${cardLead(s)} — open this session's history`)}"
                  aria-describedby="${escape(s.message ? `${stateId} ${msgId}` : stateId)}"
            ><span class="name" title="${escape(s.name)}">${escape(s.name)}</span
            ><span class="name-more" aria-hidden="true">›</span></button>
          <button class="dismiss" type="button" data-dismiss="${escape(s.id)}" aria-label="Dismiss session" title="Dismiss">×</button>
        </div>
        <div class="card-state-row">${stateMark(shown)}${working ? STALE_MARK : ''}<span class="badge" aria-hidden="true">${
          escape(shown)}</span><span class="sr-only" id="${escape(stateId)}">${escape(stateWord(shown))}${
          working ? staleSaid(s) : ''}.</span></div>
      </div>${
        s.message ? `<p class="message" id="${escape(msgId)}">${escape(s.message)}</p>` : ''
      }${rows}${cardMeta(s)}${renderFocus(s)}`;
  }

  function patchCard(rec, s) {
    const { el } = rec;
    const sub = subtasksOf(s);
    // Class, edge lift, stale timer and data-status all follow what the card
    // wears, so entering or leaving WORKING is a state change like any other.
    const shown = display(s);
    const prev = el.dataset.status;
    if (prev !== shown) {
      if (prev) {
        const gone = statusClass(prev);
        if (gone) el.classList.remove(gone);
        // One brief lift of the card's own edge, and only on a real change —
        // never on a card's first paint, where there is no news yet. The class
        // is removed on `animationend`, which is what lets the next change
        // re-trigger it without a forced reflow inside this loop.
        el.classList.add('changed');
      }
      const now = statusClass(shown);
      if (now) el.classList.add(now);
      el.dataset.status = shown;
    }
    // Never dimmed while a subagent runs. Subagents post when their status
    // class changes, and otherwise at most once a minute when what they do
    // changes, so one in a long command can be silent for many minutes and
    // still be working; the server expires rows that really went quiet.
    // Without data-active-since the 15s timer below leaves the card alone too.
    const active = ACTIVE_STATUSES.has(shown) && !(sub && sub.running > 0);
    if (active) el.dataset.activeSince = String(s.updatedAt);
    else delete el.dataset.activeSince;
    el.classList.toggle('stale', active && Date.now() - s.updatedAt > STALE_MS);

    const before = subs.get(s.id);
    const block = sub ? subsBlock(s, sub) : null;
    if (block) subs.set(s.id, { ledger: block.ledger, rows: block.rows, counts: block.counts });
    else forgetSubs(s.id);

    const inner = cardInner(s, shown, block ? block.html : '');
    if (rec.inner === inner) return;
    const news = rec.inner !== '';   // a card's first paint has no news to move
    rec.inner = inner;
    paint(el, inner);
    if (block && news) moveSubs(el, before, block);
  }

  function renderGrid() {
    const list = arrange();
    renderStats(list);
    renderUsage(); // session changes can change which sources' bars are shown
    if (list.length === 0) { renderEmpty(); renderNeeds(); return; }

    // Whatever message block was showing is not a card, so it goes first.
    if (cards.size === 0 && gridEl.firstChild) paint(gridEl, '');

    let withSubs = false;
    const born = new Set();   // the cards this render made
    for (const s of list) {
      if (subtasksOf(s)) withSubs = true;
      let rec = cards.get(s.id);
      if (!rec) {
        born.add(s.id);
        const el = document.createElement('article');
        el.className = 'card entering';
        el.dataset.id = s.id;
        // Both events, not just animationend: an animation that is cancelled —
        // the card hidden mid-flight, the sheet swapped — never ends, and a
        // `.changed` left behind cannot be re-added, so the card would stop
        // reporting its next state change.
        const settle = (e) => {
          if (e.animationName === 'card-in') el.classList.remove('entering');
          if (e.animationName === 'state-change') el.classList.remove('changed');
        };
        el.addEventListener('animationend', settle);
        el.addEventListener('animationcancel', settle);
        rec = { el, inner: '' };
        cards.set(s.id, rec);
      }
      patchCard(rec, s);
    }

    // Ordering in one pass: each section's label, then its cards. A node is
    // moved only when it is not already where it belongs; insertBefore on a
    // node in place would still reparent it, which is work for nothing. A
    // node that does move (a card whose section changed, or whatever stood
    // between) takes focus with it out of the document, so the control that
    // had it before the pass gets it back after, without scrolling the page.
    const held = gridEl.contains(document.activeElement) ? document.activeElement : null;
    const sections = sectionsOf(list);

    // What leaves goes first, so the pass meets only nodes that stay: a
    // section that emptied takes its label with it, and a card no longer on
    // the board goes. Left in place until after the pass, each stood before
    // every node below it that stays, so the pass put every one of those
    // back after it: one card leaving the top of a board of eight in four
    // sections took the seven cards and three labels under it out of the
    // grid and back, which cleared a reader's text selection in them,
    // restarted an animation in flight and rebuilt each one's node for a
    // screen reader.
    const drawn = new Set(sections.map(({ key }) => key));
    for (const key of [...labels.keys()]) if (!drawn.has(key)) dropLabels(key);
    for (const [id, rec] of cards) {
      if (state.has(id)) continue;
      rec.el.remove();
      cards.delete(id);
    }

    let anchor = null;
    const place = (el) => {
      const next = anchor ? anchor.nextSibling : gridEl.firstChild;
      if (next !== el) gridEl.insertBefore(el, next);
      anchor = el;
    };
    const painted = [];
    for (const { key, sessions } of sections) {
      const label = labelFor(key, sessions.length, born.has(sessions[0].id));
      if (label.painted) painted.push(label.el);
      place(label.el);
      for (const s of sessions) place(cards.get(s.id).el);
    }

    // In place now, so there is a line to measure.
    for (const el of painted) fitLabel(el);
    if (held && held.isConnected && document.activeElement !== held) held.focus({ preventScroll: true });

    // Each card keeps its own height while any of them carries subagent rows
    // (board.css), so a short card does not stretch beside a tall one.
    gridEl.classList.toggle('has-subs', withSubs);
    renderNeeds();
  }

  // ---- Needs you ------------------------------------------------------------
  //
  // The board's one alarm since 1.7.0: a bar along the bottom edge while any
  // session is blocked, naming one and the project it is in, "2 BLOCKED ·
  // Fix the login redirect · in acme-api · Show". One button: a press brings
  // that card into view under its stuck label, moves focus to its title and
  // rings the title for two seconds; with more than one blocked the bar then
  // names the next in reading order, and says Next, round to the first. iOS,
  // the web and Android draw the same bar (docs/design/project-sections.md).
  //
  // Reading order is the grid's own: sections in order, cards in order, row
  // by row. Every render works out what the bar names from the board as it
  // is drawn then, so a card dismissed or unblocked meanwhile is passed over,
  // and one that blocks between the card a press brought and the next is
  // the next. A card that becomes blocked never moves (the board's order);
  // the bar is the way to it.

  const RING_MS = 2000;
  // The bar's memory between renders. `brought` is the card its last press
  // brought: null until the first press, and null again once the bar leaves,
  // so each time it comes back it starts from the top. `named` is the card it
  // names as last drawn, and `ring` the card ringing now.
  const bar = { brought: null, named: null, ring: null };

  const reducedMotion = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The cards in reading order as drawn now, and the blocked ones among them: ids. */
  function drawnOrder() {
    const order = [];
    const blocked = [];
    for (const el of gridEl.querySelectorAll('.card')) {
      order.push(el.dataset.id);
      if (el.dataset.status === 'blocked' && state.has(el.dataset.id)) blocked.push(el.dataset.id);
    }
    return { order, blocked };
  }

  /**
   * The card the bar names, by the rule iOS and Android keep (NeedsYou,
   * barTarget): the first blocked card after the one the last press brought,
   * in reading order as drawn now, round to the first, and so that card
   * itself when it is the only one blocked. With no press yet, or that card
   * gone from the board, the first blocked card. A card brought and since
   * unblocked is still where the walk goes on from. Null with none blocked.
   */
  function barTarget({ order, blocked }) {
    if (blocked.length === 0) return null;
    const at = bar.brought === null ? -1 : order.indexOf(bar.brought);
    if (at < 0) return blocked[0];
    const waiting = new Set(blocked);
    for (let i = 1; i <= order.length; i += 1) {
      const id = order[(at + i) % order.length];
      if (waiting.has(id)) return id;
    }
    return blocked[0];
  }

  /**
   * What the bar and the voice call a blocked session, in the words every
   * client uses: its name, or its agent's where it has none; and where it
   * is, "in <section>" for a folder's section and its agent for No project,
   * each left out where it would only say the name again (an untitled card
   * named after its folder; a Codex session called "Codex"). Compared
   * exactly. Never the live folder: the section is where the reader looks.
   */
  function needsWhat(s) {
    const agent = agentName(s.source);
    const name = sessionName(s);
    const key = sectionKey(s);
    if (key === NO_PROJECT) return { name, place: agent === name ? '' : agent };
    return { name, place: key === name ? '' : `in ${key}` };
  }

  function needsHTML(count, s, verb) {
    const { name, place } = needsWhat(s);
    return `<span class="needs-alarm">${STATE_MARK.blocked || ''}<span class="needs-n">${count}</span>`
      + '<span class="needs-word">blocked</span></span>'
      + `<span class="needs-what"><span class="needs-name">${escape(name)}</span>${
        place ? `<span class="needs-where"><span class="needs-sep">·</span>${escape(place)}</span>` : ''}</span>`
      + `<span class="needs-verb">${verb}</span>`;
  }

  /** The bar as the board stands: shown, named and worded, or leaving. */
  function renderNeeds() {
    const drawn = drawnOrder();
    const { blocked } = drawn;
    noteBlocked(blocked);
    // Gone sooner than two seconds when its card is no longer blocked.
    if (bar.ring && !blocked.includes(bar.ring.id)) clearRing();
    if (blocked.length === 0) {
      hideNeeds();
      bar.brought = null;
      bar.named = null;
      return;
    }
    const id = barTarget(drawn);
    const s = state.get(id);
    bar.named = id;
    // "Next" while the card a press brought is still on the board and there
    // is another to walk to; "Show" before any press, and again once that
    // card has gone or is the only one left.
    const walks = bar.brought !== null && drawn.order.includes(bar.brought) && blocked.length > 1;
    const verb = walks ? 'Next' : 'Show';
    const { name, place } = needsWhat(s);
    // iOS's words, and then the verb the bar shows, so that its name holds
    // every word of its label (WCAG 2.5.3): a speech user who says "click
    // Show" or "click Next", as iOS Voice Control answers to "Show blocked",
    // reaches it.
    const label = `${blocked.length} blocked: ${name}${place ? `, ${place}` : ''}, ${verb}`;
    if (needsEl.getAttribute('aria-label') !== label) needsEl.setAttribute('aria-label', label);
    // Fitted as its words are painted. A press, a rename or a block that
    // arrives changes them and not the bar's size, so the observer that
    // fits a bar as it appears never fires for them: without this fit the
    // bar kept the give-way of the card it named before, dropping a place
    // or BLOCKED that fit, or keeping a place that left the name no room.
    // A bar still hidden has no width to fit to, and waits for the observer.
    // Painted into the face, which outlives its words, so a beat in flight
    // carries on through a press or a rename.
    if (paint(faceEl, needsHTML(blocked.length, s, verb))) fitNeeds();
    showNeeds();
  }

  // Enters from the bottom edge when the first block lands and leaves when
  // none remain: motion for news, and in place under reduced motion, where
  // board.css takes every animation to nothing. Leaving, it is inert, so it
  // can be neither pressed nor reached while it goes.
  let leaveTimer = 0;
  function showNeeds() {
    clearTimeout(leaveTimer);
    if (!needsEl.hidden && !needsEl.classList.contains('leaving')) return;
    const fresh = needsEl.hidden;
    needsEl.classList.remove('leaving');
    needsEl.removeAttribute('inert');
    needsEl.hidden = false;
    if (fresh) needsEl.classList.add('entering');
    document.body.classList.add('needs-up');
    padForNeeds();
  }

  function hideNeeds() {
    if (needsEl.hidden || needsEl.classList.contains('leaving')) return;
    // Focus on a control that turns inert, then hidden, falls to <body>, and
    // a reader on the bar would start again from the top of the page. So it
    // is handed on first, before the bar forgets what it brought.
    if (needsEl.contains(document.activeElement)) handFocusOn();
    needsEl.classList.remove('entering');
    faceEl.classList.remove('beat');
    needsEl.classList.add('leaving');
    needsEl.setAttribute('inert', '');
    const gone = () => {
      clearTimeout(leaveTimer);
      if (!needsEl.classList.contains('leaving')) return;
      needsEl.classList.remove('leaving');
      needsEl.hidden = true;
      paint(faceEl, '');
      needsEl.removeAttribute('aria-label');
      document.body.classList.remove('needs-up');
    };
    // Its animation's end, or a moment past it where none runs.
    leaveTimer = setTimeout(gone, reducedMotion() ? 0 : 400);
  }

  /**
   * Where a reader on the leaving bar goes: the first of these still on the
   * board. The card the bar last brought in this life of it, else the one it
   * named last, so they land where the bar sent them or was about to; else
   * the first card's title, the next stop after the bar; else, with no card
   * left, the board's heading. Never a card brought in an earlier life,
   * which nothing on the bar had named. Without moving the page where the
   * reader can see where focus lands (handTo).
   */
  function handFocusOn() {
    for (const id of [bar.brought, bar.named]) {
      const rec = id === null ? null : cards.get(id);
      const title = rec && rec.el.isConnected ? rec.el.querySelector('[data-open]') : null;
      if (title) { handTo(title); return; }
    }
    const first = gridEl.querySelector('.card [data-open]');
    if (first) { handTo(first); return; }
    const heading = document.querySelector('h1');
    if (!heading) return;
    // A heading takes focus only with a tabindex of -1, which keeps it out
    // of the Tab order. That goes again once focus moves on, so a later
    // click on the heading focuses nothing.
    if (!heading.hasAttribute('tabindex')) {
      heading.setAttribute('tabindex', '-1');
      heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
    }
    handTo(heading);
  }

  /**
   * Focus handed to `el` by the board rather than moved there by the
   * reader. Where all of it shows, below whatever label is stuck at the top
   * and above the bar, the page stays still under the reader, as with every
   * focus this board hands back. Where it does not, it is brought into view
   * as focus lands, the least way (nearest), so the root's scroll padding
   * stops it clear of the label or the bar, and in one step under reduced
   * motion: a reader who had scrolled the board with the bar focused, and
   * then saw the block answered, had focus land on a title under the stuck
   * label, or far below the window, where nothing showed where it was
   * (WCAG 2.4.11).
   */
  function handTo(el) {
    if (!seenWhole(el) && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    el.focus({ preventScroll: true });
  }

  /**
   * Whether all of an element shows: below the labels stuck at the top
   * edge, where a label sticks while its cards pass (board.css) and every
   * earlier one sticks under it, and above the bar while it shows.
   */
  function seenWhole(el) {
    let top = 0;
    for (const { el: label } of labels.values()) {
      const l = label.getBoundingClientRect();
      if (l.top <= 0.5 && l.bottom > top) top = l.bottom;
    }
    const bottom = needsEl.hidden ? window.innerHeight : needsEl.getBoundingClientRect().top;
    const r = el.getBoundingClientRect();
    return r.top >= top && r.bottom <= bottom;
  }

  // The bar's own arrival, not its face's beat, which runs the same
  // animation and whose end reaches the bar too.
  const arrived = (e) => {
    if (e.target === needsEl && e.animationName === 'needs-in') needsEl.classList.remove('entering');
  };
  needsEl.addEventListener('animationend', arrived);
  needsEl.addEventListener('animationcancel', arrived);

  /**
   * The page is padded by the bar's height while it shows, so nothing ends
   * under it, and whatever is scrolled into view stops clear of it (the
   * root's scroll padding, shell.css): measured, since it takes one line or
   * two and grows with the reader's text. On the root, where both read it.
   */
  function padForNeeds() {
    if (needsEl.hidden || !needsEl.offsetHeight) return;
    document.documentElement.style.setProperty('--needs-h', `${needsEl.offsetHeight}px`);
  }

  /**
   * Fits the bar to its line as the spec orders it: where room runs out the
   * word BLOCKED goes first (the mark and the count stay), then the project,
   * and then the name is cut at its end (shell.css). On a phone the bar
   * takes two lines, the alarm over the session, and each gives way on its
   * own: the session's drops the project and then cuts the name, and the
   * word goes only if it crowds the alarm's line, since dropping it there
   * gives the session nothing.
   */
  function fitNeeds() {
    needsEl.classList.remove('drop-word', 'drop-where');
    const name = needsEl.querySelector('.needs-name');
    const alarm = needsEl.querySelector('.needs-alarm');
    const what = needsEl.querySelector('.needs-what');
    if (!name || !alarm || !what || !needsEl.clientWidth) return;
    // In fractions of a pixel, as fitLabel measures: whole pixels let a
    // name a fraction too wide pass, and CSS cut it while the word or the
    // project still showed, against the order above.
    const cut = () => drawnWidth(name) > roomOf(name);
    const crowded = drawnWidth(alarm) > roomOf(alarm);
    // One line or two, as the stylesheet laid the bar out: on two the
    // session starts below the alarm. Not from whether dropping the word
    // gave the name more room: a project wider than the line leaves the
    // name no box with the word or without it, which read as two lines, so
    // a wide board kept BLOCKED and dropped only the project.
    const ownLine = what.getBoundingClientRect().top >= alarm.getBoundingClientRect().bottom;
    if (crowded || (!ownLine && cut())) needsEl.classList.add('drop-word');
    if (cut()) needsEl.classList.add('drop-where');
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { fitNeeds(); padForNeeds(); }).observe(needsEl);
  }

  function clearRing() {
    if (!bar.ring) return;
    clearTimeout(bar.ring.timer);
    const rec = cards.get(bar.ring.id);
    if (rec) rec.el.classList.remove('is-ringed');
    bar.ring = null;
  }

  /**
   * Brings a card into view: no scroll if it is already in view, below
   * whatever label is stuck and above the bar; else it lands 8px under its
   * own stuck label (the root's scroll padding, board.css), smoothly unless
   * motion is reduced. Focus moves to its title, whose description reads
   * the state and the message, and the title is ringed for two seconds in a
   * neutral ink: the focus ring's green would say done on a blocked card,
   * and a mouse press leaves no focus ring at all.
   */
  function bring(id) {
    const rec = cards.get(id);
    if (!rec) return;
    const el = rec.el;
    const label = gridEl.querySelector('.section-label');
    const top = label ? label.offsetHeight : 0;
    const bottom = needsEl.hidden ? 0 : needsEl.offsetHeight;
    const r = el.getBoundingClientRect();
    const inView = r.top >= top && r.bottom <= window.innerHeight - bottom;
    if (!inView && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    const title = el.querySelector('[data-open]');
    if (title) title.focus({ preventScroll: true });
    bar.brought = id;
    clearRing();
    el.classList.add('is-ringed');
    bar.ring = { id, timer: setTimeout(clearRing, RING_MS) };
  }

  // A press brings the card the bar names, read from the board as drawn now,
  // and the render after it names the next.
  needsEl.addEventListener('click', () => {
    const id = barTarget(drawnOrder());
    if (id === null) return;
    bring(id);
    renderNeeds();
  });

  // ---- A new block, aloud
  //
  // Said through the polite region beside the bar, as iOS says it with
  // VoiceOver: "Fix the login redirect, in acme-api, needs you". Speech
  // nobody asked for has to be earned, so only a block that arrives while
  // the board is watching is said: a session frame that turns a card
  // blocked, or brings one new and blocked. Never a snapshot, which is the
  // page loading or the stream coming back with blocks that were standing
  // before the board looked; never a fetch. A session said is not said
  // again within a minute, the server's own wait before it pushes the same
  // block twice. Blocks that land within half a second are said together,
  // "2 sessions need you", since a second sentence would cut the first off.

  const SAID_MS = 60000;
  const GATHER_MS = 500;
  // How long a sentence stays in the region once written: long past the
  // moment a screen reader queues it, and gone before anyone reading the page
  // from the top meets an alarm for a block that was answered long ago.
  const SAID_KEPT_MS = 5000;
  const saidAt = new Map();        // session id → when its block was said
  let gathered = [];
  let gatherTimer = 0;
  let saidTimer = 0;

  function gatherBlock(id) {
    const now = Date.now();
    for (const [k, t] of saidAt) if (now - t >= SAID_MS) saidAt.delete(k);
    if (saidAt.has(id) || gathered.includes(id)) return;
    gathered.push(id);
    if (!gatherTimer) {
      gatherBeat();
      gatherTimer = setTimeout(sayBlocks, GATHER_MS);
    }
  }

  function sayBlocks() {
    gatherTimer = 0;
    // Only those still blocked: one answered within the half second is not news.
    const still = gathered.map((id) => state.get(id)).filter((s) => s && s.status === 'blocked');
    gathered = [];
    endBeat(still.length === 0);
    if (still.length === 0) return;
    const now = Date.now();
    for (const s of still) saidAt.set(s.id, now);
    let sentence = `${still.length} sessions need you`;
    if (still.length === 1) {
      // The commas set the place off; with no place there is nothing to set
      // off, and it is a plain sentence, as iOS says it: "Codex needs you".
      const { name, place } = needsWhat(still[0]);
      sentence = place ? `${name}, ${place}, needs you` : `${name} needs you`;
    }
    // Emptied first, so the same words a minute later are a change too; and
    // again a few seconds on, which a screen reader does not say (a polite
    // region speaks what is added), so no stale alarm stays in the page. A
    // sentence written meanwhile keeps its own few seconds.
    clearTimeout(saidTimer);
    saidEl.textContent = '';
    saidTimer = setTimeout(() => {
      saidEl.textContent = sentence;
      saidTimer = setTimeout(() => { saidEl.textContent = ''; }, SAID_KEPT_MS);
    }, 100);
  }

  // ---- The bar's beat
  //
  // A second block changes one figure on the bar, its count: a glyph far too
  // small for the corner of the eye, which is where this board is read. The
  // bar's arrival is the one motion on the board that peripheral vision
  // catches, so when the count rises while the bar already shows, the bar
  // comes in from the bottom edge again, once, with the new count already in
  // it, and nothing else changes: no word, no colour, no focus, no sound. The
  // rule below is the one iOS keeps (BarBeat), so the clients agree.
  //
  // Only its face moves, by the bar's own arrival (shell.css). The button's
  // box stays where it is, and with it the page's padding and scroll padding
  // measured from it, the scroll position and focus, and a press while the
  // face is still rising lands on the bar, never on a card showing through
  // above it.
  //
  // It hears what the voice hears, a session's transition into blocked while
  // the board watches (gatherBlock): never a snapshot's block, a reconnect's
  // or a fetch's, and never one said within its minute. It gathers them for
  // the voice's half second, so blocks that land together make one beat, and
  // when the half second is over (sayBlocks) the bar beats only if all of
  // these hold:
  // - one of its blocks is still blocked;
  // - the bar rested on a count when the first of them landed, and has not
  //   emptied since. A bar that showed nothing arrives with them, and its
  //   arrival is their beat; so are blocks gathered in the half second that
  //   starts with it.
  // - the count is higher than the one the bar rested on: never on a fall,
  //   nor for one block in place of another within half a second of it,
  //   whichever lands first, where the bar rested on the count before them
  //   both and no half second ends between them;
  // - the board was in front of the reader when the first landed and is
  //   now: the tab showing, and no detail screen over the board. So never for
  //   blocks that landed while the reader was away, nor on the way back.
  // - the bar is neither arriving nor leaving, and motion is not reduced.
  //   Under reduced motion the count changes in place, as everything here
  //   does, and the voice carries the news.

  const beat = {
    // The count the bar rests on: one that stood for half a second, or that
    // a half second ended on; nothing while the bar is empty. A rise is
    // measured from it, so a block that lands just after another was
    // answered is no rise where the bar rested on the count before the
    // answer and no half second ended between them, and a block gathered in
    // the half second that starts with the bar's arrival finds it resting on
    // nothing.
    rest: 0,
    // The blocked cards as the bar last drew them, and when they changed.
    drawn: [],
    changedAt: -Infinity,
    // The half second in flight: the count the bar rested on as its first
    // block landed, whether the bar has emptied since, and whether the board
    // was out of the reader's sight then.
    gathering: null,
  };

  /** Whether the board is in front of the reader: the tab showing, and no detail screen over it. */
  const boardInFront = () => !document.hidden && !document.body.classList.contains('detail-open');

  /** Every render of the bar hands over the blocked cards as drawn (renderNeeds). */
  function noteBlocked(blocked) {
    const was = beat.drawn;
    if (was.length === blocked.length && blocked.every((id) => was.includes(id))) return;
    const now = Date.now();
    if (now - beat.changedAt >= GATHER_MS) beat.rest = was.length;
    if (blocked.length === 0) {
      beat.rest = 0;
      if (beat.gathering) beat.gathering.emptied = true;
    }
    beat.changedAt = now;
    beat.drawn = blocked;
  }

  /**
   * The first block of a half second has landed. Called once the frame that
   * brought it is drawn, so the count it rests on is already brought up to
   * date for that frame (the session listener renders, then gathers).
   */
  function gatherBeat() {
    beat.gathering = { rest: beat.rest, emptied: false, away: !boardInFront() };
  }

  /** The half second is over: the bar beats, or does not (above). `answered`: none of its blocks still stands. */
  function endBeat(answered) {
    const done = beat.gathering;
    beat.gathering = null;
    const count = beat.drawn.length;
    beat.rest = count;
    if (!done || answered) return;
    const rest = done.emptied ? 0 : done.rest;
    if (rest === 0 || count <= rest) return;
    if (done.away || !boardInFront() || reducedMotion()) return;
    if (needsEl.hidden || needsEl.classList.contains('entering') || needsEl.classList.contains('leaving')) return;
    beatBar();
  }

  /** The face comes in from the bottom edge again (shell.css, .needs-face.beat). */
  function beatBar() {
    if (!faceEl.classList.contains('beat')) {
      faceEl.classList.add('beat');
      return;
    }
    // A beat whose end has not been heard yet starts again, from the edge.
    if (typeof faceEl.getAnimations === 'function') for (const a of faceEl.getAnimations()) a.currentTime = 0;
  }

  // Ended, or cancelled: a face hidden mid-beat, with the detail screen
  // opened over the board, never ends, and left with the class it would
  // beat again the moment the board came back.
  const beaten = (e) => {
    if (e.target === faceEl && e.animationName === 'needs-in') faceEl.classList.remove('beat');
  };
  faceEl.addEventListener('animationend', beaten);
  faceEl.addEventListener('animationcancel', beaten);

  async function refreshSessions() {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      if (!res.ok) return;
      const list = await res.json();
      // Merge, don't replace: the fetch may race newer SSE-delivered state.
      // Deletions are handled by SSE remove/snapshot events, not here.
      for (const s of list) {
        const cur = state.get(s.id);
        if (!cur || cur.updatedAt <= s.updatedAt) state.set(s.id, s);
      }
      renderGrid();
    } catch { /* SSE snapshot will reconcile on reconnect */ }
  }

  async function dismissSession(id) {
    const at = order.indexOf(id);
    if (at >= 0) returning.set(id, { below: at + 1 < order.length ? order[at + 1] : null, at });
    state.delete(id);
    // The card is going now, so its focus state and pending timers go with it:
    // waiting for the server's `remove` leaves them alive for as long as the SSE
    // backoff (up to 30s) while this DELETE succeeds anyway. Sessions are only
    // soft-deleted and resurrect on the next post, and the card that comes back
    // must not be wearing the status — or the Resume button — of a dead tap.
    // Nor the slots, or the opened-in-place list, of its subagents.
    setFocus(id, null);
    forgetSubs(id);
    renderGrid();
    try {
      const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await refreshSessions();
    } catch {
      await refreshSessions();
    }
    // Gone for good, or back in its place by now. Either way a later post
    // that brings it back is a new card, and goes on top.
    returning.delete(id);
  }

  // ---- Focus: bring a session's terminal to the front on its machine -------
  //
  // An explicit control, never the card tap. Presence comes from the
  // `machines`/`machine` SSE frames, a tap POSTs a command carrying ids only,
  // and the outcome arrives as `command_ack` (docs/api.md "Focus commands",
  // docs/design/focus-protocol.md §7).

  // Two waiting marks, not one. The server's command TTL is 120s and its own
  // `expired` ack follows within a sweep of that (§3.3), so a listener that was
  // asleep at 15s can still connect, claim and ack long after — the design's
  // "hard 15s timeout" (§7) says the machine looks asleep, it does not decide.
  // Only the second mark gives up, past any expired ack this board could be sent.
  const ACK_SLOW_MS = 15000;
  const ACK_GIVEUP_MS = 150000;
  const STATUS_CLEAR_MS = 8000;   // successes fade; failures stay until the next tap

  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    // A plain-http LAN board has no crypto.randomUUID; build a v4 by hand.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  const machineOnline = (id) => {
    const m = machines.get(id);
    return Boolean(m && m.online);
  };

  // The hook's label, plus the id's last four hex when two online machines
  // share it — the default names ("Mac", "PC") make that likely.
  function machineLabel(host) {
    const own = machines.get(host.machine.id);
    const name = (own && own.name) || host.machine.name || 'Machine';
    let same = 0;
    for (const m of machines.values()) if (m.online && m.name === name) same += 1;
    return same > 1 ? `${name} (${host.machine.id.slice(-4)})` : name;
  }

  function offlineText(host, name) {
    const m = machines.get(host.machine.id);
    return m && m.lastSeen ? `${name} is offline (${relTime(m.lastSeen)})` : `${name} is offline`;
  }

  // The visible note: the time keeps ticking with the other [data-ts] labels, and a
  // machine the board has never seen gets the hint a tooltip can't give on touch.
  function offlineNote(host, name) {
    const m = machines.get(host.machine.id);
    if (!m) {
      return `${escape(name)} is offline — needs the <a href="/docs#hooks-focus-optional-opt-in">AgStatus listener</a> on that machine`;
    }
    return m.lastSeen
      ? `${escape(name)} is offline (<span data-ts="${Number(m.lastSeen)}"></span>)`
      : `${escape(name)} is offline`;
  }

  // Every element is always present and toggled with `hidden`, so a status
  // change is painted in place and the live region actually announces it.
  function renderFocus(s) {
    const host = s.host;
    if (!host || !host.machine) return '';
    const name = machineLabel(host);
    const blocked = !BASE && requiresSecret;
    const online = !blocked && machineOnline(host.machine.id);
    const st = focus.get(s.id);
    const offline = online ? '' : blocked ? 'Bring-to-front needs the webhook secret on this board' : offlineText(host, name);
    const noteHtml = online ? '' : blocked ? escape(offline) : offlineNote(host, name);
    let title = `Bring this session's window to the front on ${name}`;
    if (!online) {
      title = blocked || machines.has(host.machine.id)
        ? offline
        : `${offline} — bring-to-front needs the AgStatus listener on that machine`;
    }
    // aria-disabled rather than disabled: an offline machine's button keeps
    // its tooltip and stays reachable for a screen reader to say why.
    // The machine's name is on the meta line now, and in this button's tooltip
    // and accessible name — a 320px card cannot hold "Bring to front on
    // MacBook Pro" as a label, and repeating a fact the card already states is
    // what the label was doing.
    const button = (type, cls, icon, label, hidden) => `
          <button class="act ${cls} focus-btn" type="button" data-focus="${escape(s.id)}" data-type="${type}"
                  title="${escape(title)}" aria-label="${escape(`${label} — ${title}`)}"${
                    online ? '' : ' aria-disabled="true"'
                  }${hidden ? ' hidden' : ''}>${icon}${escape(label)}</button>`;
    // One element doing both jobs: `.focus` is what paintFocus() patches
    // through, `.card-actions` is the rail board.css draws.
    return `
        <div class="focus card-actions">
          ${button('focus', 'act-focus', ICON.focus, 'Focus', false)}
          ${button('resume', 'act-resume', ICON.resume, 'Resume', !(st && st.resume))}
          <span class="act-spacer"></span>
          <span class="focus-note"${offline && !st ? '' : ' hidden'}>${noteHtml}</span>
          <span class="focus-status${st ? ` ${st.kind}` : ''}" aria-live="polite">${st ? escape(st.text) : ''}</span>
        </div>`;
  }

  /** Repaints one card's focus row without re-rendering the grid. */
  function paintFocus(id) {
    let row = null;
    for (const el of gridEl.querySelectorAll('.card')) {
      if (el.dataset.id === id) row = el.querySelector('.focus');
    }
    if (!row) return;
    const st = focus.get(id);
    const status = row.querySelector('.focus-status');
    status.className = `focus-status${st ? ` ${st.kind}` : ''}`;
    status.textContent = st ? st.text : '';
    const note = row.querySelector('.focus-note');
    note.hidden = Boolean(st) || !note.textContent;
    row.querySelector('[data-type="resume"]').hidden = !(st && st.resume);
  }

  function setFocus(id, st) {
    const cur = focus.get(id);
    if (cur) {
      clearTimeout(cur.ackTimer);
      clearTimeout(cur.clearTimer);
    }
    if (st) focus.set(id, st); else focus.delete(id);
    paintFocus(id);
  }

  // Drops focus state no card can show any more: a session that left the board,
  // and one whose machine turned Focus off — the hook posts `host: null` so a live
  // card clears (§3.2). renderFocus draws no row for either, so paintFocus would
  // leave the entry and its timers behind, and a machine that re-enabled Focus
  // would get its card back wearing the old tap's status and Resume button.
  function pruneFocus() {
    for (const id of focus.keys()) {
      const s = state.get(id);
      if (!s || !s.host) setFocus(id, null);
    }
  }

  // The same for subagent memory: a snapshot can drop sessions without a
  // `remove` for each. A card still on the board forgets its own when its
  // block goes (patchCard).
  function pruneSubs() {
    for (const id of [...subs.keys(), ...expanded]) {
      if (!state.has(id)) forgetSubs(id);
    }
  }

  /** A final outcome: successes fade after a while, failures stay until the next tap. */
  function showResult(id, st, kind, text, resume) {
    st.done = true;
    st.inferred = false;   // heard, not guessed, unless the caller says otherwise
    st.kind = kind;
    st.text = text;
    st.resume = Boolean(resume);
    clearTimeout(st.ackTimer);
    if (kind === 'ok') {
      st.clearTimer = setTimeout(() => { if (focus.get(id) === st) setFocus(id, null); }, STATUS_CLEAR_MS);
    }
    paintFocus(id);
  }

  // An outcome the board inferred rather than heard: the tap may have landed all
  // the same — a lost response, or a TTL this board can only guess at — so a
  // matching ack still overrides it. Dropping a genuine ack, and leaving the card
  // on a failure while the window is in front, is what this must never produce.
  function inferFailure(id, st, text) {
    showResult(id, st, 'fail', text);
    st.inferred = true;
  }

  const SEND_ERRORS = {
    401: 'Not allowed — this board needs the webhook secret',
    404: 'Session gone',
    409: 'No machine info for this session',
    429: 'Too many taps — wait a moment',
  };

  async function sendCommand(id, type) {
    const s = state.get(id);
    if (!s || !s.host) return;
    const name = machineLabel(s.host);
    const st = {
      cmdId: uuid(), type, name, kind: 'pending', text: 'Sending…', done: false, inferred: false, resume: false,
      app: (s.host.app && s.host.app.name) || 'the app',
    };
    setFocus(id, st);
    // The slow mark repaints in place and leaves the card pending; the give-up
    // timer reuses `ackTimer`, so a newer tap and a real ack both cancel it.
    st.ackTimer = setTimeout(() => {
      if (focus.get(id) !== st || st.done) return;
      st.text = `No answer from ${name} yet — is it asleep?`;
      paintFocus(id);
      st.ackTimer = setTimeout(() => {
        if (focus.get(id) === st && !st.done) inferFailure(id, st, `No answer from ${name} — is it asleep?`);
      }, ACK_GIVEUP_MS - ACK_SLOW_MS);
    }, ACK_SLOW_MS);
    let res;
    try {
      res = await fetch(`${BASE}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: st.cmdId, type, session_id: id }),
      });
    } catch {
      // The POST may still have reached the server and only its answer been lost.
      if (focus.get(id) === st && !st.done) inferFailure(id, st, "Couldn't reach the board");
      return;
    }
    // A newer tap, or an ack that beat the response, already took over.
    if (focus.get(id) !== st || st.done) return;
    if (!res.ok) {
      showResult(id, st, 'fail', SEND_ERRORS[res.status] || `Couldn't send (HTTP ${res.status})`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (focus.get(id) !== st || st.done) return;
    st.text = data.delivered === false ? `Sent — ${name} is not connected` : 'Sent…';
    paintFocus(id);
  }

  function handleAck(ack) {
    const id = ack.session_id;
    const st = focus.get(id);
    // Only the command this card is waiting on: an older one that a re-tap
    // superseded, or a stray ack, has nothing to say to the viewer. A card that
    // gave up waiting is still listening — that is what `inferred` is for.
    if (!st || st.cmdId !== ack.id || (st.done && !st.inferred)) return;
    const name = st.name;
    switch (ack.result) {
      case 'focused': showResult(id, st, 'ok', `Brought to front on ${name}`); return;
      case 'activated': showResult(id, st, 'ok', `Opened ${st.app} on ${name} — couldn't find the exact window`); return;
      case 'selected': showResult(id, st, 'ok', `Selected the pane on ${name}; the window stayed behind`); return;
      case 'resumed': showResult(id, st, 'ok', `Resumed on ${name}`); return;
      default: break;
    }
    switch (ack.reason) {
      case 'superseded': showResult(id, st, 'ok', 'Replaced by a newer tap'); return;
      case 'not-running': showResult(id, st, 'fail', `Not running on ${name}`, true); return;
      case 'expired': showResult(id, st, 'fail', `No answer from ${name} — is it asleep?`); return;
      case 'unsupported-type':
        if (st.type === 'resume') { showResult(id, st, 'fail', "Resume isn't available yet"); return; }
        break;
      default: break;
    }
    showResult(id, st, 'fail', `Couldn't bring it to front (${ack.reason || ack.result || 'unknown'})`);
  }

  gridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dismiss]');
    if (btn) {
      e.preventDefault();
      dismissSession(btn.dataset.dismiss);
      return;
    }
    const focusBtn = e.target.closest('[data-focus]');
    if (!focusBtn) return;
    e.preventDefault();
    if (focusBtn.getAttribute('aria-disabled') === 'true') return;
    sendCommand(focusBtn.dataset.focus, focusBtn.dataset.type === 'resume' ? 'resume' : 'focus');
  });

  // The subagent rows and their footer. A row opens the session screen at
  // that subtask. The footer opens the list in place (it carries
  // aria-expanded then), or under phone rules goes to the screen. Whichever
  // opened the screen is remembered, so closing it hands focus back there.
  // The ids are not encoded, for the reason given on the title's handler.
  gridEl.addEventListener('click', (e) => {
    const foot = e.target.closest('[data-foot]');
    const row = foot ? null : e.target.closest('[data-sub]');
    if (!foot && !row) return;
    e.preventDefault();
    if (foot) {
      const id = foot.dataset.foot;
      if (foot.hasAttribute('aria-expanded')) {
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        renderGrid();
        return;
      }
      opener = { id, foot: true };
      location.hash = `session/${id}`;
      return;
    }
    const card = row.closest('.card');
    if (!card) return;
    opener = { id: card.dataset.id, sub: row.dataset.sub };
    location.hash = `session/${card.dataset.id}/${row.dataset.sub}`;
  });

  // Motion classes come off when their animation does, cancelled included,
  // so the next change can put them back. Delegated, because a repaint makes
  // new rows; the card's own `entering`/`changed` are handled on the card.
  // The session screen's rows move for the same news, so it listens too.
  const settleSub = (e) => {
    const el = e.target;
    if (!el || !el.classList) return;
    if (e.animationName === 'row-in') {
      if (el.classList.contains('sub')) el.classList.remove('entering');
      else if (el.classList.contains('sub-st') && el.parentElement) el.parentElement.classList.remove('changed');
    }
    if (e.animationName === 'tick') el.classList.remove('ticked');
  };
  for (const el of [gridEl, detailEl]) {
    el.addEventListener('animationend', settleSub);
    el.addEventListener('animationcancel', settleSub);
  }

  // Last, deliberately: the card's own controls are matched first, so a
  // control nested inside the title can never be swallowed by it.
  //
  // The id is NOT encodeURIComponent'd. SESSION_ID_RE allows ':', which that
  // would turn into %3A — and the route below matches the raw charset, so
  // encoding here would break every session whose id contains one. Every
  // character the server accepts is already legal in a fragment.
  gridEl.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (!open) return;
    e.preventDefault();
    opener = { id: open.dataset.open };
    location.hash = `session/${open.dataset.open}`;
  });

  function setConnected(ok) {
    connEl.classList.toggle('disconnected', !ok);
    const word = ok ? 'Live' : 'Reconnecting…';
    connEl.title = word;
    // role="status" on the wrapper, so writing the word here announces it.
    const text = document.getElementById('conn-text');
    if (text) text.textContent = word;
  }

  // Deleted/expired workspace: stop reconnecting and say so.
  function renderGone() {
    state.clear();
    order = [];
    returning.clear();
    machines.clear();
    for (const id of focus.keys()) setFocus(id, null);
    subs.clear();
    expanded.clear();
    usage = [];
    renderUsage();
    webhookUrl = '';
    urlEl.textContent = '—';
    connEl.hidden = true;
    if (footerEl) footerEl.hidden = true;
    statsEl.hidden = true;
    paint(statsEl, '');
    setGridMessage(`
      <div class="empty">
        <strong>This board no longer exists</strong>
        It may have been deleted, or expired.<br><br>
        <a href="/">Create a new board</a>
      </div>`);
  }

  // Only trust an explicit 404 (unknown workspace); anything else — network
  // error, 200, 429 — means the workspace may still exist, so keep retrying.
  async function workspaceGone() {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      return res.status === 404;
    } catch {
      return false;
    }
  }

  // SSE with reconnect: on error close the stream and retry with exponential
  // backoff (1s, 2s, 4s… capped at 30s), reset on a successful open.
  let backoff = 1000;
  let sseErrors = 0;

  function connect() {
    const es = new EventSource(`${BASE}/events`);
    let retried = false;

    // An open session screen follows the live session too, but only its
    // subtasks section: the timeline is history, fetched once.
    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse(e.data);
      state.clear();
      for (const s of list) state.set(s.id, s);
      pruneFocus();
      pruneSubs();
      renderGrid();
      paintScreenSubs();
    });

    // A block is gathered once its frame is drawn, so the bar's beat knows
    // the count it rested on before this one landed (gatherBeat).
    es.addEventListener('session', (e) => {
      const s = JSON.parse(e.data);
      const was = state.get(s.id);
      state.set(s.id, s);
      pruneFocus();
      renderGrid();
      if (s.status === 'blocked' && !(was && was.status === 'blocked')) gatherBlock(s.id);
      if (screen && screen.id === s.id) paintScreenSubs();
    });

    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse(e.data);
      state.delete(id);
      setFocus(id, null);
      forgetSubs(id);
      renderGrid();
      if (screen && screen.id === id) paintScreenSubs();
    });

    // Presence: the frame lists the machines online right now (src/app.ts
    // `onlineMachines`), so a reconnect re-seeds them; single frames then keep it
    // current. It is not the whole map, so nothing is cleared — an offline machine
    // dropped here loses the name and `lastSeen` behind "<name> is offline (3m
    // ago)", and its card then tells a user who already installed the listener to
    // install it. One that went offline while the stream was down keeps its name
    // and loses only `lastSeen`: the frame that said when never arrived.
    es.addEventListener('machines', (e) => {
      const online = new Set();
      for (const m of JSON.parse(e.data)) {
        machines.set(m.id, { ...(machines.get(m.id) || {}), ...m });
        online.add(m.id);
      }
      for (const [id, m] of machines) {
        if (m.online && !online.has(id)) machines.set(id, { id, name: m.name, online: false });
      }
      renderGrid();
    });

    // An offline frame carries no name, so the merge keeps the one we had for
    // the "<name> is offline" copy.
    es.addEventListener('machine', (e) => {
      const m = JSON.parse(e.data);
      machines.set(m.id, { ...(machines.get(m.id) || {}), ...m });
      renderGrid();
    });

    es.addEventListener('command_ack', (e) => {
      handleAck(JSON.parse(e.data));
    });

    es.addEventListener('usage', (e) => {
      usage = JSON.parse(e.data);
      renderUsage();
      renameWindows();
    });

    es.onopen = () => {
      backoff = 1000;
      sseErrors = 0;
      setConnected(true);
    };

    es.onerror = async () => {
      if (retried) return;
      retried = true;
      es.close();
      setConnected(false);
      sseErrors += 1;
      // After repeated failures on a workspace page, check whether the
      // workspace itself is gone — if so, stop reconnecting for good.
      if (BASE && sseErrors >= 2 && await workspaceGone()) {
        renderGone();
        return;
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  }

  // Multi-tenant landing: on / with mode "multi", offer to create a board
  // instead of showing an empty dashboard.
  function renderWelcome() {
    connEl.hidden = true;
    if (footerEl) footerEl.hidden = true;
    // The empty <div class="logo"> that used to sit above the title was a
    // gradient square with a purple glow — and the <h1> beneath it already
    // said the name.
    setGridMessage(`
      <div class="welcome">
        <h1>AgStatus</h1>
        <p>Live status board for your coding agents.</p>
        <button class="create-board" id="create-board" type="button">Create a status board</button>
        <div class="welcome-error" id="welcome-error" role="alert"></div>
      </div>`);
    document.getElementById('create-board').addEventListener('click', createBoard);
  }

  // A refused POST /api/workspaces, for the person who clicked. 429 is this
  // address's own hourly budget. 503 is the server's: at capacity, or past the
  // number of new boards it makes in an hour, and then Retry-After says when
  // the next one frees. "Please try again" was wrong for both: the next click
  // fails the same way. landing.html carries the same function.
  function createBoardError(res) {
    if (res.status === 429) return 'Too many boards created from this address. Try again later.';
    if (res.status === 503) {
      const seconds = Number(res.headers && res.headers.get('Retry-After'));
      if (!(seconds > 0)) return "This server isn't taking new boards right now. Try again later.";
      const minutes = Math.ceil(seconds / 60);
      return `This server isn't taking new boards right now. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    return 'Could not create a board. Please try again.';
  }

  async function createBoard() {
    const btn = document.getElementById('create-board');
    const errEl = document.getElementById('welcome-error');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const res = await fetch('/api/workspaces', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !(data.token || data.dashboardUrl)) {
        errEl.textContent = createBoardError(res);
        btn.disabled = false;
        return;
      }
      // Prefer a same-origin path: a misconfigured server PUBLIC_URL in
      // dashboardUrl would strand the user (and their new token) elsewhere.
      location.href = data.token ? `/w/${encodeURIComponent(data.token)}` : data.dashboardUrl;
    } catch {
      errEl.textContent = 'Could not create a board. Please try again.';
      btn.disabled = false;
    }
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(urlEl.textContent || '');
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1200);
    } catch { /* ignore */ }
  });

  setInterval(() => {
    paintTimes();
    // Active cards cross the staleness threshold without any new event. The
    // class is the whole of it: everything a stale card shows is already in its
    // markup, and painted just above. A card with a subagent running carries no
    // data-active-since (patchCard), so this never marks one stale.
    document.querySelectorAll('.card[data-active-since]').forEach((el) => {
      el.classList.toggle('stale', Date.now() - Number(el.dataset.activeSince) > STALE_MS);
    });
    renderUsage(); // keeps the "resets in …" countdowns honest
  }, 15000);

  // Neutral state while the root page can't tell legacy from multi yet.
  function renderConnecting() {
    setConnected(false);
    if (footerEl) footerEl.hidden = true;
    statsEl.hidden = true;
    paint(statsEl, '');
    setGridMessage('<div class="empty">Connecting…</div>');
  }

  let configBackoff = 1000;

  async function init() {
    let cfg = null;
    try {
      const res = await fetch('/api/config');
      if (res.ok) cfg = await res.json();
    } catch { /* handled below */ }

    if (!cfg && !BASE) {
      // On the root page a missing config could be either mode — don't guess
      // (a legacy dashboard on a multi server 404s forever). Retry instead.
      renderConnecting();
      setTimeout(init, configBackoff);
      configBackoff = Math.min(configBackoff * 2, 30000);
      return;
    }
    configBackoff = 1000;

    if (!BASE && cfg.mode === 'multi') {
      renderWelcome();
      return;
    }

    if (footerEl) footerEl.hidden = false;
    webhookUrl = (cfg && cfg.webhookUrl) || `${location.origin}${BASE}/webhook`;
    urlEl.textContent = webhookUrl;
    requiresSecret = Boolean(cfg && cfg.requiresSecret);
    if (requiresSecret) authEl.textContent = '· requires X-Webhook-Secret';
    connect();
  }

  init();

  // ---- usage detail: how limits moved, and where the tokens went ------------
  //
  // Two different units share one time axis on purpose. The bars are tokens a
  // project actually spent (from the agent's own local logs, so they reach back
  // as far as those logs go). The lines are the account-wide plan limit, which
  // only exists from the moment a board starts recording it. They correlate but
  // do not convert: a plan limit weights models and cache reads differently.
  //
  // iOS draws the same screen (UsageDetailView), and the two follow each other
  // closely: the same colours in the same order, the same patterns and marks,
  // the same keys, the same words for a screen reader. A window drawn teal
  // here and lilac there is the drift the shared palette exists to prevent.

  const DETAIL_DAYS = 30;

  // The plan-limit lines take the state colours, in the palette's own terms
  // (they were six hand-typed hex literals once, the old Tailwind-ish set), in
  // Theme.seriesColors' order: done, coding, planning, testing, idle, blocked.
  // The first three are what Claude reports, and they are as far apart as six
  // state colours allow; red, the alarm, comes last, because a red limit line
  // reads as a limit in trouble and only a sixth window draws one.
  //
  // The order used to be done, coding, testing. Blue and teal are 0.056 apart
  // in OKLab (0.044 for a deuteranope), so "week" and "week_fable" drew as one
  // blue line. Blue and lilac, second and third now, are 0.125 apart. All of
  // these are measured on the colours as drawn, 8-bit sRGB, with Machado 2009
  // for colour-blind vision.
  const LINE_COLORS = [
    'var(--st-done)', 'var(--st-coding)', 'var(--st-planning)',
    'var(--st-testing)', 'var(--st-idle)', 'var(--st-blocked)',
  ];

  // Hue is still not enough on its own (the second principle): blue and lilac
  // collapse for a protanope (0.009), and blue and teal meet again from a
  // fourth window on. So each line has its own pattern too, paired with its
  // colour by position as Theme.seriesStroke pairs them: solid, dashed,
  // dotted, dash-dot, long dash, dash-dot-dot. The two most alike, dashed and
  // long dash or dash-dot and dash-dot-dot, fall on colours that hue does
  // tell apart.
  //
  // Lengths run along the path, in px, and the chart draws one px to the px,
  // so these are the marks iOS draws in points. The round caps add half the
  // line's width to each end of a mark: a mark reads 1.75 px longer than
  // written and a gap 1.75 px shorter, and a mark of zero length is a round
  // dot. Every gap reads 3 to 3.5 px, the least that stays open on this line.
  const LINE_WIDTH = 1.75;
  const LINE_DASHES = [
    [],                               // solid
    [4.25, 5.25],                     // dashed: 6 px marks
    [0, 4.5],                         // dotted
    [4.25, 4.75, 0, 4.75],            // dash, dot
    [9.25, 5.25],                     // long dash: 11 px marks
    [4.25, 4.75, 0, 4.75, 0, 4.75],   // dash, dot, dot
  ];

  /** The nth limit line's colour and pattern, in the chart and in its key. */
  const lineStyle = (i) => {
    const dash = LINE_DASHES[i % LINE_DASHES.length];
    return `stroke:${LINE_COLORS[i % LINE_COLORS.length]}`
      + (dash.length ? `;stroke-dasharray:${dash.join(' ')}` : '');
  };

  // A window the board has only just started recording has a single reading,
  // and a point cannot carry a pattern. Every such reading sits on the same
  // day, today, so a mark in the window's colour alone would differ from its
  // neighbours by hue alone until the second day's reading. So each window
  // has a shape as well, paired with its colour and pattern by position as
  // Theme.seriesMarker pairs them: circle, plus, square, triangle, diamond,
  // triangle pointing down. A shape rather than a short sample of the line's
  // pattern: along a time axis a sample spans days, and reads as the run of
  // days it is not.
  //
  // Which shape goes on which colour was measured, on the colours as drawn
  // with Machado 2009 as above. The first four colours meet one another under
  // one kind of colour-blind vision or another (blue comes within 0.05 of
  // lilac, teal and green), so they take one shape of each kind, and blue,
  // which meets the most, takes the plus, the shape least like the rest. The
  // two pairs alike in shape, square and diamond, triangle up and down, fall
  // on colours that stay 0.128 and 0.143 apart. Red takes the triangle that
  // points down: pointing up, a red triangle is a warning sign.
  //
  // Each covers about what an 8 px circle does, 43 to 52 px², so no window's
  // mark outweighs another's. A triangle sits on its centroid, which is where
  // the eye puts it. The sizes are Theme's, point for point, at the board's
  // 11 px type; a mark grows with the plot, at half the rate of the text, so
  // a reader who enlarges the text can still tell its shape.
  const LINE_MARKS = ['circle', 'plus', 'square', 'triangle', 'diamond', 'triangle-down'];
  const TRIANGLE_H = 5 * Math.sqrt(3);   // a 10 px side
  const num = (n) => String(+n.toFixed(3));

  /** Whether a window has a single day's reading: a mark in the chart, not a line. */
  const singleReading = (s) => s.values.filter((v) => v !== null).length === 1;

  /**
   * The nth window's mark, as a path centred on (cx, cy), `k` times its size
   * at 11 px type. One absolute point and then relative steps, so a mark and
   * its key differ in that point alone.
   */
  function markPath(i, cx, cy, k = 1) {
    const from = (dx, dy) => `M${num(cx + dx * k)} ${num(cy + dy * k)}`;
    const by = (...steps) => steps.map((n) => num(n * k)).join(' ');
    const h = TRIANGLE_H;
    switch (LINE_MARKS[i % LINE_MARKS.length]) {
      case 'circle':
        return `${from(-4, 0)}a${by(4, 4)} 0 1 0 ${by(8, 0)}a${by(4, 4)} 0 1 0 ${by(-8, 0)}Z`;
      case 'plus':        // arms 3.25 px thick, 9.5 px across
        return `${from(-1.625, -4.75)}h${by(3.25)}v${by(3.125)}h${by(3.125)}v${by(3.25)}`
          + `h${by(-3.125)}v${by(3.125)}h${by(-3.25)}v${by(-3.125)}`
          + `h${by(-3.125)}v${by(-3.25)}h${by(3.125)}Z`;
      case 'square':
        return `${from(-3.6, -3.6)}h${by(7.2)}v${by(7.2)}h${by(-7.2)}Z`;
      case 'triangle':
        return `${from(0, (-h * 2) / 3)}l${by(5, h)}h${by(-10)}Z`;
      case 'diamond':
        return `${from(0, -5)}l${by(5, 5)}l${by(-5, 5)}l${by(-5, -5)}Z`;
      default:            // triangle pointing down
        return `${from(0, (h * 2) / 3)}l${by(5, -h)}h${by(-10)}Z`;
    }
  }

  /**
   * A single reading's key: its mark, as the chart draws it, without the
   * casing, which on the card it sits on draws nothing. In the key a triangle
   * is centred on its box rather than its centroid, beside the name. The box
   * grows with the text as the chart's marks do (`.dv-swatch-mark`). While a
   * window has one reading it keys the legend and heads the window's column
   * in the table of days, where `keySample` does once it has two. For eyes:
   * the table's head is not hidden from a screen reader, so the key itself is.
   */
  const MARK_KEY = 12;
  function keyMark(i) {
    const shape = LINE_MARKS[i % LINE_MARKS.length];
    const lift = shape === 'triangle' ? TRIANGLE_H / 6 : shape === 'triangle-down' ? -TRIANGLE_H / 6 : 0;
    return `<svg class="dv-swatch dv-swatch-mark" width="${MARK_KEY}" height="${MARK_KEY}"`
      + ` viewBox="0 0 ${MARK_KEY} ${MARK_KEY}" aria-hidden="true">`
      + `<path class="dv-mark" d="${markPath(i, MARK_KEY / 2, MARK_KEY / 2 + lift)}"`
      + ` style="fill:${LINE_COLORS[i % LINE_COLORS.length]}" /></svg>`;
  }

  /**
   * A limit line's key: a sample of the line, drawn as the chart draws it, so
   * key and line match by shape as well as by hue. It holds as many whole
   * marks as fit, so no key ends in a stub that reads as another pattern — a
   * long dash cut short is a dash. Theme's SeriesSwatch, mark for mark.
   * It keys the legend, and heads the window's column in the table of days,
   * once the window has a second reading; before that its mark does
   * (`keyMark`), as the chart draws no line for it.
   */
  const KEY_W = 26;
  const KEY_H = 6;
  function keySample(i) {
    const dash = LINE_DASHES[i % LINE_DASHES.length];
    let length = KEY_W;                 // as drawn, caps included
    if (dash.length) {
      length = LINE_WIDTH;
      for (let step = 0, along = 0; step < 64; step++) {
        const segment = dash[step % dash.length];
        if (step % 2 === 0) {
          if (along + segment + LINE_WIDTH > KEY_W) break;
          length = along + segment + LINE_WIDTH;
        }
        along += segment;
      }
    }
    const x1 = (KEY_W - length) / 2 + LINE_WIDTH / 2;
    return `<svg class="dv-swatch" width="${KEY_W}" height="${KEY_H}" viewBox="0 0 ${KEY_W} ${KEY_H}"`
      + ' aria-hidden="true">'
      + `<line class="dv-line" x1="${x1}" x2="${x1 + length - LINE_WIDTH}" y1="${KEY_H / 2}"`
      + ` y2="${KEY_H / 2}" style="${lineStyle(i)}" /></svg>`;
  }

  const dayLabel = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  /** The `days` UTC days ending today, oldest first. */
  function dayRange(days) {
    const out = [];
    const today = Date.parse(`${utcDay(Date.now())}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) out.push(utcDay(today - i * 86400000));
    return out;
  }

  /** Step-samples a recorded series onto the day grid; null before it starts. */
  function sampleSeries(points, days) {
    return days.map((day) => {
      const end = Date.parse(`${day}T23:59:59Z`);
      let value = null;
      for (const p of points) {
        if (p.at <= end) value = p.usedPct;
        else break;
      }
      return value;
    });
  }

  // ---- The chart, drawn at its own size -------------------------------------
  //
  // One px to the px, and drawn again whenever its width changes. It was a
  // fixed 720×220 viewBox scaled by CSS, which on a phone, in a 325 px card,
  // drew everything at 0.45: the axis labels at 4.5 px, the lines under a pixel
  // wide and the plot 81 px tall — and no one dash length can read the same
  // there and on a monitor, where the same viewBox drew at 1.31. Drawn at its
  // size, its labels are the board's 11 px tick type and its patterns the same
  // marks everywhere, as iOS's Canvas draws them in points.

  const GRID_PCTS = [0, 25, 50, 75, 100];

  // The usage detail on screen, if one is: what it draws, and the observer
  // that draws it again at a new width.
  let shown = null;

  /** Forgets the chart on screen, which is leaving or being replaced. */
  function stopChart() {
    if (shown && shown.observer) shown.observer.disconnect();
    shown = null;
  }

  let measurer;
  /** A label's width as drawn in `font`; erring wide where nothing can measure. */
  function textWidth(text, font, size) {
    if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d');
    if (!measurer) return text.length * size * 0.6;
    measurer.font = font;
    return measurer.measureText(text).width;
  }

  /** `model` as an SVG `width` px wide, its type taken from `style`. */
  function chartMarkup(model, width, style) {
    const { days, tokens, maxTokens, series } = model;
    const size = parseFloat(style.fontSize) || 11;
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const measure = (text) => textWidth(text, font, size);
    const at = (n) => n.toFixed(1);
    const line = Math.round(size * 1.2);   // a label's line: 13 px at 11 px
    // The plot grows at half the rate of the text, so the lines gain room as
    // the labels do, and a single reading's mark grows with it. Today's mark
    // reaches past the plot's right edge, so the gap before the percentages
    // grows by the same rule and the mark never meets "100%".
    const grow = 1 + (size / 11 - 1) / 2;
    const gap = 6 * grow;

    // Every label is measured before anything is placed, so the insets are
    // what the reader's text size makes them. A date is centred under its day,
    // and the end days sit near the plot's edges, so half a date has to fit
    // beside the plot as well.
    const topLabel = fmtTokens(maxTokens);
    const dates = days.map(dayLabel);
    const widestDate = Math.max(0, ...dates.map(measure));
    const L = Math.ceil(Math.max(Math.max(measure(topLabel), measure('0')) + 8, widestDate / 2));
    const R = Math.ceil(Math.max(Math.max(...GRID_PCTS.map((p) => measure(`${p}%`))) + gap, widestDate / 2));
    const T = Math.ceil(line / 2) + 1;
    const plotW = width - L - R;
    if (plotW < 2) return '';
    // A quarter of the width, which is what the old viewBox gave its plot, and
    // never under the 150 px iOS gives its own.
    const plotH = Math.round(Math.max(150, width / 4) * grow);
    const bottom = T + plotH;
    // Under the plot: half a label for "0%", a gap, and the dates.
    const H = bottom + Math.ceil(line / 2) + 3 + line + 1;

    // A day is a bar's width, at most 24 px however few the days, and the
    // first and last days sit half a bar in from the plot's edges. Centred on
    // the edges, as they were, half the last bar ran under "100%".
    const last = days.length - 1;
    const barW = Math.min(24, Math.max(2, (plotW / days.length) * 0.62));
    const step = last > 0 ? (plotW - barW) / last : 0;
    const x = (i) => (last === 0 ? L + plotW / 2 : L + barW / 2 + step * i);
    const y = (pct) => bottom - (Math.min(100, Math.max(0, pct)) / 100) * plotH;

    const grid = GRID_PCTS.map((p) => `
      <line class="dv-grid" x1="${L}" x2="${width - R}" y1="${at(y(p))}" y2="${at(y(p))}" />
      <text class="dv-axis" x="${at(width - R + gap)}" y="${at(y(p))}" dy="0.35em">${p}%</text>`).join('');

    const axis = `
      <text class="dv-axis" x="${L - 8}" y="${T}" dy="0.35em" text-anchor="end">${escape(topLabel)}</text>
      <text class="dv-axis" x="${L - 8}" y="${bottom}" dy="0.35em" text-anchor="end">0</text>`;

    const bars = tokens.map((v, i) => {
      if (!(v > 0)) return '';
      const h = Math.max(1, (v / maxTokens) * plotH);
      return `<rect class="dv-bar" x="${at(x(i) - barW / 2)}" y="${at(bottom - h)}" width="${at(barW)}"
        height="${at(h)}" rx="1.5"><title>${escape(dates[i])}: ${escape(fmtTokens(v))} tokens</title></rect>`;
    }).join('');

    // One per limit window, over the bars, each in its own colour and pattern.
    // Each is cased in the card's colour first, so it holds where it crosses a
    // bar and passes visibly over the lines drawn before it.
    const lines = series.map((s) => {
      const points = [];
      s.values.forEach((v, i) => { if (v !== null) points.push([x(i), y(v)]); });
      if (points.length === 0) return '';
      if (singleReading(s)) {
        // A board that has only just started recording a window has one
        // reading, and a path with a single moveto draws nothing at all: mark
        // it with the window's shape, cased as a line is.
        const d = markPath(s.index, points[0][0], points[0][1], grow);
        return `<path class="dv-mark-case" d="${d}" />`
          + `<path class="dv-mark" d="${d}" style="fill:${LINE_COLORS[s.index % LINE_COLORS.length]}" />`;
      }
      const d = `M${points.map(([px, py]) => `${at(px)} ${at(py)}`).join('L')}`;
      return `<path class="dv-case" d="${d}" /><path class="dv-line" d="${d}" style="${lineStyle(s.index)}" />`;
    }).join('');

    // Dates every seventh day, every fourteenth or more where a week's room no
    // longer holds one, and the last day too when its date clears the one
    // before it.
    const room = widestDate + 10;
    const every = step > 0 ? 7 * Math.max(1, Math.ceil(room / (7 * step))) : 1;
    const ticks = [];
    for (let i = 0; i <= last; i += every) ticks.push(i);
    const final = ticks[ticks.length - 1];
    if (final !== last && (last - final) * step >= room) ticks.push(last);
    const dateY = at(H - 1 - line / 2);
    const xTicks = ticks.map((i) => `
      <text class="dv-axis" x="${at(x(i))}" y="${dateY}" dy="0.35em" text-anchor="middle">${escape(dates[i])}</text>`).join('');

    return `<svg class="dv-chart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" aria-hidden="true">
      ${grid}${axis}${bars}${lines}${xTicks}
    </svg>`;
  }

  /**
   * What the board's own block calls each of an agent's windows, by id. One
   * the board no longer reports has no name here and keeps its id, as its key
   * does.
   */
  function windowNames(source) {
    return new Map(((usage.find((u) => u.source === source) || {}).windows || [])
      .map((w) => [w.id, w.label || w.id]));
  }

  /**
   * What a screen reader has in the chart's place, as VoiceOver has on iOS:
   * the two measures as two summaries, because tokens and a plan limit's
   * percentage do not convert (the fourth principle) and are not put on one
   * scale for the ear either. A window goes by the name the board's own block
   * gives it. Every day's figures follow, in the table below.
   */
  function spokenMarkup(source, name, model) {
    const { days, tokens, series } = model;
    const labels = windowNames(source);
    const total = tokens.reduce((a, b) => a + b, 0);
    let busiest = 0;
    tokens.forEach((v, i) => { if (v > tokens[busiest]) busiest = i; });
    const tokensText = total > 0
      ? `${name} tokens per day over the last ${days.length} days. ${fmtTokens(total)} tokens `
        + `in total; the busiest day, ${dayLabel(days[busiest])}, ${fmtTokens(tokens[busiest])}.`
      : `${name} tokens per day over the last ${days.length} days: none reported.`;
    // Each window's latest reading and its highest day, and since when the
    // board has recorded it where that is inside the range: a line starts
    // partway because a board only knows the limits it has seen.
    const readings = series.map((s) => {
      const seen = s.values.filter((v) => v !== null);
      if (seen.length === 0) return '';
      const first = s.values.findIndex((v) => v !== null);
      const since = first > 0 ? `, since ${dayLabel(days[first])}` : '';
      return `<li>${escape(`${labels.get(s.windowId) || s.windowId}${since}: `
        + `${Math.round(seen[seen.length - 1])}% at the latest reading, `
        + `${Math.round(Math.max(...seen))}% on the highest day.`)}</li>`;
    }).join('');
    return `<p>${escape(tokensText)}</p>${readings ? `
      <p>${escape(`${name} plan limit used, by day, over the last ${days.length} days.`)}</p>
      <ul>${readings}</ul>` : ''}`;
  }

  /** Whether there is a figure to put in a table: a token spent, or a reading. */
  const hasFigures = (model) => model.tokens.some((v) => v > 0)
    || model.series.some((s) => s.values.some((v) => v !== null));

  /**
   * The chart's figures, a day to a row, for whoever cannot hover a bar for its
   * tooltip: a keyboard, a screen reader, a phone. iOS hands VoiceOver every
   * point as an Audio Graph. The web's way to the same figures is a table, and
   * it is there for eyes too, behind a disclosure under the chart: the chart
   * is the reading, the table the lean-in.
   *
   * Tokens and each window's percentage keep columns of their own, because
   * they do not convert. The newest day comes first, as the session timeline
   * puts its newest event first: today is what the board is checked for. A
   * day's percentage is the window's reading as that day ended, the point its
   * line passes through, printed as the board's block prints it. Before the
   * board first recorded a window its cell is empty, where its line has not
   * started yet, and it tells a screen reader so rather than reading as
   * nothing at all. Each window's column is headed by its block's name and
   * the key the legend gives it, a sample of its line or, while it has a
   * single reading, its mark: what ties it to a legend that shows ids. An
   * agent that reported no tokens at all has no tokens column: thirty zeros
   * would say it spent none, where the card below says none were reported.
   */
  function daysMarkup(source, name, model) {
    const { days, tokens, series } = model;
    const names = windowNames(source);
    const spent = tokens.some((v) => v > 0);
    const windows = series.filter((s) => s.values.some((v) => v !== null));
    const caption = `${name} by day over the last ${days.length} days, newest first: `
      + [spent && 'tokens spent', windows.length > 0 && 'plan limit used as each day ended']
        .filter(Boolean).join(', and ') + '.';
    // A name wraps between its words on a phone and never inside one, where
    // "GPT-6-Astra" left "6-" on a line of its own.
    const words = (text) => escape(text).split(' ')
      .map((word) => `<span class="dv-word">${word}</span>`).join(' ');
    const head = windows.map((s) => `
          <th scope="col">${singleReading(s) ? keyMark(s.index) : keySample(s.index)}${
            words(names.get(s.windowId) || s.windowId)}</th>`).join('');
    const rows = days.map((day, i) => {
      const limits = windows.map((s) => (s.values[i] === null
        ? '<td><span class="sr-only">no reading</span></td>'
        : `<td>${fmtPct(s.values[i])}</td>`)).join('');
      const spend = !spent ? ''
        : `<td${tokens[i] > 0 ? '' : ' class="dv-nil"'}>${escape(fmtTokens(tokens[i]))}</td>`;
      return `
        <tr><th scope="row">${escape(dayLabel(day))}</th>${spend}${limits}</tr>`;
    }).reverse().join('');
    return `<table class="dv-table">
      <caption class="sr-only">${escape(caption)}</caption>
      <thead><tr><th scope="col">Day</th>${spent ? '<th scope="col">Tokens</th>' : ''}${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /**
   * A table too wide for its card, six windows on a phone, scrolls sideways
   * inside the card rather than pushing the page wider, and is then a stop on
   * the Tab order, because a table holds nothing else a keyboard could scroll
   * it by. One that fits is neither a scrolling box nor a Tab stop, and not
   * being a scrolling box is what lets its header row hold at the top of the
   * window while the page scrolls through thirty days. The box scrolls until
   * this has measured it (shell.css says why), and is measured as it opens,
   * as the card's width or the table's own changes, and once the webfonts are
   * in.
   */
  function fitDays() {
    const wrap = document.getElementById('dv-days');
    if (!wrap || !wrap.parentElement.open) return;
    // A pixel over is rounding, and lands in the card's padding unseen.
    const fits = wrap.scrollWidth <= wrap.clientWidth + 1;
    wrap.classList.toggle('fits', fits);
    if (!fits) {
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-labelledby', 'dv-days-toggle');
    } else if (document.activeElement !== wrap) {
      // Kept while it has focus, which would otherwise drop to <body>.
      wrap.removeAttribute('tabindex');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-labelledby');
    }
  }

  /**
   * Names the windows again once the board's usage frame is in, in the
   * summaries and over the table's columns. A detail opened straight from its
   * address can draw before that frame lands, and would otherwise go on
   * calling every window by its id. The table is painted inside its
   * disclosure, which stays open if it was.
   */
  function renameWindows() {
    if (!shown) return;
    const spoken = document.getElementById('dv-spoken');
    if (spoken) paint(spoken, spokenMarkup(shown.source, shown.name, shown.model));
    const figures = document.getElementById('dv-days');
    const before = figures && figures.querySelector('table');
    if (figures && paint(figures, daysMarkup(shown.source, shown.name, shown.model))) {
      if (shown.observer) {
        shown.observer.unobserve(before);
        shown.observer.observe(figures.querySelector('table'));
      }
      fitDays();
    }
  }

  function renderDetail(source, data) {
    stopChart();
    const days = dayRange(data.days || DETAIL_DAYS);
    const name = agentName(source);

    // Tokens per day for this source, and the per-project totals beside it.
    const perDay = new Map(days.map((d) => [d, 0]));
    const perProject = new Map();
    for (const row of data.projects || []) {
      if (row.source !== source) continue;
      if (perDay.has(row.day)) perDay.set(row.day, perDay.get(row.day) + row.tokens);
      perProject.set(row.project, (perProject.get(row.project) || 0) + row.tokens);
    }
    const daily = days.map((d) => perDay.get(d));
    const totalTokens = daily.reduce((a, b) => a + b, 0);
    const model = {
      days,
      tokens: daily,
      maxTokens: Math.max(1, ...daily),
      series: (data.history || []).filter((h) => h.source === source)
        .map((s, index) => ({ windowId: s.windowId, values: sampleSeries(s.points, days), index })),
    };

    // The keys wrap as words do: one row where they fit, a new row where the
    // next does not, and an id never breaks while it fits a row of its own.
    // Each is what the chart draws for its window: a sample of its line, or
    // its mark while it has a single reading. They are for eyes. A screen
    // reader hears every window named, with its readings, from the chart's
    // own text below.
    const legend = model.series.length === 0
      ? '<span class="dv-legend"><span class="dv-key-none">limit history starts once reported</span></span>'
      : `<span class="dv-legend" aria-hidden="true">${model.series.map((s) => {
          const key = singleReading(s) ? keyMark(s.index) : keySample(s.index);
          return `
          <span class="dv-key">${key}<span class="dv-key-id">${escape(s.windowId)}</span></span>`;
        }).join('')}
        </span>`;

    const projects = [...perProject.entries()].sort((a, b) => b[1] - a[1]);
    const topShare = projects.length > 0 ? projects[0][1] : 1;
    const projectRows = projects.length === 0
      ? '<p class="dv-empty">No per-project token data reported yet.</p>'
      : projects.map(([project, tokens]) => `
        <div class="dv-proj">
          <div class="dv-proj-head">
            <span class="dv-proj-name">${escape(project)}</span>
            <span class="dv-proj-val">${escape(fmtTokens(tokens))}
              <span class="dv-proj-pct">${totalTokens ? Math.round((tokens / totalTokens) * 100) : 0}%</span>
            </span>
          </div>
          <div class="dv-proj-track"><div class="dv-proj-fill" style="width:${(tokens / topShare) * 100}%"></div></div>
        </div>`).join('');

    paint(detailEl, `
      <div class="dv-head">
        <button class="dv-back" type="button" id="dv-back" aria-label="Back to the board">‹ Board</button>
        <h2 class="dv-title">${escape(name)} · last ${days.length} days</h2>
      </div>
      <div class="dv-card">
        <div class="dv-card-head">
          <h3 class="dv-card-title">Tokens per day <span class="dv-sub">· ${escape(fmtTokens(totalTokens))} total</span></h3>
          ${legend}
        </div>
        <div class="dv-plot" id="dv-plot"></div>
        <div class="sr-only" id="dv-spoken"></div>
        ${hasFigures(model) ? `<details class="dv-days">
          <summary class="dv-days-toggle" id="dv-days-toggle"><svg class="dv-days-more" width="10" height="10"
            viewBox="0 0 10 10" aria-hidden="true"><path d="M3.75 1.75 7 5 3.75 8.25" /></svg>Each day's figures</summary>
          <div class="dv-days-wrap" id="dv-days"></div>
        </details>` : ''}
      </div>
      <div class="dv-card">
        <div class="dv-card-head"><h3 class="dv-card-title">Where the tokens went</h3></div>
        ${projectRows}
      </div>
      <p class="dv-note">Bars are tokens your agent spent, read from its own local logs.
        Lines are the account-wide plan limit, recorded from when this board first saw it.
        They track each other but are not the same measure.</p>`);

    // The chart is drawn into the card once the card has a width, and again
    // whenever that width changes: a window resized, a phone turned.
    const plot = document.getElementById('dv-plot');
    shown = { source, name, model, observer: null };
    // Through paint, so a usage frame that changes no name leaves it alone.
    paint(document.getElementById('dv-spoken'), spokenMarkup(source, name, model));
    const figures = document.getElementById('dv-days');
    if (figures) {
      paint(figures, daysMarkup(source, name, model));
      figures.parentElement.addEventListener('toggle', fitDays);
    }
    let drawnWidth = 0;
    const draw = () => {
      const width = plot.clientWidth;
      if (!plot.isConnected || width <= 0) return;
      drawnWidth = width;
      paint(plot, chartMarkup(model, width, getComputedStyle(plot)));
      fitDays();   // the card's width is the table's room too
    };
    draw();
    if (typeof ResizeObserver === 'function') {
      shown.observer = new ResizeObserver(() => {
        if (plot.clientWidth !== drawnWidth) draw();
        else fitDays();
      });
      shown.observer.observe(plot);
      // The table's own size too, which changes without the card's when the
      // reader's text size does, and which a table that fits would otherwise
      // carry past the card's edge.
      if (figures) shown.observer.observe(figures.querySelector('table'));
    }
    // A cold load can draw before the webfonts arrive and measure its labels in
    // the fallback face; it draws again once they are in.
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(draw);

    const back = document.getElementById('dv-back');
    back.addEventListener('click', () => { location.hash = ''; });
    // Opening the detail hides `.usage`, including the control that was just
    // pressed, so a keyboard user is dropped back to <body> and has to tab in
    // from the top of the document. This view takes over the whole page, so
    // its Back button is where they should be; applyRoute puts them back on
    // the block they came from when it closes.
    back.focus();
  }

  // ---- Session timeline ----------------------------------------------------
  //
  // The second hash route. It renders into the same `.detail` element and
  // under the same `body.detail-open` as the usage screen, because they are
  // the same thing from the page's point of view: a view that takes over.
  //
  // Mirrors the iOS timeline (SessionHistoryView / HistoryRow) rather than
  // inventing a second design — a gutter line with a state-coloured dot, the
  // state's own word, when it happened, and what it said. The word is what
  // carries the state here; the dot is a second channel, not the only one.
  //
  // Above the timeline, the session's subtasks, while it has any: painted
  // from the live session rather than from history, and kept current by the
  // stream. `#session/<id>/<subtask>` opens the screen at one of them.

  /** "18:42" today, "26 Jul, 18:42" otherwise — the same split iOS makes. */
  function eventTime(at) {
    const d = new Date(at);
    const hhmm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate();
    if (sameDay) return hhmm;
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${hhmm}`;
  }

  // The session screen while one is open: whose it is, the subtask it was
  // opened at ('' for none), whether that row is still lit, and what its
  // subtasks section last showed.
  let screen = null;   // { id, sub, lit, timer, shown }

  /**
   * The frame of a session's screen: the way back, then the session's
   * subtasks (painted from the live session by paintScreenSubs), then the
   * timeline (painted by paintTimeline once history arrives). The subtasks do
   * not wait for history: they show while it loads, when it is empty and when
   * it failed — states that used to replace the whole screen, Back included.
   */
  function renderSession(id) {
    const s = state.get(id);
    const name = s ? s.name : id;
    const fresh = paint(detailEl, `
      <div class="dv-head">
        <button class="dv-back" type="button" id="dv-back" aria-label="Back to the board">‹ Board</button>
        <h2 class="dv-title" id="dv-title">${escape(name)}</h2>
      </div>
      <section class="dv-subs" id="dv-subs"></section>
      <section class="dv-tl">
        <h3 class="ss-label" id="dv-tl-head" hidden>Timeline</h3>
        <div class="dv-timeline" id="dv-timeline"><p class="dv-empty">Loading…</p></div>
      </section>`);
    if (fresh) document.getElementById('dv-back').addEventListener('click', () => { location.hash = ''; });
  }

  /** The timeline part: the history, or why there is none (`null`: it failed). */
  function paintTimeline(events) {
    const el = document.getElementById('dv-timeline');
    if (!el) return;
    if (!events) {
      paint(el, '<p class="dv-empty">Could not load this session\'s history.</p>');
      return;
    }
    const rows = events.map((e, i) => `
      <li class="tl-row${i === 0 ? ' tl-first' : ''}${i === events.length - 1 ? ' tl-last' : ''} ${statusClass(e.status)}">
        <span class="tl-gutter" aria-hidden="true"><span class="tl-dot"></span></span>
        <span class="tl-body">
          <span class="tl-head">
            <span class="tl-status">${stateMark(e.status)}${escape(e.status)}</span>
            <span class="tl-at">${escape(eventTime(e.at))}</span>
            <span class="tl-ago" data-ts="${Number(e.at)}"></span>
          </span>
          ${e.message ? `<span class="tl-msg">${escape(e.message)}</span>` : ''}
        </span>
      </li>`).join('');

    paint(el, `${events.length === 0
        ? '<p class="dv-empty">No history yet. Events appear here as the agent works.</p>'
        : `<ol class="tl">${rows}</ol>`}
      <p class="dv-note">Every status this session reported, newest first. A session's history
        is bounded and goes when its card does — a card stops being served 24 hours after its
        last update.</p>`);
  }

  /**
   * The subtasks section, from the live session. Blocked first, so the one
   * that needs you is on top — where a phone's footer lands — then the rest
   * in start order, failed included. Plain list items, not controls: this is
   * where a card's row leads. The row the screen was opened at is the one
   * that can take focus (tabindex -1), so focus can land on it and stay on it
   * through the repaints a live session brings.
   */
  function screenSubsHTML(s, at) {
    const sub = subtasksOf(s);
    if (!sub) return '';
    // Each class counted apart: a blocked subagent is not running, it is
    // waiting on you. The counts are the server's, not the list's length.
    const count = [[sub.running, 'running'], [sub.blocked, 'blocked'], [sub.failed, 'failed']]
      .filter(([k]) => k > 0).map(([k, word]) => `${k} ${word}`).join(' · ');
    const list = [
      ...sub.items.filter((x) => x.state === 'blocked'),
      ...sub.items.filter((x) => x.state !== 'blocked'),
    ];
    const rows = list.map((x) => `<li class="sub is-roomy st-${x.state}" data-sub="${escape(x.id)}"${
      x.id === at ? ' tabindex="-1"' : ''} aria-label="${escape(rowName(x))}">${rowInner(x)}</li>`).join('');
    return `<h3 class="ss-label">Subtasks${count ? ` <span class="ss-count">${count}</span>` : ''}</h3>`
      + (rows ? `<ul class="ss-list">${rows}</ul>` : '')
      + (sub.done > 0 ? `<p class="ss-done"><span class="n" data-count="done">${sub.done}</span> done this turn</p>` : '');
  }

  /** Repaints the open screen's subtasks, and nothing else: not the timeline. */
  function paintScreenSubs() {
    if (!screen) return;
    const el = document.getElementById('dv-subs');
    if (!el) return;
    const s = state.get(screen.id);
    const sub = subtasksOf(s);
    const html = screenSubsHTML(s, screen.sub);
    // What the section showed before, kept as a card keeps it, so a repaint
    // moves the same news a card's does: undefined until its first paint,
    // which has none, and null while there was no section.
    const before = screen.shown;
    screen.shown = sub
      ? { rows: new Map(sub.items.map((x) => [x.id, x.state])), counts: { done: sub.done } }
      : null;
    const held = el.contains(document.activeElement);
    if (paint(el, html)) {
      // Focus was on the arrived row, and it has finished. No other row here
      // can hold focus (only the arrived one is given tabindex), so it goes
      // to Back, where a screen whose subtask had already gone opens, rather
      // than dropping to <body> and the top of the document.
      if (held && !el.contains(document.activeElement)) {
        const back = document.getElementById('dv-back');
        if (back) back.focus({ preventScroll: true });
      }
      if (before !== undefined && sub) moveSubs(el, before, screen.shown);
    }
    // The timeline takes a heading only while a section above it needs
    // telling apart from it.
    const head = document.getElementById('dv-tl-head');
    if (head) head.hidden = html === '';
    // A screen opened before the first frame could only title itself by id.
    const title = document.getElementById('dv-title');
    if (title && s && title.textContent !== s.name) title.textContent = s.name;
    // A repaint inside the lit two seconds made a new row: light that one.
    if (screen.lit) {
      const row = el.querySelector(`[data-sub="${screen.sub}"]`);
      if (row) row.classList.add('is-arrived');
    }
  }

  /**
   * Arrived from a card's row: that row, scrolled to the middle and focused,
   * its ground lit for two seconds and then let go — faded out, or at once
   * with reduced motion (shell.css). A later repaint does not light it again.
   */
  function arrive(here, row) {
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
    row.focus();
    row.classList.add('is-arrived');
    here.lit = true;
    here.timer = setTimeout(() => {
      here.lit = false;
      if (screen !== here) return;
      const now = document.querySelector(`#dv-subs [data-sub="${here.sub}"]`);
      if (now) now.classList.add('is-settled');
    }, ARRIVAL_MS);
  }

  function closeScreen() {
    if (screen) clearTimeout(screen.timer);
    screen = null;
  }

  async function openSession(id, sub) {
    detailEl.hidden = false;
    closeScreen();
    const here = { id, sub, lit: false, timer: 0 };
    screen = here;
    renderSession(id);
    paintScreenSubs();
    // A subtask that is gone by the time the screen opens gets no highlight,
    // and the screen opens at the top, on Back — the same as the usage
    // detail, since the control that opened it is hidden now.
    const row = sub ? document.querySelector(`#dv-subs [data-sub="${sub}"]`) : null;
    if (row) arrive(here, row);
    else document.getElementById('dv-back').focus();
    let events = null;
    try {
      const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}/history`);
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      events = Array.isArray(list) ? list : [];
    } catch { /* painted as the timeline's own error, below */ }
    if (screen !== here) return;   // a newer route took the surface meanwhile
    paintTimeline(events);
  }

  async function openDetail(source) {
    detailEl.hidden = false;
    paint(detailEl, '<p class="dv-empty">Loading…</p>');
    try {
      const res = await fetch(`${BASE}/api/usage/history?days=${DETAIL_DAYS}`);
      if (!res.ok) throw new Error(String(res.status));
      renderDetail(source, await res.json());
    } catch {
      paint(detailEl, '<p class="dv-empty">Could not load usage history.</p>');
    }
  }

  /** Two detail routes, one surface. Back returns to the board from either. */
  // Remembered so closing can return focus to the control that opened it,
  // which is no longer on screen by the time the route changes.
  let lastSource = '';
  let lastSession = '';
  // And for a session screen, which control on its card it was: { id } for
  // the title, plus `foot` or `sub` for the subagent footer or one of the
  // rows. Set by the click, so a screen reached any other way (a link, the
  // browser's back button) returns to the title.
  let opener = null;

  // The server's own session-id charset (SESSION_ID_RE in src/app.ts), then
  // optionally a subagent's key, for a screen opened at that subtask. Every
  // character in either is safe unescaped inside a quoted attribute selector,
  // and none of them is a quote — which is what lets the focus-return below
  // build one by interpolation.
  const SESSION_HASH_RE = /^#session\/([A-Za-z0-9._:-]{1,128})(?:\/([A-Za-z0-9._:-]{1,64}))?$/;

  /** The control a closed session screen hands focus back to: its opener, else the title. */
  function sessionOpener(id) {
    const card = gridEl.querySelector(`.card[data-id="${id}"]`);
    if (!card) return null;
    const o = opener && opener.id === id ? opener : null;
    const again = (o && o.foot && card.querySelector('[data-foot]'))
      || (o && SUB_ID_RE.test(o.sub || '') && card.querySelector(`[data-sub="${o.sub}"]`));
    // A row that finished while the screen was open, or a footer that is no
    // longer a control, has gone: the title is always there.
    return again || card.querySelector('[data-open]');
  }

  function applyRoute() {
    const m = /^#usage\/([a-z][a-z0-9_-]*)$/.exec(location.hash);
    const sm = SESSION_HASH_RE.exec(location.hash);
    if (m) lastSource = m[1];
    if (sm) lastSession = sm[1];
    const showing = Boolean(m || sm);
    stopChart();   // whatever comes next, the chart on screen now is leaving
    document.body.classList.toggle('detail-open', showing);
    if (!sm) closeScreen();
    if (m) openDetail(m[1]);
    else if (sm) openSession(sm[1], sm[2] || '');
    else { detailEl.hidden = true; paint(detailEl, ''); }
    // Opening the detail hides `.usage` — including the button that was just
    // pressed — so without this the keyboard user is dropped back to <body>
    // and has to tab in from the top of the document. Closing it puts them
    // back on the block they came from.
    // Closing: put them back on the block they opened. (Opening is handled in
    // renderDetail, which is where the Back button comes into existence —
    // openDetail is async and there is nothing to focus until it resolves.)
    // No CSS.escape needed: the regex above already constrains lastSource to
    // [a-z][a-z0-9_-]*, which is selector-safe by construction.
    if (!showing) {
      const land = lastSession
        ? sessionOpener(lastSession)
        : lastSource
          ? usageEl.querySelector(`[data-source="${lastSource}"] .usage-open`)
          : null;
      if (land) land.focus();
      lastSession = '';
      opener = null;
    }
  }

  // One handler: a real button answers Enter and Space itself, so the keydown
  // shim that used to be needed for role="button" is gone with it.
  usageEl.addEventListener('click', (e) => {
    const open = e.target.closest('.usage-open');
    if (open) location.hash = `usage/${open.dataset.source}`;
  });
  window.addEventListener('hashchange', applyRoute);
  applyRoute();

})();
