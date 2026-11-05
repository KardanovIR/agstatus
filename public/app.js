(() => {
  'use strict';

  const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];
  const ACTIVE_STATUSES = new Set(['planning', 'coding', 'testing']);
  // An active card gone quiet for this long is probably a dead agent
  // (killed mid-turn, crashed machine) — stop pulsing and dim it.
  const STALE_MS = 10 * 60 * 1000;

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

  const fmtTokens = (n) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  };

  /** Every [data-ts] on the page, or inside one element, retimed. */
  function paintTimes(root) {
    (root || document).querySelectorAll('[data-ts]').forEach((el) => {
      el.textContent = relTime(Number(el.dataset.ts));
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
  const { STATE_MARK = {}, ICON = {} } = window.AGSTATUS_MARKS || {};

  // Only a known status becomes a class or picks a mark. The server validates
  // the enum, but this is a string off the network going into classList.add,
  // which throws on anything containing a space — and a throw in the render
  // loop would take every card after this one down with it. The old code
  // interpolated it into a class attribute and could not throw; this can.
  //
  // An unrecognised status keeps its card, shows its own word in the badge and
  // simply matches no rule, which is the fallback tokens.css already describes:
  // an unknown should sit quiet rather than claim a state it is not in.
  const statusClass = (v) => (STATUSES.includes(v) ? `status-${v}` : '');
  const stateMark = (v) => STATE_MARK[STATUSES.includes(v) ? v : 'idle'] || '';

  const sourceChip = (source) => {
    const key = String(source || 'claude').toLowerCase();
    const mark = key.startsWith('codex') ? ICON.codex : ICON.claude;
    return `<span class="source">${mark}${escape((SOURCE_NAMES[key] || key).toUpperCase())}</span>`;
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
  function focusKey(node) {
    const d = node.dataset || {};
    if (SAFE.test(d.type || '')) return `[data-type="${d.type}"]`;
    if (d.dismiss !== undefined) return '[data-dismiss]';
    if (d.open !== undefined) return '[data-open]';
    if (SAFE.test(d.source || '')) return `[data-source="${d.source}"]`;
    if (SAFE.test(node.id || '')) return `#${node.id}`;
    return null;
  }

  function paint(el, html) {
    if (painted.get(el) === html) return false;
    const key = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    el.innerHTML = html;
    painted.set(el, html);
    paintTimes(el);
    if (key) {
      const again = el.querySelector(key);
      if (again) again.focus();
    }
    return true;
  }

  // Live cards, keyed by session id: { el, inner }.
  const cards = new Map();

  /** A message in place of the grid; clears the reconciler with it. */
  function setGridMessage(html) {
    cards.clear();
    paint(gridEl, html);
  }

  // ---- plan usage limit bars ------------------------------------------------

  const SOURCE_NAMES = { claude: 'Claude', codex: 'Codex' };
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

  function renderUsage() {
    // Only show limits for agents that actually have sessions on the board —
    // a Claude-only evening doesn't need Codex bars. With no sessions there is
    // nothing to disambiguate, and the limits still matter between runs, so
    // show everything rather than nothing.
    const active = new Set();
    for (const s of state.values()) active.add(s.source || 'claude');
    const blocks = [];
    for (const u of usage) {
      if (active.size > 0 && !active.has(u.source)) continue;
      const bars = (u.windows || []).map((w) => {
        const pct = Math.min(100, Math.max(0, Number(w.usedPct) || 0));
        const pctText = pct % 1 ? pct.toFixed(1) : String(pct);
        const reset = w.resetsAt ? fmtReset(w.resetsAt) : '';
        // board.css's .meter, which is what it was written for: "a percentage
        // of an unknown quota — never a token count". scaleX rather than width,
        // because width is a layout property and animating it relayouts the
        // block on every frame of the transition.
        return `
          <div class="meter">
            <div class="meter-head">
              <span class="meter-label">${escape(w.label || w.id)}</span>
              <span class="meter-value">${pctText}%${
                reset ? ` <span class="usage-reset">· ${escape(reset)}</span>` : ''
              }</span>
            </div>
            <div class="meter-track">
              <div class="meter-fill ${usageLevel(pct)}" style="transform:scaleX(${(pct / 100).toFixed(4)})"></div>
            </div>
          </div>`;
      });
      if (bars.length === 0) continue;
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
      const label = escape(SOURCE_NAMES[u.source] || u.source);
      blocks.push(`
        <section class="usage-block" data-source="${escape(u.source)}">
          <h2 class="usage-src"><button class="usage-open" type="button" data-source="${escape(u.source)}"
            >${label}<span class="usage-more" aria-hidden="true">›</span></button></h2>
          ${bars.join('')}
        </section>`);
    }
    paint(usageEl, blocks.join(''));
    usageEl.hidden = blocks.length === 0;
  }

  // All six always, even at zero. A legend that reflows every time a count
  // changes is movement reporting nothing, and this board animates only when
  // something actually happened — so the zeros recede instead of leaving.
  //
  // It also has to be unhidden. The markup carries `hidden` for the moment
  // before the first frame, and the old stylesheet's `.stats { display: flex }`
  // quietly outranked the UA's [hidden] rule, so it showed anyway. board.css
  // makes [hidden] `!important`, which is correct and would have hidden this
  // row for good.
  function renderStats(list) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
    paint(statsEl, STATUSES
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

  // The facts under the title, in the order you would ask for them: which
  // agent, which machine, how long ago, how much.
  //
  // `project` is shown only when it differs from the name. The hook once built
  // one value and sent it under both keys, so the old meta line repeated the
  // card's own title on every card, forever. They answer different questions
  // now: `name` is the session's title when the agent has one (the Claude app
  // titles every session, `/rename` titles one in the CLI) and the folder it
  // started in otherwise, while `project` follows the live directory — with a
  // Claude worktree root reported as its repository, never as the folder name
  // the app made up. So a titled card reads "in <repo>", which is where that
  // work is happening. An untitled one grows the directory once the session
  // has moved, and also from its first event at a worktree root, where the
  // name is the worktree's own folder and the project its repository
  // ("feature-x · in my-repo"); any other untitled session that never left
  // home shows nothing extra.
  function cardMeta(s) {
    const facts = [];
    if (s.host && s.host.machine) {
      const host = machineLabel(s.host);
      facts.push(`<span class="host" title="${escape(host)}">${escape(host)}</span>`);
    }
    if (s.project && s.project !== s.name) {
      facts.push(`<span class="proj" title="${escape(s.project)}">in ${escape(s.project)}</span>`);
    }
    // Left empty on purpose: paintTimes fills it, here and on the 15s tick, so
    // the markup this card is compared against does not change every minute
    // purely because a label aged.
    facts.push(`<span class="ts" data-ts="${s.updatedAt}"></span>`);
    // Absent, not zero, when nothing was reported — a card must never claim a
    // session spent nothing. These are tokens the agent's own logs attribute to
    // it, and they are NOT a share of a plan limit: the two measures do not
    // convert, so this carries its unit and no denominator.
    if (typeof s.tokens === 'number') {
      facts.push(`<span class="tok">${escape(fmtTokens(s.tokens))} tokens</span>`);
    }
    return `<div class="meta">${sourceChip(s.source)}`
      + facts.map((f) => `<span class="meta-sep">·</span>${f}`).join('')
      + '</div>';
  }

  // The name is first and largest — it is how you know WHICH session this is,
  // and the state only matters once you have found the right card. They were on
  // one line before, competing for width, and the name was what truncated.
  function cardInner(s) {
    return `<div class="card-head">
        <div class="card-title-row">
          <button class="name-open" type="button" data-open="${escape(s.id)}"
                  aria-label="${escape(`${s.name} — open this session's history`)}"
            ><span class="name" title="${escape(s.name)}">${escape(s.name)}</span
            ><span class="name-more" aria-hidden="true">›</span></button>
          <button class="dismiss" type="button" data-dismiss="${escape(s.id)}" aria-label="Dismiss session" title="Dismiss">×</button>
        </div>
        <div class="card-state-row">${stateMark(s.status)}<span class="badge">${escape(s.status)}</span></div>
      </div>${
        s.message ? `<p class="message">${escape(s.message)}</p>` : ''
      }${cardMeta(s)}${renderFocus(s)}`;
  }

  function patchCard(rec, s) {
    const { el } = rec;
    const prev = el.dataset.status;
    if (prev !== s.status) {
      if (prev) {
        const gone = statusClass(prev);
        if (gone) el.classList.remove(gone);
        // One brief lift of the card's own edge, and only on a real change —
        // never on a card's first paint, where there is no news yet. The class
        // is removed on `animationend`, which is what lets the next change
        // re-trigger it without a forced reflow inside this loop.
        el.classList.add('changed');
      }
      const now = statusClass(s.status);
      if (now) el.classList.add(now);
      el.dataset.status = s.status;
    }
    const active = ACTIVE_STATUSES.has(s.status);
    if (active) el.dataset.activeSince = String(s.updatedAt);
    else delete el.dataset.activeSince;
    el.classList.toggle('stale', active && Date.now() - s.updatedAt > STALE_MS);

    const inner = cardInner(s);
    if (rec.inner === inner) return;
    rec.inner = inner;
    paint(el, inner);
  }

  function renderGrid() {
    const list = Array.from(state.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    renderStats(list);
    renderUsage(); // session changes can change which sources' bars are shown
    if (list.length === 0) { renderEmpty(); return; }

    // Whatever message block was showing is not a card, so it goes first.
    if (cards.size === 0 && gridEl.firstChild) paint(gridEl, '');

    let anchor = null;
    for (const s of list) {
      let rec = cards.get(s.id);
      if (!rec) {
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
      // Ordering in one pass. insertBefore on a node already in place would
      // still reparent it, which restarts nothing but is work for nothing.
      const next = anchor ? anchor.nextSibling : gridEl.firstChild;
      if (next !== rec.el) gridEl.insertBefore(rec.el, next);
      anchor = rec.el;
    }

    for (const [id, rec] of cards) {
      if (state.has(id)) continue;
      rec.el.remove();
      cards.delete(id);
    }
  }

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
    state.delete(id);
    // The card is going now, so its focus state and pending timers go with it:
    // waiting for the server's `remove` leaves them alive for as long as the SSE
    // backoff (up to 30s) while this DELETE succeeds anyway. Sessions are only
    // soft-deleted and resurrect on the next post, and the card that comes back
    // must not be wearing the status — or the Resume button — of a dead tap.
    setFocus(id, null);
    renderGrid();
    try {
      const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await refreshSessions();
    } catch {
      await refreshSessions();
    }
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
    machines.clear();
    for (const id of focus.keys()) setFocus(id, null);
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

    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse(e.data);
      state.clear();
      for (const s of list) state.set(s.id, s);
      pruneFocus();
      renderGrid();
    });

    es.addEventListener('session', (e) => {
      const s = JSON.parse(e.data);
      state.set(s.id, s);
      pruneFocus();
      renderGrid();
    });

    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse(e.data);
      state.delete(id);
      setFocus(id, null);
      renderGrid();
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
      respeak();
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
    // Active cards cross the staleness threshold without any new event.
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
   * grows with the text as the chart's marks do (`.dv-swatch-mark`).
   */
  const MARK_KEY = 12;
  function keyMark(i) {
    const shape = LINE_MARKS[i % LINE_MARKS.length];
    const lift = shape === 'triangle' ? TRIANGLE_H / 6 : shape === 'triangle-down' ? -TRIANGLE_H / 6 : 0;
    return `<svg class="dv-swatch dv-swatch-mark" width="${MARK_KEY}" height="${MARK_KEY}"`
      + ` viewBox="0 0 ${MARK_KEY} ${MARK_KEY}">`
      + `<path class="dv-mark" d="${markPath(i, MARK_KEY / 2, MARK_KEY / 2 + lift)}"`
      + ` style="fill:${LINE_COLORS[i % LINE_COLORS.length]}" /></svg>`;
  }

  /**
   * A limit line's key: a sample of the line, drawn as the chart draws it, so
   * key and line match by shape as well as by hue. It holds as many whole
   * marks as fit, so no key ends in a stub that reads as another pattern — a
   * long dash cut short is a dash. Theme's SeriesSwatch, mark for mark.
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
    return `<svg class="dv-swatch" width="${KEY_W}" height="${KEY_H}" viewBox="0 0 ${KEY_W} ${KEY_H}">`
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
   * What a screen reader has in the chart's place, as VoiceOver has on iOS:
   * the two measures as two summaries, because tokens and a plan limit's
   * percentage do not convert (the fourth principle) and are not put on one
   * scale for the ear either. A window goes by the name the board's own block
   * gives it, and one the board no longer reports keeps its id, as its key
   * does.
   */
  function spokenMarkup(source, name, model) {
    const { days, tokens, series } = model;
    const labels = new Map(((usage.find((u) => u.source === source) || {}).windows || [])
      .map((w) => [w.id, w.label || w.id]));
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

  /**
   * Names the windows again once the board's usage frame is in. A detail
   * opened straight from its address can draw before that frame lands, and
   * would otherwise go on calling every window by its id.
   */
  function respeak() {
    const el = shown && document.getElementById('dv-spoken');
    if (el) paint(el, spokenMarkup(shown.source, shown.name, shown.model));
  }

  function renderDetail(source, data) {
    stopChart();
    const days = dayRange(data.days || DETAIL_DAYS);
    const name = SOURCE_NAMES[source] || source;

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
    let drawnWidth = 0;
    const draw = () => {
      const width = plot.clientWidth;
      if (!plot.isConnected || width <= 0) return;
      drawnWidth = width;
      paint(plot, chartMarkup(model, width, getComputedStyle(plot)));
    };
    draw();
    if (typeof ResizeObserver === 'function') {
      shown.observer = new ResizeObserver(() => { if (plot.clientWidth !== drawnWidth) draw(); });
      shown.observer.observe(plot);
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

  function renderSession(id, events) {
    const s = state.get(id);
    const name = s ? s.name : id;
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

    paint(detailEl, `
      <div class="dv-head">
        <button class="dv-back" type="button" id="dv-back" aria-label="Back to the board">‹ Board</button>
        <h2 class="dv-title">${escape(name)}</h2>
      </div>
      ${events.length === 0
        ? '<p class="dv-empty">No history yet. Events appear here as the agent works.</p>'
        : `<ol class="tl">${rows}</ol>`}
      <p class="dv-note">Every status this session reported, newest first. A session's history
        is bounded and goes when its card does — a card stops being served 24 hours after its
        last update.</p>`);

    const back = document.getElementById('dv-back');
    back.addEventListener('click', () => { location.hash = ''; });
    back.focus();   // same reasoning as the usage detail: the opener is now hidden
  }

  async function openSession(id) {
    detailEl.hidden = false;
    paint(detailEl, '<p class="dv-empty">Loading…</p>');
    try {
      const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}/history`);
      if (!res.ok) throw new Error(String(res.status));
      const events = await res.json();
      renderSession(id, Array.isArray(events) ? events : []);
    } catch {
      paint(detailEl, '<p class="dv-empty">Could not load this session\'s history.</p>');
    }
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

  // The server's own session-id charset (SESSION_ID_RE in src/app.ts). Every
  // character in it is safe unescaped inside a quoted attribute selector, and
  // none of them is a quote — which is what lets the focus-return below build
  // one by interpolation.
  const SESSION_HASH_RE = /^#session\/([A-Za-z0-9._:-]{1,128})$/;

  function applyRoute() {
    const m = /^#usage\/([a-z][a-z0-9_-]*)$/.exec(location.hash);
    const sm = SESSION_HASH_RE.exec(location.hash);
    if (m) lastSource = m[1];
    if (sm) lastSession = sm[1];
    const showing = Boolean(m || sm);
    stopChart();   // whatever comes next, the chart on screen now is leaving
    document.body.classList.toggle('detail-open', showing);
    if (m) openDetail(m[1]);
    else if (sm) openSession(sm[1]);
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
        ? gridEl.querySelector(`[data-open="${lastSession}"]`)
        : lastSource
          ? usageEl.querySelector(`[data-source="${lastSource}"] .usage-open`)
          : null;
      if (land) land.focus();
      lastSession = '';
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
