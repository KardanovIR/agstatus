# App Store listing copy — 1.7.0

Paste into App Store Connect. The build is **1.7.0 (8)**: `MARKETING_VERSION`
follows the repo release the build is cut from, and `CURRENT_PROJECT_VERSION`
goes up by one for each version that is uploaded. 1.6.5 is build 7, so this
version takes 8.

> **Scope.** This covers everything that changed in the app since **1.6.5
> (build 7)**, the version on the store. The web board and the server go out
> first, so by the time this version is approved agstatus.online already
> groups its board by project; the 1.6.5 app keeps working against it, grouped
> by agent and without subagent rows.

---

## What's New in This Version (4000 max — this is 2,286)

```
Your board grouped by project, subagents on their session's card, and one bar for whatever needs you.

A SECTION PER PROJECT
Sessions are grouped by the folder each one started in: a section per project, in name order, each under a label with its session count. On iPhone the label stays in view while its cards scroll by. A session that changes directory keeps its card where it is, and the card says where it went ("in ios"). Claude and Codex sessions share the sections, so every card now starts its details with its agent's mark. On iPad the agent columns give way to full-width sections with cards two across, under a full-width strip for each agent.

ONE BAR FOR WHAT NEEDS YOU
While any session is blocked, a bar along the bottom says how many are blocked and names one of them with its project. Tap it and that card comes into view with a ring around it; tap again for the next one. When another session blocks while the bar is up, the bar comes in from the bottom edge once more, with the new count. The agents' heads keep their plan limits, show how many sessions each agent has where there is room, as on iPad, and no longer carry an alarm.

With VoiceOver, Magic Tap presses the bar from anywhere on the board, and the new block VoiceOver announces now names its project. Voice Control answers to the bar's own word, Show or Next. With Reduce Motion on, the bar appears and goes in place.

SUBAGENTS ON THE CARD
When a session runs subagents, each running one is a row on its card: what it was asked to do, what it is doing and its state. A card shows up to three rows on iPad and two on iPhone, then a count of the others and of those done. Tap a row to open the session, where every subagent is listed above its timeline. A subagent waiting on your approval turns the card blocked and names itself, and a session whose turn is over while its subagents still work reads WORKING, not done. At accessibility text sizes a row gives its task a line of its own.

Subagent rows need AgStatus 1.7.0 on the computer your agents run on: run its install command there again. Project sections and the bar need nothing new on your computer.

ALSO
• Sessions with no usable folder, such as one started in the root folder, wait in a "No project" section at the end until they report one.
```

Not claimed, on purpose:

- **What VoiceOver says, word for word, and how VoiceOver and Full Keyboard
  Access behave on a device.** Neither was run on a real iPhone or iPad: the
  owner waived those checks for 1.7.0. VoiceOver does not run in the
  Simulator, so what it is told was checked in the accessibility tree, and
  Full Keyboard Access was walked in the Simulator only. What's New says what
  VoiceOver now does and quotes none of it.
- **Anything about iOS 17 or 18.** The app ran only on iOS 26.5, in the
  Simulator. It still supports iOS 17.0 and later, and the bar's motion uses
  APIs that came with iOS 17, but neither iOS 17 nor 18 was run.
- **A card keeps its place.** It already did on iOS. It is the web board that
  stops re-sorting its cards in 1.7.0.
- **How the bar moves in detail**: turning round where it is when a block
  lands as it leaves, staying still while another screen is over the board,
  and making one beat of blocks that land within half a second. They are how
  the bar behaves, not features to look for.
- **The order of sections in detail** (letter case, Unicode forms, a Greek
  final sigma). Every client orders them the same way; nobody looks for it.
- **Less work for each hook event while the bar shows.** The figures come
  from harnesses on a Mac, not from a device.

---

## Promotional text

Carries over from 1.5.0, and is still true. It can be changed without a
build, so nothing has to be done here.

## Description — paste the committed copy

The description can only be changed alongside a new version, and this one
changes one line and adds two. Paste the whole description from
[../app-store-submission.md](../app-store-submission.md) (3981 of 4000
characters) rather than editing in place. What differs from what the store
shows for 1.6.5:

| Was | Now | Why |
| --- | --- | --- |
| Sessions grouped by agent, with a column for each on iPad | Sessions grouped by project, each under its own label, with the cards two across on iPad | The board is grouped by project, and the agent columns are gone. |
| — | While a session is blocked, a bar along the bottom names it and its project; tap the bar to bring that card into view, and again for the next one | The bar is the board's one alarm now; the heads lost theirs. |
| — | A session's running subagents as rows on its card: what each was asked to do, what it is doing and its state; one waiting on your approval turns the card blocked | Subagent rows are new in 1.7.0. |

The two new lines are in ON THE BOARD: the subagents' after "The last thing
the agent reported", the bar's after the line about blocked and finished
cards.

## Screenshots

All sixteen images are retaken for 1.7.0. The board images show the board
grouped by project, a card with two subagent rows, and the needs-you bar
naming the blocked session, where 1.6.5's showed the board by agent; the
history images open the card with the subagent rows, its two subagents above
its timeline. The usage images differ from 1.6.5's only in their dates, and the welcome images
not at all on the iPhones and only in the status bar's date on the iPads.
Upload them in the order in [README.md](README.md), iPhone 6.5", iPhone 6.9"
and one iPad set. For the iPad, upload the portrait set (`ipad/`), as for
1.6.5: its welcome screen's buttons stretch less than they do across a
landscape iPad.

## Not changing

Keywords, category, age rating and the privacy answers all carry over. The
app still only reads a board: the subagent rows show what the hook on the
user's computer reports, and the project a card is filed under is worked out
by the server from the folder name the hook already sent.
