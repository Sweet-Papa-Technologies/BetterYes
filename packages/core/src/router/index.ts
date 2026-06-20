import type { RouterLabel } from '@foreman/shared';
import type { ModelClient } from '../models/index.js';
import { redact } from '../logger.js';

/**
 * Router (DESIGN §3 / PRD FR2): the cheap, fast, per-turn classifier. It reads a summary of
 * the Coder's latest turn and assigns one of 7 labels that drive the supervision loop. Runs
 * every turn, so it uses the lightest model.
 */

export const ROUTER_LABELS: readonly RouterLabel[] = [
  'on_track',
  'needs_director',
  'blocked',
  'awaiting_approval',
  'drifting',
  'complete',
  'error',
];

const SYSTEM = `You are the Router, a fast classifier supervising an autonomous coding agent.
Read the agent's latest turn and classify it into exactly one label:
- on_track: making normal progress, no intervention needed
- needs_director: stuck or ambiguous; needs higher-level guidance
- blocked: needs a human decision/approval to proceed
- awaiting_approval: explicitly asked for human approval
- drifting: going off-scope, rabbit-holing, or repeating itself
- complete: the task is finished
- error: hit a hard error it cannot recover from
Respond with a JSON object: {"label": "<one label>", "reason": "<short reason>"}.`;

export interface RouterVerdict {
  label: RouterLabel;
  reason: string;
}

export class Router {
  constructor(
    private readonly model: ModelClient,
    private readonly modelId: string,
  ) {}

  async classify(turnSummary: string): Promise<RouterVerdict> {
    const raw = await this.model.complete({
      model: this.modelId,
      system: SYSTEM,
      user: `Agent's latest turn:\n${redact(turnSummary)}`,
      temperature: 0,
      // Headroom for any reasoning tokens before the JSON verdict.
      maxTokens: 800,
      json: true,
    });
    return parseVerdict(raw);
  }
}

/** Robustly parse the classifier output; default to needs_director if it's malformed. */
export function parseVerdict(raw: string): RouterVerdict {
  try {
    const obj = JSON.parse(raw) as { label?: string; reason?: string };
    const label = (obj.label ?? '').trim() as RouterLabel;
    if (ROUTER_LABELS.includes(label)) {
      return { label, reason: obj.reason?.trim() || '' };
    }
  } catch {
    // fall through
  }
  // Fail toward asking for guidance, never toward silently continuing.
  return { label: 'needs_director', reason: `unparseable router output: ${raw.slice(0, 80)}` };
}
