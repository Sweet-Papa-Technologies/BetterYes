# FOREMAN — Product Requirements Document (v0.2)

**Owner:** FoFo · **Status:** Ready for build · **Lineage:** EED Buddy, personal edition

> **⚠️ Clean-room reimplementation.** This is a fresh build of the *pattern* proven
> in EED Buddy — NOT a fork, copy, or import of EED Buddy source. EED Buddy is
> separate (employer) code with its own plumbing and licensing; do not look for,
> clone, or reuse that repository. Every component below is implemented new from the
> description in this doc. "Director / Router / ledger" name *roles to build*, not
> modules to lift.
>
> **What this is:** a personal, publishable take on the Director → Router → Coder
> supervision loop — minus all enterprise plumbing (Pub/Sub, Jira, GitLab, Firestore,
> Vertex-specific wiring), plus concurrent multi-session tracking, a phone-reachable
> dashboard, granular per-tool rules, swappable models, a real human-in-the-loop via
> Hermes, and clean OSS packaging.
>
> **What this is NOT:** a coding orchestrator (Claude Code does the engineering), a
> SaaS, or a from-scratch *design* — the architecture is known-good, so most of the
> effort is the two new surfaces (dashboard + Hermes intake/escalation) rather than
> inventing the loop.

---

## 1. Problem

Running multiple Claude Code sessions on personal projects turns the operator into
a full-time approval clerk across several terminals — no single place to see what's
happening, no way to steer from a phone, and a wall of "Yes" prompts that drowns the
5% of moments where human judgment actually matters.

The operator already runs the two halves of the answer: **HermesAgent** (always-on
ambient agent on WARLOCK — memory, cron, agent core reachable over its HTTP/session
API, its own TUI, and a messaging gateway) and the
**EED Buddy loop** (the supervised Director/Router/Coder pattern, proven in
production). FOREMAN fuses them for personal use so the operator gives direction
once, watches everything from one dashboard or their phone, and is interrupted only
for real decisions.

## 2. Goals

1. **One place for all sessions.** Track and steer N concurrent jobs — phase, live
   log, files touched, burn, pending questions — from a single dashboard.
2. **Phone-reachable, one surface.** Dashboard served over local HTTP, viewable on a
   phone over LAN/Tailscale, installable as a PWA. It carries *both* the visual control
   and the **conversational channel** (a chat panel talking to Hermes' session API) —
   replacing any third-party messenger. Notifications via Web Push (PWA) or an optional
   dumb-pipe notifier (ntfy); Hermes' own messaging gateway is optional, not the
   primary path.
3. **Supervision without yes-fatigue.** Keep EED Buddy's turn-level Router
   supervision (no per-call prompting for routine work) and add a deterministic,
   operator-configurable rule layer that can deny or escalate *specific* tools.
4. **Granular tool rules.** Operator declares, per tool and per argument pattern,
   whether a call is auto-allowed, denied, or escalated — editable in config and in
   the dashboard, live-reloadable.
5. **Swappable models, with sane defaults.** Director and Router models are config,
   not code. Defaults: **Gemini 3.5 Flash** for heavy reasoning (Director), **Gemini
   3.1 Flash Lite** for frequent/speed work (Router). Any OpenAI/Anthropic-compatible
   endpoint (LiteLLM proxy) works; anyone can swap models freely.
6. **Built to publish, share, and maintain.** Clean TypeScript monorepo, single
   config file + `.env`, no hardcoded paths or secrets, Docker one-command run,
   permissive license, real README. A stranger should be able to clone it and run
   their own instance against their own Hermes + Claude Code.

## 3. Non-Goals (v1)

- **Not multi-tenant SaaS.** "Shareable" means others run their own single-operator
  instance — not a hosted service with accounts.
- **Not a coding orchestrator.** FOREMAN supervises and dispatches; Claude Code (and
  optionally its Agent Teams) does the actual task decomposition and engineering.
- **No enterprise integrations in core.** Jira/GitLab/Slack/Pub-Sub are gone. Optional
  thin adapters (e.g. open a GitHub PR via `gh`) are fine, off by default.
- **No model router/gateway re-implementation.** The operator already runs LiteLLM;
  FOREMAN just points at an endpoint.

## 4. User (single persona)

**The Operator** — senior engineer, terminal/Docker/YAML-comfortable, runs local +
cloud models behind a proxy, wants *supervised autonomy* from the couch or the dog
park, not unattended YOLO. Design every default for this person.

## 5. User Stories

| # | Story | Acceptance |
|---|-------|-----------|
| U1 | I start a job ("rebuild Moods per this brief") from the dashboard — either the visual New Job form or the in-dashboard chat panel (which talks to Hermes) — without opening a terminal. | Job created, worktree prepared, headless Claude Code launched, job appears in dashboard with ID + phase. |
| U2 | I open the dashboard on my phone and see *all* running jobs at a glance. | One screen lists every job: phase, last activity, files touched, open question count, turn/token burn. Live-updating. |
| U3 | I tap into a job and watch its live log, then redirect it ("use SQLite, not Postgres"). | Live stream renders; redirect injects a user turn into that session, takes effect ≤ one turn boundary. |
| U4 | When a session hits a decision the rules can't auto-resolve, I get a push notification (Web Push / ntfy) and a dashboard badge; I answer in natural language in the dashboard chat panel and the answer flows back. | Escalation round-trips while the session holds; answerable from the dashboard (and optionally the Hermes gateway/TUI if enabled); configurable timeout behavior. |
| U5 | I declare that a specific tool (e.g. `WebFetch`, or `Bash` matching `docker`) must never auto-run — always deny or always escalate. | Rule enforced deterministically before the call executes; editable in dashboard; live-reloaded; logged. |
| U6 | I pause / resume / kill any job from the dashboard (controls or chat panel). | Action takes effect ≤ one turn boundary; state persists across FOREMAN restarts (session resume). |
| U7 | A job drifts (rabbit-holing, repeated failures, scope creep) and FOREMAN catches it. | Router/circuit-breaker trips → nudge or escalate per policy; surfaced in dashboard + push. |
| U8 | I swap the Director model to something heavier (or the Router to something cheaper) by editing config. | No code change; restart (or hot-reload) picks up the new model/endpoint. |
| U9 | Someone else clones the repo and runs their own instance against their own Hermes + Claude Code in under 30 minutes. | `docker compose up` (or `npm run setup`) → guided init → smoke test passes. |

## 6. Functional Requirements

### FR1 — Multi-job lifecycle (concurrent)
Run **N jobs at once**, each with its own git worktree, headless Claude Code session,
and orchestration-loop instance. States carried over from EED Buddy:
`created → planning → running → blocked(escalation) → review → done | killed | failed`.
Jobs resume across FOREMAN restarts via Claude Code session resume. Single SQLite
store holds all job rows + the escalation queue.

### FR2 — Dispatch & the loop (the supervision pattern)
Implement the proven supervision pattern fresh, per-job:
- **Director** (stateless, planning + review + escalation resolution) writes *text*;
  never talks to Claude Code directly.
- **Router** classifies each Coder turn into the 7 labels; cheap and fast.
- **Coder** = headless Claude Code in the worktree, with the operator's own
  CLAUDE.md / skills / MCP config.
- **Amnesia ledger** re-injected into the stateless Director each call; powers the
  **circuit breaker** (stop looping on the same failure).
- **MCP bridge** exposes `ask_director` and `request_human_approval` back into the
  session — see FR4 for what makes approval *real* now.
- Feedback loop with a max-iteration cap; final review + optional security pass.

### FR3 — Granular tool rules (deterministic gate)
A live-reloadable rules set, per tool + argument pattern, with action
`allow | deny | escalate`, enforced by a **PreToolUse hook** before the call runs:
- Bulk of calls flow without prompting the operator (no yes-fatigue), exactly as
  EED Buddy's skip-permissions behavior — *except* where a rule says otherwise.
- `deny` blocks the call and feeds the reason back to the loop; `escalate` routes to
  human (FR4); unmatched → allow (configurable default per profile).
- Editable in `rules.yaml` **and** in the dashboard; changes hot-reload.
- Ships with a sensible default rule set (protect `~/.ssh`, `**/.env`, secrets; deny
  writes outside the worktree, `rm -rf` outside worktree, force-push, `curl|sh`,
  package publishes; escalate `docker`/`systemctl`/`gcloud`/`kubectl`).

### FR4 — Real human-in-the-loop (the new value)
In EED Buddy `request_human_approval` is a stub that auto-approves. Here it's real:
- An escalation raises a **push notification** (Web Push to the installed PWA, or ntfy)
  and shows in the dashboard as a **badge + context + Allow/Deny + free-text answer**,
  surfaced both on the job view and inline in the **chat panel**.
- The operator answers in the dashboard (natural language in chat, or the
  Allow/Deny/answer controls). If the optional Hermes gateway/TUI is enabled, those can
  answer too; first answer wins.
- The answer resolves the gate and is injected into the session as Director guidance /
  a redirect turn.
- Configurable timeout behavior per profile (default: hold + re-ping once, then
  `hold | deny`).

> Mechanism note: the escalation is the Claude Code PreToolUse **`defer`** decision
> (or `--permission-prompt-tool` fallback) — see the design doc. The human-facing
> round-trip rides the dashboard + push; Hermes' session API is the conversational
> brain behind the chat panel, not a required notification transport.

### FR5 — Dashboard over local HTTP (phone-reachable, the primary surface)
A web dashboard served by the Core daemon — the single surface for both control and
conversation:
- **Overview:** every job, phase, live activity, burn, open-question count.
- **Job view:** live log stream, files touched, plan/notes, controls (redirect,
  pause/resume/kill, answer escalation, approve plan).
- **Chat panel ("Talk to Hermes"):** a conversational view that streams Hermes'
  session API (`/api/sessions/{id}/chat/stream`, SSE) — start jobs, ask status,
  redirect, and answer escalations in natural language. This is what replaces a
  third-party messenger; the Hermes agent core (with its memory/cron) is the brain
  behind it.
- **Rules editor:** view/edit granular tool rules; hot-reload.
- **Settings:** model assignments + endpoints (read from config; editable optional).
- **PWA + Web Push:** installable to a phone home screen; escalations and completions
  arrive as native push. ntfy supported as an alternative/independent notifier.
- Reachable from a phone browser over LAN/Tailscale (see NFRs for binding + auth).

### FR6 — Hermes integration (the conversational brain)
FOREMAN talks to the Hermes agent core over its HTTP API; Hermes provides the
natural-language understanding, memory, and (optional) cron behind the dashboard's
chat panel:
- **FOREMAN → Hermes:** the dashboard chat panel streams Hermes' session API; FOREMAN
  Core also calls Hermes (`/v1/chat/completions` or `/v1/runs`) to phrase
  escalations/summaries in natural language and parse free-text answers.
- **Hermes → FOREMAN:** FOREMAN is registered as an **MCP server** (`hermes mcp add`)
  exposing `dispatch_job`, `status`, `redirect`, etc., so a Hermes conversation can
  command FOREMAN. Control-plane only — Hermes never edits worktrees.
- **Optional cron** for the periodic drift sweep.
- **Optional gateway:** Hermes' built-in messaging gateway (Telegram/Slack/etc.) and
  its native TUI remain usable as *additional* surfaces for anyone who wants them, but
  are **not required** — the dashboard chat panel + Web Push is the default phone path.
- **Hermes is optional overall:** the dashboard + CLI make FOREMAN usable without it,
  but without Hermes the chat panel falls back to structured commands rather than free
  natural language.

> Security: the Hermes HTTP API requires its key even on loopback; webhook/cron paths
> are untrusted-input surfaces (known RCE + prompt-injection issues) — enforce HMAC,
> sandbox, and least-privilege toolsets. See design doc §Security.

### FR7 — Swappable models
All model assignments are config:

| Role | Default | Rationale |
|------|---------|-----------|
| Director (heavy: plan / review / resolve) | **Gemini 3.5 Flash** | Heavy reasoning |
| Router (frequent / speed: per-turn classify) | **Gemini 3.1 Flash Lite** | Runs every turn; latency-sensitive |
| Optional per-call AI judge (off by default) | Gemini 3.1 Flash Lite | Frequent if enabled |
| Coder | Claude Code (BYO) | Unchanged |

Endpoint is any OpenAI/Anthropic-compatible URL (LiteLLM proxy). Swapping a model or
provider is a config edit, never a code change.

### FR8 — Audit & observability
Per-job JSONL audit: every tool call, every rule decision (which rule, action, why),
every escalation + the human's answer, every Router classification, every drift
verdict. Surfaced in the dashboard and summarizable via the chat panel (Hermes).
Token/cost accounting
carried over from EED Buddy.

### FR9 — Setup & packaging
- `docker compose up` brings up Core + dashboard; a guided init detects the Hermes API
  endpoint and Claude Code, writes config, registers FOREMAN as a Hermes MCP server,
  installs the PreToolUse hooks, generates Web Push (VAPID) keys, and runs a smoke test
  (trivial job in a temp repo with a planted forbidden command to prove the rule gate
  fires).
- Everything operator-specific in `foreman.yaml` + `rules.yaml` + `.env`. No hardcoded
  paths, models, or tokens.

## 7. Non-Functional Requirements

- **Fail-safe, never fail-open:** if the rule engine, judge, or Core errors, the
  affected call escalates (or denies per profile) — it never silently auto-allows.
- **Phone access security:** dashboard binds to a configurable interface (loopback by
  default; LAN/Tailscale when phone access is wanted) and **requires a bearer token**.
  Recommend Tailscale for off-LAN. No public exposure.
- **Concurrency:** N jobs run truly in parallel without git collisions (worktree per
  job). Default cap configurable.
- **Footprint:** TypeScript/Node, SQLite, no external queue/DB to babysit; runs
  comfortably alongside existing WARLOCK services. Docker-first.
- **Secrets:** endpoint keys from `.env`; never logged; audit redacts secret-pattern
  argument values.
- **Compliance / evolving surfaces:** uses only documented Claude Code surfaces
  (headless/SDK, hooks, permission modes, optionally Agent Teams). Coder must verify
  the hook I/O contract, headless flags, and **whether PreToolUse hooks fire/deny under
  skip-permissions** against current official docs at build time (see Design §9).

## 8. Success Metrics (v1)

- ≥ 90% of routine work flows without operator input; ≤ 3 human interruptions per
  typical job, none the operator judges "the rules should've handled that."
- All N concurrent jobs visible and steerable from one screen; phone round-trip works.
- Zero rule-gate violations executed (protected-path writes, denied commands).
- Moods rebuild run end-to-end primarily from the phone, intervening < 5 times.
- Fresh clone → running instance < 30 minutes.

## 9. Milestones

1. **M1 — Core loop.** Build the orchestrator / Director / Router / ledger /
   circuit-breaker / MCP-bridge fresh; wire to a LiteLLM endpoint and SQLite; no
   enterprise integrations. Single job, CLI-launched. *Exit: one job runs the loop
   end-to-end with Gemini Director/Router.*
2. **M2 — Concurrency + granular rules.** N jobs in parallel (worktree per job);
   PreToolUse rule gate with `rules.yaml`; audit log. *Exit: two jobs at once, a
   planted denied command is blocked.*
3. **M3 — Dashboard (primary surface).** Local-HTTP Quasar SPA: overview, job view +
   live log, rules editor, controls, escalation answer. Token auth. Installable PWA.
   Phone-reachable. *Exit: drive everything from a phone browser.*
4. **M4 — Hermes brain + real human-in-the-loop.** Dashboard **chat panel** streaming
   Hermes' session API; FOREMAN registered as a Hermes MCP server for conversational
   intake; Web Push (and/or ntfy) notifications; escalation round-trip via PreToolUse
   `defer` that makes `request_human_approval` real. *Exit: launch and answer an
   escalation from the phone via the dashboard chat panel + push.*
5. **M5 — Publish.** `docker compose`, guided init, profiles, README, license, smoke
   test, versioning.

## 10. Open Questions

1. Claude Code auth mode for headless dispatch under the operator's plan — confirm
   current product terms before relying on it programmatically.
2. Confirm exact provider model IDs the LiteLLM proxy expects for "Gemini 3.5 Flash" /
   "Gemini 3.1 Flash Lite" — treat the names as config defaults, verify the strings.
3. Keep EED Buddy's RAG learning store (local SQLite) or drop for v1? (Recommend keep
   it optional/lite — it's cheap and useful.)
4. Multiple answer surfaces (dashboard chat, dashboard controls, optional Hermes
   gateway/TUI) can each resolve a pending escalation — confirm single-resolution
   semantics (first answer wins, others clear). Confirm Web Push reliability on the
   operator's phone OS (iOS requires home-screen-installed PWA); ntfy as fallback.
5. You left a sixth bullet blank in the brief — anything you meant to add?
