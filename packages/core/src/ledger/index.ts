import type { RouterLabel } from '@foreman/shared';

/**
 * Amnesia ledger (DESIGN §3 / PRD FR2). The Director is stateless: it gets no memory of its
 * own, so each call we re-inject a compact digest of what has happened. The ledger also
 * powers the circuit breaker — if the Coder keeps hitting the *same* failure, we stop the
 * loop instead of burning turns.
 */

export interface LedgerEntry {
  turn: number;
  label: RouterLabel;
  /** One-line summary of the Coder's last turn (already redacted). */
  summary: string;
  /** A stable signature of a failure, if this turn failed. Used by the breaker. */
  failureSignature?: string;
}

export class Ledger {
  private entries: LedgerEntry[] = [];

  add(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  get length(): number {
    return this.entries.length;
  }

  /** Compact digest re-injected into the stateless Director (most recent last). */
  digest(maxEntries = 12): string {
    const recent = this.entries.slice(-maxEntries);
    if (recent.length === 0) return '(no prior activity)';
    return recent
      .map((e) => {
        const fail = e.failureSignature ? ` [failure: ${e.failureSignature}]` : '';
        return `- turn ${e.turn} → ${e.label}: ${e.summary}${fail}`;
      })
      .join('\n');
  }
}

/**
 * Circuit breaker: trips when the same failure signature recurs `threshold` times in a row.
 * Deterministic — no model verdict can keep a wedged loop alive (DESIGN §8 fail-safe).
 */
export class CircuitBreaker {
  private lastSignature: string | null = null;
  private repeats = 0;

  constructor(private readonly threshold: number) {}

  /** Record the outcome of a turn. Returns true if the breaker has tripped. */
  record(failureSignature?: string): boolean {
    if (!failureSignature) {
      this.lastSignature = null;
      this.repeats = 0;
      return false;
    }
    if (failureSignature === this.lastSignature) {
      this.repeats += 1;
    } else {
      this.lastSignature = failureSignature;
      this.repeats = 1;
    }
    return this.repeats >= this.threshold;
  }

  get tripped(): boolean {
    return this.lastSignature !== null && this.repeats >= this.threshold;
  }

  get count(): number {
    return this.repeats;
  }
}
