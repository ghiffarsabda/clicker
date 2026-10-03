#!/usr/bin/env bash
# EPM bootstrap — ensure Node.js >= 18 and git are present, then put `epm` on PATH.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE=18
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m\u2713\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m\u2717\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

say "EPM setup"

if have node && [ "$(node_major)" -ge "$MIN_NODE" ]; then
  ok "node $(node -v)"
else
  warn "Node.js >= $MIN_NODE not found — attempting to install"
  if have brew; then brew install node
  elif have apt-get; then sudo apt-get update && sudo apt-get install -y nodejs npm
  elif have dnf; then sudo dnf install -y nodejs
  elif have pacman; then sudo pacman -S --noconfirm nodejs npm
  elif have yum; then sudo yum install -y nodejs
  else die "install Node.js $MIN_NODE+ from https://nodejs.org and re-run"; fi
  have node && [ "$(node_major)" -ge "$MIN_NODE" ] || die "Node.js is still missing or too old"
  ok "node $(node -v)"
fi

if have git; then
  ok "git $(git --version | awk '{print $3}')"
else
  warn "git not found — attempting to install"
  if have brew; then brew install git
  elif have apt-get; then sudo apt-get install -y git
  elif have dnf; then sudo dnf install -y git
  elif have pacman; then sudo pacman -S --noconfirm git
  else warn "install git from https://git-scm.com (needed to clone/update the source)"; fi
fi

chmod +x "$DIR/bin/epm.js"
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"
ln -sf "$DIR/bin/epm.js" "$LINK_DIR/epm"
ok "linked epm -> $LINK_DIR/epm"
case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) warn "add to PATH:  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.profile && . ~/.profile" ;;
esac

say "Done. Run:  epm doctor"
