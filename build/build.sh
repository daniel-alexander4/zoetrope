#!/usr/bin/env bash
# Build Zoetrope artifacts for Linux (AppImage), Windows (.exe), and macOS (.app).
#
# Usage: ./build/build.sh [version]
# Output goes to dist/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-${VERSION:-$(cat VERSION 2>/dev/null | tr -d '[:space:]' || echo 0.0.0-dev)}}"
DIST="dist"
APP="zoetrope"
DISPLAY_NAME="Zoetrope"

rm -rf "$DIST"
mkdir -p "$DIST"

LDFLAGS_RELEASE="-s -w -X main.version=${VERSION}"
GOFLAGS_RELEASE=(-trimpath)

echo "==> Version: $VERSION"

# --- Linux (amd64) -----------------------------------------------------------
echo "==> Building linux/amd64"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE" \
  -o "$DIST/$APP-linux-amd64" .

# --- Windows (amd64, GUI subsystem - no console window) ----------------------
echo "==> Building windows/amd64"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE -H windowsgui" \
  -o "$DIST/$DISPLAY_NAME.exe" .

# --- macOS (universal: amd64 + arm64) ---------------------------------------
echo "==> Building darwin/amd64"
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE" \
  -o "$DIST/$APP-darwin-amd64" .

echo "==> Building darwin/arm64"
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE" \
  -o "$DIST/$APP-darwin-arm64" .

echo "==> Fusing macOS universal binary"
go run build/lipo.go -out "$DIST/$APP-darwin-universal" \
  "$DIST/$APP-darwin-amd64" "$DIST/$APP-darwin-arm64"

echo "==> Assembling $DISPLAY_NAME.app"
APP_BUNDLE="$DIST/$DISPLAY_NAME.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$DIST/$APP-darwin-universal" "$APP_BUNDLE/Contents/MacOS/$APP"
chmod +x "$APP_BUNDLE/Contents/MacOS/$APP"
sed "s/__VERSION__/$VERSION/g" build/Info.plist > "$APP_BUNDLE/Contents/Info.plist"
# macOS uses .icns; for unsigned demo apps a PNG works as a fallback resource
cp build/icon.png "$APP_BUNDLE/Contents/Resources/icon.png"

# Zip the .app for easier distribution (preserves exec bits with -y)
(cd "$DIST" && zip -qry "$DISPLAY_NAME-mac-universal.zip" "$DISPLAY_NAME.app")

# --- Linux AppImage ----------------------------------------------------------
echo "==> Building Linux AppImage"
APPDIR="$DIST/$DISPLAY_NAME.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
cp "$DIST/$APP-linux-amd64" "$APPDIR/usr/bin/$APP"
chmod +x "$APPDIR/usr/bin/$APP"
cp build/AppRun "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp build/zoetrope.desktop "$APPDIR/$APP.desktop"
cp build/icon.png "$APPDIR/$APP.png"
cp build/icon.png "$APPDIR/.DirIcon"

APPIMAGETOOL="${APPIMAGETOOL:-$(command -v appimagetool || true)}"
if [ -z "$APPIMAGETOOL" ]; then
  echo "    appimagetool not on PATH; downloading"
  APPIMAGETOOL="$DIST/appimagetool"
  curl -fsSL -o "$APPIMAGETOOL" \
    https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$APPIMAGETOOL"
fi

ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" \
  "$DIST/$DISPLAY_NAME-x86_64.AppImage" >/dev/null

# --- Tidy up intermediate artifacts ------------------------------------------
rm -f "$DIST/$APP-darwin-amd64" "$DIST/$APP-darwin-arm64" "$DIST/$APP-darwin-universal"
rm -rf "$APPDIR"
rm -f "$DIST/appimagetool"

echo
echo "==> Done. Artifacts in $DIST/:"
ls -lh "$DIST"
