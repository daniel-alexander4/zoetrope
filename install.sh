#!/usr/bin/env bash
# install.sh — build (if needed) and install the Zoetrope .deb on this machine.
#
# Usage:
#   ./install.sh            # install the current VERSION's .deb, building it if absent
#   ./install.sh --rebuild  # force a fresh build first
#
# Requires: dpkg-deb (to build the package) and sudo + apt (to install it).
# Linux/amd64 only — the .deb is the Debian/Ubuntu artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
if [ -z "$VERSION" ]; then
  echo "error: VERSION file is missing or empty" >&2
  exit 1
fi
DEB="dist/Zoetrope-${VERSION}-linux-amd64.deb"

if [ "${1:-}" = "--rebuild" ] || [ ! -f "$DEB" ]; then
  echo "==> Building v${VERSION} (./build.sh)…"
  ./build.sh
fi

if [ ! -f "$DEB" ]; then
  echo "error: $DEB was not produced — is dpkg-deb installed? (sudo apt install dpkg-dev)" >&2
  exit 1
fi

echo "==> Installing $DEB (sudo)…"
# apt resolves the local file and handles reinstall/upgrade cleanly.
sudo apt install -y "./$DEB"

echo
echo "==> Installed Zoetrope v${VERSION}."
echo "    Launch it from your apps menu, or run: zoetrope"
