#!/usr/bin/env bash
# Startet das EK050-Widget (macOS / Linux)
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
exec npx electron .
