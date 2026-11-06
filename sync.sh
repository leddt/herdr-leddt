#!/usr/bin/env bash
# Copy the leddt layout and leddt-* mods from the Herdr home into this repo.
# One-way: Herdr home -> repo. Edit in ~/.config/herdr-app (live reload works there),
# then run this before committing.
set -euo pipefail

HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")" && pwd)"
PREFIX="leddt"

mkdir -p "$REPO/layouts" "$REPO/mods"

# Layout: leddt.json plus any preview (leddt.svg / leddt.png). Not .state (Herdr's click memory).
rsync -a --delete \
  --include="$PREFIX.*" --exclude='*' \
  "$HOME_DIR/layouts/" "$REPO/layouts/"

# Mods: every leddt-* folder, without the files Herdr regenerates.
# --delete also drops repo copies of mods you've removed from Herdr.
rsync -a --delete \
  --exclude='*.d.ts' --exclude='jsconfig.json' --exclude='node_modules' --exclude='.*' \
  --include="$PREFIX-*/" --include="$PREFIX-*/**" --exclude='*' \
  "$HOME_DIR/mods/" "$REPO/mods/"

echo "Synced from $HOME_DIR:"
ls "$REPO/layouts" | sed 's/^/  layouts\//'
ls "$REPO/mods" | sed 's/^/  mods\//'
