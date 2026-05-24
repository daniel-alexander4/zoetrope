#!/usr/bin/env bash
# Build Zoetrope artifacts for Linux (.deb, bare binary), Windows (.exe),
# and macOS (.app universal, zipped).
#
# Usage: ./build/build.sh [version]
# Output goes to dist/. Filenames embed the version, e.g.
#   Zoetrope-0.1.0-linux-amd64.deb
#   Zoetrope-0.1.0-windows-amd64.exe
#   Zoetrope-0.1.0-mac-universal.zip   (contains Zoetrope.app)
#   zoetrope-0.1.0-linux-amd64         (bare binary)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION_FROM_FILE=$(cat VERSION 2>/dev/null | tr -d '[:space:]' || true)
VERSION="${1:-${VERSION:-${VERSION_FROM_FILE:-0.0.0}}}"
DIST="dist"
APP="zoetrope"
DISPLAY_NAME="Zoetrope"
STEM="${APP}-${VERSION}"
DISPLAY_STEM="${DISPLAY_NAME}-${VERSION}"

rm -rf "$DIST"
mkdir -p "$DIST"

LDFLAGS_RELEASE="-s -w"
GOFLAGS_RELEASE=(-trimpath)

echo "==> Version: $VERSION"

# --- Linux (amd64) bare binary ----------------------------------------------
echo "==> Building linux/amd64"
LINUX_BIN="$DIST/${STEM}-linux-amd64"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE" \
  -o "$LINUX_BIN" .

# --- Windows (amd64, GUI subsystem - no console window) ----------------------
echo "==> Building windows/amd64"
WIN_EXE="$DIST/${DISPLAY_STEM}-windows-amd64.exe"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build "${GOFLAGS_RELEASE[@]}" -ldflags "$LDFLAGS_RELEASE -H windowsgui" \
  -o "$WIN_EXE" .

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
cp web/icon.png "$APP_BUNDLE/Contents/Resources/icon.png"

# Zip the .app for distribution (preserves exec bits)
(cd "$DIST" && zip -qry "${DISPLAY_STEM}-mac-universal.zip" "$DISPLAY_NAME.app")

# --- Linux .deb --------------------------------------------------------------
if command -v dpkg-deb >/dev/null 2>&1; then
  echo "==> Building Debian package"
  DEBROOT="$DIST/deb-root"
  rm -rf "$DEBROOT"
  mkdir -p "$DEBROOT/DEBIAN" \
           "$DEBROOT/usr/bin" \
           "$DEBROOT/usr/share/applications" \
           "$DEBROOT/usr/share/icons/hicolor/256x256/apps"
  cp "$LINUX_BIN" "$DEBROOT/usr/bin/$APP"
  chmod +x "$DEBROOT/usr/bin/$APP"
  cp build/zoetrope.desktop "$DEBROOT/usr/share/applications/$APP.desktop"
  cp web/icon.png "$DEBROOT/usr/share/icons/hicolor/256x256/apps/$APP.png"

  # Approximate installed size in KiB
  INSTALLED_SIZE=$(du -sk "$DEBROOT" | cut -f1)

  cat > "$DEBROOT/DEBIAN/control" <<EOF
Package: $APP
Version: $VERSION
Section: graphics
Priority: optional
Architecture: amd64
Installed-Size: $INSTALLED_SIZE
Maintainer: Daniel Alexander <daniel@alexander4.org>
Description: Configurable bouncing-ball pattern animator
 Visual eye-tracking aid that serves a localhost browser page playing
 a configurable playlist of ball-motion patterns (horizontal /
 vertical / diagonal sweeps, circles, infinity figures, bounce). A
 vision-training "edge linger" mode pulses the ball at sweep extremes
 for peripheral feedback.
EOF

  # dpkg-deb requires DEBIAN/ and contents to be world-readable; user's
  # umask can leave them at 0750. Normalize to 0755 dirs / 0644 files
  # (binary stays 0755 below).
  find "$DEBROOT" -type d -exec chmod 0755 {} +
  find "$DEBROOT" -type f -exec chmod 0644 {} +
  chmod 0755 "$DEBROOT/usr/bin/$APP"

  DEB_OUT="$DIST/${DISPLAY_STEM}-linux-amd64.deb"
  dpkg-deb --root-owner-group --build "$DEBROOT" "$DEB_OUT" >/dev/null
  rm -rf "$DEBROOT"
else
  echo "==> dpkg-deb not found; skipping .deb"
fi

# --- Tidy up intermediate artifacts ------------------------------------------
rm -f "$DIST/$APP-darwin-amd64" "$DIST/$APP-darwin-arm64" "$DIST/$APP-darwin-universal"
rm -rf "$APP_BUNDLE"

echo
echo "==> Done. Artifacts in $DIST/:"
ls -lh "$DIST" | awk 'NR > 1 {print "    "$0}'
