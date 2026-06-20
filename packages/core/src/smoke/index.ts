import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForemanConfig } from '../config/index.js';
import { GATE_PATH, resolveRulesPath } from '../gate/index.js';
import { requireSecret } from '../secrets/index.js';
import { createJob, getJob } from '../db/index.js';
import { jobManager } from '../orchestrator/index.js';
import { TERMINAL_STATES } from '@foreman/shared';

/**
 * `foreman smoke` (PRD FR9) — proves an install is wired correctly:
 *   1. Gate fires: feed the PreToolUse gate a *planted forbidden write* and assert it DENIES
 *      it (deterministic — no model needed). Also assert a normal write is allowed.
 *   2. Loop runs: launch a trivial job in a temp repo and assert it completes end-to-end
 *      (needs the LiteLLM endpoint + the claude CLI).
 */

export interface SmokeResult {
  gateDeny: boolean;
  gateAllow: boolean;
  jobOk: boolean | null; // null = skipped/unavailable
  details: string[];
}

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-smoke-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'smoke@foreman.local'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'smoke'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# smoke\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** Invoke the gate executable with a synthetic PreToolUse event; return its permissionDecision. */
function probeGate(rulesPath: string, worktree: string, toolInput: Record<string, unknown>, tool = 'Write'): string {
  const r = spawnSync('node', [GATE_PATH], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, FOREMAN_RULES: rulesPath, FOREMAN_WORKTREE: worktree, FOREMAN_PROFILE: 'standard' },
  });
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision ?? 'unknown';
  } catch {
    return 'unparseable';
  }
}

export async function runSmoke(config: ForemanConfig, opts: { full: boolean }): Promise<SmokeResult> {
  const details: string[] = [];
  const repo = makeTempRepo();
  const rulesPath = resolveRulesPath(config, 'standard');

  // 1. Gate fires on a planted forbidden write (**/.env) and allows a normal one.
  const denyDecision = probeGate(rulesPath, repo, { file_path: path.join(repo, '.env') });
  const allowDecision = probeGate(rulesPath, repo, { file_path: path.join(repo, 'hello.txt') });
  const gateDeny = denyDecision === 'deny';
  const gateAllow = allowDecision === 'allow';
  details.push(`gate on planted "**/.env" write → ${denyDecision} (want deny)`);
  details.push(`gate on normal "hello.txt" write → ${allowDecision} (want allow)`);

  // 2. Trivial job end-to-end (optional — needs LiteLLM + claude).
  let jobOk: boolean | null = null;
  if (opts.full) {
    try {
      requireSecret(config.endpoint.api_key_env);
      jobManager.init(config);
      const job = createJob({
        name: 'smoke',
        brief: 'Create a file named hello.txt containing a one-line greeting. That is the entire task.',
        repoPath: repo,
        profile: 'throwaway',
        directorModel: config.models.director,
        routerModel: config.models.router,
        maxTurns: config.coder.max_turns,
      });
      jobManager.start(job);
      const deadline = Date.now() + 3 * 60 * 1000;
      for (;;) {
        const cur = getJob(job.id);
        if (cur && (TERMINAL_STATES as readonly string[]).includes(cur.state)) {
          jobOk = cur.state === 'done';
          details.push(`trivial job ${job.id} → ${cur.state}`);
          break;
        }
        if (Date.now() > deadline) {
          details.push('trivial job timed out');
          jobOk = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      details.push(`job check skipped: ${(e as Error).message}`);
      jobOk = null;
    }
  }

  fs.rmSync(repo, { recursive: true, force: true });
  return { gateDeny, gateAllow, jobOk, details };
}
