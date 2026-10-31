#!/bin/sh
set -eu
native_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$native_root/bin" "$native_root/.module-cache"
xcrun swiftc -swift-version 5 -parse-as-library -O \
  -target "$(uname -m)-apple-macosx14.0" \
  -module-cache-path "$native_root/.module-cache" \
  "$native_root/MacOSAXReadOnly.swift" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework ScreenCaptureKit -framework ImageIO -framework IOKit \
  -o "$native_root/bin/macos-ax-readonly"
printf '%s\n' "$native_root/bin/macos-ax-readonly"
xcrun swiftc -swift-version 5 -parse-as-library -O -D CONTROL_HELPER \
  -target "$(uname -m)-apple-macosx14.0" \
  -module-cache-path "$native_root/.module-cache" \
  "$native_root/MacOSAXReadOnly.swift" "$native_root/MacOSAXControl.swift" "$native_root/MacOSPasteboard.swift" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework ScreenCaptureKit -framework ImageIO -framework IOKit \
  -o "$native_root/bin/macos-ax-control"
printf '%s\n' "$native_root/bin/macos-ax-control"
