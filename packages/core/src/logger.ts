/**
 * Tiny structured logger with secret redaction.
 *
 * Security invariant (PRD NFR / DESIGN §8): secret-pattern values must never reach the
 * logs or any model. `redact()` is applied to every string we log and is also reused by
 * the audit writer and the model adapters.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g, // Google API keys
  /\bsk-[A-Za-z0-9\-_]{16,}\b/g, // OpenAI-style keys
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, // GitHub tokens
  /\b([A-Fa-f0-9]{32,})\b/g, // long hex blobs (generated tokens)
  /(?<=Bearer )[A-Za-z0-9\-._~+/]+=*/g, // bearer header values
];

export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level = (process.env.FOREMAN_LOG_LEVEL as Level) || 'info';

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${redact(JSON.stringify(extra))}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
