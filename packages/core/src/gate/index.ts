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
const FOREMAN_BIN = path.resolve(here, '../../bin/foreman.ts');

/** Resolve the tsx binary used to run FOREMAN's MCP server in-session. */
function tsxPath(): string | null {
  const root = path.resolve(here, '../../../../');
  for (const p of [
    path.join(root, 'node_modules', '.bin', 'tsx'),
    path.join(root, 'packages', 'core', 'node_modules', '.bin', 'tsx'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Build the `--mcp-config` JSON that exposes FOREMAN's MCP server (ask_director,
 * request_human_approval) back INTO the Coder session (PRD FR2/FR4). The env it carries lets
 * request_human_approval raise a real escalation against this job and ask_director reach the
 * live Director. Returns null if tsx isn't available (the session simply runs without it).
 */
export function buildMcpConfig(opts: {
  jobId: string;
  apiBase: string;
  token: string;
  escTimeoutMs: number;
}): string | null {
  const tsx = tsxPath();
  if (!tsx) return null;
  const cfg = findConfigPath();
  return JSON.stringify({
    mcpServers: {
      foreman: {
        command: tsx,
        args: [FOREMAN_BIN, 'mcp-server'],
        env: {
          ...(cfg ? { FOREMAN_CONFIG: cfg } : {}),
          FOREMAN_JOB_ID: opts.jobId,
          FOREMAN_API: opts.apiBase,
          FOREMAN_TOKEN: opts.token,
          FOREMAN_ESC_TIMEOUT_MS: String(opts.escTimeoutMs),
        },
      },
    },
  });
}

/** Directory holding the rules files (next to foreman.yaml, else cwd). */
function rulesDir(config: ForemanConfig): string {
  if (config.rules.path) return path.dirname(path.resolve(config.rules.path));
  const cfg = findConfigPath();
  return cfg ? path.dirname(cfg) : process.cwd();
}

/**
 * Resolve the rules file for a job's policy profile (M5). `standard` uses rules.yaml; other
 * profiles use rules.<profile>.yaml if present, falling back to rules.yaml.
 */
export function resolveRulesPath(config: ForemanConfig, profile?: string): string {
  if (config.rules.path && (!profile || profile === 'standard')) return path.resolve(config.rules.path);
  const dir = rulesDir(config);
  if (profile && profile !== 'standard') {
    const profilePath = path.join(dir, `rules.${profile}.yaml`);
    if (fs.existsSync(profilePath)) return profilePath;
  }
  return path.join(dir, 'rules.yaml');
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
  profile?: string;
}): GateLaunch {
  const escTimeoutMs = opts.config.loop.escalation_timeout_ms;
  // The hook must be allowed to run for at least the whole hold, plus a buffer, or Claude
  // cancels it mid-escalation. (Default hook timeout is only 600s.)
  const hookTimeoutSec = Math.ceil(escTimeoutMs / 1000) + 60;
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: `node ${GATE_PATH}`, timeout: hookTimeoutSec }],
        },
      ],
    },
  };
  return {
    settingsJson: JSON.stringify(settings),
    env: {
      FOREMAN_RULES: resolveRulesPath(opts.config, opts.profile),
      FOREMAN_PROFILE: opts.profile ?? 'standard',
      FOREMAN_WORKTREE: opts.worktree,
      FOREMAN_JOB_ID: opts.jobId,
      FOREMAN_AUDIT: opts.auditPath,
      FOREMAN_API: opts.apiBase,
      FOREMAN_TOKEN: opts.token,
      FOREMAN_ESC_TIMEOUT_MS: String(escTimeoutMs),
    },
  };
}

/** True if the gate executable is present (doctor uses this). */
export function gateInstalled(): boolean {
  return fs.existsSync(GATE_PATH);
}
