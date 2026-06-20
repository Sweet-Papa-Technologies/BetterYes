# FOREMAN — High-Level Design (v0.2)

**Companion to PRD.md** · Lineage: clean-room reimplementation of the EED Buddy pattern

> **⚠️ Clean-room.** Build the *pattern* described here from scratch. Do NOT fork,
> clone, copy, or import EED Buddy source — it is separate (employer) code. Section 2's
> "Build" column means "reimplement this role from scratch," never "lift this module."
>
> **Ground rule for the coder:** wherever this touches Claude Code's hooks,
> headless/SDK flags, permission modes, session resume, or Agent Teams, **fetch and
> read the current official docs first**. These surfaces evolve. Treat shapes here as
> illustrative. One specific item to verify early: *do PreToolUse hooks fire — and can
> they deny — when the session runs with permissions skipped?* The whole rule-gate
> design depends on the answer (fallback in §9).

---

## 1. Architecture

```
  Operator's phone / desktop                      ┌── Hermes (BYO, WARLOCK) ───┐
  ┌─────────────────────────────┐  session API /   │  agent core: NL, memory,   │
  │ FOREMAN dashboard (PWA)      │  MCP intake      │  cron, its own TUI         │
  │  · overview · job view       │◄────────────────►│  HTTP API server           │
  │  · rules editor              │                  │  (gateway = OPTIONAL)      │
  │  · CHAT PANEL ("Talk to      │                  └────────────────────────────┘
  │    Hermes") · Web Push       │                         ▲ FOREMAN as MCP server
  └──────────────┬──────────────┘                         │ + escalation phrasing
   LAN/Tailscale │ REST + WebSocket + Web Push             │
                 ▼                                         │
        ┌──────────────────────────────────────────────────┴───┐
        │            FOREMAN CORE (daemon, TS)                  │
        │  REST + WebSocket API  ·  bearer-token auth · PWA push │
        │  job manager / state (SQLite)                         │
        │  ── per job: one supervision-loop instance ──         │
        │     Director (stateless)   Router (sensor)            │
        │     amnesia ledger + circuit breaker                  │
        │     MCP bridge (ask_director/request_approval)        │
        │  escalation broker  ·  drift detector                 │
        │  serves Quasar dashboard (static) + Hermes bridge     │
        └───────┬───────────────────────────────▲───────────────┘
    model calls │                                │ stream-json events
   ┌────────────▼──────────────────────┐         │
   │ LiteLLM proxy (BYO endpoint)       │   ┌─────┴────────────────────────┐
   │  Director → Gemini 3.5 Flash       │   │ Claude Code (BYO) × N jobs    │
   │  Router   → Gemini 3.1 Flash Lite  │   │ headless, one git worktree ea.│
   │  (all swappable in config)         │   │ operator's CLAUDE.md/skills/  │
   └────────────────────────────────────┘   │ MCP; Agent Teams optional     │
                                            └──────────────┬───────────────┘
                                                           │ every tool call
                                                           ▼
                                            ┌──────────────────────────────┐
                                            │  PreToolUse rule gate (hook)  │
                                            │  rules.yaml: allow/deny/escal │
                                            │  hot-reload · audit JSONL      │
                                            │  escalate (defer) → broker     │
                                            └──────────────────────────────┘
```

Three planes:
- **Control plane:** the **dashboard is the operator's single surface** (visual control
  + a chat panel that streams Hermes' session API + Web Push), reachable on the phone
  over LAN/Tailscale. **Hermes is the conversational brain** behind the chat panel and
  the source of NL escalation phrasing; it reaches into Core via MCP for intake.
  Hermes' own gateway/TUI stay available but optional.
- **Work plane:** Core ↔ N headless Claude Code sessions (spawn, stream, inject,
  resume, kill).
- **Gate plane:** Claude Code ↔ PreToolUse rule gate, escalations raised via the
  `defer` decision up to the broker.

## 2. Pattern elements to build / skip / add (vs. the EED Buddy pattern)

"Build" = reimplement this role from scratch in this codebase. Nothing is imported.

| Pattern element (from EED Buddy) | FOREMAN |
|---|---|
| Orchestrator state machine | **Build** — instantiated once per job, run concurrently |
| Director (stateless, ledger re-injected) | **Build** — model Gemini 3.5 Flash via config |
| Router (7-label classifier) | **Build** — model Gemini 3.1 Flash Lite via config |
| Amnesia ledger + circuit breaker | **Build** |
| MCP bridge (`ask_director`, `request_human_approval`) | **Build** — approval is now *real* (§5) |
| Final review + security pass | **Build** (security pass optional/config) |
| Vertex `rawPredict` | **Skip** → generic OpenAI/Anthropic-compatible endpoint (LiteLLM) |
| Firestore | **Skip** → SQLite |
| Pub/Sub intake | **Skip** → REST / dashboard / Hermes intake |
| Jira / GitLab / Slack posting + transitions | **Skip** → dashboard job records; optional `gh` PR (off by default) |
| Wiz / gcloud mode | **Skip** for v1 |
| RAG learning store | **Optional** (local SQLite, keep lite) |
| — | **Add:** concurrency manager, granular rule gate, dashboard (with chat panel + Web Push), Hermes API bridge, real escalation broker, swappable-model config |

## 3. Core daemon

Long-running TypeScript process. Organize the roles into clear modules
(`orchestrator/`, `director/`, `router/`, `ledger/`, `mcp-server/`) — all written
fresh for this project, with swappable adapters for the model endpoint and storage.

- **Job manager:** CRUD + state machine; SQLite `foreman.db` (jobs, escalations,
  audit index); per-job dir `~/.foreman/jobs/<id>/` (`job.yaml`, `events.jsonl`,
  `audit.jsonl`, `notes.md`).
- **Concurrency manager:** spawns/owns one loop instance per job, each bound to its own
  `git worktree`; enforces a configurable max-parallel cap; isolates state so jobs
  can't collide on branches or files.
- **Dispatcher:** prepares worktree, composes the Coder prompt (mission brief + repo /
  branch convention + operator's build/test commands), launches headless Claude Code
  with `--resume` on later turns, parses the stream-json event stream into job state.
- **Escalation broker:** receives `defer`-escalate requests from the hook (loopback
  HTTP), holds the gate, raises a dashboard badge + chat-panel message and fires a
  **Web Push (or ntfy)** notification; optionally calls Hermes to phrase the question
  in natural language; applies whichever surface answers first; enforces timeout
  policy; resumes the session via `claude -p --resume`.
- **Hermes bridge:** thin client to Hermes' HTTP API — proxies the dashboard chat panel
  to Hermes' session SSE, calls `/v1/chat/completions`/`/v1/runs` to phrase escalations
  and parse free-text answers, and registers Core as a Hermes MCP server for intake.
- **Push service:** Web Push (VAPID) to the installed PWA; optional ntfy publisher.
- **Drift detector:** EED Buddy's circuit breaker (deterministic) + a periodic Router/
  Director sweep; verdicts `on_track | nudge | escalate`.
- **API:** REST + WebSocket, bearer-token auth, serves the dashboard static bundle.
  Endpoints: `POST /jobs`, `GET /jobs`, `GET /jobs/{id}`, `WS /jobs/{id}/stream`,
  `POST /jobs/{id}/{redirect|pause|resume|kill}`, `GET/POST /escalations`,
  `GET/PUT /rules`, `GET /jobs/{id}/report`, `GET /config`,
  `WS|SSE /chat` (proxies Hermes session stream), `POST /push/subscribe` (Web Push),
  plus an MCP server endpoint exposing `dispatch_job`/`status`/`redirect` to Hermes.

## 4. Granular rule gate (PreToolUse hook)

A standalone hook executable (no heavy imports — cold start matters). On each tool
call:
1. Load `rules.yaml` (cached, hot-reloaded on file change).
2. Match tool name + argument patterns against rules in order; first match wins.
3. Action: `allow` → proceed silently; `deny` → block, return reason to the loop;
   `escalate` → `POST /escalations`, hold for human; unmatched → profile default.
4. Append decision to `audit.jsonl` (matched rule, action, reason, latency, redacted
   args).
5. **Fail-safe:** any error / unreachable broker → behave per profile `on_error`
   (default `escalate`, strict `deny`). Never default-allow.

`rules.yaml` (illustrative):

```yaml
default_action: allow            # for unmatched calls (profile-overridable)
on_error: escalate
rules:
  - match: { tool: "*", path_glob: ["~/.ssh/**", "**/.env", "**/secrets/**"] }
    action: deny
  - match: { tool: "Edit|Write", path_outside_worktree: true }
    action: deny
  - match: { tool: "Bash", cmd_regex: "(rm -rf\\s+/|git push --force|curl[^|]*\\|\\s*(ba)?sh|npm publish)" }
    action: deny
  - match: { tool: "Bash", cmd_regex: "\\b(docker|systemctl|gcloud|kubectl)\\b" }
    action: escalate
  - match: { tool: "WebFetch" }   # example of a user's personal preference
    action: escalate
```

The dashboard's **Rules editor** reads/writes this file via `GET/PUT /rules` and
triggers hot-reload. Path matching resolves symlinks + normalizes `..`; secret-pattern
values redacted before logging or sending to any model.

This is the merge of the two supervision philosophies: **turn-level Router supervision**
(EED Buddy's steering) for trajectory, plus a **deterministic per-call veto** for the
handful of tools the operator wants gated — without reintroducing yes-fatigue on
everything else.

## 5. Real human-in-the-loop

`request_human_approval` (and any `escalate` rule, drift escalation, or final-review
ESCALATE) is raised as a PreToolUse **`defer`** decision and flows through the broker:
1. Hook returns `defer`; the headless session pauses (`tool_deferred`) preserving the
   tool input. Broker creates an escalation record.
2. Broker flags the **dashboard** (badge + context + Allow/Deny + free-text answer,
   shown on the job view and inline in the chat panel) and fires a **Web Push / ntfy**
   notification to the phone. Optionally it asks Hermes to phrase the question in
   natural language for the chat panel.
3. Operator answers in the dashboard (chat or controls); if the optional Hermes
   gateway/TUI is enabled it can answer too. First answer wins; others clear.
4. Broker resumes the session with `claude -p --resume <id>`; the same PreToolUse
   re-evaluates and returns `allow` with any `updatedInput` (or the answer is injected
   as a redirect/Director-guidance turn).
5. Timeout (profile default 30 min): hold + re-ping once, then `hold | deny`.

> Fallback if `defer` proves brittle on the pinned CLI version: implement the same
> round-trip via `--permission-prompt-tool` (an MCP tool the broker answers) or the
> Agent SDK `canUseTool` callback. See §9.

## 6. Dashboard (Quasar SPA)

Vue 3 + Quasar (operator's existing stack → low maintenance burden), built to a static
bundle the Core serves. Talks REST + WebSocket.
- **Overview:** card/row per job — phase, last activity, files touched, open-question
  badge, turn/token burn; live via WS.
- **Job view:** live log tail, plan/notes, files, controls (redirect box, pause/resume/
  kill, approve plan, answer escalation).
- **Rules editor:** edit `rules.yaml` with validation; hot-reload on save.
- **Chat panel ("Talk to Hermes"):** streams Hermes' session API via Core's `/chat`
  proxy; start jobs, query status, redirect, and answer escalations in natural
  language. Falls back to structured commands if Hermes is absent.
- **Settings:** show model assignments + endpoint from config (editing optional in v1).
- **PWA + Web Push:** ships a manifest + service worker; installable to the phone home
  screen; receives escalation/completion push (VAPID). ntfy optional alternative.
- Mobile-first layout (it's a phone surface as much as desktop).

## 7. Models & config

`foreman.yaml` (illustrative):

```yaml
endpoint:
  base_url: "http://localhost:4000"     # operator's LiteLLM proxy
  api_key_env: "LITELLM_KEY"
models:
  director: "gemini-3.5-flash"          # heavy reasoning — verify exact proxy ID
  router:   "gemini-3.1-flash-lite"     # frequent/speed
  judge:    "gemini-3.1-flash-lite"     # optional per-call judge, off by default
coder:
  command: "claude"                     # BYO Claude Code on PATH
  max_turns: 50
concurrency:
  max_parallel_jobs: 4
hermes:
  enabled: true
  base_url: "http://warlock:8765"       # Hermes API server
  api_key_env: "HERMES_API_KEY"         # required even on loopback
  register_mcp: true                    # expose Core to Hermes as an MCP server
  gateway: false                        # Hermes messaging gateway optional, off
push:
  web_push: true                        # VAPID keys generated by `foreman init`
  ntfy_topic_env: "FOREMAN_NTFY_TOPIC"  # optional alternative notifier
dashboard:
  bind: "100.x.x.x"                     # Tailscale IP / LAN; loopback by default
  port: 7777
  auth_token_env: "FOREMAN_TOKEN"
  pwa: true
profiles_dir: "~/.foreman/policies"
```

Every model is a string in config → swap freely. No provider assumptions in code beyond
"OpenAI/Anthropic-compatible HTTP."

## 8. Security

- Rule-gate fail-safe is the core invariant — **no path defaults to allow.** Unit-test
  by killing the broker / corrupting `rules.yaml` / timing out the judge.
- Dashboard: bearer token required; bind to loopback or a private interface
  (Tailscale/LAN) only; never public. Token in `.env`.
- Prompt-injection containment: models that judge/route see only tool + args + plan,
  never raw repo/web content; `deny` rules are absolute (no model verdict overrides a
  deterministic deny); escalate-always list for irreversible ops.
- Worktree isolation: writes outside `${WORKTREE}` denied by default in every shipped
  profile.
- Audit log append-only, redacted before write.
- **Hermes surface:** the Hermes HTTP API requires its key even on loopback — always
  set it. If the messaging gateway is enabled, lock it to the operator's account/chat
  ID. Treat any webhook/cron-triggered Hermes path as untrusted input (known RCE +
  prompt-injection issues in that path): enforce HMAC, sandbox Hermes, and give
  webhook/cron sessions least-privilege toolsets. FOREMAN's MCP server (exposed to
  Hermes) is control-plane only and never edits worktrees.

## 9. Build-time verification (confirm against your pinned CLI version)

Research resolved the big unknowns, but they're version-sensitive — snapshot them in
integration tests before committing:
1. **Hooks under bypass (largely answered):** PreToolUse hooks *do* fire and a `deny` /
   exit-2 *does* block even under `--dangerously-skip-permissions` / `bypassPermissions`
   and in headless `-p`. Confirm on your version. The "auto-approve most, veto some"
   pattern is: run bypass *inside a sandbox* with a PreToolUse blocklist.
2. **`defer` semantics:** confirm a `defer` decision exits with `tool_deferred`,
   preserves `deferred_tool_use`, and resumes cleanly via `claude -p --resume <id>` with
   the hook re-evaluating. This is the HITL mechanism; if brittle, fall back to
   `--permission-prompt-tool` (MCP) or the Agent SDK `canUseTool` callback.
3. **stream-json schema:** the event shape (esp. `result.permission_denials[]` and
   `system/api_retry`) is under-documented and reverse-engineered — pin the version and
   version-gate the parser.
4. **Claude auth mode:** the subscription-vs-API-key rules for programmatic dispatch
   have flip-flopped in 2026 (the June 15 "Agent SDK credit pool" split is *paused, not
   cancelled*). Make auth a config switch (OAuth for dev, `ANTHROPIC_API_KEY` for
   unattended) and re-verify terms before launch.
5. **Hermes API/session shapes:** confirm the session-stream SSE event names and the
   `/v1/runs` progress shape on your Hermes version (young, fast-moving project).
6. Agent Teams headless behavior (keep behind a per-job flag, default off; token-heavy).
7. Exact LiteLLM model IDs for the named Gemini models.

> Consider adapting **CodeLayer** (HumanLayer) for the Claude-side approval broker — it
> already implements daemon + permission-prompt-tool + durable approval store +
> multi-session UI under an open license. Build-vs-adapt decision is open.

## 10. Tech stack

- **Backend:** TypeScript/Node (Fastify or Express), roles implemented fresh per §2;
  SQLite
  via `better-sqlite3`; WebSocket for live updates.
- **Frontend:** Vue 3 + Quasar SPA (PWA: manifest + service worker), static-built,
  served by the backend; chat panel over SSE, Web Push for notifications.
- **Hooks:** standalone TS/Node executables, minimal imports on the gate path.
- **Hermes bridge:** HTTP client to the Hermes API server (session SSE proxy +
  `/v1/chat`/`/v1/runs` calls) and a small MCP server registering Core with Hermes —
  no Hermes skill files required. Optional cron via Hermes' `/api/jobs`.
- **Claude driver:** Agent SDK (`@anthropic-ai/claude-agent-sdk`) preferred, with
  headless `claude -p --output-format stream-json` for CLI-only paths.
- **Packaging:** monorepo (pnpm workspaces); `docker compose` for Core + dashboard;
  guided init + `doctor`; permissive license (MIT/Apache-2.0); README with 30-min
  quickstart; semantic versioning.
- **No** external queue, no Postgres/Redis, no enterprise SDKs.

## 11. Build order (matches PRD milestones)

M1 build the core supervision loop → M2 concurrency + rule gate + audit → M3 dashboard
(PWA) → M4 chat panel + Hermes bridge + Web Push + `defer`-based escalation → M5 publish.
M1 is the smallest slice: the loop with a LiteLLM endpoint and SQLite, no enterprise
integrations to begin with; the genuinely new surfaces (rule gate, dashboard, the chat
panel + push escalation round-trip) land in M2–M4.
