#!/usr/bin/env -S npx tsx
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import type { JobEvent } from '@foreman/shared';
import { TERMINAL_STATES } from '@foreman/shared';
import { loadConfig } from '../src/config/index.js';
import {
  resolveSecret,
  setSecret,
  optionalSecret,
  deleteSecret,
  isKeychainAvailable,
} from '../src/secrets/index.js';
import { startServer } from '../src/api/index.js';
import { runMcpServer } from '../src/mcp-server/index.js';
import { hasGcloud, runInit } from '../src/provision/index.js';
import { gateInstalled } from '../src/gate/index.js';
import { runSmoke } from '../src/smoke/index.js';
import {
  hermesBin,
  installHermes,
  setupHermes,
  startHermes,
  stopHermes,
  isRunning,
  reachable,
  readMeta,
  setHermesModel,
  DEFAULT_HERMES_MODEL,
  HERMES_INSTALL_URL,
} from '../src/hermes/setup.js';
import { ModelClient } from '../src/models/index.js';
import { createJob, getJob, listJobs, ensureSchema } from '../src/db/index.js';
import { jobManager } from '../src/orchestrator/index.js';
import { bus } from '../src/bus.js';

const program = new Command();
program.name('foreman').description('FOREMAN — mission control for AI coding jobs').version('0.1.0');

// ── serve ─────────────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the FOREMAN daemon (REST + WebSocket API + dashboard).')
  .option('--with-hermes', 'also start the managed isolated Hermes gateway (see `foreman hermes setup`)')
  .action(async (opts: { withHermes?: boolean }) => {
    const config = loadConfig();

    if (opts.withHermes) {
      if (!readMeta()) {
        console.error('--with-hermes: no managed Hermes found. Run `foreman hermes setup` first.');
        process.exit(1);
      }
      if (isRunning()) {
        console.log('Managed Hermes gateway already running.');
      } else {
        const { port, pid } = startHermes();
        console.log(`Started managed Hermes gateway (pid ${pid}, port ${port}).`);
        // Tie its lifecycle to the daemon — stop it when we exit.
        const shutdown = () => {
          stopHermes();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      }
      if (!config.hermes.enabled) {
        console.warn('Note: hermes.enabled is false in foreman.yaml — the chat panel won\'t use it until you enable it.');
      }
    }

    await startServer(config);
  });

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Provision the Gemini key, store secrets, and write litellm.config.yaml.')
  .option('--project <id>', 'GCP project to mint the Gemini key in (default: gcloud active project)')
  .option('--gemini-key <key>', 'use a Gemini API key directly (https://aistudio.google.com/apikey) — skips gcloud')
  .action(async (opts: { project?: string; geminiKey?: string }) => {
    let geminiKey = opts.geminiKey;
    // No key + no gcloud → offer the free, no-billing AI Studio path interactively.
    if (!geminiKey && !opts.project && !hasGcloud()) {
      console.log('gcloud not found — no problem. You can paste a free Gemini API key instead.');
      console.log('Get one (no GCP project or billing needed): https://aistudio.google.com/apikey\n');
      geminiKey = (await prompt('Paste your Gemini API key (or Ctrl-C to cancel): ')).trim();
      if (!geminiKey) {
        console.error('No key provided. Re-run with --gemini-key <KEY> or install gcloud.');
        process.exit(1);
      }
    }
    console.log(
      geminiKey ? '\nProvisioning FOREMAN with the provided Gemini key…\n' : '\nProvisioning FOREMAN via gcloud…\n',
    );
    const r = await runInit({ ...(geminiKey ? { geminiKey } : {}), ...(opts.project ? { project: opts.project } : {}) });
    console.log(`✓ Gemini API key ${r.geminiKeySource} (stored to ${r.storedTo})`);
    if (r.envPath) console.log(`✓ Secrets written to ${r.envPath} (chmod 600 — not printed)`);
    console.log(`✓ Director model: ${r.directorModel}`);
    console.log(`✓ Router model:   ${r.routerModel}`);
    console.log(`✓ Wrote ${r.litellmConfigPath}`);
    for (const n of r.notes) console.log(`  • ${n}`);
    // Opt-in offer: set up an isolated Hermes Agent for the chat panel.
    if (hermesBin() && !readMeta()) {
      const ans = (await prompt('\nSet up an isolated Hermes Agent for the chat panel? (own home + port, never touches ~/.hermes) [y/N] ')).toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        const h = await setupHermes({ registerMcp: true, enableInConfig: true });
        console.log(`✓ Hermes ready on ${h.baseUrl} (home ${h.home}); start it with: foreman hermes start`);
      }
    } else if (!hermesBin()) {
      console.log(`\nTip: install Hermes for the chat panel — \`foreman hermes setup --install\` (or ${HERMES_INSTALL_URL}).`);
    }

    console.log('\nNext:');
    console.log("  1) Install the LiteLLM proxy if you haven't:  pip install 'litellm[proxy]'");
    if (r.storedTo === 'keychain') {
      console.log('  2) Load secrets + start the proxy:');
      console.log('       export GEMINI_API_KEY=$(pnpm -s foreman secret get GEMINI_API_KEY --raw)');
      console.log('       export LITELLM_KEY=$(pnpm -s foreman secret get LITELLM_KEY --raw)');
      console.log('       litellm --config litellm.config.yaml --port 4000');
    } else {
      console.log('  2) Load .env + start the proxy:');
      console.log('       bash/zsh:    set -a && source .env && set +a');
      console.log('       PowerShell:  Get-Content .env | %% { $kv=$_ -split "=",2; if($kv[0]){[Environment]::SetEnvironmentVariable($kv[0],$kv[1])} }');
      console.log('       litellm --config litellm.config.yaml --port 4000');
    }
    console.log('  3) foreman doctor   # verify everything is reachable');
    console.log('  4) foreman serve    # start the daemon + dashboard');
  });

// ── doctor ──────────────────────────────────────────────────────────────────--
program
  .command('doctor')
  .description('Preflight: check every prerequisite (claude, LiteLLM, secrets, models, DB) with fixes.')
  .action(async () => {
    let ok = true;
    const config = loadConfig();
    // `soft` checks inform but don't fail the run; `fix` prints a copy-paste remedy on failure.
    const check = (label: string, pass: boolean, opts: { detail?: string; fix?: string; soft?: boolean } = {}) => {
      console.log(`${pass ? '✓' : opts.soft ? '·' : '✗'} ${label}${opts.detail ? `  — ${opts.detail}` : ''}`);
      if (!pass) {
        if (opts.fix) console.log(`    ↳ ${opts.fix}`);
        if (!opts.soft) ok = false;
      }
    };

    // 1. Claude Code (the Coder) — required.
    const claudeV = spawnSync(config.coder.command, ['--version'], { encoding: 'utf8' });
    check('claude CLI installed', claudeV.status === 0, {
      detail: claudeV.stdout?.trim().split('\n')[0] ?? '',
      fix: 'install Claude Code (https://claude.com/claude-code), then run `claude` once to log in',
    });

    // 2. LiteLLM proxy package — the #1 missed prerequisite.
    const litellmV = spawnSync('litellm', ['--version'], { encoding: 'utf8' });
    check('LiteLLM installed', litellmV.status === 0, {
      detail: (litellmV.stdout || litellmV.stderr || '').trim().split('\n')[0],
      fix: "pip install 'litellm[proxy]'   (needs Python 3.9+)",
    });

    // 3. gcloud — only needed if you provision via GCP (the AI Studio key path skips it).
    check('gcloud on PATH', hasGcloud(), {
      soft: true,
      detail: hasGcloud() ? '' : 'optional — or use `foreman init --gemini-key <KEY>`',
    });

    check('rule gate', !config.rules.enabled || gateInstalled(), { detail: config.rules.enabled ? 'enabled' : 'disabled' });

    for (const name of [config.dashboard.auth_token_env, config.endpoint.api_key_env, 'GEMINI_API_KEY']) {
      const r = resolveSecret(name);
      check(`secret ${name}`, !!r, {
        detail: r ? `from ${r.source}` : 'missing',
        fix: `run \`foreman init\` (or set ${name} in .env / Keychain)`,
      });
    }

    try {
      ensureSchema();
      check('SQLite writable', true);
    } catch (e) {
      check('SQLite writable', false, { detail: (e as Error).message });
    }

    try {
      const models = new ModelClient(config);
      const reachable = await models.ping(config.models.router);
      check('LiteLLM endpoint', reachable, {
        detail: reachable ? config.endpoint.base_url : 'no response',
        fix: 'start it:  litellm --config litellm.config.yaml --port 4000   (with GEMINI_API_KEY + LITELLM_KEY in env)',
      });
    } catch (e) {
      check('LiteLLM endpoint', false, { detail: (e as Error).message, fix: 'start the LiteLLM proxy (see `foreman init` output)' });
    }

    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
    process.exit(ok ? 0 : 1);
  });

// ── smoke ──────────────────────────────────────────────────────────────────--
program
  .command('smoke')
  .description('Prove the install works: the rule gate denies a planted forbidden write, and a trivial job runs end-to-end.')
  .option('--no-full', 'skip the end-to-end job (only check the gate; no LiteLLM/claude needed)')
  .action(async (opts: { full: boolean }) => {
    const config = loadConfig();
    console.log('Running FOREMAN smoke test…\n');
    const r = await runSmoke(config, { full: opts.full });
    for (const d of r.details) console.log(`  • ${d}`);
    const line = (label: string, ok: boolean | null) =>
      console.log(`${ok === null ? '·' : ok ? '✓' : '✗'} ${label}`);
    console.log('');
    line('rule gate denies forbidden write', r.gateDeny);
    line('rule gate allows normal write', r.gateAllow);
    if (opts.full) line('trivial job runs end-to-end', r.jobOk);
    const pass = r.gateDeny && r.gateAllow && (!opts.full || r.jobOk === true);
    console.log(pass ? '\nSmoke test PASSED.' : '\nSmoke test FAILED.');
    process.exit(pass ? 0 : 1);
  });

// ── secret ──────────────────────────────────────────────────────────────────--
const secret = program.command('secret').description('Manage secrets (macOS Keychain / .env).');
secret
  .command('set <name> [value]')
  .description('Store a secret in the Keychain (prompts if value omitted).')
  .action(async (name: string, value?: string) => {
    if (!isKeychainAvailable()) {
      console.error(`Keychain is macOS-only. Add ${name}=… to your .env instead.`);
      process.exit(1);
    }
    const val = value ?? (await prompt(`Value for ${name}: `));
    const where = setSecret(name, val);
    console.log(where === 'keychain' ? `✓ stored ${name} in Keychain` : `add ${name} to .env`);
  });
secret
  .command('get <name>')
  .description('Show where a secret resolves from (masked); --raw prints just the value.')
  .option('--raw', 'print only the value (for `export FOO=$(foreman secret get FOO --raw)`)')
  .action((name: string, opts: { raw?: boolean }) => {
    const r = resolveSecret(name);
    if (!r) {
      console.error(`${name}: not found`);
      process.exit(1);
    }
    if (opts.raw) process.stdout.write(r.value); // value only, no newline — safe to pipe
    else console.log(`${name}: set (source: ${r.source}, ${r.value.length} chars)`);
  });
secret
  .command('list')
  .description('Show which known secrets are resolvable.')
  .action(() => {
    for (const name of ['FOREMAN_TOKEN', 'LITELLM_KEY', 'GEMINI_API_KEY', 'HERMES_API_KEY']) {
      const r = resolveSecret(name);
      console.log(`${r ? '✓' : '·'} ${name}${r ? `  (${r.source})` : ''}`);
    }
  });
secret
  .command('delete <name>')
  .description('Remove a secret from the Keychain.')
  .action((name: string) => {
    console.log(deleteSecret(name) ? `✓ removed ${name}` : `${name}: not in Keychain`);
  });

// ── job (CLI launch path, for verification) ───────────────────────────────────
const job = program.command('job').description('Create and inspect jobs from the terminal.');
job
  .command('run')
  .description('Create a job and run it to completion, streaming events to the terminal.')
  .requiredOption('--repo <path>', 'git repo to work in')
  .requiredOption('--brief <text>', 'what the job should do')
  .option('--name <name>', 'job name', 'CLI job')
  .action(async (opts: { repo: string; brief: string; name: string }) => {
    const config = loadConfig();
    jobManager.init(config);
    const j = createJob({
      name: opts.name,
      brief: opts.brief,
      repoPath: opts.repo,
      directorModel: config.models.director,
      routerModel: config.models.router,
      maxTurns: config.coder.max_turns,
    });
    console.log(`Started ${j.id} — ${j.name}\n`);
    bus.onEvent(j.id, (e: JobEvent) => {
      const tag = (e.level ?? e.type).toUpperCase().padEnd(6);
      console.log(`[${tag}] ${e.message}`);
    });
    jobManager.start(j);
    // Poll until terminal.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const cur = getJob(j.id);
        if (cur && (TERMINAL_STATES as readonly string[]).includes(cur.state)) {
          clearInterval(t);
          console.log(`\n${cur.id} → ${cur.state}  (${cur.turns} turns, ${cur.filesTouched} files, $${cur.costUsd.toFixed(4)})`);
          resolve();
        }
      }, 500);
    });
    process.exit(0);
  });
job
  .command('list')
  .description('List all jobs.')
  .action(() => {
    for (const j of listJobs()) {
      console.log(`${j.id.padEnd(10)} ${j.state.padEnd(9)} ${j.name}`);
    }
  });

// ── hermes (optional, isolated) ───────────────────────────────────────────────
const hermes = program
  .command('hermes')
  .description('Optional isolated Hermes Agent for the chat panel (own home + port).');

hermes
  .command('setup')
  .description('Set up an isolated Hermes Agent under ~/.foreman/hermes — never touches ~/.hermes.')
  .option('--install', 'install Hermes first if it is missing (runs the official installer)')
  .option('--port <n>', 'API server port (default: first free port from 8650)', (v) => parseInt(v, 10))
  .option('--model <m>', 'default Gemini model for Hermes', DEFAULT_HERMES_MODEL)
  .option('--no-register-mcp', 'do not register FOREMAN as an MCP server inside Hermes')
  .option('--no-enable', 'do not enable hermes in foreman.yaml')
  .option('--start', 'start the Hermes gateway after setup')
  .action(async (opts: { install?: boolean; port?: number; model: string; registerMcp: boolean; enable: boolean; start?: boolean }) => {
    if (!hermesBin()) {
      if (!opts.install) {
        console.error(`Hermes is not installed. Re-run with --install, or install it yourself:\n  curl -fsSL ${HERMES_INSTALL_URL} | bash`);
        process.exit(1);
      }
      const ok = (await prompt(`Install Hermes Agent now via the official installer (curl | bash)? [y/N] `)).toLowerCase();
      if (ok !== 'y' && ok !== 'yes') process.exit(1);
      if (!installHermes()) {
        console.error('Hermes install failed.');
        process.exit(1);
      }
    }
    console.log('Setting up an isolated Hermes Agent (own home + port)…\n');
    const r = await setupHermes({
      ...(opts.port ? { port: opts.port } : {}),
      model: opts.model,
      registerMcp: opts.registerMcp,
      enableInConfig: opts.enable,
    });
    console.log(`✓ Home:    ${r.home}`);
    console.log(`✓ Port:    ${r.port}  (${r.baseUrl})`);
    console.log(`✓ Model:   ${r.model} (gemini)`);
    console.log(`✓ Key:     stored to ${r.storedKeyTo} as HERMES_API_KEY`);
    console.log(`✓ MCP:     FOREMAN ${r.mcpRegistered ? 'registered in Hermes (dispatch_job/status/redirect)' : 'not registered'}`);
    console.log(`✓ Config:  ${r.configUpdated ? 'hermes enabled in foreman.yaml' : 'foreman.yaml unchanged'}`);
    for (const n of r.notes) console.log(`  • ${n}`);
    if (opts.start) {
      const { port } = startHermes();
      console.log(`\nStarting Hermes gateway… (port ${port})`);
    } else {
      console.log('\nStart it with:  foreman hermes start');
    }
  });

hermes
  .command('start')
  .description('Start the isolated Hermes gateway in the background.')
  .action(() => {
    const { port, pid } = startHermes();
    console.log(`Hermes gateway started (pid ${pid}, port ${port}). Logs: ~/.foreman/hermes/gateway.log`);
  });

hermes
  .command('stop')
  .description('Stop the isolated Hermes gateway.')
  .action(() => console.log(stopHermes() ? 'Hermes gateway stopped.' : 'Hermes gateway was not running.'));

hermes
  .command('status')
  .description('Show the isolated Hermes status.')
  .action(async () => {
    const meta = readMeta();
    if (!meta) {
      console.log('Hermes is not set up. Run `foreman hermes setup`.');
      return;
    }
    const running = isRunning();
    const live = running && (await reachable(meta.port));
    console.log(`home:      ${meta.home}`);
    console.log(`port:      ${meta.port} (${meta.baseUrl})`);
    console.log(`process:   ${running ? 'running' : 'stopped'}`);
    console.log(`reachable: ${live ? 'yes' : 'no'}`);
    console.log(`model:     ${meta.model}`);
  });

hermes
  .command('model <name>')
  .description('Set the managed Hermes default model (a Gemini id, e.g. gemini-3.1-flash-lite).')
  .action((name: string) => {
    const r = setHermesModel(name);
    if (!r.ok) {
      console.error(r.error);
      process.exit(1);
    }
    if (isRunning()) {
      stopHermes();
      startHermes();
      console.log(`Hermes model → ${r.model} (gateway restarted).`);
    } else {
      console.log(`Hermes model → ${r.model}.`);
    }
  });

// ── mcp-server ──────────────────────────────────────────────────────────────--
program
  .command('mcp-server')
  .description('Run the FOREMAN MCP bridge over stdio (ask_director / request_human_approval).')
  .action(async () => {
    await runMcpServer();
  });

function prompt(q: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.resume();
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(d.toString().trim());
    });
  });
}

// silence unused import in some build configs
void optionalSecret;

program.parseAsync().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
