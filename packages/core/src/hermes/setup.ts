import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { FOREMAN_HOME } from '../paths.js';
import { findConfigPath } from '../config/index.js';
import { requireSecret, setSecret, optionalSecret, isKeychainAvailable } from '../secrets/index.js';
import { randomToken } from '../provision/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('hermes-setup');

/**
 * Optional, non-destructive setup of an isolated Hermes Agent (NousResearch/hermes-agent) to
 * power FOREMAN's chat panel. Everything lives under ~/.foreman/hermes with its own port and
 * key, so it never touches a pre-existing `~/.hermes` install. Opt-in only.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FOREMAN_BIN = path.resolve(here, '../../bin/foreman.ts'); // packages/core/bin/foreman.ts

export const HERMES_DIR = path.join(FOREMAN_HOME, 'hermes');
export const HERMES_HOME = path.join(HERMES_DIR, 'home');
const PID_FILE = path.join(HERMES_DIR, 'gateway.pid');
const LOG_FILE = path.join(HERMES_DIR, 'gateway.log');
const META_FILE = path.join(HERMES_DIR, 'foreman-hermes.json');

export const HERMES_INSTALL_URL = 'https://hermes-agent.nousresearch.com/install.sh';

// Hermes talks to Gemini directly (provider: gemini), so this must be a real Gemini model id
// — the same one the Router uses. Cheap + fast; bump to gemini-3.5-flash for a smarter chat.
export const DEFAULT_HERMES_MODEL = 'gemini-3.1-flash-lite';

export interface HermesMeta {
  home: string;
  port: number;
  model: string;
  baseUrl: string;
}

/** Path to the `hermes` binary, or null if not installed. */
export function hermesBin(): string | null {
  const r = spawnSync('hermes', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'hermes' : null;
}

/** Run the official Hermes installer (curl | bash). Caller must obtain consent first. */
export function installHermes(): boolean {
  log.info('installing Hermes Agent via the official installer…');
  const r = spawnSync('bash', ['-c', `curl -fsSL ${HERMES_INSTALL_URL} | bash`], { stdio: 'inherit' });
  return r.status === 0;
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** First free port in [start, end] that isn't the Hermes default 8642. */
export async function findFreePort(start = 8650, end = 8700): Promise<number> {
  for (let p = start; p <= end; p++) {
    if (p === 8642) continue;
    if (await checkPortFree(p)) return p;
  }
  throw new Error(`no free port in ${start}-${end}`);
}

function hermesEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HERMES_HOME };
}

export function readMeta(): HermesMeta | null {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) as HermesMeta;
  } catch {
    return null;
  }
}

export interface SetupOptions {
  port?: number;
  model?: string;
  registerMcp?: boolean;
  enableInConfig?: boolean;
}

export interface SetupResult extends HermesMeta {
  storedKeyTo: 'keychain' | 'env';
  mcpRegistered: boolean;
  configUpdated: boolean;
  notes: string[];
}

/** Provision the isolated Hermes home: env, model, key, optional MCP registration + config. */
export async function setupHermes(opts: SetupOptions = {}): Promise<SetupResult> {
  if (!hermesBin()) {
    throw new Error(
      `Hermes is not installed. Install it first:\n  curl -fsSL ${HERMES_INSTALL_URL} | bash\nor run \`foreman hermes setup --install\`.`,
    );
  }
  const notes: string[] = [];
  fs.mkdirSync(HERMES_HOME, { recursive: true });

  const port = opts.port ?? (await findFreePort());
  const model = opts.model ?? DEFAULT_HERMES_MODEL;
  const baseUrl = `http://localhost:${port}`;
  const gemini = requireSecret('GEMINI_API_KEY'); // reuse FOREMAN's provisioned key
  const apiServerKey = optionalSecret('HERMES_API_KEY') ?? randomToken();

  // 1. Isolated home .env — Gemini provider + the API server on our private port.
  fs.writeFileSync(
    path.join(HERMES_HOME, '.env'),
    [
      `GEMINI_API_KEY=${gemini}`,
      `API_SERVER_KEY=${apiServerKey}`,
      `API_SERVER_PORT=${port}`,
      `API_SERVER_HOST=127.0.0.1`,
      `API_SERVER_ENABLED=true`,
      '',
    ].join('\n'),
  );

  // 2. Default model → Gemini (config.yaml in the isolated home).
  spawnSync('hermes', ['config', 'set', 'model.default', model], { env: hermesEnv(), encoding: 'utf8' });
  spawnSync('hermes', ['config', 'set', 'model.provider', 'gemini'], { env: hermesEnv(), encoding: 'utf8' });

  // 3. Store the API server key as FOREMAN's HERMES_API_KEY so the bridge can authenticate.
  const storedKeyTo: 'keychain' | 'env' = isKeychainAvailable() ? 'keychain' : 'env';
  if (storedKeyTo === 'keychain') setSecret('HERMES_API_KEY', apiServerKey);
  else notes.push(`Add to your .env: HERMES_API_KEY=${apiServerKey}`);

  // 4. Optional: register FOREMAN's MCP server inside this Hermes (Hermes → FOREMAN control).
  let mcpRegistered = false;
  if (opts.registerMcp) mcpRegistered = registerForemanMcp();

  // 5. Optional: point foreman.yaml at this managed instance + flip it on (comments preserved).
  let configUpdated = false;
  if (opts.enableInConfig) {
    configUpdated = setHermesConfig({ enabled: true, baseUrl, apiKeyEnv: 'HERMES_API_KEY' });
  }

  const meta: HermesMeta = { home: HERMES_HOME, port, model, baseUrl };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  return { ...meta, storedKeyTo, mcpRegistered, configUpdated, notes };
}

/** Resolve the tsx binary used to run FOREMAN's MCP server. */
function tsxPath(): string | null {
  const root = path.resolve(here, '../../../../'); // repo root
  for (const p of [
    path.join(root, 'node_modules', '.bin', 'tsx'),
    path.join(root, 'packages', 'core', 'node_modules', '.bin', 'tsx'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** `hermes mcp add foreman …` so a Hermes conversation can dispatch/redirect/query FOREMAN. */
export function registerForemanMcp(): boolean {
  const tsx = tsxPath();
  if (!tsx) {
    log.warn('tsx not found — skipping MCP registration (run `pnpm install`)');
    return false;
  }
  const configPath = findConfigPath() ?? path.join(process.cwd(), 'foreman.yaml');
  const r = spawnSync(
    'hermes',
    ['mcp', 'add', 'foreman', '--command', tsx, '--env', `FOREMAN_CONFIG=${configPath}`, '--args', FOREMAN_BIN, 'mcp-server'],
    { env: hermesEnv(), input: 'y\ny\n', encoding: 'utf8' },
  );
  return r.status === 0;
}

/** Patch the hermes block in the resolved foreman.yaml, preserving comments + formatting. */
export function setHermesConfig(patch: {
  enabled?: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
}): boolean {
  const configPath = findConfigPath();
  if (!configPath) return false;
  const doc = YAML.parseDocument(fs.readFileSync(configPath, 'utf8'));
  if (patch.enabled !== undefined) doc.setIn(['hermes', 'enabled'], patch.enabled);
  if (patch.baseUrl !== undefined) doc.setIn(['hermes', 'base_url'], patch.baseUrl);
  if (patch.apiKeyEnv !== undefined) doc.setIn(['hermes', 'api_key_env'], patch.apiKeyEnv);
  fs.writeFileSync(configPath, doc.toString());
  return true;
}

/** Point the active Hermes at the managed isolated instance (must be set up first). */
export function selectManaged(): { ok: boolean; error?: string; baseUrl?: string } {
  const meta = readMeta();
  if (!meta) return { ok: false, error: 'Managed Hermes is not set up yet — run setup first.' };
  const ok = setHermesConfig({ enabled: true, baseUrl: meta.baseUrl, apiKeyEnv: 'HERMES_API_KEY' });
  return ok ? { ok: true, baseUrl: meta.baseUrl } : { ok: false, error: 'could not write foreman.yaml' };
}

/** Point the active Hermes at a remote endpoint (advanced). Stores the key as HERMES_REMOTE_KEY. */
export function selectRemote(opts: { baseUrl: string; apiKey?: string }): {
  ok: boolean;
  error?: string;
  storedKeyTo?: 'keychain' | 'env';
  note?: string;
} {
  const baseUrl = (opts.baseUrl ?? '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'Base URL must start with http:// or https://' };
  let storedKeyTo: 'keychain' | 'env' | undefined;
  let note: string | undefined;
  const key = opts.apiKey?.trim();
  if (key) {
    if (isKeychainAvailable()) {
      setSecret('HERMES_REMOTE_KEY', key);
      storedKeyTo = 'keychain';
    } else {
      storedKeyTo = 'env';
      note = `Add to your .env: HERMES_REMOTE_KEY=${key}`;
    }
  }
  const ok = setHermesConfig({ enabled: true, baseUrl, apiKeyEnv: 'HERMES_REMOTE_KEY' });
  return ok
    ? { ok: true, ...(storedKeyTo ? { storedKeyTo } : {}), ...(note ? { note } : {}) }
    : { ok: false, error: 'could not write foreman.yaml' };
}

/** Turn the chat bridge off (foreman.yaml hermes.enabled = false). */
export function disableHermes(): boolean {
  return setHermesConfig({ enabled: false });
}

/**
 * Change the managed instance's default model (a real Gemini id — it calls Gemini directly).
 * Writes the isolated home's config + meta. A running gateway must be restarted to pick it up
 * (the caller handles that, since restart needs a beat for the port to free).
 */
export function setHermesModel(model: string): { ok: boolean; error?: string; model?: string } {
  const m = (model ?? '').trim();
  if (!m) return { ok: false, error: 'model required' };
  const meta = readMeta();
  if (!meta) return { ok: false, error: 'Managed Hermes is not set up yet.' };
  const r = spawnSync('hermes', ['config', 'set', 'model.default', m], { env: hermesEnv(), encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'hermes config set failed').trim() };
  spawnSync('hermes', ['config', 'set', 'model.provider', 'gemini'], { env: hermesEnv(), encoding: 'utf8' });
  fs.writeFileSync(META_FILE, JSON.stringify({ ...meta, model: m }, null, 2));
  return { ok: true, model: m };
}

// ── async install (so the dashboard can kick it off without blocking) ──────────
const INSTALL_LOG = path.join(HERMES_DIR, 'install.log');
let installing = false;
let lastInstallError: string | null = null;

export function installState(): { installing: boolean; installed: boolean; error: string | null } {
  return { installing, installed: !!hermesBin(), error: lastInstallError };
}

/** Run the official installer in the background (curl | bash). Returns immediately. */
export function installHermesAsync(): { started: boolean; alreadyInstalled: boolean } {
  if (hermesBin()) return { started: false, alreadyInstalled: true };
  if (installing) return { started: true, alreadyInstalled: false };
  fs.mkdirSync(HERMES_DIR, { recursive: true });
  installing = true;
  lastInstallError = null;
  const out = fs.openSync(INSTALL_LOG, 'a');
  const child = spawn('bash', ['-c', `curl -fsSL ${HERMES_INSTALL_URL} | bash`], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.on('exit', (code) => {
    installing = false;
    if (code !== 0) lastInstallError = `installer exited with code ${code} (see ${INSTALL_LOG})`;
  });
  child.on('error', (e) => {
    installing = false;
    lastInstallError = e.message;
  });
  child.unref();
  return { started: true, alreadyInstalled: false };
}

// ── lifecycle ────────────────────────────────────────────────────────────────
export function startHermes(): { port: number; pid: number } {
  const meta = readMeta();
  if (!meta) throw new Error('Hermes not set up yet — run `foreman hermes setup`.');
  if (isRunning()) return { port: meta.port, pid: Number(fs.readFileSync(PID_FILE, 'utf8')) };
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn('hermes', ['gateway', 'run'], {
    env: hermesEnv(),
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return { port: meta.port, pid: child.pid ?? -1 };
}

export function stopHermes(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function isRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0); // throws if not alive
    return true;
  } catch {
    return false;
  }
}

export async function reachable(port: number): Promise<boolean> {
  return !(await checkPortFree(port)); // not free ⇒ something is listening
}
