import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKTREES_DIR } from '../paths.js';

/**
 * Per-job git worktree isolation (PRD FR1 / DESIGN §8). Each job gets its own worktree on
 * its own branch so concurrent jobs can't collide on files or branches, and so a denied
 * "write outside the worktree" rule (M2) has a concrete boundary.
 */

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function isGitRepo(repoPath: string): boolean {
  return git(repoPath, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Create a worktree for the job at ~/.foreman/worktrees/<jobId> on a fresh branch off the
 * repo's current HEAD. Idempotent enough for resume: if the path already exists, reuse it.
 */
export function prepareWorktree(opts: {
  jobId: string;
  repoPath: string;
  branch: string;
}): WorktreeInfo {
  const { jobId, repoPath, branch } = opts;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository. FOREMAN runs each job in a worktree.`);
  }
  const wtPath = path.join(WORKTREES_DIR, jobId);
  if (fs.existsSync(wtPath)) {
    return { path: wtPath, branch };
  }
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Base off current HEAD. New branch isolates the job's commits.
  const add = git(repoPath, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  if (!add.ok) {
    // Branch may already exist (e.g. retry) — fall back to attaching without -b.
    const retry = git(repoPath, ['worktree', 'add', wtPath, branch]);
    if (!retry.ok) {
      throw new Error(`git worktree add failed: ${add.stderr || retry.stderr}`);
    }
  }
  return { path: wtPath, branch };
}

/** Remove a job's worktree (used on kill/cleanup). Best-effort. */
export function removeWorktree(repoPath: string, wtPath: string): void {
  if (!fs.existsSync(wtPath)) return;
  git(repoPath, ['worktree', 'remove', '--force', wtPath]);
}

/** List files changed in the worktree vs HEAD (the real "files touched" set). */
export function changedFiles(wtPath: string): string[] {
  const r = git(wtPath, ['status', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim()) // strip the 2-char status code + space
    .filter(Boolean);
}

/** Count files changed in the worktree vs HEAD (drives the "files touched" metric). */
export function countChangedFiles(wtPath: string): number {
  return changedFiles(wtPath).length;
}
