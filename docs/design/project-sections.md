# AgStatus 1.7.0: the board grouped by project (implementation spec)

Ships together with Subtasks in 1.7.0, built on `claude/subtasks-1.7.0` (d0d8687). Subtasks' rows stay on their parent card, unchanged.

The build plan's step 0 (a prototype for sign-off) is skipped: the owner decided from the mockups below.

## Owner decisions (2026-11-08)

The owner asked: "Let's group tasks by the project the same way we group subagents", and confirmed it means the session cards on the AgStatus board. Asked to choose, the owner decided:

1. **Layout: project sections.** Each project gets a label that sticks while its cards scroll by, with its sessions as full cards under it (not project cards with session rows).
2. **Replace agent grouping on every client** (iPhone, iPad, web, Android). Agents stay as the pinned heads carrying their plan limits and session count, and as a mark on every card. No Agent | Project setting.
3. **The alarm is one needs-you bar at the bottom edge** on every client, present only while something is blocked. The agents' heads keep only their limits; the agent line retires.
4. **Ship together with Subtasks as 1.7.0**, built on the subtasks branch.

Defaults taken from the design's recommendations (not separately asked): a project is the folder a session started in, pinned by the server (`homeProject`); wide boards stack full-width project sections with cards two across under full-width head strips; the web keeps each card's place (new cards on top of their section, nothing re-sorts on a tool call).

## Wire contract (server ↔ clients)

- Every session object on REST (`/api/sessions`, `/w/:token/api/sessions`) and SSE (snapshot and upserts) gains `homeProject: string`.
- The server derives it and never accepts it from a post: the session's previous `homeProject` if non-empty; else the session's current `project` if that is a **usable folder name** (below), and `''` if not. Once non-empty it never changes for the session's life (a later `cd` never moves a card).
- A **usable folder name**: a string can name a folder (a section, or the place a card says it is) only when, with the white space at its ends trimmed, it is non-empty, it is not `/` and not `.`, and it is not UUID-shaped (the hook's `UUID_NAME_RE`). Every test is on the trimmed value; the name itself is used as the server serves it, in NFC (below), and never trimmed. The server's normalisation returns `''` for anything else. The legacy shell hook posts `/` for a session started at `/`, because POSIX `basename /` is `/` (the Node hook posts `''`); white space alone and a padded UUID come from raw posts, or from a folder so named. Each platform trims with its own white-space set, and the sets differ only at U+0085 (Swift trims it, JavaScript and Kotlin do not) and U+FEFF (JavaScript trims it, Swift and Kotlin do not). No hook sends either, and the server already strips U+0000–U+001F and U+007F, so only a raw post built for it can open a section on one client that another files under No project; that is accepted.
- **Unicode form.** The server stores and serves a session's `project` and `name` in Unicode NFC. It composes them on the way in, on every route that accepts a session (the legacy and `/w/:token` webhooks), before it cuts them to 120 UTF-16 units, and its `normalizeProject` returns NFC, so a home worked out at load from an old row is NFC too; an old row's own name and project are composed as it loads. One folder written in two forms on two machines (a folder made in the macOS Finder is often named decomposed, NFD; a Linux checkout of it composed, NFC) is then one section on every client.
- **A blank name is no name.** The server treats a session name of white space alone as no name, as it already treats an empty one: it keeps the session's previous name, or names the card by its id. White space alone is a name that trims to nothing as JavaScript trims, with U+0085 counted too, as Swift counts it, so a name that any client would trim to nothing is caught. The server applies this on every route that accepts a session, and to a row an older server stored so, as it loads (in memory only; the session's next write stores the name), so no client is sent a name of white space alone. Only a raw post, or a hook for an untitled session in a folder named with white space alone, sends one. A server older than 1.7.0 passes one on as it is; iOS and the web then read the card as its agent and a comma, and Android as its agent and the session's id. Clients need no change for this, and an older server's blank name is accepted.
- A card the board drops on request (dismissed, which is also what the hook's `SessionEnd` sends; cleared; or evicted by the 50-card cap) keeps its `homeProject` for its session's return: a post within 24 hours of the session's last one files the new card under it. A card the TTL expires keeps nothing, because the hook's pinned name ages out with it and the two start over together. The server holds this in memory only, in a bounded map per board, so a restart forgets it and such a session starts over from the folder it then reports.
- Persisted in a new column `home_project TEXT` (ALTER TABLE … ADD COLUMN IF NOT EXISTS; on load a missing value is derived from the row's project, and derived again at every load until the session's next write stores it, so an older server writing the row in between can change it: see Risks). Nothing is deleted.
- Clients compute the **section key**: `homeProject` if it is a usable folder name; else `project` if it is one (a server too old to send the field); else the **No project** bucket.
- **Comparing names.** Clients compare folder names, section keys and names by UTF-16 code unit, which is exact. For NFC text this agrees with Swift's canonical equality, but iOS must not rely on that: an older server sends whatever it got. This covers the section key, a moved card's 'in <folder>', the bar's place elision and a card named after its agent. One comparison on iOS still uses Swift's own equality: a session's synthesized Equatable, so a post that changed only the Unicode form of a name or folder would not draw its card again. That cannot happen: every post also moves `updatedAt`.
- **Section order**, identical on every client: compare the names lowercased, by UTF-16 code unit, then the exact names, by UTF-16 code unit (`AgStatus` before `agstatus`), never by a locale's collation; **No project** always last. Never by activity, state or arrival. Lowercasing applies Unicode's final-sigma rule, so a capital sigma that ends a word becomes `ς` (U+03C2), not `σ`, as JavaScript's `toLowerCase` and Kotlin's `lowercase(Locale.ROOT)` do. iOS uses `lowercased(with: nil)`, and its tests check that it applies the rule (Swift's `lowercased()` does not). At the rule's corners, such as a `Σ` before punctuation and another letter, the platforms do not all agree; Risks records where.
- **Shared test vector** (every client's tests assert this exact order): input `["zeta", "", "Alpha", "alpha", "beta", "AgStatus", "agstatus", "0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b"]` → sections `["AgStatus", "agstatus", "Alpha", "alpha", "beta", "zeta", <No project>]` (the empty name and the UUID both fall into No project). Every client's order tests also assert two pairs:
  - the final-sigma pair `ΝΟΜΟΣ` and `νομος-api`, which order `[ΝΟΜΟΣ, νομος-api]` (without the rule, `ΝΟΜΟΣ` lowercases to `νομοσ`, which sorts after);
  - `café` composed and decomposed, given as raw values from a server older than NFC: two sections, by code unit, the decomposed one first (`e`, U+0065, sorts before `é`, U+00E9).
- **Card order inside a section**: the board's own stable order, filtered and never re-sorted: a new session goes on top of its section, every other card keeps its place.

## The recommended design (synthesis of three designs and two judges)

Group the board by project on every client, the way it groups by agent today: a section per project, a quiet label that sticks while its cards scroll by, sections in a fixed order, and cards that never move except to arrive or leave.

A project is the folder a session started in. The server will remember it for the life of the session. That takes one new column in the production database and nothing reinstalled on your machines. So an agent that runs cd ios keeps its place, and its card just adds 'in ios'. A Claude worktree counts as its repository, as it does today. Sessions with no usable folder share a 'No project' section at the end. Sections run in name order and never reorder because one got busy.

Two things can't belong to a project, so they stay with the agents:
- Plan limits belong to an agent's account. Each agent keeps its head, with every limit and its session count. On a phone the heads are pinned two across, by the same rules as 1.6.5. On an iPad they become full-width strips.
- Claude and Codex now share sections, so every card's meta line starts with its agent's neutral mark again.

The alarm becomes one bar. There are too many projects to keep every label in view, so an alarm per section can't work the way the alarms in the agent heads did. Instead, while anything is blocked, a bar along the bottom edge names the session and its project: '2 BLOCKED · Fix the login redirect · in acme-api · Show'. Press it and that card comes into view with a two-second ring; press again for the next one. It's the same bar on iPhone, iPad, web and Android, so the web and Android get their first alarm. The heads lose their alarms, so red in a head can only mean a limit.

Smaller changes:
- A label carries only a name and a count: no colour, no tap.
- 'in <folder>' appears only when a session has moved away from its project's folder.
- On the iPad, the agent columns give way to full-width sections with cards two across.
- The web stops moving the latest card to the top on every tool call.

Nothing new is coloured, nothing moves unless something changed, and 1.6.5's rules for large text, a phone on its side and VoiceOver carry over.

Five decisions are yours (below). The two that matter most are retiring the agent sections and moving the alarm. Everything is drawn first in a prototype for you to sign off before any code is written.

## Mockups

### Phone

```text
FRAME A. iPhone 16, 393 x 852 pt, default text, upright. Two agents, nine
sessions in five projects, two of them blocked. The top of the board.

┌───────────────────────────────────────────────┐
│ 9:41                                    ▂▄▆ ▮ │  59  status bar
│ ●             AgStatus          [pair] [gear] │  44  navigation bar
├───────────────────────────────────────────────┤      PINNED where 1.6.5 pins its heads
│ ╭────────────────────╮ ╭────────────────────╮ │  10  THE AGENTS' HEADS, two across, narrow
│ │ ✳ CLAUDE           │ │ ⬡ CODEX            │ │      form: mark, name, every plan limit.
│ │ Current session    │ │ 5-hour             │ │      No alarm and no blocked edge any
│ │ 64% · 2h 15m       │ │ 12% · 4h 2m        │ │      more, so red in a head can only be
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ │ │ ▓▓░░░░░░░░░░░░░░░░ │ │  213 a limit past 85%. A tap opens that
│ │ Weekly             │ │ Weekly             │ │      agent's 30 days, as today.
│ │ 22% · 3d 4h        │ │ 40% · 6d           │ │      Pinned for at most two agents with
│ │ ▓▓▓▓░░░░░░░░░░░░░░ │ │ ▓▓▓▓▓▓▓░░░░░░░░░░░ │ │      at most four windows each, at a
│ │ Weekly (Opus)      │ ╰────────────────────╯ │      standard text size, upright (the
│ │ 41% · 3d 4h        │                        │      1.6.5 rule); otherwise the heads
│ │ ▓▓▓▓▓▓▓░░░░░░░░░░░ │                        │      lead the list and scroll away
│ ╰────────────────────╯                        │      (frame C).
├╌╌╌╌╌╌╌╌╌╌╌ the list scrolls under ╌╌╌╌╌╌╌╌╌╌╌╌┤  2
│ acme-api  3 sessions                          │  40  PROJECT LABEL: name in exact case and
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │      a count, on its own opaque ground;
│ ┃ Fix the login redirect        (!) BLOCKED ┃ │  112 sticks while its cards pass. Not a
│ ┃ Approve: git push --force-with-lease      ┃ │      control: no tap, no alarm, no colour.
│ ┃ ✳ MacBook Pro · 2m ago · 41.2k tokens [⧉] ┃ │      (Heavy edge = the blocked card's edge.)
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │      The mark leading the meta line is the
│                                               │  12  card's agent: ✳ Claude, ⬡ Codex.
│ ╭───────────────────────────────────────────╮ │
│ │ Add rate limiting to /login    </> CODING │ │  112 It cd'd into web/: it keeps its place,
│ │ Editing src/middleware/limit.ts           │ │      and 'in web' says where it is now. No
│ │ ✳ MacBook Pro · in web · 14s ago      [⧉] │ │      card under this label says 'in
│ ╰───────────────────────────────────────────╯ │      acme-api'.
│                                               │  12
│ ╭───────────────────────────────────────────╮ │      an untitled Codex session, named
│ │ acme-api                         (v) DONE │ │      after its folder (the fold)
├───────────────────────────────────────────────┤      present only while something is blocked
│ (!) 2 BLOCKED                            Show │  56  NEEDS-YOU BAR, one button and the
│ Fix the login redirect · in acme-api          │      board's only alarm: names the card it
├───────────────────────────────────────────────┤      brings. Enters from the bottom edge.
│ ★ 12 days active    ▓▓▓▓▓░░░      2 to Silver │  36  streak, unchanged
│                  ─────────                    │  34  home indicator
└───────────────────────────────────────────────┘

FRAME B. The same board after a second press of the bar. The first press
ringed 'Fix the login redirect' (already in view), and the bar then named
the next blocked card with 'Next'. This press brought it.

┌───────────────────────────────────────────────┐
│ ●             AgStatus          [pair] [gear] │  103 status + navigation bars
├───────────────────────────────────────────────┤
│ ✳ CLAUDE …            ⬡ CODEX …               │  225 the heads, pinned as in frame A
├╌╌╌╌╌╌╌╌╌╌╌ the list scrolls under ╌╌╌╌╌╌╌╌╌╌╌╌┤
│ etl-jobs  1 session                           │  40  the label of the section under it,
│ ╔═══════════════════════════════════════════╗ │      stuck on its own opaque ground
│ ║ Nightly backfill for March    (!) BLOCKED ║ │  112 THE CARD THE BAR BROUGHT lands under
│ ║ Approve: dbt run --full-refresh           ║ │      the label, with a 2 pt neutral ring
│ ║ ✳ mini · 3m ago · 212.4k tokens       [⧉] ║ │      (drawn double) for 2 s, or until it
│ ╚═══════════════════════════════════════════╝ │      is unblocked. VoiceOver lands on it.
│                                               │  24  between projects; 12 between cards
│ No project  1 session                         │  40  secondary ink, regular weight: the
│ ╭───────────────────────────────────────────╮ │      board's words, not a folder's name.
│ │ Codex                        [=] PLANNING │ │  112 Codex Desktop started at /: no folder
│ │ Reading the brief                         │ │      yet, so no place on its line. Always
│ │ ⬡ just now                                │ │      the last section.
│ ╰───────────────────────────────────────────╯ │
├───────────────────────────────────────────────┤
│ (!) 2 BLOCKED                            Next │  56  after a press the bar names the NEXT
│ Fix the login redirect · in acme-api          │      blocked card in reading order, round
├───────────────────────────────────────────────┤      to the first; the count is the board's
│ ★ 12 days active    ▓▓▓▓▓░░░      2 to Silver │  36
└───────────────────────────────────────────────┘

FRAME C. Three agents, or any accessibility text size, a phone on its side,
or a fifth limit window: the heads lead the list instead, full width, and
here they have scrolled away. Only the label of the section under you is
pinned.

┌───────────────────────────────────────────────┐
│ ●             AgStatus          [pair] [gear] │  103 status + navigation bars
├───────────────────────────────────────────────┤      nothing else pinned up here
│ claude-status  3 sessions                     │  40  sticks, as in every phone mode
│ ╭───────────────────────────────────────────╮ │
│ │ Session organization by        </> CODING │ │  130 a title may take two lines; the message
│ │ agent                                     │ │      then takes one. On a tight line the
│ │ Editing ios/AgStatus/BoardLayout.swift    │ │      optional facts give way, the place
│ │ ✳ just now · 1.1M tokens              [⧉] │ │      before the machine (here the machine
│ ╰───────────────────────────────────────────╯ │      went); the mark never does.
│                                               │  12
│ ╭───────────────────────────────────────────╮ │
│ │ agstatus-listener-windows-    [t] TESTING │ │      Codex on the other machine: its mark
│ │ terminal-focus                            │ │      and its machine tell it apart
│ │ npm test -- focus/wt -- 57 passed         │ │
│ │ ⬡ Studio · 1m ago · 402.6k tokens     [⧉] │ │
├───────────────────────────────────────────────┤
│ (!) 2 BLOCKED                            Show │  56
│ Fix the login redirect · in acme-api          │
├───────────────────────────────────────────────┤
│ ★ 12 days active    ▓▓▓▓▓░░░      2 to Silver │  36
└───────────────────────────────────────────────┘

Marks: ✳ Claude, ⬡ Codex, ◇ any other agent (neutral ink, never a colour).
States, schematic: (!) blocked, </> coding, [t] testing, [=] planning,
(v) done, (o) idle. [⧉] is the card's Focus control. Heights in pt.

Budget on this 6.1-inch phone: 679 pt of board between the bars and the streak.
The pinned heads take 225 and a label 40, which leaves about 414 pt (three and
a half cards). While something is blocked the bar takes 56 more (about 358 pt,
three cards). With four windows a head the heads take 278 (the 1.6.5 cap).

Android (unpublished) draws these frames with its own parts: its usage bars
stay pinned above the list as today, the labels are sticky list headers, and
the bar is the screen's bottom bar. Swipe to dismiss and tap for history
are unchanged.
```

### iPad

```text
iPad Air 11-inch, landscape, 1180 x 820 pt, default text. The same board as the
phone: two agents, nine sessions in five projects, two blocked.

┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ●                                  AgStatus                                      [pair] [gear] │  74  status + navigation bars
├────────────────────────────────────────────────────────────────────────────────────────────────┤      PINNED
│ ╭────────────────────────────────────────────────────────────────────────────────────────────╮ │  10  THE AGENTS' HEADS as full-width
│ │ ✳ CLAUDE  5 sessions   Current session        Weekly                 Weekly (Opus)         │ │      strips, ONE PER ROW: never side by
│ │                        64% · in 2h 15m        22% · in 3d 4h         41% · in 3d 4h        │ │  80  side over two columns of cards that
│ │                        ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  ▓▓▓▓▓░░░░░░░░░░░░░░░░  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ │ │      mix agents, which would read as
│ ╰────────────────────────────────────────────────────────────────────────────────────────────╯ │      'left = Claude'. Mark, name, count,
│                                                                                                │  10  every limit; no alarm, no edge.
│ ╭────────────────────────────────────────────────────────────────────────────────────────────╮ │
│ │ ⬡ CODEX  4 sessions    5-hour                 Weekly                                       │ │      Pinned for one agent always, for two
│ │                        12% · in 4h 2m         40% · in 6d                                  │ │  80  with at most four windows each at a
│ │                        ▓▓▓░░░░░░░░░░░░░░░░░░  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░                        │ │      standard text size; from a third they
│ ╰────────────────────────────────────────────────────────────────────────────────────────────╯ │      lead the scroll instead.
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ sections scroll under the strips ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤  2
│ acme-api  3 sessions                                                                           │  40  label, inline: it scrolls with its section
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  ╭────────────────────────────────────────────╮ │
│ ┃ Fix the login redirect         (!) BLOCKED ┃  │ Add rate limiting to /login     </> CODING │ │  112 cards two across; each is given a side once,
│ ┃ Approve: git push --force-with-lease       ┃  │ Editing src/middleware/limit.ts            │ │      inside its own section, and keeps it
│ ┃ ✳ MacBook Pro · 2m ago · 41.2k tokens  [⧉] ┃  │ ✳ MacBook Pro · in web · 14s ago       [⧉] │ │      (the side holding fewer of its section's
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  ╰────────────────────────────────────────────╯ │      cards; leading on a tie)
│                                                                                                │  12
│ ╭────────────────────────────────────────────╮                                                 │
│ │ acme-api                          (v) DONE │                                                 │  112 one card leaves its other side empty
│ │ Turn finished                              │                                                 │
│ │ ⬡ Studio · 41m ago · 9.8k tokens           │                                                 │
│ ╰────────────────────────────────────────────╯                                                 │
│                                                                                                │  24  between projects, twice the 12 between
│ claude-status  3 sessions                                                                      │  40  cards: proximity groups them, no boxes
│ ╭────────────────────────────────────────────╮  ╭────────────────────────────────────────────╮ │
│ │ Session organization by agent   </> CODING │  │ Fix listener reinstall leaving [t] TESTING │ │      the fold. Below: this section's Codex card,
│ │ Editing ios/AgStatus/BoardLayout.swift     │  │ Focus stopped                              │ │      then docs, etl-jobs (its blocked card) and
│ │ ✳ MacBook Pro · just now · 1.1M tokens [⧉] │  │ xcodebuild test -scheme AgStatus           │ │      No project
│                                                 │ ✳ Studio · 2m ago · 640.8k tokens      [⧉] │ │
├────────────────────────────────────────────────────────────────────────────────────────────────┤      present only while something is blocked
│ (!) 2 BLOCKED   Fix the login redirect · in acme-api                                      Show │  44  NEEDS-YOU BAR, one line on a wide board
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ★ 12 days active    ▓▓▓▓▓▓▓▓▓░░░░░░░                                               2 to Silver │  36  streak
│                                           ──────────                                           │  20  home indicator
└────────────────────────────────────────────────────────────────────────────────────────────────┘

About 182 pt is pinned at the top and 100 at the bottom (bar, streak, home
indicator), which leaves about 464 of the 746 pt under the bars for sections:
a label and two rows of cards, then the next label. In portrait (820 x 1180)
the strips take the 'across' form (about 98 pt each) and the sections get about
790 pt. When nothing is blocked the bar is gone and the sections get its 44 pt
back.

Every wide board draws this one arrangement, whatever the project count. It is
1.6.5's 'more agents than fit' layout, keyed by project, and the agent columns
retire. In Split View, Slide Over, or at a text size where two 340 pt columns
no longer fit, the board steps down to the phone's list, as today. With three
or more agents nothing is pinned at the top: the strips lead the scroll, and
the bar stays at the bottom.
```

### Web

```text
WEB, a 1440 px window on the second monitor (dark theme). The same board: two
agents, nine sessions in five projects, two blocked. Four 336 px tracks.

┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ AgStatus ●                                                                                       │  topbar, as today (it does not stick)
│                                                                                                  │
│ ┌─ ✳ Claude › ──────────────────────┐  ┌─ ⬡ Codex › ───────────────────────┐                     │  usage blocks: per agent, as today, and
│ │ Current session   64% · resets 2h │  │ 5-hour            12% · resets 4h │                     │  each agent's name now carries its mark,
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ │  │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │                     │  the legend for the marks on the cards.
│ │ Weekly            22% · resets 3d │  │ Weekly            40% · resets 6d │                     │  A block still opens #usage/<agent>.
│ │ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░ │                     │  Limits never sit on a project.
│ │ Weekly (Opus)     41% · resets 3d │  └───────────────────────────────────┘                     │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░ │                                                            │
│ └───────────────────────────────────┘                                                            │
│ ○ 1 idle   [=] 1 planning   </> 2 coding   [t] 2 testing   (!) 2 blocked   (v) 1 done            │  stats legend, as today
│                                                                                                  │
│ acme-api  3 sessions                                                                             │  <h2>, a full row of the one #grid; it
│ ┏━━━━━━━━━━━━━━━━━━━━━┓ ┌─────────────────────┐ ┌─────────────────────┐                          │  sticks to the top on an opaque ground
│ ┃ Fix the login…  › × ┃ │ Add rate limit… › × │ │ acme-api        › × │                          │  while its cards pass, and the next
│ ┃ (!) BLOCKED         ┃ │ </> CODING          │ │ (v) DONE            │                          │  label slides over it. No card under
│ ┃ Approve: git push   ┃ │ Editing src/midd…   │ │ Turn finished       │                          │  it says 'in acme-api'; 'in web' is
│ ┃ ✳ MacBook Pro · 2m  ┃ │ ✳ MacBook Pro · in  │ │ ⬡ Studio · 41m ago  │                          │  the one that moved.
│ ┃ · 41.2k tokens      ┃ │ web · 14s ago       │ │ · 9.8k tokens       │                          │  Cards keep their place: a new one
│ ┗━━━━━━━━━━━━━━━━━━━━━┛ └─────────────────────┘ └─────────────────────┘                          │  goes on top of its section, and
│                                                                                                  │  nothing re-sorts on a tool call.
│ claude-status  3 sessions                                                                        │  Each card's first fact is its agent's
│ ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐                          │  mark, plain, no box: the bordered
│ │ Session organi… › × │ │ Fix listener r… › × │ │ agstatus-liste… › × │                          │  CLAUDE chip goes. The name is in
│ │ </> CODING          │ │ [t] TESTING         │ │ [t] TESTING         │                          │  sr-only text and the tooltip; an
│ │ Editing ios/AgSt…   │ │ xcodebuild test     │ │ npm test -- focu…   │                          │  unknown agent gets the diamond
│ │ ✳ MacBook Pro ·     │ │ ✳ Studio · 2m ago   │ │ ⬡ Studio · 1m ago   │                          │  instead of Claude's asterisk.
│ │ just now · 1.1M     │ │ · 640.8k tokens     │ │ · 402.6k tokens     │                          │  The Focus rail is as today (not
│ └─────────────────────┘ └─────────────────────┘ └─────────────────────┘                          │  drawn).
│                                                                                                  │
│ docs  1 session                                                                                  │  a one-card project leaves three cells
│ ┌─────────────────────┐                                                                          │  of its row empty: the honest cost of
│ │ docs            › × │                                                                          │  grouping on a wide screen
│ │ (o) IDLE            │                                                                          │
│ │ Waiting for input   │                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤  fixed to the bottom edge, only while
│ (!) 2 BLOCKED   Fix the login redirect · in acme-api                                        Show │  something is blocked; one <button>
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

Below the fold: docs' card, etl-jobs (its blocked card), No project (Codex
Desktop at /). Pressing Show scrolls the card into view under the stuck label,
moves focus to its title button and rings it for 2 s. Next then walks the
others in reading order: section by section, row by row.

WEB, a 375 px phone browser, scrolled into claude-status:

┌───────────────────────────────────────────────┐
│ claude-status  3 sessions                     │  the label of the section under you,
│ ┌───────────────────────────────────────────┐ │  stuck at the top
│ │ Session organization by agent         › × │ │
│ │ </> CODING                                │ │  one column at 560 px and narrower;
│ │ Editing ios/AgStatus/BoardLayout.swift    │ │  the message clamps to two lines
│ │ ✳ MacBook Pro · just now · 1.1M tokens    │ │
│ └───────────────────────────────────────────┘ │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ agstatus-listener-windows-…           › × │ │
│ │ [t] TESTING                               │ │
├───────────────────────────────────────────────┤
│ (!) 2 BLOCKED                            Show │  the bar takes two lines here, as on
│ Fix the login redirect · in acme-api          │  the phone, above the safe-area inset
└───────────────────────────────────────────────┘
```

## Behaviour rules

- WHAT A PROJECT IS. It is the folder a session started in. The server pins the first usable folder name it hears for each session and keeps it for the session's life. A Claude worktree root already reports its repository. A later cd never moves the card, and nor does a dismissal: a card dismissed, cleared or evicted comes back to its section when its session posts again within a day of its last post, unless the server restarted in between. Some sessions have no usable folder: an agent started at '/', a Codex scratch folder, or a raw webhook post with a blank folder or none. They sit in 'No project' and move once, when a real folder arrives. The server keeps a folder's name in Unicode NFC, so a name that reaches it in two forms is one project. On a server too old to send the field, clients fall back to the live folder.
- SECTION ORDER. Sections sort by name: the names lowercased, with Unicode's final-sigma rule, and compared by UTF-16 code unit, then the exact names the same way (AgStatus before agstatus). The rule is computed identically on iOS, the web and Android. 'No project' is always last. Sections never reorder by activity, state or arrival time. A new project takes its alphabetical place, and the sections after it move down as its first card arrives.
- CARD ORDER INSIDE A SECTION. Cards follow the board's own order, filtered and never re-sorted. A new session goes on top of its section, then every card keeps its place, blocked included. A failed dismiss puts a card back where it was. The web adopts this rule; today it re-sorts by last update on every event.
- THE LABEL. Every section has one, including a one-card project and the only project on the board. It shows the folder name in exact case (semibold) and 'N sessions' (tertiary ink, tabular digits) on one line. When space runs short, the count goes before any letter of the name, then the name is cut in the middle. 'No project' is set in secondary ink at regular weight. A label is not a control and carries no mark, colour, limit, token total or alarm.
- STICKING. A label sticks on its own opaque ground while its cards scroll under it: on the phone in every mode, text size and orientation, on Android, and on the web at every width. On the iPad it scrolls with its section. The iPad's stacks are eager so that a jump lands exactly, and eager stacks cannot pin headers. At the end of the list a stuck label can rest with none of its cards showing, after a press near the end or, on Android, a plain scroll to the end: that is List and LazyColumn mechanics, on iOS and Android alike, and accepted.
- SPACING DOES THE GROUPING, as in 1.6.5: 24 pt between sections, 12 between cards, 8 from a label to its first card. Nothing is boxed.
- THE AGENTS' HEADS. A head shows the mark, the name, the session count where it fits, and every plan limit. The count is all of the agent's cards on the board, done included ('7 sessions', '1 session'). It is the first thing to go when room runs short, and it is always in the head's accessible name. On the web and Android each agent's usage block is its head: it shows the count beside the agent's name where it fits, in the label count's quiet ink. A tap opens that agent's 30 days of usage. Heads lose the alarm and the blocked edge. Which agents get a head is unchanged: those with sessions, or every agent that reports limits on an empty board.
- WHERE THE HEADS GO. Phone, unchanged from 1.6.5: pinned two across while there are at most two agents with at most four windows each, at a standard text size, upright. Otherwise they become the first rows of the list and scroll away. Wide boards: full-width strips, one per row. A lone agent's strip is always pinned. Two are pinned at standard text sizes with at most four windows each. From a third agent, the strips lead the scroll. On Android the usage blocks are pinned while the list keeps room under them for a label, the shortest card and the needs-you bar, and otherwise lead the list as its first item (ANDROID). The agent line retires.
- AGENTS: NAMES AND MARKS. An agent's display name is 'Claude' for claude and 'Codex' for codex. Any other source keeps its spelling with its first letter upper-cased, which is the hook's agentLabel rule: gemini is 'Gemini', codex-cli 'Codex-cli', claude-work 'Claude-work'. The web looks a name up with Object.hasOwn, never a bare object index, because SOURCE_NAMES['constructor'] is a function. The mark goes by the source's start: one starting with 'claude' gets the asterisk, one starting with 'codex' the hexagon, anything else the diamond.
- CARDS. The agent's neutral mark leads the meta line on every card, always. It never drops, and it is hidden from VoiceOver, which hears the agent in the card's label. 'in <folder>' shows only when the live folder is a usable folder name and differs from both the section and the name, compared by UTF-16 code unit, that is, when the session has moved. The other facts give way in one order on every card: machine and place, then machine, then place, then nothing. Nothing is ever cut to an ellipsis. The rest of the card is unchanged: the name on up to two lines, the state, the message, the rail, Focus, the long-press menu with Dismiss, the swipe, the stale words and the tokens.
- THE NEEDS-YOU BAR: WHERE AND WHAT. It is present only while at least one session is blocked; done is never counted. On iOS it sits between the board and the streak. On the web it is fixed to the bottom edge, above the safe-area inset, and the page is padded so nothing hides under it. On Android it is the screen's bottom bar. It reads '(!) 2 BLOCKED · <session> · in <project> · Show'. The mark, count and word are in the blocked ink, the session in primary ink, the project and the verb in secondary ink. It is one line on a wide screen: on the web wider than 560 px, on Android with 600 dp for it, and on iOS on a board two columns wide and on a phone held sideways. Narrower, as on a phone upright, it takes two lines, the alarm over the session. On one line it gives way in one order: the word BLOCKED (the mark and count stay), then the place, then the name is cut at its end. So on one line the word never shows without the place, even where it would fit beside the name alone; whether it should is the owner's call, still open. On an iOS board two columns wide the bar takes its second line instead of cutting the name; the web, Android and a phone held sideways cut it. On two lines each line gives way on its own: the session line drops the place, then cuts the name at its end, and the alarm line drops the word BLOCKED only when that line itself lacks room, since dropping it there frees nothing on the session line. The session is the card's name, or its agent's display name when it has none. The place is 'in <section>' for a folder section, left out when the section equals the name; for 'No project' it is the agent's display name instead, left out when that equals the name. Both comparisons are exact, by UTF-16 code unit. The whole bar is one button, at least 44 pt tall.
- PRESSING THE BAR. It brings the card it names into view: under its stuck label in a list, or 8 pt below what is pinned on a stack. The card gets a neutral ring for 2 s (gone sooner if the card is unblocked), and VoiceOver, TalkBack or keyboard focus moves onto it. The bar keeps one value between renders: the card its last press brought. It holds none until the first press, and none again once the bar leaves, whichever screen is showing: Android clears it where blocks are watched, not in the board screen, which is not composed while History, Usage or Settings is open. The card the bar names, which its next press brings, is the first blocked card after that one in the reading order as drawn now, wrapping round; that is the card itself when it is the only one blocked. With no card held, or one no longer on the board, it is the first blocked card. The verb is 'Next' while the card held is on the board and more than one card is blocked, and 'Show' otherwise. Reading order is sections in order, then cards in order: on the web's grid, row by row; on the iPad's two-across board, where cards are drawn, by each card's top edge with the left side first on a tie, so it goes down the screen as VoiceOver reads it even when cards differ in height. The bar's walk and its press follow it, and keeping it costs nothing on an event that changes no layout, measured in main-thread instructions per hook event before and after. A card's place is the top edge layout gives it, measured within its section, and two edges within a point of each other are a tie. A section holding a card not yet laid out, one that has just arrived or moved in, is read row by row until layout gives that card its edge: each side's first card, the left one first, then each side's second, and so on. A card's height can change while the bar shows (subagent rows, a two-line name, a card opened in place), and the order can change with it. The bar then names the next blocked card in the new order, its words changing in place. VoiceOver keeps the platform's own order by position, which meets the cards in the same order, though it can read a tall card's subagent rows after the name of the card beside it; that is accepted. A press reads the board as last drawn, so a card dismissed or unblocked in the meantime is skipped. A card that becomes blocked never moves; the bar is the way to it.
- WIDE BOARDS. On the iPad, and any width where two 340 pt columns fit, there is one arrangement for any number of projects. Sections stack full width with cards two across. A card is given a side once, inside its own section, and keeps it. Split View, Slide Over and large text step down to the phone's list, as today.
- WEB. The labels are full-row headings inside the one board grid, so no card ever changes container. A label is one line by its own line height, so a reader's own text spacing (WCAG 1.4.12) makes it taller rather than cutting its letters, and the web measures it for its scroll padding. A label is fitted again when its size, its count or the webfonts change, so letter or word spacing that changes alone, after a label is fitted, can leave a cut name clipped without its ellipsis until the next fit. Focus, the history route's focus return and the landing page are untouched. The per-agent usage blocks above stay, and each name gains its mark, as the legend for the cards, and its agent's session count beside it where it fits, in the label count's quiet ink (THE AGENTS' HEADS). Its button is named '<agent>, <N> sessions', as iOS names its head, or the name alone on an empty board, which shows every agent's limits. The count is the first to go; a head's name is one line, cut at its end only where it alone does not fit, with no tooltip, the button's name holding it whole. Keyboard focus on a head stays on it when the usage area is drawn again, for a count, a reading or a countdown. When the head itself goes, with its agent's last session, focus on it falls to the page. A card's meta line keeps its mark's agent name as hidden text, so a screen reader reading a card through hears the agent in its title and again in its meta line; that is accepted. The bar tells one line from two by where the session sits, beside the alarm or below it, never by whether dropping the word gave the name room: a place wider than the line leaves the name no room either way. The grid is one column at 560 px and narrower.
- ANDROID. The same sections appear as sticky list headers. No item but a card can take a session id as its key: a label is 'project/<name>' ('project/' for No project), and the usage blocks, where they lead the list, 'board/usage'. The usage blocks are pinned above the list while it keeps room under them for a label, the shortest card and the needs-you bar (counted whether or not the bar shows), at the reader's text size. Otherwise, as on a phone held sideways or upright at a larger text size, they are the list's first item and scroll away with it. They are measured wherever they stand, out of view too, so they always stand where a board drawn for the first time would put them: when the reader comes back from a card's history, Settings or Usage; after a turn, on the board or while another screen shows; and after a change of text size. Through each of these a list that stood at a card starts at that card. A list that stood at its top when the blocks joined it shows them whole at its top. A list whose first item was the blocks when they left it starts at its top, its first label and card whole. Turning the phone redraws the board in place. Where the blocks' place changes across a round trip (a turn while another screen shows, or a smaller text size), the board's first frame draws them where they stood and the next where they now go, so the list shifts by their height for one frame, under the screen's crossfade or the activity's relaunch; that is accepted. Each block shows its agent's session count beside the name in the label count's quiet ink, with tabular digits, and the count is the first thing to go (THE AGENTS' HEADS). TalkBack hears 'Claude, 7 sessions', or the name alone when the agent has no sessions on the board. Sideways at a large text size, TalkBack can land a second time on what still shows of a block as the list scrolls past blocks drawn side by side. A block shows a keyboard's focus only by Compose's default state layer, a 1.30:1 change, under WCAG 1.4.11's 3:1, and the bar's hand-off can send focus there (ASSISTIVE TECHNOLOGY: THE BAR AND ANNOUNCEMENTS); a focus ring of its own needs a design, and that is the owner's call, still open. The bar is the screen's bottom bar. Swipe-to-dismiss and tap-for-history are unchanged. A swiped card is dismissed once the swipe settles: the red Dismiss slab fills its place until then, and then the place closes. A card that comes back, because its session posted again or the dismiss failed, is drawn whole. A card that leaves the screen before its swipe settles is not dismissed and stays on the board. Whether a card should go on release instead is the owner's call, still open.
- MOTION ONLY FOR NEWS. The bar enters from the bottom edge when the first block lands and leaves when none remain. Under Reduce Motion, prefers-reduced-motion or animations turned off, it appears and goes in place. Text inside it changes in place, never cross-faded. Cards animate only when the order of cards changes, so a new section arrives with its first card. The one move between sections, out of 'No project', is drawn, not animated, and so is a label it opens. Jumps snap under Reduce Motion and while VoiceOver runs. Nothing pulses.
- ASSISTIVE TECHNOLOGY: STRUCTURE. A label is one heading, 'acme-api, 3 sessions', so the Headings rotor walks the projects. The heads are buttons in a container named 'Plan limits' and lose the header trait. Each wide-board section is a container named '<project> sessions'. A card reads '<agent>, <name>', with the agent's display name (AGENTS) taken from the session itself, and '<name>' alone when the name equals that display name, compared exactly, by UTF-16 code unit: the untitled Codex session at '/' is 'Codex', never 'Codex, Codex'. This holds on iOS, on Android and on the web, where the card title's accessible name is '<agent>, <name> — open this session's history', or '<name> — open this session's history' where the name is its agent's display name. The visible label stays inside the accessible name (WCAG 2.5.3), after the agent rather than at its start as 2.5.3 recommends; on the web's title button that order is the owner's call, still open. Chrome joins boxes with spaces in an accessible name, so on the web any hidden text goes inline in one element, or the title takes an aria-label that contains its visible text. More Content adds Project, and shows Directory only when it differs from the project.
- ASSISTIVE TECHNOLOGY: THE BAR AND ANNOUNCEMENTS. The bar's accessible name is '<N> blocked: <name>, <place>, <verb>' in the bar's own words, as in '2 blocked: Fix the login redirect, in acme-api, Show'; with no place, the place and its comma are left out. On iOS the label stops before the verb, and the verb goes into accessibilityInputLabels instead, with 'Show blocked' and 'Blocked', so Voice Control answers to all three. The hint is 'Shows that session'. On every client the bar comes after the heads (on the web and Android, the usage blocks) and before the cards in screen-reader and keyboard order: the web places it so, Android orders it so for TalkBack and places it so for Tab, and iOS orders it so for VoiceOver. Where the heads are not pinned but lead the scroll, they are the first thing in it, and VoiceOver and TalkBack read the bar just before them, then the cards. On iOS that happens on the one-list board (a phone, or an iPad where two columns do not fit), where the heads are the list's first rows, with three agents or more, a head with more than four limit windows, an accessibility text size, or a phone held sideways. It also happens on the two-across board, where the strips are the first thing in its scroll, with three strips or more, or with two at an accessibility size or with more than four windows in one. On Android it happens wherever the usage blocks lead the list. On Android, TalkBack and a keyboard's Tab reach the board in this order: the top bar, the pinned usage blocks, the needs-you bar, then the labels and cards. Where the usage blocks lead the list they are its first item, so TalkBack hears the bar just before them, as VoiceOver hears it before heads that lead the scroll; Tab still reaches the bar after them. The web, whose usage blocks come before the bar in the page, has no such case: the heads, then the bar, then the cards, for the keyboard and the accessibility tree alike. On iOS the board is one VoiceOver container, read as the pinned heads, the bar, the cards, then the streak. While the bar shows, VoiceOver's Magic Tap presses it from anywhere on the board. While it does not, the board leaves Magic Tap to the system, which pauses whatever is playing. Whether iOS Full Keyboard Access reaches the bar in this order has not been checked (Risks). When the bar leaves while it holds the web's focus or an Android keyboard's, that focus is handed on. On the web it goes to the title of the card the bar last brought, else of the card it named, else the first card's title, else the board's heading; the page scrolls only when that target does not show whole, under a stuck label, under the bar (which still shows as focus moves) or off the window, and then the least way, in one step under reduced motion. On Android a keyboard's focus goes to the card the bar last named if that card is at least partly in view under the stuck label, else to the first card in view, else, with no card in view (as where the usage blocks fill a phone held sideways at a large text size), to the first usage block. Nothing scrolls for it, and the board never sends it to the top bar. TalkBack's own focus is not handed on: when the bar leaves under it, TalkBack loses its place, and the next swipe starts again at the top of the screen. Compose tells the app nothing when TalkBack's focus moves, and with animations off the bar is gone before the board could ask where that focus was; that is accepted. A block is spoken only on a session's transition into blocked: never on the first draw or after a reconnect, and at most once a minute for each session. Blocks that land within 500 ms of each other are said together, as '<N> sessions need you'; a single block is '<name>, <place>, needs you', as in 'Fix the login redirect, in acme-api, needs you'. The commas set the place off, so without a place it is a plain sentence, '<name> needs you', as in 'Codex needs you', which is how iOS has said it. iOS also keeps today's silences: nothing when push is on, the app is inactive or VoiceOver is off. The web says the same through a polite live region, never on page load. Android says it on every screen while the app is in front (resumed): the alarm's voice sits above the NavHost, not in the board screen, so a block that lands while History, Usage or Settings is open is said there, and is not lost while counted as said. While the app is not in front nothing is said, and what arrives then is dropped, not kept for later.
- HONEST NUMBERS. Tokens stay on each card. No label or head sums them, because Claude's and Codex's counts are not comparable. Limits never sit on a label and are never divided among projects.
- A PROJECT IS A FOLDER NAME ONLY, as the privacy promise requires. The same name on two machines is one section, whichever Unicode form each machine wrote it in. One repository checked out under two names is two sections. Two repositories that share a name are one.
- UNCHANGED: the idle board (every reporting agent's head and 'Nothing running', with no labels and no bar), the connecting state, the streak, the push tip, stale cards, the usage screen and its per-folder spend, and Subtasks' rows, which stay on their parent card.

## Build plan

- 0. DESIGN FIRST, NO PRODUCTION CODE.
- On your Mac, check which folder a Codex Desktop worktree session reports, and whether Codex's working folder moves within a session.
- Build docs/design/prototypes/project-sections.html from agent-sections.html's device frames and URL scheme, in iOS points and CSS px.
- Give it a switch for each open decision: ?alarm=bar|heads, ?wide=stacked|columns, and ?group=agent|project only if decision 1 keeps the setting.
- Give it the scenarios the apps will mirror: projects (the board in these mockups), many-projects (nine or more, with a blocked card near the end), one-project, moved, no-project (Codex at / and a UUID folder), two-machines and idle, each with blocked=0|1|2.
- Frames: iPhone at 375, 393 and 440; iPad at 820 portrait, 1180 and 1376; web at 375, 1440 and 1920.
- Verify: headless Chrome renders through CDP device metrics, with the accessibility tree dumped, laid beside 1.6.5 captures. You sign off the decisions in the prototype's header.
- 1. SERVER (src/store.ts).
- Work in a scratch worktree outside iCloud, from origin/master (7ca3a22 today) or from the shipped 1.7.0.
- Add homeProject to every session. The server derives it and never accepts it from a post: the previous value if there is one, else the session's project, with a name that is not a usable folder name (Wire contract) turned into ''.
- Add one column, home_project TEXT, next to host's with ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and write it in the upsert. On load, a missing value is derived once from the row's project. Nothing is deleted. The field goes out on REST and SSE.
- Verify with new tests in the root suite (Node 20.9 via nvm; vitest --no-file-parallelism):
  - the first post pins the value, and a later cd does not move it;
  - '' and a UUID are skipped, then claimed by a real folder;
  - a post without a project carries the value forward;
  - eviction followed by a re-post;
  - a restart against a disposable Postgres;
  - the in-memory path.
- Docs: update docs/api.md (the session object), docs/hooks.md (what boards group by) and docs/privacy.md (worked out on the server; nothing new leaves a machine). Rebuild docs.html with Node 22+ and commit it.
- This can ship in any push, since no client reads the field yet.
- 2. WEB: CARDS KEEP THEIR PLACE. This is its own commit with its own 'push it', because every web viewer will see the change.
- Port Android's stable order into renderGrid: the first paint is newest first, then new ids go on top and every other card stays where it was.
- Verify: root-suite tests on the order, and a CDP-scripted run that posts events and checks that nothing moves. landing.html renders as before.
- 3. WEB: SECTIONS (public/app.js, board.css, marks.js).
- Each card gets a section key: homeProject, else project, each only when it is a usable folder name, else No project. Sections use the shared order rule.
- Labels are full-row h2 elements, placed in renderGrid's existing ordering pass and kept in a second map beside the cards. A label is removed when its section empties, and setGridMessage clears both maps.
- Labels are sticky on an opaque ground, styled in board.css only. landing.html does not load board.css, so card.css's .grid, .card and .source keep their meaning there.
- cardMeta gets the plain mark (with the name in sr-only text and a tooltip) and the place rule. marks.js gains a diamond for unknown agents. Each usage block's name gains its mark.
- Verify:
  - root-suite web tests using one shared order vector, the same vector the Swift and Kotlin tests use;
  - headless Chrome via CDP at 320, 375, 768, 1280, 1440 and 1920 px, and at 200% text (set the root font size before load), with the accessibility tree dumped to check the h2s and card names;
  - a before-and-after capture of landing.html that must match;
  - an /impeccable audit.
- 4. WEB: THE NEEDS-YOU BAR (index.html, app.js, shell.css).
- A button fixed to the bottom edge, above the safe-area inset, with the page padded while it shows.
- The jump: scrollIntoView with a scroll-margin-top that clears the stuck label, smooth unless motion is reduced; focus moves to the card's title button, which gets a 2 s neutral ring. Next follows reading order.
- A polite live region announces new blocks: transitions only, never on page load, each session at most once a minute.
- Verify: CDP-scripted presses on test boards with 0, 1, 2 and 5 blocked, checking focus and the ring through the accessibility tree and captures, plus reduced-motion emulation; then /impeccable.
- Hold the push of steps 3 and 4 until the iOS build is approved, so both boards change on the same day.
- 5. iOS: MODEL AND LAYOUT FIRST (Models.swift, BoardLayout.swift).
- Add Session.homeProject, optional, falling back to project.
- Build project sections on every render from the store's flat list, never stored, in the shared order.
- Give sections a jump target case of their own, so a folder named 'codex' cannot collide with the Codex head or a session id.
- Reduce the arrangements to the list and one stacked board.
- Pin rules for the heads: the phone's unchanged, a new one for wide boards. Card sides are counted per section, and the reading order gets a 'next after' step.
- Verify with verify() tables in DEBUG at 361, 408, 646, 1000, 1178 and 1344 pt, crossed with 0 to 12 projects, 1 to 3 agents, default, xxxL and accessibility text sizes, upright and sideways. Also check:
  - the shared order vector;
  - 'a cd never re-groups';
  - 'a message is no label's, head's or bar's news';
  - that the jump targets stay distinct;
  - then xcodebuild test.
- 6. iOS: THE VIEWS (AgentSections.swift, BoardView.swift, SessionCardView.swift).
- Heads lose the alarm, the blocked edge and the header trait, and sit in a 'Plan limits' container. The agent line is removed.
- The project label is an Equatable value: one line, cut in the middle, the count first to go, on an opaque ground.
- The List shows the heads as rows when they scroll, then a Section per project with sticky labels.
- The stacked board is keyed by section, with containers named after each project. The column board is deleted.
- Each card is handed its own agent's name. The card gets the mark, the place rule, the single fallback order, and Project in More Content.
- The bar sits between the board and the streak, and a press reads the board as last drawn. The spoken sentence names the project.
- Verify:
  - re-measure PERF-3: a message event must stay at 3.1 to 5.3 ms, counting layout passes as well as body runs;
  - simulator captures of the debug scenarios at every width above, at default, xxxL, AX3 and AX5, upright and sideways (landscape via notifyutil, the phone layout on an iPad via AGSTATUS_BOARD_WIDTH, text sizes via simctl ui content_size);
  - VoiceOver: the Headings rotor, the bar's label, and focus landing on a row the lazy list had not yet laid out;
  - captures laid beside the prototype's, then an /impeccable audit.
- 7. iOS DEMO DATA (DemoData.swift).
- Add debug scenarios projects, manyprojects, moved and noproject, matching the prototype card for card.
- The screenshot hook presses the bar.
- The App Store demo board stays untouched unless you decide otherwise at release.
- 8. ANDROID, LAST, SINCE IT IS UNPUBLISHED (Models.kt, SessionStore.kt, ui/BoardScreen.kt, ui/SessionCard.kt, one new ui/ file for the label, bar and marks, DemoData.kt).
- Add homeProject, the grouping and the shared order, with unit tests on the same vector.
- The LazyColumn gets a stickyHeader per section, keyed 'project/<name>', opaque, with heading semantics. A slash can appear in neither a session id nor a folder name, so the keys cannot collide.
- MetaLine's CLAUDE box is replaced by the vector mark (paths from marks.js), and the place rule applies.
- The bar is the Scaffold's bottom bar. The jump goes through LazyListState, with no animation when animations are off, then the ring and a focus request, with an announcement as the fallback.
- Demo sessions share projects.
- Verify:
  - a build with Homebrew JDK 17 from a scratch copy;
  - the agstatus_test emulator (adb -s emulator-5554) at font scales 1.0, 1.3 and 2.0, portrait and landscape;
  - uiautomator dumps of the TalkBack text for headings, cards and the bar.
- 9. RELEASE.
- Release notes for this version only, the four manifests, and an annotated tag.
- The App Store listing changes from 'a board sorted by agent' to sorted by project. landing.html's 'grouped by agent' copy and its three phone images change, and the 16 App Store screenshots are retaken from the debug scenarios.
- One atomic push of master and the tag, after your 'push it'.
- You sign in to Xcode and distribute the iOS archive.

## Out of scope

- Any hook change: no search for .git and no new field from the hook. Repository-root detection, for sessions started in a subfolder or worktrees outside .claude/worktrees, can come later as an upgrade that replaces a folder-derived value once.
- Anything per project beyond its label: no project screen or tap, no token total, no blocked count, no colour or mark, and no share of a plan limit.
- Matching the usage screen's per-folder spend to the sections. A worktree's spend stays filed under the worktree's folder.
- Per-folder spend in one Unicode form. The usage screen keeps a folder's name as it was sent, so one folder sent in two forms can be listed twice there: the server's Unicode form (Wire contract) covers a session's name and project only. Whether it should cover spend too is the owner's call, still open.
- Collapsing, filtering, pinning or reordering sections; an 'Other' bucket for one-card projects; nesting agents inside projects, or the reverse.
- Columns per project on the iPad, and packing small projects into shared rows on the web.
- Bring to front from the bar. The card's own Focus control is one tap after Show.
- Telling repositories apart by anything beyond folder names, such as remotes or paths, which the privacy promise rules out.
- Making the hook report Codex Desktop worktrees as their repository.
- Android's empty state ('No agents yet' becoming 'Nothing running'), tokens on Android cards, and porting iOS's head pin rules to Android's usage bars.
- A grouping setting, unless decision 1 picks it, and a new App Store demo board, unless you ask for one at release.

## Risks

- The alarm moves two days after 1.6.5 taught it. The heads lose their alarm and edge, and you have to learn to look at the bottom edge. The blocked card's own state and push notifications are unchanged.
- 1.6.5's headline is withdrawn. Its App Store listing, the landing page and three phone images sell 'a board sorted by agent'. New copy and every screenshot belong in this release, not a follow-up.
- A project is only as good as a session's first folder. A session started inside ios/ lives under 'ios' for its whole life. Sessions alive at the deploy are pinned to the folder their row last reported before it, the only one the server has for them: one that had already run cd web lives under 'web', while the hook still names it after the folder it started in. The exception is a row whose folder was not a usable name ('', '/' or a UUID), which the next usable folder claims. On hosted boards these sessions age out within a day; a self-hosted board in legacy mode, which has no TTL unless one is set, keeps them for as long as they last. A self-hosted board on an older server falls back to the live folder, where cards move on a cd.
- A rollback to 1.6.5 and forward again can move a card, in two ways that need both steps. A row 1.7.0 never wrote keeps `home_project` NULL, and its home is worked out from the row's project at every load, not once: so a cd that 1.6.5 records for it during the rollback moves the card on the roll-forward. And 1.6.5's upsert never touches `home_project`, so a card dismissed and re-posted under 1.6.5 (or flagged by 1.6.5's TTL sweep and then resumed) keeps the home 1.7.0 wrote, where 1.7.0 after a restart starts over from the folder the session then reports. Rows 1.7.0 wrote keep their home through a rollback. Either way a card is filed under a folder its own session reported, and that is accepted.
- Folder names are not repositories. This repository already lives under three names (claude-status, claude-status-dashboard, agstatus) and would split into three sections, while unrelated repositories called api or docs merge into one.
- Codex Desktop's worktree layout is unverified. Its worktree sessions may report their own folder and land in sections of their own. Step 0 checks this before the prototype is signed off.
- Pinned room on a phone while something is blocked: two heads (225 pt with three windows each), the bar (56) and a label (40) leave a 6.1-inch phone about 358 pt, or three cards, and an SE about two. The bar's 56 pt come back when nothing is blocked.
- Density: every one-card project costs a 40 pt label. On the web it also leaves the rest of its row empty, so the second-monitor board scrolls sooner than today's flat grid. The fixed bar keeps a blocked card below the fold in view.
- On the iPad, labels scroll with their sections, so after a jump the card's label can sit above the top edge of the screen. The bar has already named the project, and the card shows its agent.
- iOS List mechanics are untested at this scale: many sticky Sections on iOS 18 and 26, head rows before the first Section without breaking 1.6.5's section-spacing fix, the centre jump anchor before iOS 26, and VoiceOver landing on a row the lazy list had not laid out.
- VoiceOver's own gestures (the swipe order, Magic Tap), where VoiceOver lands after a press of the bar, and iOS Full Keyboard Access have been checked only in the Simulator, which runs neither VoiceOver nor Full Keyboard Access and holds no accessibility focus. The checks went through the accessibility tree and a walk of Magic Tap's dispatch. They need the owner's iPhone and iPad. No screen reader has run on the web board either: its checks read Chrome's accessibility tree. The web paints the usage area whole whenever anything in it changes, a count, a reading or a countdown, and puts focus back on the new head, so a screen reader may say a focused head again each time, about once a minute from the countdown alone.
- Section order lowercases names with Unicode's final-sigma rule, and at the rule's corners the platforms differ. Measured with 29 probes on macOS 26.5.2 and in the iOS 26.5 simulator, against Node 20.9.0: Swift's String.lowercased(with: nil), which iOS calls, gives what JavaScript's toLowerCase gives on all 29. NSString's lowercased(with: nil) and CFStringLowercase give ς where JavaScript gives σ on 8 of them: a Σ followed by a full stop, colon or middle dot and then a letter, as in ΑΣ.Z or ΝΟΜΟΣ.api, and a Σ with only an apostrophe before it. An iOS older than 26 may take the NSString path for this call, and one that does orders a pair such as ΝΟΜΟΣ.api and νομος.b the other way round: νομος.b first on the web and on iOS 26, ΝΟΜΟΣ.api first there. iOS 17.0, the oldest the app supports, and iOS 18 were not checked, since only the 26.5 runtime was installed, and nor was any other path the app takes before 26. The shared pairs order the same on every path measured, so iOS's verify() passes either way and cannot catch it. Separately, OpenJDK 17.0.20.1, where Android's unit tests run, differs from JavaScript on 7 of the 29, both ways round: it lowercases ΝΟΜΟΣ-api to νομοσ-api where JavaScript and iOS give νομος-api, and ΑΣ:Z to ας:z where they give ασ:z. Under those tests a pair such as ΝΟΜΟΣ-api and νομος-b orders the other way round from the web. The app runs on Android's own runtime, not that JVM, and no Android device was measured. Accepting these corners, or having iOS apply the rule itself, is the owner's call, still open.
- PERF-3 can regress quietly. A label or the bar handed its whole section, which carries every session, instead of only what it draws, would re-run on every hook event. verify() pins this, and step 6 re-measures it. The iPad's reading order by where cards are drawn is held to the same: main-thread instructions per hook event, measured before and after.
- The production database gains a column on the deploy that follows a push to master, and a push deploys even when CI is red. The suites and the disposable-Postgres test must run locally first.
- Subtasks 1.7.0 (50 local, unpushed commits on claude/subtasks-1.7.0) rewrites the same files. Whichever ships second has to be merged into the other.
- Keeping card order on the web changes a long-standing behaviour for every viewer: the latest activity no longer rises to the top.
- Android has no precedent for sticky headers combined with swipe-to-dismiss and item animation, or for moving TalkBack focus after a jump.

## Calls still open for the owner

Each is described where it applies; none has been decided.

- The one-line bar drops BLOCKED before the place, so where the place has to go the word has gone too, even where it would fit beside the name alone (THE NEEDS-YOU BAR). Every client does this, and changing it means changing all of them together.
- The web card title's accessible name leads with the agent, so the visible name is inside it but not at its start, where WCAG 2.5.3 recommends it (ASSISTIVE TECHNOLOGY: STRUCTURE).
- Android dismisses a swiped card once the swipe settles, not on release (ANDROID).
- Android shows a keyboard's focus on a usage block only by Compose's default state layer, a 1.30:1 change against WCAG 1.4.11's 3:1; a focus ring of its own needs a design (ANDROID).
- The final-sigma corners: accept them, or have iOS apply the rule itself (Risks).
- Per-folder spend in two Unicode forms (Out of scope).

## Decisions the owner did not take, as the design framed them

- **Should project sections replace the agent sections, or sit beside them?** Options: Replace them on every client. Sections become projects; the agents remain as the pinned heads (limits and session count) and as a mark on every card. / Add a per-device 'Group sessions by: Agent | Project' setting on iOS only. Agent is the default and is exactly 1.6.5, head alarms included. The web and Android get project sections only. / Add the setting on all three clients. That first means building 1.6.5's agent sections on the web and Android, which never had them. Recommended: Replace them on every client.
- **Where does the alarm live once sections are projects?** Options: One needs-you bar along the bottom edge on every client, present only while something is blocked. It names the session and its project; Show brings that card, Next the following one. The heads keep their limits only, and the agent line retires. / Keep 1.6.5's alarm in each agent's head and on the agent line, on iOS only. It jumps to that agent's first blocked card in whichever project, and its spoken and VoiceOver text gains the project. The web and Android stay without an alarm. Recommended: The needs-you bar.
- **What decides which section a card is in?** Options: The folder the session started in, remembered by the server for the session's life. This is a new field the server works out itself, plus one added column in the production database. The hook does not change, so grouping is right on every machine the day the server deploys. / The live folder the hook already sends. There is no backend work, but a card jumps to another section whenever its agent runs cd ios or cd src, and back when it returns. / The git repository root, found by the hook (a search up the folders for .git at the session's first event) and pinned. This is also right for sessions started in a subfolder and for worktrees outside .claude/worktrees. But it reaches a machine only once its installer is re-run, and it adds filesystem work to the hook. Recommended: The starting folder, pinned by the server.
- **What does a wide board (iPad) show, now that its columns are no longer agents?** Options: Retire the agent columns. Project sections stack full width with cards two across, under the agents' heads pinned as full-width strips, one per row. / A column per project while they fit (two in portrait, three in landscape), and the stack beyond that. / Keep a column per agent, with project labels inside each column. Recommended: Stacked sections under full-width strips.
- **When does this ship relative to Subtasks 1.7.0?** Options: After it. Finish and ship 1.7.0 (integrated on the local claude/subtasks-1.7.0 branch, probes still open), then build project sections on the shipped code. The prototype and your sign-off happen in the meantime. / Together. Build on claude/subtasks-1.7.0 and ship both as 1.7.0. / Before it. Ship project sections first on master, then rebase the 50 Subtasks commits onto them. Recommended: After it.
