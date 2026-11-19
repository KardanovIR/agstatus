# Google Play submission — AgStatus for Android

Everything needed to publish `com.kardanov.agstatus`. Assets here are final;
the checklist marks what still needs doing in Play Console.

```
distribution/google-play/
├── README.md                     this file
├── listing/
│   ├── title.txt                 28 / 30 chars
│   ├── short-description.txt     72 / 80
│   ├── full-description.txt      3968 / 4000
│   └── whats-new.txt             478 / 500
├── graphics/
│   ├── icon-512.png              512×512, no alpha
│   ├── feature-graphic.png       1024×500, no alpha
│   └── screenshots/              1080×1920 phone screenshots
├── data-safety.md                every Data safety answer, with reasons
├── content-rating.md             IARC answers + the other blocking declarations
└── release/
    └── agstatus-release.aab      signed bundle (gitignored — rebuild locally)
```

## Checklist

App version: **`versionName 1.7.0`, `versionCode 7`** (`android/app/build.gradle.kts`).
The checklist below was written against 1.1.0 / versionCode 1 and the app has
moved on several releases since, so read the rows in bold before uploading
anything.

| Step | Status |
| --- | --- |
| Upload key created, stored outside the repo | **done** |
| Listing copy within every character limit | **done** — rewritten and re-counted for 1.7.0 |
| Data safety answers derived from the code | **done** — re-checked against 1.7.0, which adds no permission, request or dependency to the app; transcribe into Console |
| Content rating + app content declarations | **done** — transcribe into Console |
| **Privacy policy text for the Android app** — https://agstatus.online/privacy | **done in 1.7.0** — `docs/privacy.md` and `public/privacy.html`, both dated November 19, 2026, now cover "the AgStatus apps for iOS and Android" and say nothing of where the app is published, so they hold during the closed test and after it ([content-rating.md](content-rating.md), R1). It is live once the 1.7.0 push to `master` redeploys agstatus.online: check that the live page serves it before the closed-test release |
| **Screenshots regenerated for 1.7.0** | **done** — the board by project with the agents' heads and the needs-you bar, and a session's subagents (below) |
| **Icon and feature graphic regenerated** | **done** for 1.7.0 — redrawn from the launcher icon (below) |
| **Signed App Bundle built at versionCode 7** | **TODO** — `scripts/build-play-bundle.sh`, on your Mac, from the integrated 1.7.0 release tip; CI builds no bundle |
| Create the app in Play Console and pay the one-time $25 registration | you |
| Fill Data safety, content rating, and app content from the docs here | you |
| **Closed test: 12 or more testers opted in for 14 days in a row** | **you** — required before production on a personal account; see the note below. Line the testers up before the upload. Internal testing is optional and does not count |
| Apply for production access, then countries, pricing (free), and rollout | you |

### The two graphics

Until 1.7.0, `graphics/icon-512.png` and `graphics/feature-graphic.png` were
exported from the palette this project retired in 1.5 — the near-black
`#0B0D12` ground with Tailwind's `blue-500` / `purple-500` / `amber-500` on
it. For 1.7.0 both were redrawn from the launcher icon in the app itself
(`res/drawable/ic_launcher_foreground.xml` and its background): four solid
tiles, planning `#D4A3DF`, coding `#78B2DB`, testing `#69BABF`, done
`#69C88E`, on `#0C0F0D`. The icon is that vector rasterised at 512×512; the
feature graphic, 1024×500, sets the same tiles beside the name and the
landing page's line "Live status for your coding agents". Both are PNG with
no alpha, as Play wants, and nothing in this repo renders them, so a change
to the icon means exporting them again by hand.

## Rebuilding the bundle

```bash
scripts/build-play-bundle.sh      # builds + signs, copies here
```

The upload key already exists (its fingerprint is below), so making one is not
part of a rebuild. `scripts/make-upload-keystore.sh` is for a machine where no
upload key has ever been made: it refuses to run when it finds
`agstatus-upload.jks` in any folder the key might be in, or when the checkout
already has a `keystore.properties`.

This is the only way to get the bundle Play takes. CI's `Android (build + tests)`
job runs `assembleDebug` and keeps `agstatus-debug-apk`, signed with the
runner's throwaway debug key, and `release.yml` has no Android job: nothing in
CI builds an `.aab` or signs anything, because the upload key must never reach
it. Play rejects a debug-signed APK.

The script finds JDK 17 at `~/.jdks/temurin-17` (set `JAVA_HOME` to use
another); `/usr/libexec/java_home -V` does not list that one, so it is easy to
conclude there is none. The first run downloads Gradle 8.14.3 through the
wrapper, and AGP and Kotlin through Gradle.

The keystore and its password live in the private `claude-status-private/`
folder. It was made at `~/Desktop/claude-status-private/`; on the development
Mac iCloud's Desktop sync has since moved it to
`~/Desktop/Desktop - MacBook Pro (2)/claude-status-private/`. Both scripts look
in both places, and in any other `~/Desktop/Desktop - <Mac name>/` copy.

`android/keystore.properties`, which points at the keystore, is gitignored, so
a fresh checkout or worktree has none. Copy it from the main checkout rather
than making a new key, and check that its `storeFile` names the `.jks` where it
is now (at 1.6.2 the development Mac's main checkout still named the old
folder).
`build-play-bundle.sh` says which file to copy when it is missing, and stops
before Gradle when `storeFile` names a keystore that is not there.

Back up the keystore and its password. With Play App Signing — on by default
for new apps — Google holds the real app signing key and this upload key only
proves the upload is yours, so losing it is recoverable.

Upload key SHA-256, which Play Console will show after the first upload:

```
44:CB:00:E8:E0:F1:5C:D9:86:36:C6:43:D4:9B:CD:65:9D:AA:3F:22:F6:DE:F9:C3:FD:CF:00:33:B9:64:78:B8
```

## Screenshots

Captured from the emulator in demo mode, so nothing personal appears and the
board is populated without pairing a machine. Play caps phone screenshots at a
2:1 aspect ratio, so these are 1080×1920 (16:9) rather than the emulator's
native 1080×2400, which would be rejected.

1.7.0's were captured from a debug build of the release branch, made on the
Mac with JDK 17 from Homebrew (`/opt/homebrew/opt/openjdk@17`); AGP 8.13 needs
JDK 17, and `java_home` lists only 11 and 8 there. A CI build serves as well:
the `Android (build + tests)` job keeps `agstatus-debug-apk` for fourteen days.

```bash
gh run download <run-id> -n agstatus-debug-apk -D /tmp/apk
adb uninstall com.kardanov.agstatus   # CI signs with its own debug key
adb install /tmp/apk/app-debug.apk
```

| # | File | Shows |
| --- | --- | --- |
| 1 | `01-board.png` | The board grouped by project: Claude's and Codex's heads with their plan limits, mark and session count, the acme-api section's label over its first two cards, each card's agent mark, and the needs-you bar naming the first of two blocked sessions, with Show |
| 2 | `02-history.png` | A session's screen: the demo's workflow session, opening on its ten running subagents, each with its state's mark and word, above its timeline |
| 3 | `03-welcome.png` | Setup options and demo mode — no account required |

To regenerate:

```bash
adb shell wm size 1080x1920 && adb shell wm density 420
# agstatus_demo_freeze (debug builds) holds the demo still, so no tick lands mid-capture
adb shell am start -n com.kardanov.agstatus/.MainActivity \
  --ez agstatus_demo true --ez agstatus_demo_freeze true
adb exec-out screencap -p > 01-board.png
# history needs the debug deep link, since it cannot be reached by a launch intent
adb shell am start -n com.kardanov.agstatus/.MainActivity \
  --ez agstatus_demo true --ez agstatus_demo_freeze true --ez agstatus_open_history true
adb exec-out screencap -p > 02-history.png
adb shell wm size reset && adb shell wm density reset
```

`screencap` writes RGBA, every pixel opaque, and Play takes screenshots only
as JPEG or 24-bit PNG, so save each as 24-bit RGB with no alpha before
uploading. The welcome screen needs the app's data cleared first.

## Notes that affect review

- **A personal developer account needs a closed test before production.**
  For personal accounts created after 13 November 2023, Play Console allows an
  application for production access only after a closed-testing track has had
  at least 12 testers opted in continuously for at least 14 days; a tester who
  opts out and back in restarts the count. Internal testing does not count.
  An organization account, which needs a D-U-N-S number, is exempt. The Play
  account for this app is still to be created, so plan on the closed test:
  recruit the testers before the first upload, or register as an
  organization. Google's rule:
  https://support.google.com/googleplay/android-developer/answer/14151465
- **No push notifications.** The Android app deliberately ships without them,
  so nothing in the listing or the Data safety form mentions notifications.
  The iOS app has them; do not copy iOS listing text over.
- **Camera is optional.** It is used only to decode a pairing QR code
  on-device; no frame is stored or transmitted. It is declared as optional
  hardware so devices without a camera can still install.
- **Third-party names.** "Claude Code", "Codex", "Anthropic" and "OpenAI"
  appear only as interoperability statements, with an explicit disclaimer in
  the full description. Play rejects listings that imply a relationship with
  another brand.
- **Every upload needs a higher versionCode than the last**, including the
  replacement for a rejected build. Nothing has been uploaded yet, so Play
  would take any number; 1.7.0's 7 keeps its bundle apart from 6, which 1.6.2
  was given and every CI debug APK carried from then until 1.7.0, as 5 was
  1.6.0's. Neither was ever uploaded.
- **The screenshots have to match the build.** Play rejects listings whose
  images do not show the app as submitted, and the 1.5 redesign changed every
  surface of it: palette, card, status marks, controls.
