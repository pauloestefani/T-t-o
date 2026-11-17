#!/bin/bash
# Monta o Tatao-Linux.AppImage a partir do app empacotado (node build.js linux).
# Uso: ./build-appimage.sh <appimagetool> [saída]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOL="$1"; OUT="${2:-$ROOT/Tatao-Linux.AppImage}"
SRC="$ROOT/dist/Tatao-linux-x64"
[ -x "$SRC/tatao" ] || { echo "falta $SRC/tatao (rode: node build.js linux)"; exit 1; }
AD="$ROOT/dist/Tatao.AppDir"
rm -rf "$AD"; mkdir -p "$AD/usr/lib"
cp -a "$SRC" "$AD/usr/lib/tatao"
install -m 755 "$ROOT/linux/AppRun" "$AD/AppRun"
cp "$ROOT/linux/tatao.desktop" "$AD/tatao.desktop"
cp "$ROOT/icon.png" "$AD/tatao.png"; ln -s tatao.png "$AD/.DirIcon"
mkdir -p "$AD/usr/share/icons/hicolor/256x256/apps"; cp "$ROOT/icon.png" "$AD/usr/share/icons/hicolor/256x256/apps/tatao.png"
chmod -R a+rX "$AD"
VER="$(node -p "require('$ROOT/package.json').version")"
ARCH=x86_64 VERSION="$VER" APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream "$AD" "$OUT"
chmod 755 "$OUT"; ls -la "$OUT"
