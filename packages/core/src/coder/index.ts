import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { ForemanConfig } from '../config/index.js';
import { createLogger } from '../logger.js';
import {
  parseLine,
  SUPPORTED_CLI_MAJOR,
  type AssistantEvent,
  type ResultEvent,
  type StreamEvent,
} from './streamjson.js';

const log = createLogger('coder');

/**
 * Coder dispatcher (DESIGN §3 / PRD FR2). Drives a headless Claude Code session in the job's
 * worktree. One `runTurn()` call == one supervision turn: Claude works autonomously (up to
 * its internal --max-turns) and returns a result, which the orchestrator hands to the Router.
 *
 * stream-json events are emitted to `onEvent` as they arrive so the dashboard log console
 * streams live; the accumulated summary feeds the Router/Director.
 */

export interface CoderTurnResult {
  sessionId: string | null;
  /** Final result text from Claude (its summary of the turn). */
  resultText: string;
  /** Assistant narration + tool calls, condensed for the Router. */
  summary: string;
  toolCalls: Array<{ name: string; target?: string }>;
  filesTouched: string[];
  numTurns: number;
  costUsd: number;
  tokens: number;
  isError: boolean;
  errorSubtype?: string;
  permissionDenials: number;
}

export interface CoderEvent {
  level: 'init' | 'sync' | 'read' | 'plan' | 'exec' | 'warn' | 'error' | 'info';
  message: string;
}

let versionWarned = false;

export class Coder {
  constructor(private readonly config: ForemanConfig) {}

  /**
   * Run one turn. `prompt` is the Coder instruction (mission brief on turn 1, Director
   * guidance / redirect thereafter). `resumeSessionId` continues an existing session.
   */
  runTurn(opts: {
    cwd: string;
    prompt: string;
    resumeSessionId?: string | null;
    onEvent: (e: CoderEvent) => void;
    signal?: AbortSignal;
  }): Promise<CoderTurnResult> {
    const { cwd, prompt, resumeSessionId, onEvent, signal } = opts;
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(this.config.coder.max_turns),
      '--permission-mode',
      this.config.coder.permission_mode,
    ];
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    const env = { ...process.env };
    if (this.config.coder.auth === 'oauth') {
      // Force subscription/OAuth path for dev: don't let a stray ANTHROPIC_API_KEY take over.
      delete env.ANTHROPIC_API_KEY;
    }

    return new Promise<CoderTurnResult>((resolve, reject) => {
      const child = spawn(this.config.coder.command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const result: CoderTurnResult = {
        sessionId: resumeSessionId ?? null,
        resultText: '',
        summary: '',
        toolCalls: [],
        filesTouched: [],
        numTurns: 0,
        costUsd: 0,
        tokens: 0,
        isError: false,
        permissionDenials: 0,
      };
      const summaryParts: string[] = [];
      const filesSet = new Set<string>();

      if (signal) {
        signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      }

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const ev = parseLine(line);
        if (ev) handleEvent(ev, result, summaryParts, filesSet, onEvent);
      });

      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn '${this.config.coder.command}': ${err.message}`));
      });

      child.on('close', (code) => {
        result.summary = summaryParts.join('\n').slice(0, 4000);
        result.filesTouched = [...filesSet];
        if (code !== 0 && !result.resultText && !result.isError) {
          result.isError = true;
          result.errorSubtype = `exit_${code}`;
          if (stderr.trim()) onEvent({ level: 'error', message: stderr.trim().slice(0, 500) });
        }
        resolve(result);
      });
    });
  }
}

function handleEvent(
  ev: StreamEvent,
  result: CoderTurnResult,
  summaryParts: string[],
  filesSet: Set<string>,
  onEvent: (e: CoderEvent) => void,
): void {
  switch (ev.type) {
    case 'system': {
      if ('subtype' in ev && ev.subtype === 'init') {
        result.sessionId = (ev as { session_id: string }).session_id;
        const ver = (ev as { claude_code_version?: string }).claude_code_version;
        if (ver && !versionWarned) {
          const major = Number(ver.split('.')[0]);
          if (major !== SUPPORTED_CLI_MAJOR) {
            versionWarned = true;
            log.warn(
              `claude CLI ${ver} is outside the tested major (${SUPPORTED_CLI_MAJOR}.x); stream-json parsing may need re-snapshotting.`,
            );
          }
        }
        onEvent({ level: 'init', message: 'Booting agent environment…' });
      }
      break;
    }
    case 'assistant': {
      const a = ev as AssistantEvent;
      for (const block of a.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          summaryParts.push(block.text.trim());
          onEvent({ level: 'info', message: block.text.trim() });
        } else if (block.type === 'tool_use') {
          const target = describeToolTarget(block.name, block.input);
          result.toolCalls.push({ name: block.name, ...(target ? { target } : {}) });
          if (isWriteTool(block.name) && target) filesSet.add(target);
          summaryParts.push(`[tool] ${block.name}${target ? ` ${target}` : ''}`);
          onEvent({
            level: toolLevel(block.name),
            message: `${block.name}${target ? `  ${target}` : ''}`,
          });
        }
      }
      if (a.message.usage) {
        result.tokens +=
          (a.message.usage.input_tokens ?? 0) + (a.message.usage.output_tokens ?? 0);
      }
      break;
    }
    case 'result': {
      const r = ev as ResultEvent;
      result.resultText = r.result ?? '';
      result.numTurns = r.num_turns ?? 0;
      result.costUsd = r.total_cost_usd ?? 0;
      result.isError = !!r.is_error;
      result.errorSubtype = r.subtype;
      result.permissionDenials = r.permission_denials?.length ?? 0;
      if (r.result?.trim()) summaryParts.push(`[result] ${r.result.trim()}`);
      onEvent({
        level: r.is_error ? 'error' : 'sync',
        message: r.is_error
          ? `Turn ended: ${r.subtype}`
          : `Turn complete (${r.num_turns} steps)`,
      });
      break;
    }
    default:
      break;
  }
}

function isWriteTool(name: string): boolean {
  return name === 'Edit' || name === 'Write' || name === 'NotebookEdit';
}

function toolLevel(name: string): CoderEvent['level'] {
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return 'read';
  if (isWriteTool(name)) return 'exec';
  if (name === 'Bash') return 'exec';
  return 'info';
}

function describeToolTarget(name: string, input: Record<string, unknown>): string | undefined {
  if ('file_path' in input && typeof input.file_path === 'string') return input.file_path;
  if (name === 'Bash' && typeof input.command === 'string') {
    return (input.command as string).slice(0, 80);
  }
  if ('pattern' in input && typeof input.pattern === 'string') return input.pattern as string;
  return undefined;
}
