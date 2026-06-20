import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { findConfigPath, type ForemanConfig } from '../config/index.js';

/**
 * Wires the standalone PreToolUse rule gate (bin/foreman-gate.mjs) into a headless Claude
 * Code launch. Produces the `--settings` JSON and the env the gate reads. Used by the Coder
 * dispatcher when `rules.enabled` (DESIGN §4).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// src/gate -> packages/core
export const GATE_PATH = path.resolve(here, '../../bin/foreman-gate.mjs');

/** Resolve rules.yaml: config override, else next to foreman.yaml, else repo root. */
export function resolveRulesPath(config: ForemanConfig): string {
  if (config.rules.path) return path.resolve(config.rules.path);
  const cfg = findConfigPath();
  const base = cfg ? path.dirname(cfg) : process.cwd();
  return path.join(base, 'rules.yaml');
}

export interface GateLaunch {
  settingsJson: string;
  env: Record<string, string>;
}

export function buildGateLaunch(opts: {
  config: ForemanConfig;
  jobId: string;
  worktree: string;
  auditPath: string;
  apiBase: string;
  token: string;
}): GateLaunch {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: `node ${GATE_PATH}` }],
        },
      ],
    },
  };
  return {
    settingsJson: JSON.stringify(settings),
    env: {
      FOREMAN_RULES: resolveRulesPath(opts.config),
      FOREMAN_WORKTREE: opts.worktree,
      FOREMAN_JOB_ID: opts.jobId,
      FOREMAN_AUDIT: opts.auditPath,
      FOREMAN_API: opts.apiBase,
      FOREMAN_TOKEN: opts.token,
    },
  };
}

/** True if the gate executable is present (doctor uses this). */
export function gateInstalled(): boolean {
  return fs.existsSync(GATE_PATH);
}
