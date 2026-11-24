# App Store listing copy — 1.7.0

Paste into App Store Connect. The build is **1.7.0 (9)**: `MARKETING_VERSION`
follows the repo release the build is cut from, and `CURRENT_PROJECT_VERSION`
goes up by one for each build that is uploaded. 1.5.0 went to the store as
build 6, and 1.6.2 and 1.6.5 were each staged as build 7 and never uploaded.
1.7.0's build 8 was uploaded with each project's name running down its
section's side, which the owner took out before review, and was never
submitted; so this version goes to review as build 9.

> **Scope.** The store shows **1.5.0 (build 6)**, the version it serves now.
> 1.6.2 and 1.6.5 were written up for it
> ([listing-1.6.2.md](listing-1.6.2.md), [listing-1.6.5.md](listing-1.6.5.md))
> and never uploaded, so everyone updating goes from 1.5.0 to 1.7.0 in one
> step. This covers everything that changed in the app since 1.5.0, 1.6.2's and
> 1.6.5's changes included wherever 1.7.0 kept them. The web board and the
> server go out first, so by the time this version is approved agstatus.online
> already groups its board by project. The 1.5.0 app reads only the session
> fields it knows, so against that server it still draws one list, with no
> sections, bar or subagent rows; with a 1.7.0 hook, a card shows the server's
> reading of its subagents in their place ("Needs approval: …",
> [../design/subtasks.md](../design/subtasks.md) §9.3). Only the 1.6.5 app was
> run against the 1.7.0 server, not 1.5.0.

---

## What's New in This Version (4000 max — this is 3,994)

```
Your board grouped by project, subagents on their session's card, and one bar for blocked sessions.

A SECTION PER PROJECT
Sessions are now grouped by the folder each one started in: a section per project, in name order, each under a label with its session count. A session that changes directory stays in its section. On iPhone the label stays in view while its cards scroll by. On iPad, where two columns fit, each section's cards stand two across, under a strip for each agent's limits.

Each agent's plan limits at the top now carry its mark and, where there is room, its session count.

ONE BAR FOR WHAT NEEDS YOU
While any session is blocked, a bar along the bottom says how many are blocked and names one of them with its project. Tap it and that card comes into view with a ring around it; tap again for the next one. If another session blocks while the bar is up, the bar comes in again with the new count. With Reduce Motion on, it never slides in or out.

SUBAGENTS ON THE CARD
When a session runs subagents, each one not yet done is a row on its card: what it was asked to do, what it is doing and its state. A card shows up to two rows on iPhone and three where cards stand two across, then a count of the others and of those done. Tap a row to open the session, where the full list stands above its timeline. A subagent waiting on your approval turns the card blocked, and the card names it. A session whose turn is over while its subagents still work reads WORKING, not done.

Subagents on the card need AgStatus 1.7.0 on the computer your agents run on: run its install command there again. Project sections and the bar need nothing new there. A server you run yourself needs 1.7.0 too. The demo shows subagents at work.

CARDS
A busy session that has sent no update for ten minutes used to fade, words and all. Now every word stays readable: the card loses its color, a "?" takes the place of its state's symbol, and "no update for 14m" stands where the time was.

A session's title can take two lines instead of one. Every card has a long-press menu with Dismiss, beside Bring to front where Focus is set up; on iPhone you can still swipe a card away.

ACCESSIBILITY
• At the largest text sizes cards no longer run off the screen, and a limit's reset time is shortened or left out, never cut mid-number.
• VoiceOver reads a card's agent and name, then its state, then its message, and with notifications off says when a session becomes blocked, with its project. Magic Tap presses the bar from anywhere on the board; Voice Control answers to the bar's word, Show or Next.
• With Increase Contrast on, the quieter text, the borders and the card edges are brighter.
• The main buttons are a darker green that their white labels can be read on.
• The connection light in the toolbar shows its state by its shape, no longer glows, and VoiceOver says when the connection drops.
• Session history passes contrast, marks each state with its symbol as well as its color, and shows every message in full.
• The usage chart tells limit lines apart by pattern as well as color, marks a window's first-day reading with a shape of its own, and grows its text with yours. VoiceOver reads its figures, with an Audio Graph.

PAIRING IS SAFER
The app now accepts only a pairing code the board's server could have issued, adds a board only when its address is made of the characters a host name can contain, and puts both in quotes in the line it gives you to paste into a terminal. If a board answers with anything else, you get an error, never a command to paste. On agstatus.online only the quotes are new.

ALSO
• Sessions with no usable folder, such as one started in the root folder, wait in a "No project" section at the end until they report one.
• A board with plan limits but nothing running says "Nothing running" instead of offering to pair a computer.
• A new icon: three strips, one lit and pulled out of line, the way an air traffic controller flags the flight that needs action.
```

Not claimed, on purpose:

- **What VoiceOver says, word for word, and how VoiceOver and Full Keyboard
  Access behave on a device.** Neither was run on a real iPhone or iPad: the
  owner waived those checks for 1.7.0. VoiceOver does not run in the
  Simulator, so what it is told was written from Apple's documentation and
  checked in the accessibility tree, never heard, and Full Keyboard Access was
  walked in the Simulator only. What's New says what VoiceOver now does and
  quotes none of it.
- **Anything about iOS 17 or 18.** The app ran only on iOS 26.5, in the
  Simulator. It still supports iOS 17.0 and later, and the bar's motion uses
  APIs that came with iOS 17, but neither iOS 17 nor 18 was run.
- **A card keeps its place.** It already did in 1.5.0, and the sections keep
  it. It is the web board that stops re-sorting its cards in 1.7.0.
- **Cards named after a session's title.** The hook chooses the name and the
  app shows what the board says, so titles reached 1.5.0 without an update.
  Only their second line is new.
- **The agent's name on a card.** 1.5.0's meta line began with the agent's
  mark and its name in a box; 1.7.0's begins with the mark alone, which is
  what tells Claude's cards from Codex's in a section they share. The name
  moved to the front of what VoiceOver reads, which What's New says.
- **Unicode board names and `_` in host names.** Both work in 1.7.0, and both
  worked in 1.5.0. 1.6.2's release notes mention them only because an earlier
  draft of the pairing fix turned them away.
- **How the board fits each screen**: the phone pinning its heads two across
  only for at most two agents of up to four limit windows each, upright and
  at a standard text size, and otherwise leading the list with them; the iPad
  pinning its strips by the same kind of rule, and taking the phone's list,
  labels pinned and two subagent rows to a card, where two columns do not
  fit, as in a narrow Split View, in Slide Over or at larger text sizes; and
  a subagent row giving its task a line of its own on a card stacked at the
  accessibility sizes. They are how the board fits each screen, not features
  to look for.
- **How the bar moves in detail**: turning round where it is when a block
  lands as it leaves, staying still while another screen is over the board,
  and making one beat of blocks that land within half a second. They are how
  the bar behaves, not features to look for.
- **The order of sections in detail** (letter case, Unicode forms, a Greek
  final sigma). Every client orders them the same way, but for a few
  final-sigma corners that [../design/project-sections.md](../design/project-sections.md)
  records under Risks; nobody looks for it.
- **Less work for each hook event**, on the iPad's board and while the bar
  shows. The costs these fixes remove came after 1.5.0, which drew every
  device as one list, and the figures come from harnesses on a Mac, not from
  a device.
- **The smaller fixes**: the dots between a card's facts; the swipe's
  Dismiss, the Bronze tier's name, "Pull down to retry.", the push tip's
  buttons and the first-run webhook row; the toolbar's buttons and Back, in
  the board's green where 1.5.0 drew them blue; VoiceOver's More Content
  rotor, its times said in words, and Focus and Resume saying how they went;
  a card that no longer cross-fades its text when a usage report lands with
  it; a session's history that keeps its name when the session leaves the
  board; the icon's dark and tinted versions; and Settings → Source code,
  which opens the repository under its new name. They are real, and too
  small to list one by one.

---

## Promotional text

Carries over from 1.5.0, and is still true. It can be changed without a
build, so nothing has to be done here.

## Description — paste the committed copy

The description can only be changed alongside a new version, and the store
still shows 1.5.0's: the corrections written for 1.6.2 and 1.6.5 never reached
it. Against 1.5.0's, this one changes four lines and adds three. Paste the
whole description from [../app-store-submission.md](../app-store-submission.md)
(3996 of 4000 characters; 1.5.0's is 3346) rather than editing in place. What
differs from what the store shows for 1.5.0
(`git show v1.5.0:docs/app-store-submission.md`):

| Was | Now | Why |
| --- | --- | --- |
| — | Sessions grouped by project, each under its own label, with the cards two across where an iPad has room | 1.5.0 drew every device as one list. |
| — | A session's running subagents as rows on its card: what each was asked to do, what it is doing and its state; one waiting on your approval turns the card blocked | Subagent rows are new in 1.7.0. |
| Blocked cards glow; finished and long-silent ones fade, so the sessions that need you stand out | Blocked and finished cards carry the color while busy ones recede, so the ones that need you stand out; a session that has gone quiet loses its color, shows a “?” and says how long it has been silent | Untrue of 1.5.0 already: no card glows, and a finished one is not dimmed. A quiet card still faded in 1.5.0; it now keeps its words, untinted. |
| — | While a session is blocked, a bar along the bottom names it and its project; tap the bar to bring that card into view, and again for the next one | The bar is new in 1.7.0, and is the board's one alarm. |
| Swipe a card away when you are done with it | Long-press a card to dismiss it or, with Focus set up on your Mac, bring its terminal to the front; on iPhone you can also swipe it away | Every card has the long-press menu now, and on the iPad's board, cards two across, it is how a card is dismissed. |
| Usage bars sit above the board: … | Each agent on the board has a head with its plan limits: … | The limits are each agent's head now, with its mark and, where there is room, its session count; over the iPad's two columns each head is a strip across the board. |
| Designed for iPhone with a dark interface. | Designed for iPhone and iPad, with a dark interface. | Universal since 1.2.0 (`TARGETED_DEVICE_FAMILY = 1,2`). |

The three new lines are in ON THE BOARD: the projects' first, the subagents'
after "The last thing the agent reported", the bar's after the line about
blocked and finished cards.

## Screenshots

All sixteen images were retaken for 1.7.0, and every one of the twelve to
upload differs from what the store shows for 1.5.0. Against 1.5.0's:

- **Board** (`02-board.png`): the board grouped by project, a labelled section
  per project under Claude's and Codex's heads, a card with two subagent rows,
  and the needs-you bar naming the blocked session; on the iPad the heads are
  strips and the cards two across. 1.5.0's showed one list of four sessions
  under the two agents' limit blocks.
- **History** (`03-history.png`): the card with the subagent rows, its two
  subagents above its timeline, every state with its glyph. 1.5.0's showed a
  timeline alone, under a state pill, its rows told apart by colour.
- **Usage** (`04-usage.png`): the limit lines told apart by pattern as well as
  colour (solid, dashed, dotted). 1.5.0's drew them all solid.
- **Welcome** (`01-welcome.png`): the new mark in the tile and the darker green
  main button. 1.5.0's tile held a pulse line, over a lighter button.

The store's 1.5.0 images are most likely the set captured from the 1.5.0 build
on October 5 (1f9286b), 25 hours after the v1.5.0 commit of October 3; the
tree at the `v1.5.0` tag still holds the set from September 8, which
predates 1.5.0's redesign. Everything above holds against either. Upload in
the order in [README.md](README.md), iPhone 6.5", iPhone 6.9" and one iPad
set. For the iPad, upload the portrait set (`ipad/`): its welcome screen's
buttons stretch less than they do across a landscape iPad.

## Not changing

Keywords, category, age rating and the privacy answers all carry over from
1.5.0. Against `git show v1.5.0:docs/app-store-submission.md`, the keywords
(94/100), the category (Developer Tools / Productivity) and the App Privacy
table are word for word the same. The age rating is written down in neither
file; every listing since 1.5.0 carries it over, and the app still shows only
what the user's own agents report. The app's privacy manifest, `Info.plist`
and entitlements are byte for byte 1.5.0's, and it calls the same endpoints
1.5.0 did. It still only reads a board: the subagent rows show what the hook
on the user's computer reports, and the project a card is filed under is
worked out by the server from the folder name the hook already sent.

Two things beside them do differ from 1.5.0. The **Support URL** in the
listing table is now https://github.com/KardanovIR/agstatus/issues, where
1.5.0's named `claude-status-dashboard`, the repository's old name; GitHub
redirects that only until another repository takes it, so paste the new one.
And the **review notes** in the same file now say iPhone and iPad, that
agstatus.online sends push, and link the repository by its new name, where
1.5.0's said iPhone only and no push and linked `claude-status-dashboard`;
the notes actually sent come from the private file [SUBMITTING.md](SUBMITTING.md)
names, so check that it says the same.
