#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$ROOT/LiveControl.app}"
CONTENTS="$OUT/Contents"
RESOURCES="$CONTENTS/Resources"

rm -rf "$OUT"
mkdir -p "$RESOURCES/LiveControl"
mkdir -p "$CONTENTS/MacOS"

cp "$ROOT/server.js" "$ROOT/ableton.js" "$ROOT/setlist.js" "$ROOT/lyrics-parser.js" "$ROOT/storage.js" "$ROOT/qr.js" \
   "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/setlist-meta.json" "$RESOURCES/LiveControl/"
cp -R "$ROOT/public" "$RESOURCES/LiveControl/public"
cp -R "$ROOT/node_modules" "$RESOURCES/LiveControl/node_modules"
cp "$(command -v node)" "$RESOURCES/node"
chmod +x "$RESOURCES/node"

# App icon (Dock / Finder) + menu bar glyph
cp "$ROOT/icon.png" "$RESOURCES/icon.png"
cp "$ROOT/menubar-icon.png" "$RESOURCES/menubar-icon.png"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ROOT/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ROOT/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

clang -fobjc-arc -fmodules -fmodules-cache-path=/private/tmp/livecontrol-module-cache -mmacosx-version-min=13.0 \
  -framework AppKit -framework WebKit -framework CoreImage \
  "$ROOT/LiveControlApp.m" -o "$CONTENTS/MacOS/LiveControl"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>LiveControl</string>
  <key>CFBundleIdentifier</key><string>com.livecontrol.app</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleName</key><string>LiveControl</string>
  <key>CFBundleDisplayName</key><string>LiveControl</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><false/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSLocalNetworkUsageDescription</key><string>LiveControl lets your phone and tablet control Ableton Live over your local network.</string>
</dict></plist>
PLIST

find "$OUT" -exec xattr -c {} +
xattr -d com.apple.FinderInfo "$OUT" 2>/dev/null || true
codesign --force --deep --sign - "$OUT"
echo "Built $OUT"
