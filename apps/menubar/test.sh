#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$SCRIPT_DIR/.build"
xcrun swiftc "$SCRIPT_DIR/Sources/StatusModel.swift" "$SCRIPT_DIR/Tests/StatusModelTests.swift" \
  -o "$SCRIPT_DIR/.build/status-model-tests"
"$SCRIPT_DIR/.build/status-model-tests"
