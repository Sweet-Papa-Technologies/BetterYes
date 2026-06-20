import type { ForemanConfig } from '../config/index.js';
import { optionalSecret } from '../secrets/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('hermes');

/**
 * Hermes bridge (PRD FR6) — the conversational brain behind the dashboard chat panel. Thin
 * HTTP client to the operator's Hermes agent core. Gated behind `hermes.enabled`; when off,
 * the chat panel falls back to structured commands and nothing here runs.
 *
 * We talk to Hermes over its OpenAI-compatible streaming endpoint (`/v1/chat/completions`,
 * SSE). The exact session-stream event names are version-sensitive (DESIGN §9.5) — verify
 * against your Hermes build; this targets the common OpenAI-compatible shape.
 */
export class HermesClient {
  readonly enabled: boolean;
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(config: ForemanConfig) {
    this.enabled = config.hermes.enabled;
    this.baseUrl = config.hermes.base_url.replace(/\/$/, '');
    // Hermes requires its key even on loopback (DESIGN §8 security).
    this.apiKey = optionalSecret(config.hermes.api_key_env);
    if (this.enabled && !this.apiKey) {
      log.warn(`hermes.enabled but ${config.hermes.api_key_env} is not set — bridge will fail closed`);
    }
  }

  async health(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /**
   * Stream a chat completion from Hermes, invoking `onDelta` with each text chunk. Returns
   * when the stream ends. Throws if Hermes is unreachable so the caller can fall back.
   */
  async streamChat(messages: { role: string; content: string }[], onDelta: (t: string) => void): Promise<void> {
    if (!this.enabled) throw new Error('hermes disabled');
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: 'hermes', stream: true, messages }),
    });
    if (!res.ok || !res.body) throw new Error(`hermes ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
        } catch {
          /* keep-alive or non-JSON line */
        }
      }
    }
  }
}
