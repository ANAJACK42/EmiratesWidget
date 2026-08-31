#!/usr/bin/env bash
#
# Baut "EK050.app" aus macos/main.swift.
#
# Voraussetzung: Xcode Command Line Tools (Apple):  xcode-select --install
# Es wird nichts heruntergeladen und kein fremdes Binary ausgeführt –
# der Compiler von Apple erzeugt das Programm lokal auf diesem Mac.
#
set -euo pipefail

cd "$(dirname "$0")/.."
APP_NAME="EK050"
DEST="${1:-$HOME/Applications}"
APP="$DEST/$APP_NAME.app"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Der Swift-Compiler fehlt."
  echo "Bitte einmalig ausführen und den Apple-Dialog bestätigen:"
  echo "    xcode-select --install"
  exit 1
fi

echo "Kompiliere $APP_NAME …"
mkdir -p build
swiftc -O -o "build/$APP_NAME" macos/main.swift -framework Cocoa -framework WebKit

echo "Baue App-Bundle in $APP …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "build/$APP_NAME" "$APP/Contents/MacOS/$APP_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>EK050 Flight Widget</string>
  <key>CFBundleIdentifier</key><string>de.local.ek050widget</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

# Lokale Ad-hoc-Signatur, damit macOS das selbst gebaute Programm startet
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo
echo "Fertig: $APP"
echo "Starten mit:  open \"$APP\""
