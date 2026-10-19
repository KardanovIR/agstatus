#!/usr/bin/env bash
# Builds the Android App Bundle Google Play expects and drops it next to the
# rest of the submission material.
#
#   scripts/build-play-bundle.sh
#
# It signs with the upload key that android/keystore.properties points at.
# That file is gitignored, so a fresh checkout or worktree has none and the
# bundle builds unsigned, which Play rejects. The upload key already exists:
# copy keystore.properties from the checkout that has it rather than making a
# new key. scripts/make-upload-keystore.sh is only for a machine where no
# upload key has ever been made.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID="$ROOT/android"
PROPS="$ANDROID/keystore.properties"
DEST="$ROOT/distribution/google-play/release"

export JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/temurin-17/Contents/Home}"
[ -x "$JAVA_HOME/bin/java" ] || { echo "JDK 17 not found at $JAVA_HOME — set JAVA_HOME" >&2; exit 1; }

# Every upload key that exists, one path per line. These are the folders
# make-upload-keystore.sh searches (see the comment there): keep the two in
# step, including the copy iCloud's Desktop sync moved on the development Mac.
find_upload_keys() {
  local d
  {
    if [ -n "${AGSTATUS_SECRETS_DIR:-}" ]; then printf '%s\n' "$AGSTATUS_SECRETS_DIR"; fi
    printf '%s\n' "$HOME/Desktop/claude-status-private"
    for d in "$HOME/Desktop/Desktop - "*/claude-status-private; do
      if [ -d "$d" ]; then printf '%s\n' "$d"; fi
    done
  } | awk '!seen[$0]++' | while IFS= read -r d; do
    if [ -f "$d/agstatus-upload.jks" ]; then printf '%s\n' "$d/agstatus-upload.jks"; fi
  done
}

# The main checkout, when this is a linked worktree; nothing otherwise.
main_checkout() {
  local common
  common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  common="$(dirname "$common")"
  if [ "$common" != "$ROOT" ]; then printf '%s\n' "$common"; fi
}

KEYS="$(find_upload_keys)"

where_the_key_is() {
  if [ -n "$KEYS" ]; then
    echo "         The upload key is here; point storeFile at it:" >&2
    printf '%s\n' "$KEYS" | sed 's/^/           /' >&2
  else
    echo "         No upload key was found in ~/Desktop/claude-status-private or a" >&2
    echo "         moved copy of it. One was made for this app (its fingerprint is in" >&2
    echo "         distribution/google-play/README.md), so find it, or set" >&2
    echo "         AGSTATUS_SECRETS_DIR to its folder. Run make-upload-keystore.sh only" >&2
    echo "         if that key is gone for good." >&2
  fi
}

if [ ! -f "$PROPS" ]; then
  echo "warning: android/keystore.properties is missing, so the bundle will be UNSIGNED." >&2
  MAIN="$(main_checkout)"
  if [ -n "$MAIN" ] && [ -f "$MAIN/android/keystore.properties" ]; then
    echo "         Copy it from the main checkout rather than making a new key:" >&2
    echo "           cp \"$MAIN/android/keystore.properties\" \"$PROPS\"" >&2
  else
    echo "         Copy it from the checkout that has it rather than making a new key." >&2
  fi
  where_the_key_is
else
  # Gradle resolves a relative storeFile against the app module (`file()` in
  # app/build.gradle.kts), and stops deep in the build when it is missing.
  STORE_FILE="$(grep -m1 '^storeFile=' "$PROPS" | cut -d= -f2- || true)"
  case "$STORE_FILE" in
    "" | /*) ;;
    *) STORE_FILE="$ANDROID/app/$STORE_FILE" ;;
  esac
  if [ -n "$STORE_FILE" ] && [ ! -f "$STORE_FILE" ]; then
    echo "error: android/keystore.properties points at a keystore that is not there:" >&2
    echo "           $STORE_FILE" >&2
    where_the_key_is
    exit 1
  fi
fi

echo "==> Building release bundle"
( cd "$ANDROID" && ./gradlew :app:bundleRelease --console=plain )

AAB="$ANDROID/app/build/outputs/bundle/release/app-release.aab"
[ -f "$AAB" ] || { echo "No bundle produced at $AAB" >&2; exit 1; }

mkdir -p "$DEST"
cp "$AAB" "$DEST/agstatus-release.aab"

# Anchored to the assignment: the comment above versionCode in build.gradle.kts
# names both properties, and an unanchored grep reported that comment line as
# the versionName and an empty versionCode.
VERSION_NAME="$(grep -m1 -E '^[[:space:]]*versionName[[:space:]]*=' "$ANDROID/app/build.gradle.kts" | sed 's/.*"\(.*\)".*/\1/')"
VERSION_CODE="$(grep -m1 -E '^[[:space:]]*versionCode[[:space:]]*=' "$ANDROID/app/build.gradle.kts" | sed 's/[^0-9]//g')"

echo "==> $DEST/agstatus-release.aab"
echo "    versionName $VERSION_NAME, versionCode $VERSION_CODE, $(du -h "$DEST/agstatus-release.aab" | cut -f1)"

# A bundle whose signature block is missing will be rejected on upload; say so
# here rather than after a round trip through Play Console.
if unzip -l "$DEST/agstatus-release.aab" 2>/dev/null | grep -q "META-INF/.*\.RSA\|META-INF/.*\.EC"; then
  echo "    signed: yes"
else
  echo "    signed: NO — see the warning above about android/keystore.properties, then rebuild"
fi
