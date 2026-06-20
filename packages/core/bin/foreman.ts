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
import { GCP_PROJECT, hasGcloud, runInit } from '../src/provision/index.js';
import { gateInstalled } from '../src/gate/index.js';
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
  .action(async () => {
    const config = loadConfig();
    await startServer(config);
  });

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Provision the Gemini key, store secrets, and write litellm.config.yaml.')
  .option('--project <id>', 'GCP project to mint the Gemini key in', GCP_PROJECT)
  .action(async (opts: { project: string }) => {
    console.log(`Provisioning FOREMAN in GCP project: ${opts.project}\n`);
    const r = await runInit({ project: opts.project });
    console.log(`✓ Gemini API key ${r.geminiKeySource} (stored to ${r.storedTo})`);
    console.log(`✓ Director model: ${r.directorModel}`);
    console.log(`✓ Router model:   ${r.routerModel}`);
    console.log(`✓ Wrote ${r.litellmConfigPath}`);
    for (const n of r.notes) console.log(`  • ${n}`);
    console.log('\nNext:');
    console.log('  1) export GEMINI_API_KEY (or source .env), then start the proxy:');
    console.log('       litellm --config litellm.config.yaml');
    console.log('  2) foreman doctor   # verify everything is reachable');
    console.log('  3) foreman serve    # start the daemon + dashboard');
  });

// ── doctor ──────────────────────────────────────────────────────────────────--
program
  .command('doctor')
  .description('Check that secrets, models, the claude CLI, and the DB are all healthy.')
  .action(async () => {
    let ok = true;
    const config = loadConfig();
    const check = (label: string, pass: boolean, detail = '') => {
      console.log(`${pass ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
      if (!pass) ok = false;
    };

    check('gcloud on PATH', hasGcloud());
    const claudeV = spawnSync(config.coder.command, ['--version'], { encoding: 'utf8' });
    check('claude CLI', claudeV.status === 0, claudeV.stdout?.trim().split('\n')[0] ?? '');
    check('rule gate', !config.rules.enabled || gateInstalled(), config.rules.enabled ? 'enabled' : 'disabled');

    for (const name of [config.dashboard.auth_token_env, config.endpoint.api_key_env, 'GEMINI_API_KEY']) {
      const r = resolveSecret(name);
      check(`secret ${name}`, !!r, r ? `from ${r.source}` : 'missing');
    }

    try {
      ensureSchema();
      check('SQLite writable', true);
    } catch (e) {
      check('SQLite writable', false, (e as Error).message);
    }

    try {
      const models = new ModelClient(config);
      const reachable = await models.ping(config.models.router);
      check('LiteLLM endpoint', reachable, reachable ? config.endpoint.base_url : 'no response (is litellm running?)');
    } catch (e) {
      check('LiteLLM endpoint', false, (e as Error).message);
    }

    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
    process.exit(ok ? 0 : 1);
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
  .description('Print where a secret resolves from (value is masked).')
  .action((name: string) => {
    const r = resolveSecret(name);
    if (!r) {
      console.error(`${name}: not found`);
      process.exit(1);
    }
    console.log(`${name}: set (source: ${r.source}, ${r.value.length} chars)`);
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
