# App Store listing copy — 1.6.5

Paste into App Store Connect. The build is **1.6.5 (7)**: `MARKETING_VERSION`
follows the repo release the build is cut from, and `CURRENT_PROJECT_VERSION`
goes up by one for each version that is uploaded. 1.5.0 went to the store as
build 6. 1.6.2 was staged as build 7 but never uploaded, so this version takes
7.

> **Scope.** This covers everything that changed in the app since **1.5.0
> (build 6)**, the version on the store. 1.6.2 never shipped, so its pairing
> fix and its two small changes are news here too, after the new board.
> [listing-1.6.2.md](listing-1.6.2.md) is kept as the text written for it.

---

## What's New in This Version (4000 max — this is ~2,700)

```
Every agent gets a section of its own.

A BOARD SORTED BY AGENT
Claude and Codex sessions used to share one list, so every glance began with sorting them by eye. Now each agent has a section of its own, under a plain mark and its session count, and a head that carries its plan limits. On an iPad, agents sit side by side, each in its own column. When one of an agent's sessions is blocked, the alarm in its head takes you to it.

A session's title now takes a second line instead of being cut after a few words. A board whose agents report plan limits but have nothing running now says "Nothing running", instead of offering to pair a computer.

Every card now has a long-press menu with Dismiss in it, next to Bring to front where Focus is set up. On iPhone, swiping a card away still works.

A QUIET SESSION SAYS SO
A working session that has sent no update for ten minutes used to fade, words and all. Now every word stays readable: the card loses its color, a "?" takes the place of its state's symbol, and "no update for 14m" stands where the time was.

ACCESSIBILITY
• At the largest text sizes, cards no longer run off the sides of the screen, and a limit's reset time is shortened or left out instead of being cut mid-number.
• VoiceOver reads a card's name, then its state, then its message, and now says when a session becomes blocked, even with notifications off.
• With Increase Contrast on, the quieter text, the borders and the card edges are brighter.
• The connection light in the toolbar shows its state by its shape, no longer glows, and VoiceOver says when the connection drops.
• The main buttons are a darker green that their white labels can be read on.

HISTORY AND USAGE
• Session history passes contrast, marks each state with its symbol as well as its color, shows every message in full and no longer glows.
• The usage chart tells limit lines apart by pattern as well as color, marks a window's first-day reading with a shape of its own, and grows its text with yours. VoiceOver reads its figures, with an Audio Graph.

PAIRING IS SAFER
When you pair a computer, the app gives you one line to paste into its terminal. It now accepts only a pairing code the board's server could have issued, adds a board only when its address is made of the characters a host name can contain, and puts both in quotes in that line. A board that answers the Pair sheet with anything else gets an error, never a command to paste. On agstatus.online pairing works as before; the code just appears in quotes.

ALSO
• The dots between the facts on a card are easier to read.
• Settings → Source code opens the project's new home, github.com/KardanovIR/agstatus.
```

Not claimed, on purpose:

- **A card keeps its place.** It already did in 1.5.0; the new board keeps it.
- **Cards named after a session's title.** The hook chooses the name and the
  app shows what the board says, so titles reached 1.5.0 without an update.
  Only their second line is new.
- **The phone's limits on pinned heads** (two agents, four limit windows in a
  head, and the line of names instead of heads at accessibility sizes and
  held sideways), and the layouts for one agent and for three or more. They
  are how the new board fits each screen, not features to look for.
- **A faster iPad.** The columns are new in this version, and so was the cost
  the fix removes: 1.5.0 drew every device as one list. The figures come from
  a harness on a Mac, not from an iPad.
- **What VoiceOver says, word for word.** VoiceOver does not run in the
  Simulator, so its labels and announcements were written from Apple's
  documentation and reviewed, not heard on a device. What's New says what
  VoiceOver now reads and announces, and quotes none of it.
- **The smaller contrast and touch-target fixes**: the swipe's Dismiss, the
  Bronze tier's name, "Pull down to retry.", the push tip's buttons and the
  first-run webhook row. They are real, and too small to list one by one.

---

## Promotional text

Carries over from 1.5.0. It can be changed without a build, so nothing has to
be done here.

## Description — paste the committed copy

The description can only be changed alongside a new version, and this one
changes four lines and adds one. Paste the whole description from
[../app-store-submission.md](../app-store-submission.md) (3638 of 4000
characters) rather than editing in place. What differs from what the store
shows for 1.5.0:

| Was | Now | Why |
| --- | --- | --- |
| Blocked cards glow; finished and long-silent ones fade, so the sessions that need you stand out | Blocked and finished cards carry the color while busy ones recede, so the ones that need you stand out; a session that has gone quiet loses its color, shows a “?” and says how long it has been silent | Not true since 1.5.0. The line written for 1.6.2, which never shipped, still said a quiet session dims; since 1.6.5 it keeps its words, untinted. |
| Designed for iPhone with a dark interface. | Designed for iPhone and iPad, with a dark interface. | Universal since 1.2.0; also written for 1.6.2. |
| Swipe a card away when you are done with it | Long-press a card to dismiss it or, with Focus set up on your Mac, bring its terminal to the front; on iPhone you can also swipe it away | Every card has the menu now. |
| Usage bars sit above the board: … | Each agent on the board has a head with its plan limits: … | The limits are now each agent's head, with its mark and alarm; on iPad each head stands over its column. |

and ON THE BOARD gains a first bullet: "Sessions grouped by agent, with a column
for each on iPad".

## Screenshots

Every image is new, the welcome screens' too: the board is the release, the
history and usage screens changed with the accessibility pass, and the welcome
screen's main button is a darker green now. Upload in the order in
[README.md](README.md), iPhone 6.5", iPhone 6.9" and one iPad set. For the
iPad, upload the portrait set (`ipad/`): its board shows both columns, and its
welcome screen's buttons stretch less than they do across a landscape iPad.

## Not changing

Keywords, category, age rating and the privacy answers all carry over. The app
still only reads a board; the new board rearranges what it already showed.
