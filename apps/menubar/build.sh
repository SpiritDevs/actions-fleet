#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR/dist/Actions Fleet.app"
mkdir -p "$APP_DIR/Contents/MacOS"
xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" -framework AppKit \
  "$SCRIPT_DIR/Sources/StatusModel.swift" "$SCRIPT_DIR/Sources/MenuBarApp.swift" \
  -o "$APP_DIR/Contents/MacOS/ActionsFleetMenuBar"
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP_DIR"
printf '%s\n' "Built $APP_DIR"
