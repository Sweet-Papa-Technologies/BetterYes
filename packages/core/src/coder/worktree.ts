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

export interface MergeResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  baseBranch?: string;
  committed?: boolean;
  cleanedUp?: boolean;
  nothingToMerge?: boolean;
}

/**
 * Merge a job's worktree branch back into the repo's checked-out branch, then (optionally)
 * remove the worktree and delete the branch. Any uncommitted work in the worktree is committed
 * first (Claude Code often leaves changes uncommitted). Fails closed: a dirty target repo or a
 * merge conflict aborts cleanly without touching the worktree, so nothing is lost.
 */
export function mergeWorktree(opts: {
  repoPath: string;
  wtPath: string;
  branch: string;
  commitMessage?: string;
  cleanup?: boolean;
}): MergeResult {
  const { repoPath, wtPath, branch } = opts;
  if (!fs.existsSync(wtPath)) return { ok: false, error: 'Worktree no longer exists.' };

  // 1. Commit pending work on the job branch so there's something to merge.
  let committed = false;
  if (changedFiles(wtPath).length > 0) {
    const add = git(wtPath, ['add', '-A']);
    if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
    const msg = opts.commitMessage?.trim() || `FOREMAN: merge work from ${branch}`;
    const commit = git(wtPath, ['commit', '-m', msg]);
    if (!commit.ok) return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
    committed = true;
  }

  // 2. Refuse to merge over uncommitted work in the target checkout.
  const dirty = git(repoPath, ['status', '--porcelain']).stdout.trim();
  if (dirty) {
    return {
      ok: false,
      committed,
      error: `Target repo has uncommitted changes — commit or stash them first, then merge.`,
    };
  }

  const baseBranch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  // 3. Already merged / no new commits? Treat as a clean no-op (still allow cleanup).
  const ahead = git(repoPath, ['rev-list', '--count', `HEAD..${branch}`]).stdout.trim();
  const nothingToMerge = ahead === '0';

  if (!nothingToMerge) {
    const merge = git(repoPath, ['merge', '--no-ff', branch, '-m', `Merge ${branch} (FOREMAN job)`]);
    if (!merge.ok) {
      git(repoPath, ['merge', '--abort']); // leave the repo exactly as it was
      return {
        ok: false,
        committed,
        baseBranch,
        conflict: true,
        error: `Merge conflict with ${baseBranch} — aborted, nothing changed. Resolve it manually.`,
      };
    }
  }

  // 4. Optional cleanup: remove the worktree, then delete its now-merged branch.
  let cleanedUp = false;
  if (opts.cleanup) {
    removeWorktree(repoPath, wtPath);
    git(repoPath, ['branch', '-D', branch]); // safe: branch is merged (or empty)
    cleanedUp = true;
  }
  return { ok: true, committed, baseBranch, cleanedUp, nothingToMerge };
}
