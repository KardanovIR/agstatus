#!/bin/sh
# install.sh decides whether a Mac gets the Focus listener, and a wrong answer
# turns Focus on against an opt-out. This checks that decision two ways, both
# on install.sh's own code, never a copy of it:
#
#   - focus_recorded, setup_focus and version_at_least, cut out of the file,
#     against every case setup_focus has to tell apart;
#   - main() itself, from a copy of the file without its last line, with only
#     the download and the profile edit replaced: --no-focus when init fails,
#     an upgrade over an install where Focus was off, the version gate on
#     --no-minimal, and the sign-off.
#
# A stub `agstatus` records what it was asked to do. CI runs this under sh,
# dash and bash; so can you:
#
#   sh scripts/test-install-focus.sh
#
# It needs node, as install.sh does, and touches nothing outside a temporary
# directory.
#
# The case variables (OS, FOCUS, PREVIOUS, ...) are read by the functions
# sourced from install.sh, which also call say/step/note/warn and the
# overrides below; shellcheck can see none of that.
# shellcheck disable=SC2034,SC2317,SC2329
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAILED=0
fail() {
  echo "✖ $1" >&2
  FAILED=$((FAILED + 1))
}

# ---------------------------------------------------------------------------
# setup_focus, case by case
# ---------------------------------------------------------------------------

FUNCTIONS="$WORK/functions.sh"
awk '/^(focus_recorded|focus_disclosure|setup_focus|version_at_least)\(\) \{/ { p = 1 }
     p { print }
     p && /^\}/ { p = 0 }' "$REPO_DIR/public/install.sh" > "$FUNCTIONS"
for fn in focus_recorded focus_disclosure setup_focus version_at_least; do
  grep -q "^$fn() {" "$FUNCTIONS" || { echo "✖ $fn() is not in public/install.sh" >&2; exit 1; }
done

# What install.sh's own say/step/note/warn print, near enough to match on.
say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }

# The stub: logs its arguments, and for `listener uninstall` writes the record
# the way the 1.6.4 CLI does (STUB_RECORDS=no plays an older CLI that does not)
# and exits STUB_RC.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/agstatus" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_LOG"
if [ "$1 $2" = 'listener uninstall' ]; then
  if [ "$STUB_RECORDS" = yes ]; then printf '{"focus":false}\n' > "$HOME/.agstatus.json"; fi
  echo 'uninstall output'
  exit "$STUB_RC"
fi
exit 0
STUB
chmod +x "$WORK/bin/agstatus"

# The defaults of one case: a first install on macOS with nothing recorded.
reset() {
  OS=darwin FOCUS=yes FOCUS_EXPLICIT=no PREVIOUS='' VERSION=1.6.4
  JSON='' PLIST=no STUB_RC=0 STUB_RECORDS=yes
}

# check <name> <expected stub calls, ;-separated> <text the output must contain, or ''>
check() {
  ck_failed=$FAILED
  ck_home=$(mktemp -d "$WORK/home.XXXXXX")
  : > "$ck_home/stub.log"
  if [ -n "$JSON" ]; then printf '%s' "$JSON" > "$ck_home/.agstatus.json"; fi
  if [ "$PLIST" = yes ]; then
    mkdir -p "$ck_home/Library/LaunchAgents"
    : > "$ck_home/Library/LaunchAgents/com.agstatus.listener.plist"
  fi
  ck_rc=0
  ck_out=$(
    HOME=$ck_home
    STUB_LOG=$ck_home/stub.log
    export HOME STUB_LOG STUB_RC STUB_RECORDS
    NODE=$(command -v node)
    BIN=$WORK/bin/agstatus
    PREFIX=$ck_home/.agstatus
    # shellcheck source=/dev/null
    . "$FUNCTIONS"
    setup_focus 2>&1
  ) || ck_rc=$?
  ck_calls=$(tr '\n' ';' < "$ck_home/stub.log")
  if [ "$ck_rc" -ne 0 ]; then fail "$1: setup_focus exited $ck_rc"; fi
  if [ "$ck_calls" != "$2" ]; then fail "$1: called [$ck_calls], expected [$2]"; fi
  case $ck_out in
    *"$3"*) ;;
    *) fail "$1: output lacks \"$3\":
$ck_out" ;;
  esac
  if [ "$FAILED" -eq "$ck_failed" ]; then echo "✔ $1"; fi
}

reset
check 'a first install sets Focus up' 'listener install;' 'Focus — tapping a session'

reset; JSON='{"focus":false,"keys":{}}'
check 'a bare run keeps an opt-out recorded as "focus": false' '' 'Skipped: Focus was turned off on this Mac'

reset; JSON="$(printf '\357\273\277{"focus":false}')"
check 'the record is read through a byte-order mark' '' 'Skipped: Focus was turned off on this Mac'

reset; JSON='{"focus":false}'; FOCUS_EXPLICIT=yes
check '--focus overrides the record' 'listener install;' ''

reset; FOCUS=no; FOCUS_EXPLICIT=yes
check '--no-focus turns Focus off and says later runs keep it off' 'listener uninstall;' 'later runs keep it off'

reset; FOCUS=no; FOCUS_EXPLICIT=yes; STUB_RECORDS=no; VERSION=1.6.3
check '--no-focus with a CLI that records nothing says so' 'listener uninstall;' 'agstatus 1.6.3 did not record that'

reset; FOCUS=no; FOCUS_EXPLICIT=yes; STUB_RC=1
check 'a failing uninstall is reported, and the run carries on' 'listener uninstall;' 'so Focus may still be on'

reset; JSON='{"focus":true}'; PREVIOUS=1.6.3
check 'an upgrade with Focus on reinstalls it' 'listener install;' ''

reset; PREVIOUS=1.6.3; PLIST=yes
check 'an upgrade with the LaunchAgent in place reinstalls it' 'listener install;' ''

reset; PREVIOUS=1.6.3
check 'an upgrade where Focus was not on keeps it off (an unrecorded --no-focus)' '' 'Focus was not on in the install this upgrades'

reset; PREVIOUS=1.6.3; FOCUS_EXPLICIT=yes
check '--focus turns it on in that upgrade' 'listener install;' ''

reset; JSON='{ not json'
check 'an unreadable file on a first install leaves the call to listener install' 'listener install;' ''

reset; OS=linux; JSON='{"focus":false}'
check 'Linux never gets the listener' '' 'macOS-only'

# shellcheck source=/dev/null
. "$FUNCTIONS"
while read -r va vb want; do
  if version_at_least "$va" "$vb"; then got=yes; else got=no; fi
  if [ "$got" = "$want" ]; then echo "✔ version_at_least $va $vb is $want"; else fail "version_at_least $va $vb: $got, expected $want"; fi
done <<'VERSIONS'
1.6.4 1.6.4 yes
1.6.3 1.6.4 no
1.6.10 1.6.4 yes
1.10.0 1.6.4 yes
2.0.0 1.6.4 yes
1.5.9 1.6.4 no
0.9.9 1.6.4 no
VERSIONS

# ---------------------------------------------------------------------------
# main(), end to end, with no download
# ---------------------------------------------------------------------------

LIB="$WORK/install-lib.sh"
[ "$(tail -n 1 "$REPO_DIR/public/install.sh")" = '{ main "$@"; }' ] || {
  echo '✖ public/install.sh no longer ends with { main "$@"; }' >&2
  exit 1
}
sed '$d' "$REPO_DIR/public/install.sh" > "$LIB"

# A fake release for each version: lib/agstatus/dist/cli.js logs its
# arguments, exits INIT_RC for `init`, and records "focus": false for
# `listener uninstall`, as the 1.6.4 CLI does.
release() {
  rl_dir="$WORK/release-$1/lib/agstatus"
  mkdir -p "$rl_dir/dist"
  printf '{ "name": "agstatus", "version": "%s" }\n' "$1" > "$rl_dir/package.json"
  cat > "$rl_dir/dist/cli.js" <<'CLI'
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, args.join(' ') + '\n');
if (args[0] === 'init') process.exit(Number(process.env.INIT_RC || 0));
if (args[0] === 'listener' && args[1] === 'uninstall') {
  fs.writeFileSync(path.join(process.env.HOME, '.agstatus.json'), '{"focus":false}\n');
}
process.exit(0);
CLI
}
release 1.6.3
release 1.6.4

# run_main <name> <version> <installed before, or ''> <init exit> <expected rc> <expected calls> <must contain> <must not contain> [installer args...]
run_main() {
  rm_name=$1 rm_version=$2 rm_before=$3 rm_init=$4 rm_want_rc=$5 rm_want_calls=$6 rm_want=$7 rm_unwanted=$8
  shift 8
  rm_failed=$FAILED
  rm_home=$(mktemp -d "$WORK/main.XXXXXX")
  : > "$rm_home/stub.log"
  if [ -n "$rm_before" ]; then
    mkdir -p "$rm_home/.agstatus/lib/agstatus"
    printf '{ "version": "%s" }\n' "$rm_before" > "$rm_home/.agstatus/lib/agstatus/package.json"
  fi
  rm_rc=0
  rm_out=$(
    HOME=$rm_home
    AGSTATUS_HOME=$rm_home/.agstatus
    AGSTATUS_VERSION=$rm_version
    AGSTATUS_NODE=$(command -v node)
    CODEX_HOME=$rm_home/.codex
    STUB_LOG=$rm_home/stub.log
    INIT_RC=$rm_init
    export HOME AGSTATUS_HOME AGSTATUS_VERSION AGSTATUS_NODE CODEX_HOME STUB_LOG INIT_RC
    # shellcheck source=/dev/null
    . "$LIB"
    detect_platform() { OS=darwin; }
    fetch_release() { TGZ_NAME="agstatus-$VERSION.tgz"; echo FETCH >> "$STUB_LOG"; }
    verify_tarball() { :; }
    extract_tarball() { ROOT="$WORK/release-$VERSION"; }
    setup_path() { :; }
    main "$@" 2>&1
  ) || rm_rc=$?
  rm_calls=$(tr '\n' ';' < "$rm_home/stub.log")
  if [ "$rm_rc" -ne "$rm_want_rc" ]; then fail "$rm_name: main exited $rm_rc, expected $rm_want_rc"; fi
  if [ "$rm_calls" != "$rm_want_calls" ]; then fail "$rm_name: called [$rm_calls], expected [$rm_want_calls]"; fi
  case $rm_out in
    *"$rm_want"*) ;;
    *) fail "$rm_name: output lacks \"$rm_want\":
$rm_out" ;;
  esac
  if [ -n "$rm_unwanted" ]; then
    case $rm_out in
      *"$rm_unwanted"*) fail "$rm_name: output has \"$rm_unwanted\":
$rm_out" ;;
    esac
  fi
  if [ "$FAILED" -eq "$rm_failed" ]; then echo "✔ main: $rm_name"; fi
}

run_main 'a first install sets up hooks, then Focus, and says what an upgrade keeps' \
  1.6.4 '' 0 0 'FETCH;init;listener install;' "it keeps this machine's server" ''
run_main '--no-focus turns Focus off even when init fails' \
  1.6.4 '' 1 1 'FETCH;init;listener uninstall;' 'later runs keep it off' "it keeps this machine's server" \
  --no-focus
run_main 'an upgrade over an install where Focus was off keeps it off' \
  1.6.4 1.6.3 0 0 'FETCH;init;' 'Focus was not on in the install this upgrades' ''
run_main '--no-minimal is refused before the download of a release older than 1.6.4' \
  1.6.3 '' 0 1 '' 'need AgStatus 1.6.4 or later' '' \
  --no-minimal
run_main 'with an older release, the sign-off promises nothing it does not keep' \
  1.6.3 '' 0 0 'FETCH;init;listener install;' 'Re-run this installer any time to upgrade.' 'it keeps'

if [ "$FAILED" -ne 0 ]; then
  echo "$FAILED check(s) failed" >&2
  exit 1
fi
echo 'install.sh decides Focus correctly in every case above'
