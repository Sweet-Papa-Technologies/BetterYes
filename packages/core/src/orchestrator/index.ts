import type { Job, JobState, RouterLabel } from '@foreman/shared';
import type { ForemanConfig } from '../config/index.js';
import { ModelClient } from '../models/index.js';
import { Director } from '../director/index.js';
import { Router } from '../router/index.js';
import { Coder, type CoderTurnResult } from '../coder/index.js';
import { Ledger, CircuitBreaker } from '../ledger/index.js';
import { prepareWorktree, countChangedFiles, removeWorktree } from '../coder/worktree.js';
import {
  appendEvent,
  createEscalation,
  getEscalation,
  getJob,
  timeoutEscalation,
  updateJob,
} from '../db/index.js';
import type { Escalation } from '@foreman/shared';
import { buildGateLaunch } from '../gate/index.js';
import { requireSecret } from '../secrets/index.js';
import { jobDir } from '../paths.js';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('orchestrator');

/** Per-job control handle: redirect injection + pause/kill, all honored at turn boundaries. */
class JobController {
  abort = new AbortController();
  paused = false;
  killed = false;
  private redirect: string | null = null;

  setRedirect(msg: string): void {
    this.redirect = msg;
  }
  takeRedirect(): string | null {
    const r = this.redirect;
    this.redirect = null;
    return r;
  }
  kill(): void {
    this.killed = true;
    this.abort.abort();
  }
}

/**
 * Orchestrator (DESIGN §3 / PRD FR2). One JobRunner per job: prepares the worktree, asks the
 * Director for a plan, then loops Coder → Router → (Director) until the job completes, drifts
 * past the circuit breaker, or hits the iteration cap. M1 runs a single job; the
 * concurrency manager (worktree cap, N-in-parallel) is M2.
 */
export class JobRunner {
  private ledger = new Ledger();
  private breaker: CircuitBreaker;
  private director: Director;
  private router: Router;
  private coder: Coder;

  constructor(
    private job: Job,
    private config: ForemanConfig,
    models: ModelClient,
    private controller: JobController,
  ) {
    this.director = new Director(models, job.directorModel);
    this.router = new Router(models, job.routerModel);
    this.coder = new Coder(config);
    this.breaker = new CircuitBreaker(config.loop.circuit_breaker_repeats);
  }

  private setState(state: JobState, lastActivity?: string): void {
    this.job = updateJob(this.job.id, {
      state,
      ...(lastActivity ? { lastActivity } : {}),
    });
    appendEvent({ jobId: this.job.id, type: 'state', message: state, data: { state } });
  }

  private logLine(level: Parameters<typeof appendEvent>[0]['level'], message: string): void {
    appendEvent({ jobId: this.job.id, type: 'log', level, message });
  }

  async run(): Promise<void> {
    try {
      // ── Prepare worktree ──────────────────────────────────────────────────
      const wt = prepareWorktree({
        jobId: this.job.id,
        repoPath: this.job.repoPath,
        branch: this.job.branch,
      });
      this.job = updateJob(this.job.id, { worktreePath: wt.path });
      this.logLine('init', `Worktree ready on branch ${wt.branch}`);

      // ── Plan ──────────────────────────────────────────────────────────────
      this.setState('planning', 'Director is planning');
      const plan = await this.director.plan(this.job.brief);
      appendEvent({ jobId: this.job.id, type: 'plan', level: 'plan', message: plan });
      this.logLine('plan', 'Director produced a plan');

      // ── Optional plan approval (real human-in-the-loop, PRD FR4 / U1) ────────
      let planGuidance = '';
      if (this.job.requirePlanApproval) {
        const ans = await this.raiseAndAwait({
          question: 'Approve this plan to start the job?',
          proposedAction: plan.slice(0, 600),
          reason: 'You asked to approve the plan before this job runs.',
        });
        if (ans === 'killed') return this.finishKilled();
        if (ans !== 'timeout' && ans.decision === 'deny' && !ans.answer) {
          this.logLine('warn', 'Plan denied by operator');
          this.setState('killed', 'Plan denied by operator');
          if (this.job.worktreePath) removeWorktree(this.job.repoPath, this.job.worktreePath);
          return;
        }
        if (ans !== 'timeout' && ans.answer) planGuidance = `\n\nOperator note: ${ans.answer}`;
      }

      // ── Supervision loop ────────────────────────────────────────────────────
      this.setState('running', 'Working');
      let nextPrompt = `${this.job.brief}\n\nPlan to follow:\n${plan}${planGuidance}\n\nBegin now. Work in the current directory only.`;
      let noProgress = 0;

      for (let iteration = 1; iteration <= this.config.loop.max_iterations; iteration++) {
        if (this.controller.killed) return this.finishKilled();
        await this.waitWhilePaused();

        // Operator redirect takes precedence over Director guidance (PRD U3).
        const redirect = this.controller.takeRedirect();
        if (redirect) {
          nextPrompt = `New instruction from the operator: ${redirect}`;
          this.logLine('info', `Redirect: ${redirect}`);
        }

        const turn = await this.runCoderTurn(nextPrompt, iteration);
        if (this.controller.killed) return this.finishKilled();

        this.applyBurn(turn);

        // ── Router classifies the turn ───────────────────────────────────────
        const verdict = await this.router.classify(turn.summary || turn.resultText || '(no output)');
        appendEvent({
          jobId: this.job.id,
          type: 'router',
          level: 'info',
          message: `${verdict.label}: ${verdict.reason}`,
          data: { label: verdict.label, reason: verdict.reason },
        });

        const failureSignature = turn.isError
          ? `${turn.errorSubtype ?? 'error'}:${(turn.resultText || verdict.reason).slice(0, 60)}`
          : undefined;
        const tripped = this.breaker.record(failureSignature);
        this.ledger.add({
          turn: iteration,
          label: verdict.label,
          summary: (turn.resultText || verdict.reason).slice(0, 200),
          ...(failureSignature ? { failureSignature } : {}),
        });

        if (tripped) {
          this.logLine('error', `Circuit breaker tripped (repeated: ${failureSignature})`);
          return this.review('Circuit breaker tripped on a repeated failure.');
        }

        // ── Act on the verdict ───────────────────────────────────────────────
        const decision = await this.decide(verdict.label, turn, verdict.reason);
        if (decision.kind === 'review') return this.review(decision.reason);
        if (decision.kind === 'continue') {
          // progress guard: stop spinning if nothing is changing
          if (!turn.isError && turn.filesTouched.length === 0) noProgress += 1;
          else noProgress = 0;
          if (noProgress >= 2) return this.review('No further file changes over multiple turns.');
          nextPrompt = decision.prompt;
        }
      }

      this.logLine('warn', `Hit max iterations (${this.config.loop.max_iterations})`);
      return this.review('Reached the maximum supervision iterations.');
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`job ${this.job.id} failed: ${msg}`);
      appendEvent({ jobId: this.job.id, type: 'error', level: 'error', message: msg });
      this.setState('failed', `Failed: ${msg.slice(0, 80)}`);
    }
  }

  /** Build the PreToolUse gate launch for this job, if rules are enabled. */
  private gateLaunch(): { settingsJson: string; env: Record<string, string> } | undefined {
    if (!this.config.rules.enabled || !this.job.worktreePath) return undefined;
    return buildGateLaunch({
      config: this.config,
      jobId: this.job.id,
      worktree: this.job.worktreePath,
      auditPath: path.join(jobDir(this.job.id), 'audit.jsonl'),
      apiBase: `http://127.0.0.1:${this.config.dashboard.port}`,
      token: requireSecret(this.config.dashboard.auth_token_env),
    });
  }

  private async runCoderTurn(prompt: string, iteration: number): Promise<CoderTurnResult> {
    this.logLine('exec', `Coder turn ${iteration}`);
    const gate = this.gateLaunch();
    const turn = await this.coder.runTurn({
      cwd: this.job.worktreePath!,
      prompt,
      resumeSessionId: this.job.sessionId,
      signal: this.controller.abort.signal,
      ...(gate ? { gate } : {}),
      onEvent: (e) => appendEvent({ jobId: this.job.id, type: 'log', level: e.level, message: e.message }),
    });
    if (turn.sessionId && turn.sessionId !== this.job.sessionId) {
      this.job = updateJob(this.job.id, { sessionId: turn.sessionId });
    }
    return turn;
  }

  /** Translate a Router label into the next loop action. */
  private async decide(
    label: RouterLabel,
    turn: CoderTurnResult,
    reason: string,
  ): Promise<{ kind: 'review'; reason: string } | { kind: 'continue'; prompt: string }> {
    switch (label) {
      case 'complete':
        return { kind: 'review', reason: 'Coder reported the task complete.' };
      case 'on_track':
        return {
          kind: 'continue',
          prompt:
            'Continue with the next step toward the brief. If everything is fully done, reply with DONE and stop.',
        };
      case 'needs_director':
      case 'drifting': {
        const guidance = await this.director.resolve({
          brief: this.job.brief,
          ledger: this.ledger,
          reason: `Router=${label}: ${reason}`,
        });
        appendEvent({ jobId: this.job.id, type: 'director', level: 'plan', message: guidance });
        return { kind: 'continue', prompt: guidance };
      }
      case 'blocked':
      case 'awaiting_approval': {
        // Real human-in-the-loop (M3): hold for an operator answer from the dashboard.
        const ans = await this.raiseAndAwait({
          question: `This job needs your decision: ${reason}`,
          proposedAction: turn.resultText?.slice(0, 400) || reason,
          reason,
        });
        if (ans === 'killed') return { kind: 'review', reason: 'Killed during escalation.' };
        this.setState('running', 'Working');
        if (ans === 'timeout') {
          // Fall back to a Director nudge so an unattended job still makes progress.
          const guidance = await this.director.resolve({
            brief: this.job.brief,
            ledger: this.ledger,
            reason: `No human answer in time; Coder was blocked: ${reason}`,
          });
          return { kind: 'continue', prompt: `(No operator answer — proceeding) ${guidance}` };
        }
        if (ans.decision === 'deny' && !ans.answer) {
          return { kind: 'review', reason: 'Operator denied the action.' };
        }
        if (ans.answer) return { kind: 'continue', prompt: `Operator says: ${ans.answer}` };
        return { kind: 'continue', prompt: 'The operator approved — proceed.' };
      }
      case 'error': {
        const guidance = await this.director.resolve({
          brief: this.job.brief,
          ledger: this.ledger,
          reason: `Coder hit an error (${turn.errorSubtype ?? 'unknown'}): ${turn.resultText || reason}`,
        });
        appendEvent({ jobId: this.job.id, type: 'director', level: 'plan', message: guidance });
        return { kind: 'continue', prompt: `An error occurred. ${guidance}` };
      }
      default:
        return { kind: 'continue', prompt: 'Continue toward the brief.' };
    }
  }

  private async review(why: string): Promise<void> {
    this.setState('review', 'Final review');
    this.logLine('info', `Reviewing: ${why}`);
    const summary = this.ledger.digest();
    const verdict = await this.director.review({
      brief: this.job.brief,
      ledger: this.ledger,
      summary: `${why}\n\nLast result: ${summary}`,
    });
    appendEvent({ jobId: this.job.id, type: 'director', level: 'plan', message: verdict });
    if (/VERDICT:\s*PASS/i.test(verdict)) {
      this.setState('done', 'Completed');
    } else {
      this.setState('failed', 'Review failed');
    }
  }

  private finishKilled(): void {
    this.logLine('warn', 'Killed by operator');
    this.setState('killed', 'Killed by operator');
    if (this.job.worktreePath) removeWorktree(this.job.repoPath, this.job.worktreePath);
  }

  private applyBurn(turn: CoderTurnResult): void {
    const files = this.job.worktreePath ? countChangedFiles(this.job.worktreePath) : 0;
    this.job = updateJob(this.job.id, {
      turns: this.job.turns + 1,
      tokens: this.job.tokens + turn.tokens,
      costUsd: this.job.costUsd + turn.costUsd,
      filesTouched: files,
      lastActivity: turn.resultText ? turn.resultText.slice(0, 100) : this.job.lastActivity,
    });
    appendEvent({
      jobId: this.job.id,
      type: 'burn',
      message: 'burn',
      data: { turns: this.job.turns, tokens: this.job.tokens, costUsd: this.job.costUsd, files },
    });
  }

  /**
   * Raise a human escalation and hold the job until the operator answers from the dashboard
   * (PRD FR4). Returns the decision/answer, or 'timeout'/'killed'. M3 holds at the Router /
   * plan-approval level; M4 upgrades the trigger to the precise PreToolUse `defer`.
   */
  private async raiseAndAwait(opts: {
    question: string;
    proposedAction?: string;
    reason?: string;
  }): Promise<{ decision: 'allow' | 'deny'; answer?: string } | 'timeout' | 'killed'> {
    const esc = createEscalation({
      jobId: this.job.id,
      question: opts.question,
      proposedAction: opts.proposedAction ?? null,
      reason: opts.reason ?? null,
    });
    this.setState('blocked', 'Needs your decision');
    appendEvent({
      jobId: this.job.id,
      type: 'escalation',
      level: 'warn',
      message: opts.question,
      data: { id: esc.id, proposedAction: opts.proposedAction, reason: opts.reason },
    });

    const deadline = Date.now() + this.config.loop.escalation_timeout_ms;
    for (;;) {
      if (this.controller.killed) return 'killed';
      const cur: Escalation | null = getEscalation(esc.id);
      if (cur && cur.state === 'resolved') {
        appendEvent({
          jobId: this.job.id,
          type: 'log',
          level: 'info',
          message: `Operator: ${cur.decision ?? 'answered'}${cur.answer ? ` — "${cur.answer}"` : ''}`,
        });
        return { decision: cur.decision ?? 'allow', ...(cur.answer ? { answer: cur.answer } : {}) };
      }
      if (Date.now() > deadline) {
        timeoutEscalation(esc.id);
        this.logLine('warn', 'Escalation timed out');
        return 'timeout';
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.controller.paused && !this.controller.killed) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// ── Job manager: concurrency cap + queue (PRD FR1, M2) ────────────────────────
class JobManager {
  private controllers = new Map<string, JobController>(); // running jobs
  private queue: Job[] = []; // jobs waiting for a slot
  private config!: ForemanConfig;
  private models!: ModelClient;

  init(config: ForemanConfig): void {
    this.config = config;
    this.models = new ModelClient(config);
  }

  private get cap(): number {
    return this.config.concurrency.max_parallel_jobs;
  }

  /** Enqueue a job; it starts immediately if a slot is free, else waits its turn. */
  start(job: Job): void {
    if (this.controllers.has(job.id) || this.queue.some((j) => j.id === job.id)) return;
    this.queue.push(job);
    this.pump();
  }

  /** Fill open slots from the queue (FIFO), respecting the parallel cap. */
  private pump(): void {
    while (this.controllers.size < this.cap && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.launch(job);
    }
    // Reflect queue position for anything still waiting.
    for (const q of this.queue) {
      const cur = getJob(q.id);
      if (cur && cur.state === 'created') updateJob(q.id, { lastActivity: 'Queued' });
    }
  }

  private launch(job: Job): void {
    const controller = new JobController();
    this.controllers.set(job.id, controller);
    const runner = new JobRunner(job, this.config, this.models, controller);
    runner
      .run()
      .catch((e) => log.error(`runner crashed for ${job.id}: ${(e as Error).message}`))
      .finally(() => {
        this.controllers.delete(job.id);
        this.pump(); // a slot freed — start the next queued job
      });
  }

  queueDepth(): number {
    return this.queue.length;
  }

  redirect(jobId: string, message: string): boolean {
    const c = this.controllers.get(jobId);
    if (!c) return false;
    c.setRedirect(message);
    return true;
  }

  pause(jobId: string): boolean {
    const c = this.controllers.get(jobId);
    if (!c) return false;
    c.paused = true;
    const j = getJob(jobId);
    if (j) updateJob(jobId, { lastActivity: 'Paused' });
    return true;
  }

  resume(jobId: string): boolean {
    const c = this.controllers.get(jobId);
    if (!c) return false;
    c.paused = false;
    return true;
  }

  kill(jobId: string): boolean {
    const c = this.controllers.get(jobId);
    if (c) {
      c.kill();
      return true;
    }
    // Not running yet — drop it from the queue and mark killed.
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      updateJob(jobId, { state: 'killed', lastActivity: 'Killed before start' });
      appendEvent({ jobId, type: 'state', message: 'killed', data: { state: 'killed' } });
      return true;
    }
    return false;
  }

  isRunning(jobId: string): boolean {
    return this.controllers.has(jobId);
  }
}

export const jobManager = new JobManager();
