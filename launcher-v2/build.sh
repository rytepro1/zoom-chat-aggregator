#!/bin/bash
# Builds the self-contained ZoomChat.app:
#   - Compiles the Swift launcher as a universal (arm64 + x86_64) binary
#   - Bundles the project source, production React build, server node_modules, and .env
#   - Bundles the Node runtime so the target Mac doesn't need Node installed
# Output: ~/Applications/ZoomChat.app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="ZoomChat"
DEST="$HOME/Applications/${APP_NAME}.app"
BUILD_DIR="$SCRIPT_DIR/.build"

mkdir -p "$BUILD_DIR" "$HOME/Applications"

echo "==> 1/5  Building React app for production..."
(cd "$ROOT/client" && npm run build) >/dev/null

echo "==> 2/5  Compiling Swift launcher (universal binary)..."
swiftc -O -parse-as-library -target arm64-apple-macos13 \
  -o "$BUILD_DIR/${APP_NAME}-arm64" \
  "$SCRIPT_DIR/Sources/main.swift"
swiftc -O -parse-as-library -target x86_64-apple-macos13 \
  -o "$BUILD_DIR/${APP_NAME}-x86_64" \
  "$SCRIPT_DIR/Sources/main.swift"
lipo -create \
  -output "$BUILD_DIR/$APP_NAME" \
  "$BUILD_DIR/${APP_NAME}-arm64" \
  "$BUILD_DIR/${APP_NAME}-x86_64"

echo "==> 3/5  Assembling .app bundle skeleton..."
rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS"
mkdir -p "$DEST/Contents/Resources"
cp "$BUILD_DIR/$APP_NAME" "$DEST/Contents/MacOS/$APP_NAME"

cat > "$DEST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundleIdentifier</key>
    <string>com.rytepro.zoomchat</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>Zoom Chat Aggregator</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.business</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

echo "==> 4/5  Generating .icns icon..."
WORK="$(mktemp -d)"
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 64 128 256 512 1024; do
  sips -z "$SIZE" "$SIZE" "$SCRIPT_DIR/icon-source.png" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
done
cp "$ICONSET/icon_32x32.png"     "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png"   "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png"   "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
rm "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"
iconutil -c icns -o "$DEST/Contents/Resources/icon.icns" "$ICONSET"
rm -rf "$WORK"

echo "==> 5/5  Bundling project files + Node runtime..."
PROJECT="$DEST/Contents/Resources/project"
mkdir -p "$PROJECT/client"
cp -R "$ROOT/src"            "$PROJECT/"
cp -R "$ROOT/client/dist"    "$PROJECT/client/"
cp -R "$ROOT/node_modules"   "$PROJECT/"
cp    "$ROOT/package.json"   "$PROJECT/"
cp    "$ROOT/package-lock.json" "$PROJECT/"
if [ -f "$ROOT/.env" ]; then
  cp "$ROOT/.env" "$PROJECT/"
fi

NODE_RUNTIME="$DEST/Contents/Resources/node-runtime"
mkdir -p "$NODE_RUNTIME"
cp -L "$(which node)" "$NODE_RUNTIME/node"

# Ad-hoc codesign so macOS will run it without the "damaged" warning.
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

echo ""
echo "Built: $DEST"
du -sh "$DEST"
