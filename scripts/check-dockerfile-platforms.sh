#!/bin/sh
# Fails when a RUN in the Dockerfile would execute for the target platform
# instead of the build platform.
#
#   scripts/check-dockerfile-platforms.sh [Dockerfile]
#
# The image is built for linux/amd64 and linux/arm64 on one amd64 runner. A
# stage that starts `FROM --platform=$BUILDPLATFORM` runs once, natively, and
# the per-platform runtime stage only copies its output in. A RUN in any other
# stage runs once per target platform, which for arm64 means under QEMU: that
# is where 1.6.2's `npm ci` died twice and then hung until the job timed out.
#
# Leaving docker/setup-qemu-action out of the workflows does not stop that.
# The docker-container BuildKit that setup-buildx-action starts ships its own
# QEMU (buildkit-qemu-aarch64 and the rest) and falls back to it when the
# kernel has no handler for the platform, so such a RUN would still build,
# emulated, and nothing would say so. This check is what refuses it; CI's
# docker job and release.yml's both run it before they build.
#
# Instructions are matched case-insensitively and may be indented; comment
# lines and the continuation lines of a multi-line instruction are skipped. A
# stage that reaches the build platform any other way (through an ARG, or by
# starting FROM another stage) counts as not pinned, so the check errs towards
# refusing.
set -eu

DOCKERFILE=${1:-Dockerfile}
[ -f "$DOCKERFILE" ] || { echo "$DOCKERFILE: no such file" >&2; exit 1; }

awk -v gha="${GITHUB_ACTIONS:-}" '
  # Comments and blank lines are not instructions, and a continuation carries
  # on past them.
  /^[ \t]*(#|$)/ { next }
  {
    continued = continues
    continues = ($0 ~ /\\[ \t]*$/)
  }
  continued { next }
  toupper($1) == "FROM" {
    pinned = index($0, "--platform=$BUILDPLATFORM") || index($0, "--platform=${BUILDPLATFORM}")
    stages++
    next
  }
  toupper($1) == "RUN" {
    runs++
    if (pinned) next
    msg = "RUN in a stage built for the target platform; for arm64 it runs under emulation. Move it to a FROM --platform=$BUILDPLATFORM stage and COPY the result"
    if (gha == "true") printf "::error file=%s,line=%d::%s\n", FILENAME, FNR, msg
    else printf "%s:%d: %s\n", FILENAME, FNR, msg
    printf "    %s\n", $0
    bad = 1
  }
  END {
    if (!stages) { printf "%s: no FROM instruction\n", FILENAME; exit 1 }
    if (bad) exit 1
    printf "%s: %d stages, and all %d RUN steps are on $BUILDPLATFORM\n", FILENAME, stages, runs
  }
' "$DOCKERFILE"
