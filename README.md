<div align="center">

<img src="docs/branding/foreman-logo-200.png" alt="FOREMAN" width="120" />

# FOREMAN

**Mission control for a crew of robot programmers.**

Supervise multiple autonomous Claude Code coding agents from one dashboard — give direction once, watch everything from your phone, and get pulled in only when a decision actually needs a human.

[![License: MIT](https://img.shields.io/badge/License-MIT-FFB020.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vue 3 + Quasar](https://img.shields.io/badge/Vue_3_+_Quasar-3FB950?logo=vuedotjs&logoColor=white)
![Node ≥ 22](https://img.shields.io/badge/Node-%E2%89%A522-2EA043?logo=nodedotjs&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-539BF5)
![Status](https://img.shields.io/badge/status-M1%E2%80%93M5%20complete-A371F7)

<img src="docs/branding/foreman-banner.png" alt="FOREMAN control room" width="100%" />

</div>

---

## What is this?

Running several Claude Code sessions on your own projects turns you into a full-time approval
clerk across a wall of terminals — no single place to see what's happening, and a constant
stream of "Yes" prompts that drowns the 5% of moments where your judgment actually matters.

**FOREMAN** is the control room. You launch coding **jobs** ("rebuild my Moods app per this
brief"); each runs as a headless Claude Code session in its own git worktree, supervised by a
**Director → Router → Coder** loop. You steer from one dashboard (installable to your phone),
and a deterministic, per-tool **rule gate** denies or escalates exactly the calls you care
about — without re-introducing yes-fatigue on everything else.

It's a personal, publishable take on the supervised-autonomy pattern: no enterprise plumbing,
swappable models, a real human-in-the-loop, and clean one-command setup.

## Highlights

- 🛰️ **One board for N concurrent jobs** — phase, live log, files touched, token/cost burn, open questions; live over WebSocket.
- 🧠 **Supervised, not babysat** — a stateless **Director** plans/reviews, a cheap **Router** classifies every turn, an amnesia **ledger** + circuit breaker stop rabbit-holes.
- 🚦 **Granular rule gate** — a PreToolUse hook that `allow`/`deny`/`escalate`s per tool + argument pattern (`rules.yaml`), editable live in the dashboard, hot-reloaded, with an append-only audit.
- ✋ **Real human-in-the-loop** — a gated tool call (or a plan-approval) **pauses the exact call** and waits for you; answer **Allow / Deny / "do this instead"** from the dashboard or the chat, with a Web Push to your phone.
- 📱 **Phone-first PWA** — installable, dark "mission-control" UI; the escalation surface is a two-tap bottom sheet.
- 💬 **Talk to Hermes** — an optional conversational brain ([Hermes Agent](https://github.com/NousResearch/hermes-agent)) that streams into the chat panel *and* can command FOREMAN back via MCP (`dispatch_job` / `status` / `redirect`). `foreman hermes setup` stands up an isolated instance for you.
- 🔧 **Swappable models, BYO everything** — Director/Router are config (default Gemini via a LiteLLM proxy); Coder is your Claude Code. No hardcoded paths, models, or tokens.
- 🔒 **Secrets done right** — macOS Keychain primary, `.env` / env-var fallback; never logged, redacted in audit.

## Screenshots

| Job board | Job detail |
|---|---|
| ![Board](docs/screenshots/board.png) | ![Job detail](docs/screenshots/job-detail.png) |

| Rules editor | Escalation (phone) |
|---|---|
| ![Rules](docs/screenshots/rules.png) | <img src="docs/screenshots/escalation-mobile.png" width="280" /> |

## Quickstart (~10 min)

**Prereqs:** Node ≥ 22, `pnpm`, [Claude Code](https://claude.com/claude-code) on PATH, and a
LiteLLM proxy + Gemini key (`foreman init` provisions both via `gcloud`). macOS for Keychain;
everyone else uses `.env`.

```bash
pnpm install

# 1) Provision: mints a Gemini key in your GCP project, stores secrets (Keychain or .env),
#    generates VAPID push keys, and writes litellm.config.yaml. Offers to set up Hermes.
pnpm foreman init --project <your-gcp-project>

# 2) Start the LiteLLM proxy
export GEMINI_API_KEY="$(security find-generic-password -s foreman -a GEMINI_API_KEY -w)"
export LITELLM_KEY="$(security find-generic-password -s foreman -a LITELLM_KEY -w)"
litellm --config litellm.config.yaml --port 4000 &

# 3) Sanity checks
pnpm foreman doctor    # secrets, models, claude, gate, DB
pnpm foreman smoke     # proves the rule gate fires + a trivial job runs end-to-end

# 4) Build the dashboard + run the daemon (serves the dashboard)
pnpm build
pnpm foreman serve     # http://127.0.0.1:7777   (add --with-hermes to co-start Hermes)
```

Open the dashboard, paste your token in **Settings** (`security find-generic-password -s
foreman -a FOREMAN_TOKEN -w`), and launch a job. Or do it from your terminal:

```bash
pnpm foreman job run --repo /path/to/a/git/repo \
  --brief "Create a file named hello.txt containing a friendly greeting."
```

**Docker:** `docker compose up --build` brings up the daemon + a LiteLLM proxy (see
[docs](docs/DESIGN.md) and `docker-compose.yml`).

## How it works

```
  Phone / desktop          ┌── FOREMAN core (daemon, TS) ──────────────┐      ┌─ LiteLLM ─┐
  ┌──────────────┐  REST/  │  per job: Director ▸ Router ▸ Coder loop  │ ───▸ │  Gemini   │
  │  Dashboard   │◀──WS──▶ │  amnesia ledger + circuit breaker         │      └───────────┘
  │  (PWA) + Chat│  +Push  │  escalation broker · SQLite · REST/WS API │
  └──────────────┘         └───────┬───────────────────────▲──────────┘
                                   │ spawn / stream / resume│ defer-style hold
                       ┌───────────▼────────────┐  every    │
                       │ Claude Code × N jobs    │  tool ───▶│ PreToolUse rule gate
                       │ headless · one worktree │  call     │ rules.yaml: allow/deny/escalate
                       └─────────────────────────┘           └──────────────────────────────
```

Each turn: the **Coder** (headless `claude`) works in its worktree; the **Router** classifies
the turn (7 labels); the **Director** (stateless, ledger re-injected) plans/steers/reviews.
Every tool call passes the **rule gate** — most flow silently, the handful you've gated
`deny` or **hold for your answer**. Full architecture: [`docs/DESIGN.md`](docs/DESIGN.md) ·
product spec: [`docs/PRD.md`](docs/PRD.md) · UI design: [`docs/STITCH_BRIEF.md`](docs/STITCH_BRIEF.md).

## Configuration

- **`foreman.yaml`** — models, endpoint, coder command, concurrency, loop caps, dashboard bind/port. Models are config, not code (swap freely; defaults `gemini-3.5-flash` / `gemini-3.1-flash-lite`).
- **`rules.yaml`** + **`rules.<profile>.yaml`** — the gate's rules per policy profile.
- **`.env` / Keychain** — secrets (resolution precedence: env → `.env` → Keychain).
- Runtime state lives in `~/.foreman/` (SQLite, per-job dirs, worktrees).

**Policy profiles** (chosen per job): `throwaway` (permissive — protects secrets only),
`standard` (default), `strict` (more commands held for approval + deny-on-error fail-safe).

## CLI

```
foreman init [--project <id>]            provision Gemini key + secrets + litellm.config.yaml
foreman doctor                           health-check secrets, models, claude, gate, DB
foreman smoke [--no-full]                prove the gate fires + a trivial job runs
foreman serve [--with-hermes]            run the daemon + dashboard (optionally co-start Hermes)
foreman job run|list                     launch / inspect jobs from the terminal
foreman hermes setup|start|stop|status   isolated Hermes Agent for the chat panel
foreman secret set|get|list|delete       Keychain / .env secret management
```

## Security

- Dashboard requires a bearer token and binds to loopback by default — for phone access bind to a Tailscale/LAN IP; never public.
- Rule-gate fail-safe: on any error it escalates/denies per profile — **no path defaults to allow**. Protected-path checks resolve symlinks.
- Secrets are never logged; the logger and audit redact secret-pattern values. Each job is isolated in its own git worktree.

## Project status & roadmap

All five milestones (**M1 core loop → M5 packaging**) are complete and verified end-to-end.
**Known limitations:** the gate enforces literal declared patterns, not semantic intent
(write rules to target outcomes); real-device Web Push delivery is built to spec but
unverified without a device. Jobs resume across daemon restarts.

## Contributing

PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Clone, `pnpm install`, `pnpm dev:core`
+ `pnpm dev:ui`, and `pnpm typecheck` before you push.

## License

[MIT](LICENSE) © FoFo. Branding generated with Gemini ("Nano Banana"). Not affiliated with
Anthropic or Nous Research.
