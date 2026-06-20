import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { ForemanConfig } from '../config/index.js';
import { resolveRulesPath } from '../gate/index.js';

/**
 * Read/validate/write rules.yaml for the dashboard's Rules editor (GET/PUT /rules). The gate
 * reads the file fresh on every tool call, so a successful write hot-reloads automatically.
 */

const MatchSchema = z
  .object({
    tool: z.string().optional(),
    path_glob: z.array(z.string()).optional(),
    path_outside_worktree: z.boolean().optional(),
    cmd_regex: z.string().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    match: MatchSchema,
    action: z.enum(['allow', 'deny', 'escalate']),
  })
  .strict();

export const RulesFileSchema = z
  .object({
    default_action: z.enum(['allow', 'deny', 'escalate']).default('allow'),
    on_error: z.enum(['allow', 'deny', 'escalate']).default('escalate'),
    rules: z.array(RuleSchema).default([]),
  })
  .strict();

export type RulesFile = z.infer<typeof RulesFileSchema>;

export function readRules(config: ForemanConfig): { path: string; text: string; parsed: RulesFile } {
  const path = resolveRulesPath(config);
  const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
  const parsed = RulesFileSchema.parse(YAML.parse(text) ?? {});
  return { path, text, parsed };
}

export interface WriteResult {
  ok: boolean;
  error?: string;
}

/** Validate then write rules.yaml. Rejects (without writing) on parse/schema errors. */
export function writeRules(config: ForemanConfig, text: string): WriteResult {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${(e as Error).message}` };
  }
  // Validate each cmd_regex compiles, on top of the structural schema.
  const result = RulesFileSchema.safeParse(doc ?? {});
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  for (const r of result.data.rules) {
    if (r.match.cmd_regex) {
      try {
        new RegExp(r.match.cmd_regex);
      } catch (e) {
        return { ok: false, error: `invalid cmd_regex "${r.match.cmd_regex}": ${(e as Error).message}` };
      }
    }
  }
  fs.writeFileSync(resolveRulesPath(config), text);
  return { ok: true };
}

/** Write from a structured ruleset (the dashboard editor sends JSON; we serialize to YAML). */
export function writeRulesParsed(config: ForemanConfig, parsed: unknown): WriteResult {
  const result = RulesFileSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const header =
    '# FOREMAN tool rules (DESIGN §4). First match wins. Edited via the dashboard Rules editor.\n';
  return writeRules(config, header + YAML.stringify(result.data));
}
