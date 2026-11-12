#!/usr/bin/env bash
# Copy the leddt layout and leddt-* mods from the Herdr home into this repo.
# One-way: Herdr home -> repo. Edit in ~/.config/herdr-app (live reload works there),
# then run this before committing.
set -euo pipefail

HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")" && pwd)"
PREFIX="leddt"

mkdir -p "$REPO/layouts" "$REPO/mods" "$REPO/themes"

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

# Layouts: drop every block whose mod Herdr doesn't ship and this repo doesn't publish (mods
# kept in another repo, e.g. a private one), so the published layout only needs what's here.
# A stack that showed a dropped child shows its first one instead.
node - "$HOME_DIR/installed.json" "$REPO" <<'EOF'
const fs = require("fs"), path = require("path");
const [installed, repo] = process.argv.slice(-2);
const shipped = Object.keys(JSON.parse(fs.readFileSync(installed, "utf8"))).filter((k) => !k.includes(":"));
const known = new Set([...shipped, ...fs.readdirSync(path.join(repo, "mods"))]);
const dropped = (node) => node?.content?.mod && !known.has(node.content.mod);
function strip(node) {
  if (Array.isArray(node.children)) {
    node.children = node.children.filter((c) => !dropped(c)).map(strip);
    if (node.active && !node.children.some((c) => c.id === node.active)) node.active = node.children[0]?.id;
  }
  if (Array.isArray(node.floating)) node.floating = node.floating.filter((c) => !dropped(c)).map(strip);
  return node;
}
for (const name of fs.readdirSync(path.join(repo, "layouts")).filter((f) => f.endsWith(".json"))) {
  const file = path.join(repo, "layouts", name);
  fs.writeFileSync(file, JSON.stringify(strip(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2) + "\n");
}
EOF

# Themes: every leddt-*.json.
rsync -a --delete \
  --include="$PREFIX-*.json" --exclude='*' \
  "$HOME_DIR/themes/" "$REPO/themes/"

echo "Synced from $HOME_DIR:"
ls "$REPO/layouts" | sed 's/^/  layouts\//'
ls "$REPO/mods" | sed 's/^/  mods\//'
ls "$REPO/themes" | sed 's/^/  themes\//'
