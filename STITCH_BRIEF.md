# FOREMAN — UI/UX Brief for Google Stitch

**Purpose of this doc:** everything Stitch needs to generate wireframes and
high-fidelity mockups for the FOREMAN dashboard — what the app is, who uses it,
the visual direction, every screen and its components, and copy-paste prompts.

**How to use it with Stitch (recommended workflow):**
1. Paste **§1 Context** + **§2 Design System** together as your first message to
   establish the product and the look. (You can also save §2 as Stitch's importable
   design-rules markdown so every screen inherits it.)
2. Generate **screen by screen in the batches in §4**, 2–3 screens at a time, using
   the ready-to-paste prompt under each screen. Generate in the listed order.
3. For consistency across screens: multi-select generated screens and re-apply the
   §2 theme prompt. Use the exact hex codes and UI terms below — Stitch follows
   precise terminology ("status pill," "log console," "bottom sheet") well.
4. Stitch leans toward high-fidelity output. If you want **wireframes first**, add
   "low-fidelity grayscale wireframe, no color, boxes and labels only" to any prompt;
   drop that line to get the hi-fi version.
5. Generate **both a mobile and a web/desktop version** of the Overview and the
   Escalation screens specifically — those are the phone-first moments.

---

## 1. Context (paste first)

**Product:** FOREMAN is a control room for supervising autonomous AI coding agents.
The operator launches coding "jobs" (e.g. "rebuild my Moods app per this brief"),
and each job runs in its own AI coding session that writes real code on its own.
Instead of babysitting four terminals and approving every step, the operator watches
all jobs from one dashboard and only steps in when a job hits a decision that needs a
human — a question, an approval, or a course-correction.

Think **mission control for a crew of robot programmers.** The operator is the
foreman: they give direction once, the crew works, and the foreman is pulled in only
when it matters.

**Primary user:** a senior software engineer / technical operator. A power user who
lives in terminals, reads dense dashboards comfortably, and values signal density and
speed over hand-holding. This is a professional ops tool, not a consumer app — closer
to Linear, the Vercel dashboard, Raycast, or a NASA control console than to a
cheerful mobile app.

**Core usage contexts (design for both):**
- **Desktop, deep focus:** monitoring several jobs at once, reading live logs,
  editing rules. Information-dense, multi-panel.
- **Phone, on the go:** the operator is away from the desk and gets a push that a job
  needs them. They open the app on their phone, understand the situation in seconds,
  and answer in two taps. The job board and the escalation screen *must* be excellent
  on a phone.

**The single most important moment in the whole app** is the **escalation** — when a
job stops and asks the human a question. Everything else is monitoring; this is the
decision. It should be impossible to miss and trivially fast to answer.

---

## 2. Design System (paste with §1; reuse as the theme on every screen)

**Mood / direction:** developer mission control. Dark, calm, precise, dense but not
cluttered. A restrained industrial "foreman" character — think blueprint grid,
hazard-amber accents, stencil/monospace touches — without literal clip-art (no hard
hats, no cartoon cranes). Quiet by default; loud only when a human is needed.

**Theme:** dark mode is primary. Optional light mode secondary.

**Color tokens (use these exact hex codes):**

| Token | Hex | Use |
|---|---|---|
| Background base | `#0E0F11` | App background (near-black, not pure black) |
| Surface | `#17191C` | Cards, panels, rows |
| Surface elevated | `#202327` | Modals, popovers, hover |
| Border / hairline | `#2A2E33` | Dividers, card edges |
| Text primary | `#E8EAED` | Headings, key values |
| Text secondary | `#9AA0A6` | Labels, metadata, timestamps |
| Text muted | `#6E7681` | De-emphasized, disabled |
| **Accent (signature)** | `#FFB020` | Primary actions, live pulse, brand — hazard amber |
| Status · running | `#3FB950` | Job actively working (with subtle live pulse) |
| Status · planning | `#539BF5` | Job thinking / planning |
| Status · escalation/blocked | `#FFB020` | Needs human — THE attention state, amber, pulsing |
| Status · review | `#A371F7` | Done, awaiting operator review |
| Status · done | `#2EA043` | Completed, low emphasis (filled check) |
| Status · failed | `#F85149` | Errored |
| Status · killed | `#6E7681` | Stopped by operator, neutral gray |

> Note the deliberate split: **amber = "needs you"** (escalation), **green = "running
> fine."** Keep amber reserved for attention so it always means "look here."

**Typography:**
- UI sans-serif: **Inter** (or Geist) — clean, modern, tight.
- Monospace: **JetBrains Mono** (or Geist Mono) — for job IDs, log output, commands,
  branch names, token/turn counts. The mono usage reinforces the dev-tool identity.

**Density & layout:** compact, Linear-like. Tight rows, small but legible type, lots
of information per viewport on desktop; clean stacked reflow on mobile. 8px spacing
grid. Generous use of subtle hairline borders over heavy shadows.

**Motion:** subtle. A soft pulse on running/escalation status dots; smooth
auto-scroll on the live log; gentle transitions. Nothing bouncy.

**Iconography:** thin line icons (Lucide style), consistent stroke weight.

**Components vocabulary** (terms to reuse in prompts): status pill, job card, job row,
log console, escalation banner, bottom sheet, command input, burn meter, sidebar nav,
bottom tab bar, badge, segmented control, toggle, code-style chip.

---

## 3. Information architecture

Seven screens + a global escalation surface and an app shell.

| # | Screen | Role |
|---|---|---|
| S1 | **Overview / Job Board** | Home. All jobs at a glance. |
| S2 | **Job Detail** | One job: live log, plan, files, controls. |
| S3 | **Escalation** | The human-in-the-loop decision (modal/sheet + can stand alone). |
| S4 | **New Job** | Create and launch a job. |
| S5 | **Rules Editor** | Granular per-tool allow/deny/escalate rules. |
| S6 | **Settings** | Models, endpoint, concurrency, notifications. |
| S7 | **Chat ("Talk to Hermes")** | Conversational control — start jobs, ask status, answer escalations in natural language. |

**App shell:** desktop = left sidebar nav (Board, Chat, Rules, Settings) + a persistent
"needs-you" indicator. Mobile = bottom tab bar (Board, Chat, Rules, Settings) + the
escalation surfaces as a bottom sheet over anything. This is an installable PWA;
notifications arrive as native push.

---

## 4. Screens (with ready-to-paste prompts)

> **Generation order / batches:**
> Batch A → S1, S2 · Batch B → S3 (mobile + desktop) · Batch C → S4, S5 · Batch D → S6, S7.

### S1 — Overview / Job Board  *(generate mobile + desktop)*

**Purpose:** see every job's state instantly; spot the ones that need you.

**Layout:**
- Top bar: app wordmark "FOREMAN," a summary strip ("3 running · 1 needs you · 2
  done"), a prominent **New Job** button (amber accent).
- A **needs-you** band pinned at top when any job is escalated: amber, listing the
  job(s) waiting on a human, one-tap into the escalation.
- Main area: a list of **job cards** (mobile) / **job rows** (desktop table-like).

**Each job card/row shows:** job name + monospace job ID; repo + branch (mono chip);
a **status pill** (colored per §2); a one-line "last activity" summary; files-touched
count; a **burn meter** (turns / tokens, small); a live pulse if running; an amber
badge if it needs the human. Sort/filter by status.

**States:** empty ("No jobs yet — launch one"), several running, one escalated (amber
band visible), some done/failed.

> **Stitch prompt:**
> "Design the home screen of FOREMAN, a dark-themed developer mission-control app for
> supervising multiple AI coding agents. Background #0E0F11, surfaces #17191C, hazard-amber
> accent #FFB020, Inter for UI and JetBrains Mono for IDs and metrics. Top bar with the
> wordmark 'FOREMAN', a summary strip '3 running · 1 needs you · 2 done', and an amber
> 'New Job' button. Below it, an amber attention band that says one job needs a human
> decision, tappable. Then a list of job cards; each card shows a job name, a monospace
> job ID, a repo/branch chip in monospace, a colored status pill (green 'running' with a
> small pulsing dot, blue 'planning', amber 'needs you', purple 'review', red 'failed'),
> a one-line last-activity summary, a files-touched count, and a small burn meter showing
> turns and tokens. Compact, information-dense, Linear-like. Show one card in the amber
> 'needs you' state. Provide both a mobile layout with stacked cards and a bottom tab bar
> (Board, Rules, Settings), and a desktop layout with a left sidebar and denser rows."

### S2 — Job Detail  *(desktop primary, mobile responsive)*

**Purpose:** go deep on one job — read what it's doing, steer it.

**Layout (desktop):** header (job name, ID, repo/branch, status pill, controls:
Pause, Kill, Approve Plan). Main = a large **log console** (monospace, dark, terminal
feel, auto-scrolling, the hero element). Right rail or tabs: **Plan/Notes**, **Files
touched**, **Audit** (rule decisions + escalations). Bottom: a **command input** ("Tell
this job to…") for redirects. Burn meters (turns/tokens vs budget) in the header.

**Mobile:** stacked — header, controls as icon buttons, log console full-width with a
tab switcher (Log / Plan / Files), command input docked at bottom.

**States:** running (log streaming), blocked (amber strip + jump-to-escalation),
review (a "Review & ship" call-to-action), done.

> **Stitch prompt:**
> "Design the job detail screen for FOREMAN (same dark theme, hazard-amber #FFB020 accent,
> Inter + JetBrains Mono). Header with job name, monospace job ID, repo/branch chip, a green
> 'running' status pill with pulsing dot, header burn meters for turns and tokens, and
> control buttons Pause / Kill / Approve Plan. The hero is a large terminal-style log console
> in monospace on a near-black surface, auto-scrolling streaming output. A right-side panel
> with tabs Plan, Files, Audit — Plan shows the agent's objectives and approach, Files shows
> a list of changed files, Audit shows a timeline of tool-rule decisions and escalations.
> A docked command input at the bottom labeled 'Tell this job to…' for sending a redirect.
> Compact and technical. Provide a desktop multi-panel layout and a mobile single-column
> layout with a Log/Plan/Files tab switcher and the command input fixed at the bottom."

### S3 — Escalation  *(the crown jewel — generate mobile FIRST, then desktop)*

**Purpose:** a job stopped to ask the human. Understand fast, decide in two taps.

**Surface:** appears as a **bottom sheet** over any screen on mobile, and a centered
**modal** on desktop. Also reachable as a standalone screen from the needs-you band.

**Contents:** which job (name + ID); a plain-language statement of what it wants ("Job
2 wants to run `docker compose up` to test the rebuild"); the **proposed action** shown
as a monospace code chip; **why** (a short Director-reasoning blurb + relevant context,
e.g. "this needs port 5432, which conflicts with your local Postgres"); and the
decision controls: a big **Allow** (amber), a **Deny**, and a **free-text answer/redirect**
box ("…or tell it what to do instead"). A subtle timeout indicator ("auto-holds in
28:00"). Keep it skimmable — the operator may be one-handed on a phone.

**States:** a simple yes/no approval; a question needing a typed answer; a
multi-line context-heavy decision.

> **Stitch prompt:**
> "Design the escalation screen for FOREMAN — the moment an AI coding job pauses to ask the
> human operator for a decision. Same dark theme; hazard-amber #FFB020 is the primary accent
> here because this is the attention moment. Show it as a mobile bottom sheet over a dimmed
> job board. Contents: a header 'Job 2 needs you' with a monospace job ID; a plain-language
> line describing what the job wants to do; the proposed action shown as a monospace code chip
> (e.g. `docker compose up`); a short 'why' explanation panel with context; and a soft timeout
> indicator 'auto-holds in 28:00'. Decision controls: a large amber 'Allow' button, a secondary
> 'Deny' button, and a free-text input 'or tell it what to do instead…'. Skimmable, one-handed,
> two-tap to resolve. Provide the mobile bottom-sheet version and a desktop centered-modal
> version."

### S4 — New Job

**Purpose:** give direction once and launch.

**Layout:** a focused form. Repo (path field / picker, monospace). A large **brief**
text area — the headline input, where the operator writes what they want ("Rebuild the
Moods app: …"). A **policy profile** segmented control (Throwaway / Standard / Strict).
Optional toggles: "Require my approval of the plan before it starts," "Enable parallel
sub-agents (Agent Teams)." Optional model overrides (collapsed by default). A primary
**Launch job** button (amber). Keep it calm and uncluttered — the brief is the star.

> **Stitch prompt:**
> "Design the 'New Job' creation screen for FOREMAN (same dark theme, amber #FFB020 accent,
> Inter + JetBrains Mono). A clean focused form: a monospace repository path field, a large
> prominent multi-line 'Brief' text area where the user describes the coding task (this is
> the main input), a segmented control to choose a policy profile (Throwaway / Standard /
> Strict), two toggles ('Require my approval of the plan before starting', 'Enable parallel
> sub-agents'), a collapsed 'Advanced: model overrides' section, and a large amber 'Launch
> job' button. Uncluttered, the brief text area is visually dominant. Mobile and desktop."

### S5 — Rules Editor

**Purpose:** define granular per-tool rules — which tool calls auto-run, which are
blocked, which must ask the human.

**Layout:** a list/table of rules. Each rule = a **match** (tool name + an argument
pattern shown as a monospace chip, e.g. tool `Bash`, pattern `docker|systemctl`) → an
**action** (Allow / Deny / Escalate) shown as a colored pill (green / red / amber). Add
/ edit / delete a rule. An editor row/drawer to build a rule (tool dropdown, pattern
field, action select). A "hot-reloaded" confirmation toast. Group or visually separate
the dangerous defaults (protect ~/.ssh, .env, block rm -rf, force-push). This screen
can be denser and more technical — it's power-user config.

> **Stitch prompt:**
> "Design the 'Tool Rules' editor for FOREMAN (same dark theme, amber #FFB020 accent, mono
> for code). A technical settings screen: a table of rules, each row showing a tool name, an
> argument-pattern shown as a monospace code chip (like a path glob or command regex), and an
> action pill colored green 'Allow', red 'Deny', or amber 'Escalate'. An 'Add rule' button and
> an edit drawer with a tool dropdown, a pattern input, and an action selector. Show example
> rows: deny writes to '**/.env' and '~/.ssh/**', deny 'rm -rf' and 'git push --force', escalate
> 'docker'/'systemctl'. A small 'rules hot-reloaded' toast. Dense and developer-focused. Mobile
> and desktop layouts."

### S6 — Settings

**Purpose:** model assignments, endpoint, concurrency, notifications.

**Layout:** grouped sections. **Models** — Director and Router model fields (mono),
showing defaults "gemini-3.5-flash" and "gemini-3.1-flash-lite," each editable, plus
the endpoint base URL. **Concurrency** — max parallel jobs (stepper). **Notifications**
— Web Push on/off (with an "Enable on this device" button), what to notify on
(escalations, completions, failures). **Hermes** — endpoint + connection status.
**Access** — dashboard bind address + a masked token (read-mostly). Simple, calm.

> **Stitch prompt:**
> "Design the Settings screen for FOREMAN (same dark theme, amber accent, mono for values).
> Grouped sections: 'Models' with editable fields for a Director model (default
> 'gemini-3.5-flash') and a Router model (default 'gemini-3.1-flash-lite') plus an endpoint
> URL field; 'Concurrency' with a max-parallel-jobs stepper; 'Notifications' with an 'Enable
> push on this device' button and toggles for escalations, completions, and failures; a
> 'Hermes' section with an endpoint field and a green 'connected' status dot; and 'Access'
> showing a bind address and a masked token. Clean, low-density, standard settings layout.
> Mobile and desktop."

### S7 — Chat ("Talk to Hermes")

**Purpose:** the conversational surface — the thing that replaces a messaging app. Start
jobs, ask "status?", redirect a job, and answer escalations in plain language. Backed by
the Hermes agent (memory + reasoning); FOREMAN actions show as inline confirmations.

**Layout:** a clean chat thread (operator messages right, Hermes left), monospace for any
job IDs / commands / code the agent emits. A composer at the bottom. **Inline action
cards:** when the conversation creates or affects a job, show a compact card (job name,
status pill, a tap-through to the job view) rather than plain text. When an escalation is
pending, it appears inline as an amber answer card (Allow / Deny / type a reply) so it can
be resolved without leaving the thread. Mobile-first — this is a primary phone surface;
one-handed, big tap targets, sticky composer.

> **Stitch prompt:**
> "Design a chat screen for FOREMAN called 'Talk to Hermes' (same dark theme, hazard-amber
> #FFB020 accent, Inter for UI and JetBrains Mono for any IDs, commands, or code). A
> conversational thread: operator messages aligned right in a neutral bubble, assistant
> ('Hermes') messages aligned left. Some assistant replies include a compact inline job card
> — job name, a colored status pill, and a 'view job' affordance — instead of plain text. Show
> one pending escalation rendered inline as an amber answer card with 'Allow', 'Deny', and a
> reply field. A sticky message composer at the bottom with a send button. Mobile-first, clean,
> one-handed, with a bottom tab bar (Board, Chat, Rules, Settings); also provide a desktop
> layout where the chat sits beside the job board."

---

## 5. Global states & components to also generate

- **Empty state** for the board ("No jobs yet — launch your first one"), illustrative
  but on-brand (blueprint/grid motif, amber accent).
- **Connection status** indicator (a small "live" dot when the WebSocket is connected,
  a muted "reconnecting…" when not) — important for a real-time tool.
- **Loading skeletons** for job cards and the log console.
- **The needs-you indicator** in the nav (a persistent amber badge/count visible from
  every screen).

---

## 6. Out of scope for Stitch

This is visual design only. No auth flows, onboarding, billing, or marketing pages —
FOREMAN is a single-operator local tool. Don't design account/login screens; access is
a token, surfaced only as a field in Settings. Keep everything inside the
"already-logged-in operator using their control room" frame.
