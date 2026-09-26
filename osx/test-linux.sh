#!/bin/bash
# PACore tests on the Linux dev box via Docker (swift:6.1). Package.swift only declares `pa` + FluidAudio on macOS,
# so the manifest is used as-is; layout mirrors the repo so tests find shared/fixtures via #filePath.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD":/w:ro -e HOME=/tmp swift:6.1 bash -c '
  set -e
  mkdir -p /tmp/r/osx /tmp/r/shared
  cp -r /w/osx/Package.swift /w/osx/Sources /w/osx/Tests /tmp/r/osx/
  cp -r /w/shared/fixtures /tmp/r/shared/
  cd /tmp/r/osx && swift test 2>&1 | grep -vE "^\[[0-9]+/[0-9]+\]|started\.$"'
