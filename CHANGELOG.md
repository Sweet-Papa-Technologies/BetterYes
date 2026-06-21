# Changelog

All notable changes to FOREMAN. Format loosely follows [Keep a Changelog](https://keepachangelog.com);
versions follow [SemVer](https://semver.org).

## [0.1.0-beta.1] — 2026-06-21

First public beta. The full **launch-and-walk-away** loop works end-to-end and has supervised
24+ real coding jobs against real repos.

### Core — supervise autonomous coding jobs
- **Supervision loop** per job: a stateless **Director** plans/reviews, a cheap **Router**
  classifies every Coder turn, an append-only **amnesia ledger** + **circuit breaker** stop
  rabbit-holes. The **Coder** is headless Claude Code in an isolated git worktree.
- **PreToolUse rule gate** — `allow` / `deny` / `escalate` per tool + argument pattern
  (`rules.yaml`, hot-reloaded), fail-safe (no path defaults to allow), symlink-resolving,
  with an append-only audit. Policy profiles: `throwaway` / `standard` / `strict`.
- **Real human-in-the-loop** — a gated tool call or plan-approval **pauses the exact call** and
  waits for your answer (Allow / Deny / "do this instead") from the dashboard or chat, with a
  Web Push to your phone. **"Always allow this for the session"** stops repeat prompts (per job,
  in-memory).
- **Crash-resilient** — jobs resume across daemon restarts (`--resume` + persisted ledger);
  hitting Claude's `--max-turns` is treated as a *yield*, not a failure.

### Jobs & repos
- **Retry** a finished job from its original brief; **Merge** a job's worktree branch back into
  your repo and clean up (commits pending work, fails closed on conflict / dirty target).
- **Any local folder** — works with local-only repos (no remote) and brand-new/empty folders;
  **`git init` a folder on the fly** from the picker, or auto-init at launch.
- Pause / resume / kill (with confirm) / redirect mid-flight.

### Dashboard (PWA)
- One board for N concurrent jobs — live over WebSocket — with **search + status filters**,
  a **project-folder column**, relative timestamps, and click-to-copy IDs/branches/paths.
- Job detail: streaming log console (smart auto-scroll), burn meters, Plan/Files/Audit tabs.
- **Keyboard shortcuts** (`n`, `g`+`b/c/r/s`, `p`, `Esc`, `?`).
- Installable, dark "mission-control" UI; Web Push notifications.

### Chat (Hermes)
- **Persistent, multi-conversation chat** — new / switch / search / load / delete; titles
  auto-generated; **file attachments** (text files inlined into the prompt).
- Optional [Hermes Agent](https://github.com/NousResearch/hermes-agent) brain answers questions
  *and* commands FOREMAN over MCP (`dispatch_job` / `status` / `redirect`).
- **Manage Hermes from the UI** — set up an isolated local instance, point at a remote, pick its
  model, start/stop — no daemon restart. CLI: `foreman hermes setup|start|stop|status|model`.

### Remote access
- **`foreman tunnel`** — reach the dashboard **from your phone, anywhere, over real HTTPS** via a
  private [Tailscale](https://tailscale.com) mesh; prints a **QR code** that signs you in. Public
  exposure is deliberately gated (it's an RCE panel) — see [`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md).
- `dashboard.trust_proxy` for correct behavior behind a reverse proxy.

### Setup & docs
- **`foreman init --gemini-key <KEY>`** — no-GCP path using a free Google AI Studio key (or mint
  via `gcloud`). Non-macOS writes secrets straight to `.env` (chmod 600).
- **`foreman doctor`** — a real preflight (Claude Code, LiteLLM, secrets, models, gate, DB) with a
  copy-paste fix for each failure. `foreman smoke` proves the gate fires.
- `foreman secret get --raw` for piping into `export`.
- Cross-platform **CI** (ubuntu/macos/windows): typecheck + gate smoke.
- Docs: [README](README.md) quickstart with a prerequisites table + platform notes,
  [`docs/ABOUT.md`](docs/ABOUT.md) overview, [`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md),
  [`docs/DESIGN.md`](docs/DESIGN.md), [`docs/PRD.md`](docs/PRD.md).

### Stack
TypeScript ESM · Fastify (+WS) · better-sqlite3 · OpenAI SDK → LiteLLM → Gemini ·
`@modelcontextprotocol/sdk` · web-push · Quasar (Vue 3) PWA · Claude Code (Coder) ·
NousResearch Hermes Agent (chat).

### Known limitations
- Setup has real prerequisites; not yet one-click. **Windows is WSL-first and lightly tested.**
- The gate enforces declared patterns, not intent. Hermes runs MCP tools server-side (chat shows
  the result, not always a per-tool status). Cost is an API-equivalent estimate. Web Push is
  built-to-spec but lightly device-verified.

[0.1.0-beta.1]: https://github.com/Sweet-Papa-Technologies/BetterYes/releases/tag/v0.1.0-beta.1
