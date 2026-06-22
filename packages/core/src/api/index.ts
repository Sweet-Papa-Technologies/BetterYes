import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import type { CreateJobRequest, PublicConfig, WsMessage } from '@foreman/shared';
import { type ForemanConfig, expandPath, loadConfig } from '../config/index.js';
import { requireSecret, optionalSecret } from '../secrets/index.js';
import { isGitRepo, mergeWorktree, initRepo } from '../coder/worktree.js';
import {
  appendChatMessage,
  appendEvent,
  createConversation,
  createEscalation,
  createJob,
  deleteConversation,
  getConversation,
  getEscalation,
  getJob,
  listChatMessages,
  listConversations,
  listEscalations,
  listEvents,
  listJobs,
  renameConversation,
  resolveEscalation,
  updateJob,
} from '../db/index.js';
import type { ChatAttachment, ChatMessage } from '@foreman/shared';
import { UPLOADS_DIR } from '../paths.js';
import { readRules, writeRules, writeRulesParsed } from '../rules/store.js';
import { jobManager } from '../orchestrator/index.js';
import { sessionAllow } from '../gate/sessionAllow.js';
import { push } from '../push/index.js';
import { HermesClient } from '../hermes/index.js';
import {
  hermesBin,
  readMeta,
  isRunning as hermesRunning,
  reachable as hermesReachable,
  setupHermes,
  startHermes,
  stopHermes,
  selectManaged,
  selectRemote,
  disableHermes,
  setHermesModel,
  installHermesAsync,
  installState,
  HERMES_INSTALL_URL,
} from '../hermes/setup.js';
import { bus } from '../bus.js';
import { createLogger } from '../logger.js';

const log = createLogger('api');
const VERSION = '0.1.0-beta.1';

/** Locate the built dashboard bundle (PWA build preferred, then SPA), if present. */
function dashboardDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/api -> packages/core -> packages -> repo root
  const root = path.resolve(here, '../../../../');
  for (const mode of ['pwa', 'spa']) {
    const dist = path.join(root, 'frontend', 'dist', mode);
    if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  }
  return null;
}

export async function buildServer(config: ForemanConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: config.dashboard.trust_proxy });
  // Tolerate empty bodies on JSON POSTs. The control routes (pause/resume/kill) carry no
  // body but the dashboard's fetch sets `Content-Type: application/json`; Fastify's default
  // parser rejects that with a 400 before the handler runs. Treat empty as `{}`.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const s = (body as string).trim();
      if (!s) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (e) {
        (e as { statusCode?: number }).statusCode = 400;
        done(e as Error, undefined);
      }
    },
  );
  // Loopback-bound + bearer-auth'd, so reflecting the dev origin is safe and lets
  // `quasar dev` (:9000) talk to the daemon (:7777). In production the SPA is same-origin.
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const token = requireSecret(config.dashboard.auth_token_env);
  // Rebuild the Hermes client from disk on each use so switching instance/remote from the
  // dashboard takes effect immediately — no daemon restart (the chat panel is low-frequency).
  const freshHermes = (): HermesClient => {
    try {
      return new HermesClient(loadConfig());
    } catch {
      return new HermesClient(config); // fall back to boot config if the file is mid-edit
    }
  };

  // ── Bearer auth (REST + WS). Loopback-only bind is set at listen() (NFR). ──
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/health') return;
    // Allow static dashboard assets through; the API routes below are what carry data.
    if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) return;
    const provided = extractToken(req);
    if (provided !== token) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true, version: VERSION }));

  // ── Config (public subset) ────────────────────────────────────────────────
  app.get('/api/config', async (): Promise<PublicConfig> => ({
    models: { director: config.models.director, router: config.models.router },
    endpoint: { baseUrl: config.endpoint.base_url },
    concurrency: { maxParallelJobs: config.concurrency.max_parallel_jobs },
    coder: { command: config.coder.command, maxTurns: config.coder.max_turns },
    dashboard: { bind: config.dashboard.bind, port: config.dashboard.port },
    hermes: { enabled: config.hermes.enabled },
    escalationTimeoutMs: config.loop.escalation_timeout_ms,
    version: VERSION,
  }));

  // ── Jobs ──────────────────────────────────────────────────────────────────
  app.get('/api/jobs', async () => listJobs());

  app.get('/api/jobs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job, events: listEvents(id) };
  });

  app.post('/api/jobs', async (req, reply) => {
    const body = req.body as CreateJobRequest;
    if (!body?.name || !body?.brief || !body?.repoPath) {
      return reply.code(400).send({ error: 'name, brief, and repoPath are required' });
    }
    // Expand ~ / $VARS / relative, then validate it's a git repo before launching.
    const repoPath = expandPath(body.repoPath);
    if (!body.initRepo && !fs.existsSync(repoPath)) {
      return reply.code(400).send({ error: `Path not found: ${repoPath}` });
    }
    if (!isGitRepo(repoPath)) {
      // Initialize it on the operator's say-so (a new/empty folder is fine — FOREMAN commits it).
      if (body.initRepo) {
        const r = initRepo(repoPath);
        if (!r.ok) return reply.code(400).send({ error: `Could not init git repo: ${r.error}` });
      } else {
        return reply.code(400).send({ error: `Not a git repo: ${repoPath} (enable "initialize git repo", or run \`git init\` there)` });
      }
    }
    const job = createJob({
      ...body,
      repoPath,
      directorModel: body.directorModel ?? config.models.director,
      routerModel: body.routerModel ?? config.models.router,
      maxTurns: config.coder.max_turns,
    });
    jobManager.start(job);
    return reply.code(201).send(job);
  });

  // ── Server-side folder browser for the New Job picker ──────────────────────
  // The dashboard browses the DAEMON's filesystem (that's where jobs run). Dir names only.
  app.get('/api/fs/list', async (req, reply) => {
    const raw = (req.query as { path?: string }).path || '~';
    let dir: string;
    try {
      dir = expandPath(raw);
    } catch {
      return reply.code(400).send({ error: 'invalid path' });
    }
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => {
          const full = path.join(dir, d.name);
          return { name: d.name, path: full, isGitRepo: fs.existsSync(path.join(full, '.git')) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        path: dir,
        parent: path.dirname(dir),
        isGitRepo: fs.existsSync(path.join(dir, '.git')),
        entries,
      };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Create a new folder under `path` (for the folder picker's "New folder").
  app.post('/api/fs/mkdir', async (req, reply) => {
    const b = (req.body as { path?: string; name?: string }) ?? {};
    if (!b.path || !b.name) return reply.code(400).send({ error: 'path and name required' });
    const name = b.name.trim().replace(/[/\\]/g, ''); // single segment only
    if (!name) return reply.code(400).send({ error: 'invalid folder name' });
    try {
      const full = path.join(expandPath(b.path), name);
      fs.mkdirSync(full, { recursive: true });
      return { path: full, isGitRepo: fs.existsSync(path.join(full, '.git')) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // `git init` a folder + initial commit so a non-repo folder becomes usable.
  app.post('/api/fs/init-repo', async (req, reply) => {
    const b = (req.body as { path?: string }) ?? {};
    if (!b.path) return reply.code(400).send({ error: 'path required' });
    const dir = expandPath(b.path);
    const r = initRepo(dir);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { path: dir, isGitRepo: true };
  });

  // Controls (PRD U3/U6) ──────────────────────────────────────────────────────
  app.post('/api/jobs/:id/redirect', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { message } = (req.body as { message?: string }) ?? {};
    if (!message) return reply.code(400).send({ error: 'message required' });
    return { ok: jobManager.redirect(id, message) };
  });
  app.post('/api/jobs/:id/pause', async (req) => ({
    ok: jobManager.pause((req.params as { id: string }).id),
  }));
  app.post('/api/jobs/:id/resume', async (req) => ({
    ok: jobManager.resume((req.params as { id: string }).id),
  }));
  app.post('/api/jobs/:id/kill', async (req) => ({
    ok: jobManager.kill((req.params as { id: string }).id),
  }));
  // Re-launch a finished/failed/killed job from scratch, reusing its stored brief (PRD U6).
  // Fresh Director plan (sessionId cleared); existing worktree is reused if still present.
  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getJob(id)) return reply.code(404).send({ error: 'not found' });
    const result = jobManager.retry(id);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return getJob(id);
  });
  // Reopen a finished job with a follow-up instruction (continues its session/worktree).
  app.post('/api/jobs/:id/followup', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getJob(id)) return reply.code(404).send({ error: 'not found' });
    const { message } = (req.body as { message?: string }) ?? {};
    if (!message?.trim()) return reply.code(400).send({ error: 'message required' });
    const result = jobManager.followUp(id, message);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return getJob(id);
  });
  // Merge the job's worktree branch into the repo's branch + (optionally) clean up (PRD U6).
  app.post('/api/jobs/:id/merge', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (jobManager.isRunning(id)) {
      return reply.code(409).send({ error: 'Job is still running — pause or kill it before merging.' });
    }
    if (!job.worktreePath) return reply.code(409).send({ error: 'This job has no worktree to merge.' });
    const body = (req.body as { cleanup?: boolean; commitMessage?: string }) ?? {};
    const result = mergeWorktree({
      repoPath: job.repoPath,
      wtPath: job.worktreePath,
      branch: job.branch,
      cleanup: body.cleanup ?? true,
      ...(body.commitMessage ? { commitMessage: body.commitMessage } : {}),
    });
    if (!result.ok) return reply.code(409).send({ error: result.error, conflict: result.conflict });
    const where = result.nothingToMerge ? 'already up to date' : `merged → ${result.baseBranch}`;
    updateJob(id, {
      lastActivity: `${result.cleanedUp ? 'Merged & cleaned up' : 'Merged'} (${where})`,
      ...(result.cleanedUp ? { worktreePath: null } : {}),
    });
    appendEvent({
      jobId: id,
      type: 'log',
      level: 'info',
      message: `${result.nothingToMerge ? 'No new commits to merge' : `Merged ${job.branch} → ${result.baseBranch}`}${result.cleanedUp ? '; worktree removed' : ''}`,
    });
    return result;
  });

  // ── Gate → core: live audit + escalation records (M2) ──────────────────────
  // Posted by the PreToolUse gate (fire-and-forget) for deny/escalate decisions.
  app.post('/api/jobs/:id/audit', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getJob(id)) return reply.code(404).send({ error: 'not found' });
    const a = req.body as { tool?: string; action?: string; rule?: string; target?: string };
    appendEvent({
      jobId: id,
      type: 'tool',
      level: a.action === 'deny' ? 'error' : 'warn',
      message: `gate ${a.action}: ${a.tool ?? '?'} ${a.target ?? ''} (${a.rule ?? ''})`,
      data: { ...a },
    });
    return { ok: true };
  });

  app.post('/api/jobs/:id/escalations', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const b = req.body as { question?: string; proposedAction?: string; reason?: string; tool?: string };
    // "Always allow for this session": if the operator previously blessed this (job, tool,
    // rule), auto-allow without raising a new hold — the gate sees autoAllowed and proceeds.
    if (b.tool && b.reason && sessionAllow.has(id, b.tool, b.reason)) {
      appendEvent({
        jobId: id,
        type: 'tool',
        level: 'info',
        message: `Auto-allowed (session rule): ${b.tool} ${b.proposedAction ?? ''} (${b.reason})`,
        data: { tool: b.tool, action: 'auto-allow', rule: b.reason, target: b.proposedAction },
      });
      return reply.code(200).send({ autoAllowed: true, decision: 'allow' });
    }
    const esc = createEscalation({
      jobId: id,
      question: b.question ?? 'Approve this action?',
      proposedAction: b.proposedAction ?? null,
      reason: b.reason ?? null,
      tool: b.tool ?? null,
    });
    // The gate is holding the tool call — reflect the hold on the board.
    if (job.state === 'running') updateJob(id, { state: 'blocked', lastActivity: 'Holding for your decision' });
    appendEvent({
      jobId: id,
      type: 'escalation',
      level: 'warn',
      message: `Escalation: ${esc.question}`,
      data: { id: esc.id, proposedAction: esc.proposedAction, reason: esc.reason },
    });
    return reply.code(201).send(esc);
  });

  app.get('/api/escalations/:id', async (req, reply) => {
    const esc = getEscalation((req.params as { id: string }).id);
    if (!esc) return reply.code(404).send({ error: 'not found' });
    return esc;
  });

  app.get('/api/escalations', async (req) => {
    const state = (req.query as { state?: 'open' | 'resolved' | 'timed_out' }).state;
    return listEscalations(state);
  });

  // Operator answers an escalation from the dashboard (PRD FR4 / U4).
  app.post('/api/escalations/:id/resolve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body as { decision?: 'allow' | 'deny'; answer?: string; remember?: boolean }) ?? {};
    const esc = getEscalation(id);
    if (!esc) return reply.code(404).send({ error: 'not found' });
    if (esc.state !== 'open') return reply.code(409).send({ error: `already ${esc.state}` });
    const decision = body.decision === 'deny' ? 'deny' : 'allow';
    const resolved = resolveEscalation(id, decision, body.answer);
    // Remember this for the session so the gate stops re-asking (allow + a gate-tool hold only).
    let remembered = false;
    if (body.remember && decision === 'allow' && esc.tool && esc.reason) {
      sessionAllow.add(esc.jobId, esc.tool, esc.reason);
      remembered = true;
    }
    appendEvent({
      jobId: esc.jobId,
      type: 'escalation',
      level: 'info',
      message: `Resolved: ${decision}${body.answer ? ` — "${body.answer}"` : ''}${remembered ? ' (always allow this session)' : ''}`,
      data: { id, decision, remembered },
    });
    return resolved;
  });

  // ── Chat → Hermes (PRD FR6). SSE stream; falls back client-side when disabled. ──
  app.post('/api/chat', async (req, reply) => {
    const { messages } = (req.body as { messages?: { role: string; content: string }[] }) ?? {};
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sse = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    const hermes = freshHermes();
    if (!hermes.enabled) {
      sse({ type: 'disabled' });
      reply.raw.end();
      return reply;
    }
    try {
      await hermes.streamChat(messages ?? [], { onDelta: (delta) => sse({ type: 'delta', delta }) });
      sse({ type: 'done' });
    } catch (err) {
      sse({ type: 'error', error: (err as Error).message });
    }
    reply.raw.end();
    return reply;
  });

  // ── Persistent chat: conversations + messages (PRD FR6) ─────────────────────
  app.get('/api/conversations', async () => listConversations());
  app.post('/api/conversations', async (req) => {
    const { title } = (req.body as { title?: string }) ?? {};
    return createConversation(title?.trim() || 'New chat');
  });
  app.get('/api/conversations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conversation = getConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    return { conversation, messages: listChatMessages(id) };
  });
  app.patch('/api/conversations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getConversation(id)) return reply.code(404).send({ error: 'not found' });
    const { title } = (req.body as { title?: string }) ?? {};
    if (title?.trim()) renameConversation(id, title.trim());
    return getConversation(id);
  });
  app.delete('/api/conversations/:id', async (req) => {
    deleteConversation((req.params as { id: string }).id);
    return { ok: true };
  });

  // Store an uploaded attachment (base64 JSON — no multipart dep). Capped at 5 MB.
  app.post('/api/uploads', async (req, reply) => {
    const b = (req.body as { conversationId?: string; name?: string; type?: string; dataBase64?: string }) ?? {};
    if (!b.name || !b.dataBase64) return reply.code(400).send({ error: 'name and dataBase64 required' });
    const buf = Buffer.from(b.dataBase64, 'base64');
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'file too large (max 5 MB)' });
    const dir = path.join(UPLOADS_DIR, (b.conversationId || 'misc').replace(/[/\\]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, `${Date.now()}-${b.name.replace(/[/\\]/g, '_')}`);
    fs.writeFileSync(full, buf);
    const att: ChatAttachment = { name: b.name, type: b.type || 'application/octet-stream', size: buf.length, path: full };
    return att;
  });

  // Send a message + stream Hermes's reply (SSE), persisting both ends.
  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conv = getConversation(id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const body = (req.body as { content?: string; attachments?: ChatAttachment[] }) ?? {};
    const content = (body.content ?? '').trim();
    const attachments = body.attachments ?? [];
    if (!content && !attachments.length) return reply.code(400).send({ error: 'empty message' });

    const userMsg = appendChatMessage({ conversationId: id, role: 'user', content, attachments });
    // Auto-title an untouched conversation from its first user message.
    if (conv.title === 'New chat' && listChatMessages(id).filter((m) => m.role === 'user').length === 1) {
      renameConversation(id, (content || attachments[0]?.name || 'New chat').slice(0, 48));
    }

    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sse = (o: unknown) => reply.raw.write(`data: ${JSON.stringify(o)}\n\n`);
    sse({ type: 'user', message: userMsg });

    const hermes = freshHermes();
    if (!hermes.enabled) {
      sse({ type: 'disabled' });
      reply.raw.end();
      return reply;
    }
    const history = listChatMessages(id).map(messageForHermes);
    let acc = '';
    const tools: string[] = [];
    try {
      await hermes.streamChat(history, {
        onDelta: (d) => { acc += d; sse({ type: 'delta', delta: d }); },
        onTool: (name) => { tools.push(name); sse({ type: 'tool', name }); },
      });
      const assistant = appendChatMessage({ conversationId: id, role: 'assistant', content: acc, toolCalls: tools });
      sse({ type: 'done', message: assistant });
    } catch (err) {
      sse({ type: 'error', error: (err as Error).message });
    }
    reply.raw.end();
    return reply;
  });

  // ── Hermes management (set up / start-stop / choose instance / remote) ──────
  // Aggregate status: what's installed, the managed gateway's lifecycle, and which endpoint
  // is currently active (managed vs remote vs off) plus a live health check.
  app.get('/api/hermes', async () => {
    const meta = readMeta();
    const inst = installState();
    const managedRunning = hermesRunning();
    const managedReachable = meta ? await hermesReachable(meta.port) : false;
    const cfg = (() => {
      try {
        return loadConfig().hermes;
      } catch {
        return config.hermes;
      }
    })();
    const source: 'managed' | 'remote' | 'off' = !cfg.enabled
      ? 'off'
      : meta && cfg.base_url.replace(/\/$/, '') === meta.baseUrl.replace(/\/$/, '')
        ? 'managed'
        : 'remote';
    const healthy = cfg.enabled ? await freshHermes().health() : false;
    return {
      installed: inst.installed,
      installing: inst.installing,
      installError: inst.error,
      installUrl: HERMES_INSTALL_URL,
      managed: meta
        ? { setUp: true, running: managedRunning, reachable: managedReachable, baseUrl: meta.baseUrl, port: meta.port, model: meta.model }
        : { setUp: false, running: false, reachable: false },
      active: {
        enabled: cfg.enabled,
        source,
        baseUrl: cfg.base_url,
        apiKeyEnv: cfg.api_key_env,
        hasKey: !!optionalSecret(cfg.api_key_env),
        healthy,
      },
    };
  });

  // Provision the managed isolated instance (own home + port; never touches ~/.hermes).
  app.post('/api/hermes/setup', async (req, reply) => {
    if (!hermesBin()) {
      return reply.code(409).send({ error: 'hermes_not_installed', installUrl: HERMES_INSTALL_URL });
    }
    const b = (req.body as { port?: number; model?: string; start?: boolean }) ?? {};
    try {
      const r = await setupHermes({
        ...(b.port ? { port: b.port } : {}),
        ...(b.model ? { model: b.model } : {}),
        registerMcp: true,
        enableInConfig: true,
      });
      if (b.start !== false) startHermes();
      return r;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // Kick off the official installer in the background (curl | bash). Poll GET /api/hermes.
  app.post('/api/hermes/install', async () => installHermesAsync());

  app.post('/api/hermes/start', async () => {
    try {
      const { port, pid } = startHermes();
      return { ok: true, port, pid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  app.post('/api/hermes/stop', async () => ({ ok: stopHermes() }));

  // Choose which Hermes the chat panel talks to (takes effect immediately).
  app.post('/api/hermes/select', async (req, reply) => {
    const b = (req.body as { source?: 'managed' | 'remote' | 'off'; baseUrl?: string; apiKey?: string }) ?? {};
    if (b.source === 'managed') {
      const r = selectManaged();
      return r.ok ? r : reply.code(409).send(r);
    }
    if (b.source === 'remote') {
      if (!b.baseUrl) return reply.code(400).send({ ok: false, error: 'baseUrl required' });
      const r = selectRemote({ baseUrl: b.baseUrl, ...(b.apiKey ? { apiKey: b.apiKey } : {}) });
      return r.ok ? r : reply.code(400).send(r);
    }
    if (b.source === 'off') return { ok: disableHermes() };
    return reply.code(400).send({ ok: false, error: 'source must be managed | remote | off' });
  });

  // Change the managed instance's model (restarts the gateway so it takes effect).
  app.post('/api/hermes/model', async (req, reply) => {
    const { model } = (req.body as { model?: string }) ?? {};
    const r = setHermesModel(model ?? '');
    if (!r.ok) return reply.code(400).send(r);
    let restarted = false;
    if (hermesRunning()) {
      stopHermes();
      await new Promise((res) => setTimeout(res, 1200)); // let the port free before re-binding
      startHermes();
      restarted = true;
    }
    return { ...r, restarted };
  });

  // ── Web Push (M4) ──────────────────────────────────────────────────────────
  app.get('/api/push/vapid', async () => ({ publicKey: push.vapidPublicKey() }));
  app.post('/api/push/subscribe', async (req, reply) => {
    const sub = req.body as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = (req.body as { endpoint?: string }) ?? {};
    if (endpoint) push.unsubscribe(endpoint);
    return { ok: true };
  });
  // Lets the operator confirm push delivery works ("send test notification").
  app.post('/api/push/test', async () => {
    await push.send({ title: 'FOREMAN', body: 'Test notification — push is working.', url: '/' });
    return { ok: true };
  });

  // ── Rules editor (DESIGN §4; editor UI is M3) ──────────────────────────────
  app.get('/api/rules', async () => {
    const { text, parsed, path: p } = readRules(config);
    return { text, parsed, path: p };
  });
  app.put('/api/rules', async (req, reply) => {
    const body = (req.body as { text?: string; parsed?: unknown }) ?? {};
    const result =
      body.parsed !== undefined
        ? writeRulesParsed(config, body.parsed)
        : typeof body.text === 'string'
          ? writeRules(config, body.text)
          : { ok: false as const, error: 'text or parsed required' };
    if (!result.ok) return reply.code(400).send(result);
    return { ok: true }; // gate reads rules.yaml fresh each call → hot-reloaded
  });

  // ── WebSocket: live job stream ──────────────────────────────────────────────
  app.register(async (scoped) => {
    scoped.get('/ws/jobs/:id/stream', { websocket: true }, (socket, req) => {
      const id = (req.params as { id: string }).id;
      const job = getJob(id);
      if (!job) {
        socket.close();
        return;
      }
      send(socket, { kind: 'snapshot', job, events: listEvents(id) });
      const offEvent = bus.onEvent(id, (e) => send(socket, { kind: 'event', event: e }));
      const offJob = bus.onJob(id, (j) => send(socket, { kind: 'job', job: j }));
      socket.on('close', () => {
        offEvent();
        offJob();
      });
    });

    // Board stream: every job-row change.
    scoped.get('/ws/jobs', { websocket: true }, (socket) => {
      for (const j of listJobs()) send(socket, { kind: 'job', job: j });
      const off = bus.onAnyJob((j) => send(socket, { kind: 'job', job: j }));
      socket.on('close', off);
    });
  });

  // ── Static dashboard (served when built) ────────────────────────────────────
  const dist = dashboardDist();
  if (dist) {
    await app.register(fstatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });
    log.info(`serving dashboard from ${dist}`);
  } else {
    log.info('dashboard bundle not built yet — run `pnpm dev:ui` or `pnpm build`');
  }

  return app;
}

// Inline text-file attachments into the message content sent to Hermes; reference others by name.
const TEXT_TYPE_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh)|application\/.*\+(json|xml))/i;
const TEXT_EXT_RE = /\.(txt|md|markdown|json|ya?ml|csv|js|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|hpp|sh|html|css|scss|toml|ini|cfg|env|sql|vue|log)$/i;
function messageForHermes(m: ChatMessage): { role: string; content: string } {
  let content = m.content;
  for (const a of m.attachments ?? []) {
    const textual = TEXT_TYPE_RE.test(a.type) || TEXT_EXT_RE.test(a.name);
    if (a.path && textual) {
      try {
        content += `\n\n[Attachment: ${a.name}]\n${fs.readFileSync(a.path, 'utf8').slice(0, 20_000)}`;
      } catch {
        content += `\n[Attachment: ${a.name} — unreadable]`;
      }
    } else {
      content += `\n[Attachment: ${a.name} (${a.type}, ${a.size} bytes)]`;
    }
  }
  return { role: m.role, content };
}

function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token'); // WS clients pass ?token= (can't set headers)
}

function send(socket: { send: (d: string) => void }, msg: WsMessage): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* socket closing */
  }
}

export async function startServer(config: ForemanConfig): Promise<FastifyInstance> {
  jobManager.init(config);
  push.init(config);
  const app = await buildServer(config);
  await app.listen({ host: config.dashboard.bind, port: config.dashboard.port });
  log.info(`FOREMAN API on http://${config.dashboard.bind}:${config.dashboard.port}`);
  // Pick up any jobs left in flight by a previous run (PRD FR1).
  jobManager.resumeInterrupted();
  return app;
}
