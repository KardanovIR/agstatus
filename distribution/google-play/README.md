# Google Play submission — AgStatus for Android

Everything needed to publish `com.kardanov.agstatus`. Assets here are final;
the checklist marks what still needs doing in Play Console.

```
distribution/google-play/
├── README.md                     this file
├── listing/
│   ├── title.txt                 28 / 30 chars
│   ├── short-description.txt     72 / 80
│   ├── full-description.txt      3987 / 4000
│   └── whats-new.txt             476 / 500
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

App version: **`versionName 1.6.2`, `versionCode 6`** (`android/app/build.gradle.kts`).
The checklist below was written against 1.1.0 / versionCode 1 and the app has
moved on several releases since, so read the rows in bold before uploading
anything.

| Step | Status |
| --- | --- |
| Upload key created, stored outside the repo | **done** |
| Listing copy within every character limit | **done** — re-counted for 1.6.2 |
| Data safety answers derived from the code | **done** — transcribe into Console |
| Content rating + app content declarations | **done** — transcribe into Console |
| Privacy policy URL — https://agstatus.online/privacy | **done**, already live |
| **Screenshots regenerated against 1.6.0** | **done** — and still current for 1.6.2, which changes only the Pair sheet's command (now quoted) and the errors for a refused code or board; no screenshot shows either |
| **Icon and feature graphic regenerated** | **TODO** — both still use the retired palette |
| **Signed App Bundle rebuilt at versionCode 6** | **TODO** — `scripts/build-play-bundle.sh`, on your Mac; CI builds no bundle |
| Create the app in Play Console and pay the one-time $25 registration | you |
| Upload the bundle to a track (internal testing first) | you |
| Fill Data safety, content rating, and app content from the docs here | you |
| Countries, pricing (free), and rollout | you |

### The two graphics still to redo

`graphics/icon-512.png` and `graphics/feature-graphic.png` were exported from
the palette this project retired in 1.5 — the near-black `#0B0D12` ground with
Tailwind's `blue-500` / `purple-500` / `amber-500` on it. The launcher icon in
the app itself (`res/drawable/ic_launcher_foreground.xml`) has been ported and
is the reference: four solid tiles, planning `#D4A3DF`, coding `#78B2DB`,
testing `#69BABF`, done `#69C88E`, on `#0C0F0D`. Play wants PNG with no alpha
at 512×512 and 1024×500, and nothing in this repo renders that vector to one,
so both need exporting by hand.

## Rebuilding the bundle

```bash
scripts/make-upload-keystore.sh   # once — creates the upload key
scripts/build-play-bundle.sh      # builds + signs, copies here
```

This is the only way to get the bundle Play takes. CI's `Android (build + tests)`
job runs `assembleDebug` and keeps `agstatus-debug-apk`, signed with the
runner's throwaway debug key, and `release.yml` has no Android job: nothing in
CI builds an `.aab` or signs anything, because the upload key must never reach
it. Play rejects a debug-signed APK.

The script finds JDK 17 at `~/.jdks/temurin-17` (set `JAVA_HOME` to use
another); `/usr/libexec/java_home -V` does not list that one, so it is easy to
conclude there is none. The first run downloads Gradle 8.14.3 through the
wrapper, and AGP and Kotlin through Gradle.

The keystore and its password live in `~/Desktop/claude-status-private/`, and
`android/keystore.properties` (which points at them) is gitignored. Back both
up. If iCloud's Desktop sync has moved that folder, as it has on the
development Mac, point `storeFile` in `keystore.properties` at where the `.jks`
is now, or the release build stops with the keystore not found. With Play App Signing — on by default for new
apps — Google holds the real app signing key and this upload key only proves
the upload is yours, so losing it is recoverable.

Upload key SHA-256, which Play Console will show after the first upload:

```
44:CB:00:E8:E0:F1:5C:D9:86:36:C6:43:D4:9B:CD:65:9D:AA:3F:22:F6:DE:F9:C3:FD:CF:00:33:B9:64:78:B8
```

## Screenshots

Captured from the emulator in demo mode, so nothing personal appears and the
board is populated without pairing a machine. Play caps phone screenshots at a
2:1 aspect ratio, so these are 1080×1920 (16:9) rather than the emulator's
native 1080×2400, which would be rejected.

The APK they are captured from comes from CI, not from this Mac: AGP 8.13 needs
JDK 17, and `java_home` lists only 11 and 8 here (the bundle script uses the
unregistered one described above). The `Android (build + tests)` job keeps
`agstatus-debug-apk` for fourteen days.

```bash
gh run download <run-id> -n agstatus-debug-apk -D /tmp/apk
adb uninstall com.kardanov.agstatus   # CI signs with its own debug key
adb install /tmp/apk/app-debug.apk
```

| # | File | Shows |
| --- | --- | --- |
| 1 | `01-board.png` | The live board: plan-limit bars, a coding session with its Focus control and why it is disabled, a finished one, and the next card beginning |
| 2 | `02-history.png` | A session timeline: every status change with its mark, its message and its time |
| 3 | `03-welcome.png` | Setup options and demo mode — no account required |

To regenerate:

```bash
adb shell wm size 1080x1920 && adb shell wm density 420
adb shell am start -n com.kardanov.agstatus/.MainActivity --ez agstatus_demo true
adb exec-out screencap -p > 01-board.png
# history needs the debug deep link, since it cannot be reached by a launch intent
adb shell am start -n com.kardanov.agstatus/.MainActivity \
  --ez agstatus_demo true --ez agstatus_open_history true
adb exec-out screencap -p > 02-history.png
adb shell wm size reset && adb shell wm density reset
```

## Notes that affect review

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
  would take any number; 6 is the next after 5, which 1.6.0 was given and
  which every CI debug APK from then until 1.6.2 carries. 1.6.0 was never
  tagged or uploaded.
- **The screenshots have to match the build.** Play rejects listings whose
  images do not show the app as submitted, and the 1.5 redesign changed every
  surface of it: palette, card, status marks, controls.
