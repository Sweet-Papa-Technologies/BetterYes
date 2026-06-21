import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  CreateJobRequest,
  Escalation,
  Job,
  JobEvent,
  JobEventType,
  JobState,
  LogLevel,
  PolicyProfile,
} from '@foreman/shared';
import { TERMINAL_STATES } from '@foreman/shared';
import { DB_PATH, ensureForemanHome, ensureJobDir, jobDir } from '../paths.js';
import { bus } from '../bus.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureForemanHome();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT PRIMARY KEY,
      seq           INTEGER,
      name          TEXT NOT NULL,
      brief         TEXT NOT NULL,
      repoPath      TEXT NOT NULL,
      branch        TEXT NOT NULL,
      worktreePath  TEXT,
      state         TEXT NOT NULL,
      profile       TEXT NOT NULL,
      sessionId     TEXT,
      lastActivity  TEXT NOT NULL DEFAULT '',
      filesTouched  INTEGER NOT NULL DEFAULT 0,
      turns         INTEGER NOT NULL DEFAULT 0,
      maxTurns      INTEGER NOT NULL DEFAULT 50,
      tokens        INTEGER NOT NULL DEFAULT 0,
      costUsd       REAL NOT NULL DEFAULT 0,
      openQuestions INTEGER NOT NULL DEFAULT 0,
      directorModel TEXT NOT NULL,
      routerModel   TEXT NOT NULL,
      requirePlanApproval INTEGER NOT NULL DEFAULT 0,
      agentTeams    INTEGER NOT NULL DEFAULT 0,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ts      TEXT NOT NULL,
      type    TEXT NOT NULL,
      level   TEXT,
      message TEXT NOT NULL,
      data    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(jobId, id);

    CREATE TABLE IF NOT EXISTS escalations (
      id             TEXT PRIMARY KEY,
      jobId          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      question       TEXT NOT NULL,
      proposedAction TEXT,
      reason         TEXT,
      state          TEXT NOT NULL DEFAULT 'open',
      decision       TEXT,
      answer         TEXT,
      createdAt      TEXT NOT NULL,
      resolvedAt     TEXT
    );
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint  TEXT PRIMARY KEY,
      p256dh    TEXT NOT NULL,
      auth      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);

  // Additive migrations for DBs created by earlier milestones (CREATE TABLE IF NOT EXISTS
  // won't add new columns to an existing table).
  addColumnIfMissing(d, 'escalations', 'decision', 'TEXT');
  addColumnIfMissing(d, 'escalations', 'tool', 'TEXT');
  addColumnIfMissing(d, 'jobs', 'paused', 'INTEGER NOT NULL DEFAULT 0');
}

// ── Web Push subscriptions (M4) ──────────────────────────────────────────────
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function addSubscription(sub: PushSub): void {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
    )
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
}

export function removeSubscription(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function listSubscriptions(): PushSub[] {
  const rows = getDb().prepare('SELECT * FROM push_subscriptions').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    endpoint: r.endpoint as string,
    keys: { p256dh: r.p256dh as string, auth: r.auth as string },
  }));
}

function addColumnIfMissing(
  d: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Open the DB and run migrations — used by `foreman doctor` to confirm writability. */
export function ensureSchema(): void {
  getDb();
}

const now = () => new Date().toISOString();

function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    name: r.name as string,
    brief: r.brief as string,
    repoPath: r.repoPath as string,
    branch: r.branch as string,
    worktreePath: (r.worktreePath as string) ?? null,
    state: r.state as JobState,
    paused: !!(r.paused as number),
    profile: r.profile as PolicyProfile,
    sessionId: (r.sessionId as string) ?? null,
    lastActivity: r.lastActivity as string,
    filesTouched: r.filesTouched as number,
    turns: r.turns as number,
    maxTurns: r.maxTurns as number,
    tokens: r.tokens as number,
    costUsd: r.costUsd as number,
    openQuestions: r.openQuestions as number,
    directorModel: r.directorModel as string,
    routerModel: r.routerModel as string,
    requirePlanApproval: !!(r.requirePlanApproval as number),
    agentTeams: !!(r.agentTeams as number),
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
  };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
export interface CreateJobParams extends CreateJobRequest {
  directorModel: string;
  routerModel: string;
  maxTurns: number;
}

export function createJob(p: CreateJobParams): Job {
  const d = getDb();
  const seq = (d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM jobs').get() as { n: number })
    .n;
  const id = `FRM-${1000 + seq}`;
  const ts = now();
  const job: Job = {
    id,
    name: p.name,
    brief: p.brief,
    repoPath: p.repoPath,
    branch: p.branch ?? `foreman/${id.toLowerCase()}`,
    worktreePath: null,
    state: 'created',
    paused: false,
    profile: p.profile ?? 'standard',
    sessionId: null,
    lastActivity: 'Created',
    filesTouched: 0,
    turns: 0,
    maxTurns: p.maxTurns,
    tokens: 0,
    costUsd: 0,
    openQuestions: 0,
    directorModel: p.directorModel,
    routerModel: p.routerModel,
    requirePlanApproval: !!p.requirePlanApproval,
    agentTeams: !!p.agentTeams,
    createdAt: ts,
    updatedAt: ts,
  };
  d.prepare(
    `INSERT INTO jobs (id, seq, name, brief, repoPath, branch, worktreePath, state, paused, profile,
      sessionId, lastActivity, filesTouched, turns, maxTurns, tokens, costUsd, openQuestions,
      directorModel, routerModel, requirePlanApproval, agentTeams, createdAt, updatedAt)
     VALUES (@id, @seq, @name, @brief, @repoPath, @branch, @worktreePath, @state, @paused, @profile,
      @sessionId, @lastActivity, @filesTouched, @turns, @maxTurns, @tokens, @costUsd,
      @openQuestions, @directorModel, @routerModel, @requirePlanApproval, @agentTeams,
      @createdAt, @updatedAt)`,
  ).run({
    ...job,
    seq,
    paused: job.paused ? 1 : 0,
    requirePlanApproval: p.requirePlanApproval ? 1 : 0,
    agentTeams: p.agentTeams ? 1 : 0,
  });
  ensureJobDir(id);
  fs.writeFileSync(path.join(jobDir(id), 'job.yaml'), jobYaml(job));
  bus.emitJob(job);
  return job;
}

export function getJob(id: string): Job | null {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToJob(r) : null;
}

export function listJobs(): Job[] {
  return (
    getDb().prepare('SELECT * FROM jobs ORDER BY seq DESC').all() as Record<string, unknown>[]
  ).map(rowToJob);
}

/** Jobs still in flight — used to resume work after a daemon restart (PRD FR1). */
export function listNonTerminalJobs(): Job[] {
  const placeholders = TERMINAL_STATES.map(() => '?').join(',');
  return (
    getDb()
      .prepare(`SELECT * FROM jobs WHERE state NOT IN (${placeholders}) ORDER BY seq ASC`)
      .all(...TERMINAL_STATES) as Record<string, unknown>[]
  ).map(rowToJob);
}

/** Patch a job's mutable fields, bump updatedAt, persist job.yaml, and broadcast. */
export function updateJob(id: string, patch: Partial<Job>): Job {
  const current = getJob(id);
  if (!current) throw new Error(`No such job: ${id}`);
  const next: Job = { ...current, ...patch, id, updatedAt: now() };
  getDb()
    .prepare(
      `UPDATE jobs SET name=@name, brief=@brief, repoPath=@repoPath, branch=@branch,
        worktreePath=@worktreePath, state=@state, paused=@paused, profile=@profile, sessionId=@sessionId,
        lastActivity=@lastActivity, filesTouched=@filesTouched, turns=@turns, maxTurns=@maxTurns,
        tokens=@tokens, costUsd=@costUsd, openQuestions=@openQuestions, directorModel=@directorModel,
        routerModel=@routerModel, updatedAt=@updatedAt
       WHERE id=@id`,
    )
    .run({ ...next, paused: next.paused ? 1 : 0 });
  fs.writeFileSync(path.join(jobDir(id), 'job.yaml'), jobYaml(next));
  bus.emitJob(next);
  return next;
}

function jobYaml(j: Job): string {
  return [
    `id: ${j.id}`,
    `name: ${JSON.stringify(j.name)}`,
    `repo: ${j.repoPath}`,
    `branch: ${j.branch}`,
    `state: ${j.state}`,
    `profile: ${j.profile}`,
    `sessionId: ${j.sessionId ?? ''}`,
    `directorModel: ${j.directorModel}`,
    `routerModel: ${j.routerModel}`,
    `createdAt: ${j.createdAt}`,
    `updatedAt: ${j.updatedAt}`,
    '',
  ].join('\n');
}

// ── Events ───────────────────────────────────────────────────────────────────
export interface AppendEventParams {
  jobId: string;
  type: JobEventType;
  message: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
}

/** Append an event: persist to SQLite + events.jsonl, then broadcast on the bus. */
export function appendEvent(p: AppendEventParams): JobEvent {
  const ts = now();
  const dataJson = p.data ? JSON.stringify(p.data) : null;
  const info = getDb()
    .prepare(
      `INSERT INTO events (jobId, ts, type, level, message, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(p.jobId, ts, p.type, p.level ?? null, p.message, dataJson);
  const event: JobEvent = {
    id: Number(info.lastInsertRowid),
    jobId: p.jobId,
    ts,
    type: p.type,
    ...(p.level ? { level: p.level } : {}),
    message: p.message,
    ...(p.data ? { data: p.data } : {}),
  };
  // Append-only per-job JSONL log (DESIGN §3).
  fs.appendFileSync(path.join(jobDir(p.jobId), 'events.jsonl'), JSON.stringify(event) + '\n');
  bus.emitEvent(event);
  return event;
}

// ── Escalations + audit (M2) ─────────────────────────────────────────────────
export interface CreateEscalationParams {
  jobId: string;
  question: string;
  proposedAction?: string | null;
  reason?: string | null;
  tool?: string | null;
}

/** Record an escalation raised by the rule gate; bumps the job's open-question count. */
export function createEscalation(p: CreateEscalationParams): Escalation {
  const d = getDb();
  const ts = now();
  const n = (d.prepare('SELECT COUNT(*) AS n FROM escalations').get() as { n: number }).n;
  const id = `ESC-${1000 + n}`;
  d.prepare(
    `INSERT INTO escalations (id, jobId, question, proposedAction, reason, tool, state, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(id, p.jobId, p.question, p.proposedAction ?? null, p.reason ?? null, p.tool ?? null, ts);
  const job = getJob(p.jobId);
  if (job) updateJob(p.jobId, { openQuestions: job.openQuestions + 1 });
  return rowToEscalation({
    id,
    jobId: p.jobId,
    question: p.question,
    proposedAction: p.proposedAction ?? null,
    reason: p.reason ?? null,
    tool: p.tool ?? null,
    state: 'open',
    decision: null,
    answer: null,
    createdAt: ts,
    resolvedAt: null,
  });
}

function rowToEscalation(r: Record<string, unknown>): Escalation {
  return {
    id: r.id as string,
    jobId: r.jobId as string,
    question: r.question as string,
    proposedAction: (r.proposedAction as string) ?? null,
    reason: (r.reason as string) ?? null,
    tool: (r.tool as string) ?? null,
    state: r.state as Escalation['state'],
    decision: (r.decision as Escalation['decision']) ?? null,
    answer: (r.answer as string) ?? null,
    createdAt: r.createdAt as string,
    resolvedAt: (r.resolvedAt as string) ?? null,
  };
}

export function getEscalation(id: string): Escalation | null {
  const r = getDb().prepare('SELECT * FROM escalations WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToEscalation(r) : null;
}

/** Record the operator's answer and close the escalation; decrements the job's open count. */
export function resolveEscalation(
  id: string,
  decision: 'allow' | 'deny',
  answer?: string,
): Escalation | null {
  const cur = getEscalation(id);
  if (!cur || cur.state !== 'open') return cur;
  const ts = now();
  getDb()
    .prepare(
      `UPDATE escalations SET state='resolved', decision=?, answer=?, resolvedAt=? WHERE id=?`,
    )
    .run(decision, answer ?? null, ts, id);
  const job = getJob(cur.jobId);
  if (job) {
    const patch: Partial<Job> = { openQuestions: Math.max(0, job.openQuestions - 1) };
    // Un-block a job that was held by the gate (the in-tool hold). The Coder turn resumes
    // as soon as the gate's poll sees this resolution.
    if (job.state === 'blocked' && countOpenEscalations(cur.jobId) <= 1) patch.state = 'running';
    updateJob(cur.jobId, patch);
  }
  return getEscalation(id);
}

function countOpenEscalations(jobId: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM escalations WHERE jobId = ? AND state = 'open'`)
      .get(jobId) as { n: number }
  ).n;
}

/** Mark an open escalation as timed out (used by the orchestrator's hold timeout). */
export function timeoutEscalation(id: string): void {
  const cur = getEscalation(id);
  if (!cur || cur.state !== 'open') return;
  getDb().prepare(`UPDATE escalations SET state='timed_out', resolvedAt=? WHERE id=?`).run(now(), id);
  const job = getJob(cur.jobId);
  if (job) updateJob(cur.jobId, { openQuestions: Math.max(0, job.openQuestions - 1) });
}

/** Time out every open escalation for a job (a dead hold after a restart). */
export function timeoutOpenEscalationsForJob(jobId: string): number {
  const open = (
    getDb().prepare(`SELECT id FROM escalations WHERE jobId = ? AND state = 'open'`).all(jobId) as {
      id: string;
    }[]
  );
  for (const e of open) timeoutEscalation(e.id);
  return open.length;
}

export function listEscalations(state?: 'open' | 'resolved' | 'timed_out'): Escalation[] {
  const rows = (
    state
      ? getDb().prepare('SELECT * FROM escalations WHERE state = ? ORDER BY createdAt DESC').all(state)
      : getDb().prepare('SELECT * FROM escalations ORDER BY createdAt DESC').all()
  ) as Record<string, unknown>[];
  return rows.map(rowToEscalation);
}

export function listEvents(jobId: string, limit = 500): JobEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE jobId = ? ORDER BY id ASC LIMIT ?')
    .all(jobId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    jobId: r.jobId as string,
    ts: r.ts as string,
    type: r.type as JobEventType,
    ...(r.level ? { level: r.level as LogLevel } : {}),
    message: r.message as string,
    ...(r.data ? { data: JSON.parse(r.data as string) as Record<string, unknown> } : {}),
  }));
}
