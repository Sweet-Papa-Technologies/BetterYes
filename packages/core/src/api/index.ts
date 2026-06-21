import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import type { CreateJobRequest, PublicConfig, WsMessage } from '@foreman/shared';
import { type ForemanConfig, expandPath } from '../config/index.js';
import { requireSecret } from '../secrets/index.js';
import { isGitRepo } from '../coder/worktree.js';
import {
  appendEvent,
  createEscalation,
  createJob,
  getEscalation,
  getJob,
  listEscalations,
  listEvents,
  listJobs,
  resolveEscalation,
  updateJob,
} from '../db/index.js';
import { readRules, writeRules, writeRulesParsed } from '../rules/store.js';
import { jobManager } from '../orchestrator/index.js';
import { push } from '../push/index.js';
import { HermesClient } from '../hermes/index.js';
import { bus } from '../bus.js';
import { createLogger } from '../logger.js';

const log = createLogger('api');
const VERSION = '0.1.0';

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
  const app = Fastify({ logger: false });
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
  const hermes = new HermesClient(config);

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
    if (!fs.existsSync(repoPath)) {
      return reply.code(400).send({ error: `Path not found: ${repoPath}` });
    }
    if (!isGitRepo(repoPath)) {
      return reply.code(400).send({ error: `Not a git repo: ${repoPath} (run \`git init\` there first)` });
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
    const b = req.body as { question?: string; proposedAction?: string; reason?: string };
    const esc = createEscalation({
      jobId: id,
      question: b.question ?? 'Approve this action?',
      proposedAction: b.proposedAction ?? null,
      reason: b.reason ?? null,
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
    const body = (req.body as { decision?: 'allow' | 'deny'; answer?: string }) ?? {};
    const esc = getEscalation(id);
    if (!esc) return reply.code(404).send({ error: 'not found' });
    if (esc.state !== 'open') return reply.code(409).send({ error: `already ${esc.state}` });
    const decision = body.decision === 'deny' ? 'deny' : 'allow';
    const resolved = resolveEscalation(id, decision, body.answer);
    appendEvent({
      jobId: esc.jobId,
      type: 'escalation',
      level: 'info',
      message: `Resolved: ${decision}${body.answer ? ` — "${body.answer}"` : ''}`,
      data: { id, decision },
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
    if (!hermes.enabled) {
      sse({ type: 'disabled' });
      reply.raw.end();
      return reply;
    }
    try {
      await hermes.streamChat(messages ?? [], (delta) => sse({ type: 'delta', delta }));
      sse({ type: 'done' });
    } catch (err) {
      sse({ type: 'error', error: (err as Error).message });
    }
    reply.raw.end();
    return reply;
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
