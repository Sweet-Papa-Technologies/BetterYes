import type { ModelClient } from '../models/index.js';
import type { Ledger } from '../ledger/index.js';
import { redact } from '../logger.js';

/**
 * Director (DESIGN §3 / PRD FR2): the heavy-reasoning role. STATELESS — every call gets the
 * mission brief + a fresh ledger digest re-injected, and returns TEXT only. It never talks
 * to Claude Code directly; the orchestrator relays its guidance as a redirect turn.
 *
 * Prompt-injection containment (DESIGN §8): the Director sees the brief, the plan, and the
 * ledger digest — never raw repo or web content.
 */

const SYSTEM = `You are the Director of an autonomous coding job. You supervise a separate
coding agent (the Coder) that writes the actual code. You are stateless: everything you know
is in this prompt. Be concise, decisive, and concrete. Never write code yourself — give the
Coder direction. Respond in plain text, no markdown headers.`;

export class Director {
  constructor(
    private readonly model: ModelClient,
    private readonly modelId: string,
  ) {}

  /** Produce the initial plan from the mission brief. */
  async plan(brief: string): Promise<string> {
    return this.model.complete({
      model: this.modelId,
      system: SYSTEM,
      user: `Mission brief:\n${redact(brief)}\n\nWrite a short, ordered plan (3–6 steps) the Coder should follow to complete this. Then state the single first action the Coder should take.`,
      temperature: 0.3,
      // gemini-3.5-flash is a thinking model — leave headroom for reasoning + output.
      maxTokens: 2048,
    });
  }

  /**
   * Given the ledger so far and why we paused, decide how to steer. Returns guidance text to
   * inject into the Coder session.
   */
  async resolve(opts: {
    brief: string;
    ledger: Ledger;
    reason: string;
  }): Promise<string> {
    return this.model.complete({
      model: this.modelId,
      system: SYSTEM,
      user: `Mission brief:\n${redact(opts.brief)}\n\nProgress so far:\n${opts.ledger.digest()}\n\nThe job paused because: ${redact(opts.reason)}\n\nGive the Coder one clear, specific instruction to make progress now. One short paragraph.`,
      temperature: 0.3,
      maxTokens: 1500,
    });
  }

  /** Final review: did the job satisfy the brief? Returns a verdict line + brief notes. */
  async review(opts: { brief: string; ledger: Ledger; summary: string }): Promise<string> {
    return this.model.complete({
      model: this.modelId,
      system: SYSTEM,
      user: `Mission brief:\n${redact(opts.brief)}\n\nWhat the Coder reported on completion:\n${redact(opts.summary)}\n\nProgress ledger:\n${opts.ledger.digest()}\n\nDid this satisfy the brief? Start your reply with exactly "VERDICT: PASS" or "VERDICT: FAIL", then one or two sentences of justification.`,
      temperature: 0.2,
      maxTokens: 1500,
    });
  }
}
