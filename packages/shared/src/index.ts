/**
 * @foreman/shared — the type contract between the FOREMAN core daemon and the dashboard.
 *
 * Type-only by design: every export is a `type` or a string-literal union, so the Vite
 * frontend and the Node core both consume it with zero runtime/bundling cost.
 */

// ── Job lifecycle (PRD FR1) ──────────────────────────────────────────────────
export type JobState =
  | 'created'
  | 'planning'
  | 'running'
  | 'blocked' // waiting on a human escalation
  | 'review'
  | 'done'
  | 'killed'
  | 'failed';

/** States from which a job is still doing work. */
export const ACTIVE_STATES: readonly JobState[] = [
  'created',
  'planning',
  'running',
  'blocked',
  'review',
];

export const TERMINAL_STATES: readonly JobState[] = ['done', 'killed', 'failed'];

// ── Router classification (PRD FR2 — the 7 labels) ───────────────────────────
export type RouterLabel =
  | 'on_track'
  | 'needs_director'
  | 'blocked'
  | 'awaiting_approval'
  | 'drifting'
  | 'complete'
  | 'error';

// ── Policy profiles (DESIGN — rule gate; used fully in M2) ────────────────────
export type PolicyProfile = 'throwaway' | 'standard' | 'strict';

// ── Job records ──────────────────────────────────────────────────────────────
export interface Job {
  id: string; // human-facing, e.g. "FRM-8924"
  name: string;
  brief: string;
  repoPath: string;
  branch: string;
  worktreePath: string | null;
  state: JobState;
  /** Paused by the operator (the loop holds at the next turn boundary). */
  paused: boolean;
  profile: PolicyProfile;
  /** Claude Code session id, used for `--resume`. Null until the first turn. */
  sessionId: string | null;
  lastActivity: string; // human one-liner shown on the board
  filesTouched: number;
  /** Burn accounting (PRD FR8). */
  turns: number;
  maxTurns: number;
  tokens: number;
  costUsd: number;
  /** Number of open escalations awaiting a human. */
  openQuestions: number;
  /** Director model & Router model resolved for this job (FR7). */
  directorModel: string;
  routerModel: string;
  /** Operator asked to approve the plan before the job runs (FR4 / M3). */
  requirePlanApproval: boolean;
  agentTeams: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by `POST /jobs`. */
export interface CreateJobRequest {
  name: string;
  brief: string;
  repoPath: string;
  branch?: string;
  profile?: PolicyProfile;
  requirePlanApproval?: boolean;
  agentTeams?: boolean;
  directorModel?: string;
  routerModel?: string;
  /** If the folder isn't a git repo, `git init` it (+ initial commit) before launching. */
  initRepo?: boolean;
}

// ── Events (persisted per job + streamed over WS) ────────────────────────────
export type JobEventType =
  | 'state' // job state transition
  | 'log' // a line for the log console
  | 'router' // a Router classification verdict
  | 'director' // Director guidance / plan / review text
  | 'plan' // the agent's plan / objectives
  | 'file' // a file was touched
  | 'tool' // a tool call (coarse, for the audit tab)
  | 'escalation' // a human decision was raised (M4 makes this real)
  | 'burn' // updated turn/token/cost meters
  | 'error';

/** Severity tag used to colour log-console lines. */
export type LogLevel = 'init' | 'sync' | 'read' | 'plan' | 'exec' | 'warn' | 'error' | 'info';

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  type: JobEventType;
  /** Short label shown in the log console gutter, e.g. INIT / PLAN / EXEC. */
  level?: LogLevel;
  message: string;
  /** Arbitrary structured payload (router verdict, burn snapshot, file path, …). */
  data?: Record<string, unknown>;
}

// ── WebSocket envelope (`WS /jobs/:id/stream` and the global board stream) ────
export type WsMessage =
  | { kind: 'snapshot'; job: Job; events: JobEvent[] }
  | { kind: 'event'; event: JobEvent }
  | { kind: 'job'; job: Job } // a job row changed (for the board)
  | { kind: 'ping' };

// ── Escalations (scaffolded in M1, made real in M4) ──────────────────────────
export interface Escalation {
  id: string;
  jobId: string;
  question: string;
  proposedAction: string | null;
  reason: string | null;
  /** The tool the gate held (e.g. Bash/Write), when this came from the rule gate. */
  tool: string | null;
  state: 'open' | 'resolved' | 'timed_out';
  /** Operator's verdict once answered. */
  decision: 'allow' | 'deny' | null;
  /** Optional free-text answer / redirect from the operator. */
  answer: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Payload for `POST /escalations/:id/resolve`. */
export interface ResolveEscalationRequest {
  decision: 'allow' | 'deny';
  answer?: string;
  /** Allow: also auto-allow matching gate holds (same job + tool + rule) for this session. */
  remember?: boolean;
}

// ── Chat: persistent Hermes conversations (PRD FR6) ──────────────────────────
export interface ChatAttachment {
  name: string;
  type: string;
  size: number;
  /** Server path where the upload was saved (for inlining text content into the prompt). */
  path?: string;
}
export interface ChatMessage {
  id: number;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  /** Tool calls the assistant made during this turn (names), surfaced in the UI. */
  toolCalls?: string[];
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationSummary extends Conversation {
  lastMessage?: string;
}

// ── Config surfaced to the dashboard (`GET /config`) ─────────────────────────
export interface PublicConfig {
  models: { director: string; router: string };
  endpoint: { baseUrl: string };
  concurrency: { maxParallelJobs: number };
  coder: { command: string; maxTurns: number };
  dashboard: { bind: string; port: number };
  hermes: { enabled: boolean };
  /** How long a job holds for a human answer before falling back (ms). */
  escalationTimeoutMs: number;
  version: string;
}
