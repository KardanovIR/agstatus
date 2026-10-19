# App Store listing copy — 1.6.2

Paste into App Store Connect. The build is **1.6.2 (7)**: `MARKETING_VERSION`
follows the repo release the build is cut from, and `CURRENT_PROJECT_VERSION`
goes up by one for each version that is uploaded. 1.5.0 went to review as
build 6.

> **Note on scope.** This covers what changed in the app since **1.5.0
> (build 6)**, the build that was in review by 5 October. Check that version's
> status in App Store Connect first. If 1.5.0 was released, use the text below
> as it is. If it is still waiting for review, or was rejected, the store still
> serves 1.3, so the people updating have seen neither 1.4 nor 1.5: put the
> paragraph below first and follow it with the What's New from
> [listing-1.5.0.md](listing-1.5.0.md).

---

## What's New in This Version (4000 max — this is ~630)

```
Pairing a computer is safer.

When you pair a computer, the app gives you one line to paste into its terminal. It now accepts only a pairing code the board's server could have issued, adds a board only when its address is made of the characters a host name can contain, and puts both in quotes in that line. A board that answers the Pair sheet with anything else gets an error, never a command to paste. On agstatus.online pairing works as before; the code just appears in quotes.

ALSO
• The dots between the facts on a card are easier to read.
• Settings → Source code opens the project's new home, github.com/KardanovIR/agstatus.
```

Not claimed, on purpose:

- **Unicode board names and `_` in host names.** Both work in 1.6.2, but they
  also worked in 1.5.0. The release notes mention them only because an earlier
  draft of the pairing fix turned them away.
- **Cards named after a session's title.** The hook chooses that name and the
  app shows whatever the board says, so it reached 1.5.0 users without an
  update.

---

## Promotional text

Carries over from 1.5.0. Promotional text can be changed without a build, so
there is nothing to do here for this release.

## Description — check two lines before submitting

The description can only be changed alongside a new version, so this is the
chance to fix it. Until this release the copy committed in
[../app-store-submission.md](../app-store-submission.md) had two lines that
the app has not matched since 1.5.0 and 1.2.0; that file now has the corrected
text. If App Store Connect still shows the old lines, replace them:

| Said | Replace with | Why |
| --- | --- | --- |
| Blocked cards glow; finished and long-silent ones fade, so the sessions that need you stand out | Blocked and finished cards carry the color while busy ones recede, and a session that has gone quiet dims, so the ones that need you stand out | A blocked card has not glowed since 1.5.0, and a finished card is no longer dimmed: it is waiting on you. Only a stale card dims. |
| Designed for iPhone with a dark interface. | Designed for iPhone and iPad, with a dark interface. | The app has been universal since 1.2.0 (`TARGETED_DEVICE_FAMILY = 1,2`). |

The review notes in the same file said "iPhone only" and now say "iPhone and
iPad". The notes actually sent come from the private `appstore-resubmission.md`
(see [SUBMITTING.md](SUBMITTING.md)); check that they do not say it too.

## Not changing

Keywords, category, age rating and the privacy answers all carry over. The app
still only reads a board, and 1.6.2 sends nothing new: it checks what the board
answers before showing it.

## Screenshots

Not recaptured. One thing in them is out of date: the `·` between a card's
facts on the board, in `02-board.png` in all four sets (`6.5/`, `6.9/`, `ipad/`,
`ipad-landscape/`). It was drawn at 1.80:1 in the 1.5.0 build these came from,
and 1.6.2 draws it in the tertiary text colour, so in the app the dots are a
little brighter than in the images. Everything else in them matches 1.6.2, so
recapturing can wait for a release that changes the board. No screenshot shows
the Pair sheet, the one screen whose content 1.6.2 changes.
