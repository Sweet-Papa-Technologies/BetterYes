import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Root for all FOREMAN runtime state. Override with FOREMAN_HOME (used by tests). */
export const FOREMAN_HOME =
  process.env.FOREMAN_HOME ?? path.join(os.homedir(), '.foreman');

export const DB_PATH = path.join(FOREMAN_HOME, 'foreman.db');
export const JOBS_DIR = path.join(FOREMAN_HOME, 'jobs');
export const WORKTREES_DIR = path.join(FOREMAN_HOME, 'worktrees');

/** Per-job state directory: ~/.foreman/jobs/<id>/ */
export function jobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

/** Create the FOREMAN home tree if missing. Idempotent. */
export function ensureForemanHome(): void {
  for (const dir of [FOREMAN_HOME, JOBS_DIR, WORKTREES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ensureJobDir(jobId: string): string {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
