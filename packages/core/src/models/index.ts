import OpenAI from 'openai';
import type { ForemanConfig } from '../config/index.js';
import { requireSecret } from '../secrets/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('models');

/**
 * Thin OpenAI-compatible client pointed at the operator's LiteLLM proxy (DESIGN §10). No
 * provider assumptions live in code beyond "OpenAI-compatible HTTP" — every model is a
 * string from config, so swapping providers is a config edit (FR7).
 */
export class ModelClient {
  private client: OpenAI;
  readonly directorModel: string;
  readonly routerModel: string;

  constructor(config: ForemanConfig) {
    const apiKey = requireSecret(config.endpoint.api_key_env);
    this.client = new OpenAI({
      baseURL: config.endpoint.base_url,
      apiKey,
    });
    this.directorModel = config.models.director;
    this.routerModel = config.models.router;
  }

  /** Single-shot completion. `system` frames the role; `user` is the (already redacted) task. */
  async complete(opts: {
    model: string;
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    /** Force a JSON object response (used by the Router classifier). */
    json?: boolean;
  }): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: opts.model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    });
    const text = res.choices[0]?.message?.content ?? '';
    return text.trim();
  }

  /** Lightweight reachability probe used by `foreman doctor`. */
  async ping(model: string): Promise<boolean> {
    try {
      const out = await this.complete({
        model,
        system: 'Reply with the single word: ok',
        user: 'ping',
        maxTokens: 8,
      });
      return out.toLowerCase().includes('ok');
    } catch (err) {
      log.warn(`ping failed for ${model}: ${(err as Error).message}`);
      return false;
    }
  }
}
