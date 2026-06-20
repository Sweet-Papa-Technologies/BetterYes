import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';

/**
 * Loads foreman.yaml (DESIGN §7 shape) into a typed, validated config object. Secrets are
 * NOT in this file — only the *name* of the env var that holds each one. The resolver in
 * ../secrets reads the actual value.
 */

const ConfigSchema = z.object({
  endpoint: z.object({
    base_url: z.string().default('http://localhost:4000'),
    api_key_env: z.string().default('LITELLM_KEY'),
  }),
  models: z.object({
    director: z.string().default('director'),
    router: z.string().default('router'),
    judge: z.string().optional(),
  }),
  coder: z.object({
    command: z.string().default('claude'),
    max_turns: z.number().int().positive().default(50),
    auth: z.enum(['oauth', 'api_key']).default('oauth'),
    // Headless permission handling. acceptEdits auto-applies file edits (safe default for
    // M1, works in an isolated worktree). bypassPermissions runs everything — pair it with
    // the PreToolUse rule gate (M2). 'default' will stall on tools needing approval.
    permission_mode: z
      .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
      .default('acceptEdits'),
  }),
  concurrency: z.object({
    max_parallel_jobs: z.number().int().positive().default(4),
  }),
  loop: z.object({
    max_iterations: z.number().int().positive().default(40),
    circuit_breaker_repeats: z.number().int().positive().default(3),
    // How long a job holds for a human answer before falling back (PRD FR4, default 30 min).
    escalation_timeout_ms: z.number().int().positive().default(30 * 60 * 1000),
  }),
  rules: z
    .object({
      // When enabled, the Coder runs under bypassPermissions with the PreToolUse gate as the
      // sole arbiter ("auto-approve most, veto some"). Disable to fall back to coder.permission_mode.
      enabled: z.boolean().default(true),
      path: z.string().optional(), // defaults to rules.yaml next to foreman.yaml
    })
    .default({ enabled: true }),
  hermes: z
    .object({
      enabled: z.boolean().default(false),
      base_url: z.string().default('http://localhost:8765'),
      api_key_env: z.string().default('HERMES_API_KEY'),
    })
    .default({ enabled: false, base_url: 'http://localhost:8765', api_key_env: 'HERMES_API_KEY' }),
  dashboard: z.object({
    bind: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(7777),
    auth_token_env: z.string().default('FOREMAN_TOKEN'),
  }),
});

export type ForemanConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_FILES = ['foreman.yaml', 'foreman.yml'];

/** Find foreman.yaml: explicit path, $FOREMAN_CONFIG, cwd-upward, then built-in defaults. */
export function findConfigPath(explicit?: string): string | null {
  if (explicit) return explicit;
  if (process.env.FOREMAN_CONFIG) return process.env.FOREMAN_CONFIG;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const name of DEFAULT_CONFIG_FILES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfig(explicit?: string): ForemanConfig {
  const configPath = findConfigPath(explicit);
  let raw: unknown = {};
  if (configPath) {
    raw = YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {};
  }
  // zod fills every default, so a missing file still yields a usable config.
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid foreman.yaml${configPath ? ` (${configPath})` : ''}:\n${issues}`);
  }
  return applyEnvOverrides(parsed.data);
}

/** A few env overrides so the daemon is configurable in Docker without editing files. */
function applyEnvOverrides(c: ForemanConfig): ForemanConfig {
  if (process.env.FOREMAN_ENDPOINT_URL) c.endpoint.base_url = process.env.FOREMAN_ENDPOINT_URL;
  if (process.env.FOREMAN_BIND) c.dashboard.bind = process.env.FOREMAN_BIND;
  if (process.env.FOREMAN_PORT) c.dashboard.port = Number(process.env.FOREMAN_PORT);
  return c;
}

/** Expand a leading ~ in a path. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Expand the shorthands a user might type for a repo path: `~`, `~/...`, `$VAR` / `${VAR}`,
 * and relative paths (resolved against home for predictability). Returns an absolute path.
 */
export function expandPath(p: string): string {
  let s = (p ?? '').trim();
  if (!s) return s;
  s = s
    .replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => process.env[n] ?? '');
  s = expandHome(s);
  if (!path.isAbsolute(s)) s = path.join(os.homedir(), s);
  return path.resolve(s);
}
