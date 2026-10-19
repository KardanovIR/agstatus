#!/usr/bin/env bash
# Creates the Play upload key and wires the Android build to it.
#
#   scripts/make-upload-keystore.sh
#
# The keystore and its password are written OUTSIDE the repo (they are
# credentials), and android/keystore.properties — which points at them — is
# gitignored.
#
# This is for a machine where no upload key has ever been made. It refuses to
# run when one already exists in any folder it might be in, or when this
# checkout already has a keystore.properties: Play registers the first upload
# key it sees, and a second key would mean asking Google to reset it.
#
# With Play App Signing (on by default for new apps) Google holds the real
# app signing key; this upload key only proves that uploads come from you. If
# it is ever lost, Google can reset it — losing it is recoverable, unlike the
# app signing key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROPS="$ROOT/android/keystore.properties"
ALIAS="upload"

# Every folder the upload key could be in, one per line: AGSTATUS_SECRETS_DIR
# when it is set, the folder this script has always defaulted to, and any copy
# of it iCloud's Desktop sync has moved into a "Desktop - <Mac name>" folder,
# as it did on the development Mac. build-play-bundle.sh searches the same
# places; keep the two in step.
upload_key_dirs() {
  local d
  if [ -n "${AGSTATUS_SECRETS_DIR:-}" ]; then printf '%s\n' "$AGSTATUS_SECRETS_DIR"; fi
  printf '%s\n' "$HOME/Desktop/claude-status-private"
  for d in "$HOME/Desktop/Desktop - "*/claude-status-private; do
    if [ -d "$d" ]; then printf '%s\n' "$d"; fi
  done
}

EXISTING=""
while IFS= read -r dir; do
  if [ -f "$dir/agstatus-upload.jks" ]; then EXISTING="$EXISTING  $dir/agstatus-upload.jks"$'\n'; fi
done < <(upload_key_dirs | awk '!seen[$0]++')

if [ -n "$EXISTING" ]; then
  echo "An upload key already exists:" >&2
  printf '%s' "$EXISTING" >&2
  echo "Refusing to make another. To sign with it from this checkout, copy" >&2
  echo "android/keystore.properties from the checkout that has one (the first line of" >&2
  echo "'git worktree list' is the main one) and set its storeFile to that path." >&2
  exit 1
fi

if [ -f "$PROPS" ]; then
  echo "This checkout already has android/keystore.properties, which points at:" >&2
  grep -m1 '^storeFile=' "$PROPS" | sed 's/^storeFile=/  /' >&2 || true
  echo "Refusing to replace it. If that key is really gone, and no backup of it" >&2
  echo "exists, move the file aside by hand and run this again." >&2
  exit 1
fi

# No key anywhere: make it in the first of those folders that exists, or in
# the default one.
SECRETS_DIR="${AGSTATUS_SECRETS_DIR:-}"
if [ -z "$SECRETS_DIR" ]; then
  while IFS= read -r dir; do
    if [ -d "$dir" ]; then SECRETS_DIR="$dir"; break; fi
  done < <(upload_key_dirs)
fi
SECRETS_DIR="${SECRETS_DIR:-$HOME/Desktop/claude-status-private}"
KEYSTORE="$SECRETS_DIR/agstatus-upload.jks"

JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/temurin-17/Contents/Home}"
KEYTOOL="$JAVA_HOME/bin/keytool"
[ -x "$KEYTOOL" ] || { echo "keytool not found at $KEYTOOL — set JAVA_HOME" >&2; exit 1; }

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# A generated password beats a memorable one: nothing has to type it, and it
# is stored next to the keystore it unlocks. Read a fixed number of bytes
# rather than piping into head — under `set -o pipefail` the closed pipe kills
# the producer and takes the whole script with it.
PASSWORD="$(LC_ALL=C head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40)"

"$KEYTOOL" -genkeypair -v \
  -keystore "$KEYSTORE" \
  -storetype PKCS12 \
  -storepass "$PASSWORD" \
  -keypass "$PASSWORD" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=AgStatus, OU=AgStatus, O=Inal Kardanov, L=, ST=, C=" > /dev/null

chmod 600 "$KEYSTORE"

umask 077
cat > "$SECRETS_DIR/agstatus-upload-password.txt" <<EOF
Play upload keystore for com.kardanov.agstatus
keystore: $KEYSTORE
alias:    $ALIAS
password: $PASSWORD

Back this file and the .jks up somewhere safe (a password manager is ideal).
EOF

cat > "$PROPS" <<EOF
storeFile=$KEYSTORE
storePassword=$PASSWORD
keyAlias=$ALIAS
keyPassword=$PASSWORD
EOF
chmod 600 "$PROPS"

echo "Created:"
echo "  keystore  $KEYSTORE"
echo "  password  $SECRETS_DIR/agstatus-upload-password.txt"
echo "  build ref $PROPS  (gitignored)"
echo
echo "Fingerprint to expect in Play Console:"
"$KEYTOOL" -list -v -keystore "$KEYSTORE" -storepass "$PASSWORD" -alias "$ALIAS" \
  | grep -E "SHA1:|SHA256:" | sed 's/^/  /'
echo
echo "Now build the bundle:  scripts/build-play-bundle.sh"
