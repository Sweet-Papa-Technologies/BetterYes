import type { JobState, LogLevel } from '@foreman/shared';

/** Per-state display metadata: the pill label, its CSS class, and whether the pip pulses. */
export const STATUS_META: Record<JobState, { label: string; cls: string; pulse?: 'slow' | 'fast' }> =
  {
    created: { label: 'queued', cls: 'status-created' },
    planning: { label: 'planning', cls: 'status-planning', pulse: 'slow' },
    running: { label: 'running', cls: 'status-running', pulse: 'slow' },
    blocked: { label: 'needs you', cls: 'status-blocked', pulse: 'fast' },
    review: { label: 'review', cls: 'status-review' },
    done: { label: 'done', cls: 'status-done' },
    killed: { label: 'killed', cls: 'status-killed' },
    failed: { label: 'failed', cls: 'status-failed' },
  };

export const LOG_LEVEL_CLASS: Record<LogLevel, string> = {
  init: 'lv-init',
  sync: 'lv-sync',
  read: 'lv-read',
  plan: 'lv-plan',
  exec: 'lv-exec',
  warn: 'lv-warn',
  error: 'lv-error',
  info: 'lv-info',
};

export function isActive(state: JobState): boolean {
  return state === 'planning' || state === 'running' || state === 'blocked' || state === 'created';
}
export function needsYou(state: JobState): boolean {
  return state === 'blocked';
}
