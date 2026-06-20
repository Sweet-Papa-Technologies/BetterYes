/**
 * Types for Claude Code's `--output-format stream-json` events.
 *
 * VERSION-GATED (DESIGN §9.3): reverse-engineered + confirmed against the pinned CLI by a
 * build-time probe. If the CLI's `claude_code_version` is outside the supported range we
 * still parse defensively, but we log a warning so the schema can be re-snapshotted.
 */

export const SUPPORTED_CLI_MAJOR = 2;

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  cwd: string;
  claude_code_version?: string;
}

export interface AssistantEvent {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  session_id: string;
}

export interface UserEvent {
  type: 'user';
  message?: { content?: unknown };
  session_id: string;
}

export interface ResultEvent {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_during_execution' | …
  is_error: boolean;
  result?: string;
  num_turns: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  permission_denials?: Array<{ tool_name?: string; tool_input?: unknown }>;
  terminal_reason?: string;
  session_id: string;
}

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | { type: 'rate_limit_event'; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}
