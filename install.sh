#!/usr/bin/env bash
#
# FOREMAN bootstrap installer.
#   curl -fsSL https://raw.githubusercontent.com/Sweet-Papa-Technologies/BetterYes/main/install.sh | bash
#
# Does everything scriptable — clone, install deps, build the dashboard, install Claude Code +
# the LiteLLM proxy — then hands off the two steps only a human can do: logging into Claude and
# pasting a (free) Gemini key. Safe to re-run; installs nothing without telling you.
#
# Env knobs:  FOREMAN_DIR=~/foreman  (where to clone)   FOREMAN_NO_CLAUDE=1 / FOREMAN_NO_LITELLM=1 (skip those)
set -euo pipefail

REPO_URL="https://github.com/Sweet-Papa-Technologies/BetterYes.git"
FOREMAN_DIR="${FOREMAN_DIR:-$HOME/foreman}"

# ── pretty output ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; A=$'\033[38;5;220m'; G=$'\033[32m'; R=$'\033[31m'; D=$'\033[2m'; X=$'\033[0m'; else B= A= G= R= D= X=; fi
say()  { printf '%s\n' "${A}▸${X} $*"; }
ok()   { printf '%s\n' "${G}✓${X} $*"; }
warn() { printf '%s\n' "${R}!${X} $*"; }
die()  { printf '%s\n' "${R}✗ $*${X}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n%s\n%s\n\n' "${B}${A}FOREMAN${X}${B} — mission control for AI coding jobs${X}" "${D}bootstrap installer${X}"

# ── platform ─────────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) PLAT=macOS ;;
  Linux)  PLAT=Linux ;;
  *) die "Unsupported shell platform ($(uname -s)). On Windows, use WSL2 and re-run this in your Linux shell." ;;
esac
ok "Platform: $PLAT"

# ── hard prerequisites we won't auto-install (too invasive / version-manager-specific) ──
have git || die "git not found. Install it, then re-run."

if ! have node; then
  die "Node.js not found. Install Node ≥ 22 ($([ "$PLAT" = macOS ] && echo 'brew install node' || echo 'https://nodejs.org or your package manager')), then re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old — FOREMAN needs ≥ 22. Upgrade, then re-run."
ok "Node $(node -v)"

if ! have python3; then
  warn "python3 not found — the LiteLLM proxy needs it. Install Python 3.9+ and re-run, or install LiteLLM yourself later."
fi

# ── pnpm via corepack (bundled with Node) ──────────────────────────────────────
if ! have pnpm; then
  say "Enabling pnpm via corepack…"
  corepack enable >/dev/null 2>&1 || true
  have pnpm || die "Couldn't enable pnpm. Run 'corepack enable' (or 'npm i -g pnpm'), then re-run."
fi
ok "pnpm $(pnpm -v)"

# ── get the source (skip if we're already inside the repo) ─────────────────────
if [ -f "foreman.yaml" ] && [ -d "packages/core" ]; then
  REPO_DIR="$(pwd)"; say "Using the repo you're already in: $REPO_DIR"
elif [ -d "$FOREMAN_DIR/.git" ]; then
  REPO_DIR="$FOREMAN_DIR"; say "Updating existing checkout at $REPO_DIR…"; git -C "$REPO_DIR" pull --ff-only >/dev/null 2>&1 || warn "git pull skipped (local changes?)"
else
  say "Cloning into $FOREMAN_DIR…"; git clone --depth 1 "$REPO_URL" "$FOREMAN_DIR"; REPO_DIR="$FOREMAN_DIR"
fi
cd "$REPO_DIR"; ok "Source ready: $REPO_DIR"

# ── install + build ────────────────────────────────────────────────────────────
say "Installing dependencies (pnpm install)…"; pnpm install --silent; ok "Dependencies installed"
say "Building the dashboard (pnpm build)…"; pnpm build >/dev/null 2>&1; ok "Dashboard built"

# ── Claude Code (the Coder) ─────────────────────────────────────────────────────
if [ "${FOREMAN_NO_CLAUDE:-}" != "1" ]; then
  if have claude; then ok "Claude Code present ($(claude --version 2>/dev/null | head -1))"
  else
    say "Installing Claude Code (npm i -g @anthropic-ai/claude-code)…"
    if npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then ok "Claude Code installed"
    else warn "Couldn't install Claude Code globally (permissions?). Install it yourself: https://claude.com/claude-code"; fi
  fi
fi

# ── LiteLLM proxy (Gemini gateway) ──────────────────────────────────────────────
if [ "${FOREMAN_NO_LITELLM:-}" != "1" ]; then
  if have litellm; then ok "LiteLLM present ($(litellm --version 2>&1 | head -1))"
  elif have pipx; then say "Installing LiteLLM via pipx…"; pipx install 'litellm[proxy]' >/dev/null 2>&1 && ok "LiteLLM installed" || warn "pipx install failed — run: pipx install 'litellm[proxy]'"
  elif have python3; then say "Installing LiteLLM via pip…"; python3 -m pip install --user --quiet 'litellm[proxy]' >/dev/null 2>&1 && ok "LiteLLM installed" || warn "pip install failed — run: python3 -m pip install 'litellm[proxy]' (or use pipx / a venv)"
  else warn "Skipped LiteLLM (no python3/pipx). Install later: pip install 'litellm[proxy]'"
  fi
fi

# ── preflight (read-only) ───────────────────────────────────────────────────────
printf '\n%s\n' "${B}Preflight:${X}"
pnpm -s foreman doctor 2>/dev/null || true

# ── what's left (the human steps) ───────────────────────────────────────────────
cat <<EOF

${G}${B}Installed.${X} Two human steps remain, then you're live:

  ${B}cd $REPO_DIR${X}

  ${B}1) Log into Claude Code${X} (uses your Claude subscription):
       claude            ${D}# run once, follow the login prompt${X}

  ${B}2) Provision FOREMAN${X} (it'll prompt for a free Gemini key — get one at
     https://aistudio.google.com/apikey — or use gcloud):
       pnpm foreman init

  ${B}Then start it (two terminals):${X}
       set -a && source .env 2>/dev/null; export GEMINI_API_KEY=\$(pnpm -s foreman secret get GEMINI_API_KEY --raw 2>/dev/null) LITELLM_KEY=\$(pnpm -s foreman secret get LITELLM_KEY --raw 2>/dev/null)
       litellm --config litellm.config.yaml --port 4000 &      ${D}# the model proxy${X}
       pnpm foreman serve                                       ${D}# the daemon + dashboard → http://127.0.0.1:7777${X}

  ${B}Phone access (optional):${X} pnpm foreman tunnel   ${D}# HTTPS via Tailscale — see docs/REMOTE_ACCESS.md${X}

  Stuck? ${B}pnpm foreman doctor${X} names exactly what's missing. Full guide: README.md
EOF
