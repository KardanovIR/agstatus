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

## What's New in This Version (4000 max — this is ~1,400)

```
Every agent gets a section of its own.

A BOARD SORTED BY AGENT
Claude and Codex sessions used to share one list, so every glance began with sorting them by eye. Now each agent has a section of its own, under a plain mark and its session count, and a head that carries its plan limits. On an iPad, agents sit side by side, each in its own column. When one of an agent's sessions is blocked, the alarm in its head takes you to it.

A session's title now takes a second line instead of being cut after a few words. A board whose agents report plan limits but have nothing running now says "Nothing running", instead of offering to pair a computer.

Every card now has a long-press menu with Dismiss in it, next to Bring to front where Focus is set up. On iPhone, swiping a card away still works.

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
- **The phone's limit on pinned heads**, and the layouts for one agent and for
  three or more. They are how the new board fits each screen, not features to
  look for.

---

## Promotional text

Carries over from 1.5.0. It can be changed without a build, so nothing has to
be done here.

## Description — paste the committed copy

The description can only be changed alongside a new version, and this one
changes four lines. Paste the whole description from
[../app-store-submission.md](../app-store-submission.md) (3581 of 4000
characters) rather than editing in place. What differs from what the store
shows for 1.5.0:

| Was | Now | Why |
| --- | --- | --- |
| Blocked cards glow; finished and long-silent ones fade, so the sessions that need you stand out | Blocked and finished cards carry the color while busy ones recede, and a session that has gone quiet dims, so the ones that need you stand out | Not true since 1.5.0; written for 1.6.2, which never shipped. |
| Designed for iPhone with a dark interface. | Designed for iPhone and iPad, with a dark interface. | Universal since 1.2.0; also written for 1.6.2. |
| Swipe a card away when you are done with it | Long-press a card to dismiss it or, with Focus set up on your Mac, bring its terminal to the front; on iPhone you can also swipe it away | Every card has the menu now. |
| Usage bars sit above the board: … | Each agent on the board has a head with its plan limits: … | The limits are now each agent's head, with its mark and alarm; on iPad each head stands over its column. |

and ON THE BOARD gains a first bullet: "Sessions grouped by agent, with a column
for each on iPad".

## Screenshots

Every set is new: the board is the release. Upload in the order in
[README.md](README.md), iPhone 6.5", iPhone 6.9" and one iPad set. For the
iPad, upload the portrait set (`ipad/`): its board shows both columns, and its
welcome screen's buttons stretch less than they do across a landscape iPad.

## Not changing

Keywords, category, age rating and the privacy answers all carry over. The app
still only reads a board; the new board rearranges what it already showed.
