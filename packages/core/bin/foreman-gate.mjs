#!/usr/bin/env node
/**
 * FOREMAN PreToolUse rule gate (DESIGN §4). A standalone, dependency-light executable that
 * Claude Code spawns before every tool call. It loads rules.yaml fresh each invocation
 * (so edits hot-reload), matches the call, and returns an allow/deny decision as JSON.
 *
 * Invoked per tool call → keep it FAST and minimal: node builtins + `yaml` only, no SQLite,
 * no model libs. Reads the PreToolUse event on stdin; writes the decision on stdout.
 *
 * Env (set by the dispatcher):
 *   FOREMAN_RULES     path to rules.yaml
 *   FOREMAN_WORKTREE  the job's worktree (boundary for path_outside_worktree)
 *   FOREMAN_JOB_ID    job id (for audit + escalation routing)
 *   FOREMAN_AUDIT     path to the job's audit.jsonl
 *   FOREMAN_API       core base URL (best-effort live audit / escalation POST)
 *   FOREMAN_TOKEN     bearer token for FOREMAN_API
 *
 * Fail-safe (DESIGN §8): any error → the profile's on_error action (default escalate, never
 * silently allow). A `deny` rule is absolute.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import YAML from 'yaml';

const t0 = Date.now();

function decision(permissionDecision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision, // 'allow' | 'deny' | 'ask'
      permissionDecisionReason: reason,
    },
  };
}

const SECRET_RE = [
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bsk-[A-Za-z0-9\-_]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];
function redact(s) {
  let out = String(s);
  for (const re of SECRET_RE) out = out.replace(re, '«redacted»');
  return out;
}

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + '/' + p.slice(2);
  return p;
}

// Convert a glob (supports **, *, ?) to an anchored RegExp.
function globToRe(glob) {
  const g = expandHome(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++; // collapse **/ → .*
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// Tool matcher: "*" all; "Edit|Write" alternation; otherwise exact (regex-anchored).
function toolMatches(pattern, tool) {
  if (!pattern || pattern === '*') return true;
  try {
    return new RegExp('^(?:' + pattern + ')$').test(tool);
  } catch {
    return pattern === tool;
  }
}

function toolPath(input) {
  return input?.file_path ?? input?.path ?? input?.notebook_path ?? null;
}

function isOutsideWorktree(input, worktree) {
  const p = toolPath(input);
  if (!p || !worktree) return false;
  const abs = resolve(worktree, expandHome(p));
  const root = resolve(worktree);
  return abs !== root && !abs.startsWith(root + sep);
}

function pathGlobMatches(globs, input) {
  const p = toolPath(input);
  if (!p) return false;
  const candidates = [p, resolve(p)];
  return globs.some((g) => {
    const re = globToRe(g);
    return candidates.some((c) => re.test(c) || re.test(expandHome(c)));
  });
}

function ruleMatches(rule, tool, input) {
  const m = rule.match ?? {};
  if (!toolMatches(m.tool, tool)) return false;
  // All present conditions must hold (AND).
  if (m.path_glob && !pathGlobMatches(m.path_glob, input)) return false;
  if (m.path_outside_worktree === true && !isOutsideWorktree(input, process.env.FOREMAN_WORKTREE))
    return false;
  if (m.cmd_regex) {
    const cmd = input?.command ?? '';
    let re;
    try {
      re = new RegExp(m.cmd_regex);
    } catch {
      return false;
    }
    if (!re.test(cmd)) return false;
  }
  // A rule with only a tool condition matches the tool.
  return true;
}

function describe(input) {
  const p = toolPath(input);
  if (p) return p;
  if (typeof input?.command === 'string') return input.command.slice(0, 120);
  if (typeof input?.pattern === 'string') return input.pattern;
  return '';
}

function writeAudit(entry) {
  if (!process.env.FOREMAN_AUDIT) return;
  try {
    appendFileSync(process.env.FOREMAN_AUDIT, JSON.stringify(entry) + '\n');
  } catch {
    /* never fail the gate on an audit write */
  }
}

// Fire-and-forget live audit / escalation to core (must NOT affect the decision).
function postToCore(path, body) {
  const api = process.env.FOREMAN_API;
  const token = process.env.FOREMAN_TOKEN;
  if (!api || !token) return;
  try {
    void fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

async function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    /* no stdin */
  }
  let event = {};
  try {
    event = JSON.parse(raw);
  } catch {
    /* malformed */
  }
  const tool = event.tool_name ?? 'unknown';
  const input = event.tool_input ?? {};
  const jobId = process.env.FOREMAN_JOB_ID ?? '';

  let config;
  try {
    config = YAML.parse(readFileSync(process.env.FOREMAN_RULES, 'utf8')) ?? {};
  } catch {
    config = null;
  }

  // Fail-safe: no rules / parse error → on_error (default escalate → deny in M2).
  if (!config) {
    emit('escalate', 'rules.yaml unreadable; failing safe', tool, input, jobId, null);
    return;
  }

  const onError = config.on_error ?? 'escalate';
  const defaultAction = config.default_action ?? 'allow';
  const rules = Array.isArray(config.rules) ? config.rules : [];

  try {
    let matched = null;
    let action = defaultAction;
    for (let i = 0; i < rules.length; i++) {
      if (ruleMatches(rules[i], tool, input)) {
        matched = i;
        action = rules[i].action ?? defaultAction;
        break;
      }
    }
    emit(action, matched === null ? `default ${defaultAction}` : `rule #${matched + 1}`, tool, input, jobId, matched);
  } catch (err) {
    emit(onError, `gate error: ${String(err).slice(0, 80)}`, tool, input, jobId, null);
  }
}

function emit(action, ruleLabel, tool, input, jobId, matchedIndex) {
  const target = redact(describe(input));
  const latencyMs = Date.now() - t0;
  const audit = {
    ts: new Date().toISOString(),
    jobId,
    tool,
    action,
    rule: ruleLabel,
    target,
    latencyMs,
  };
  writeAudit(audit);

  if (action === 'allow') {
    // Durable audit.jsonl already has it; skip the live POST for allows to avoid flooding
    // the dashboard with every routine tool call.
    process.stdout.write(JSON.stringify(decision('allow', `FOREMAN gate: ${ruleLabel}`)));
    return;
  }
  if (action === 'deny') {
    postToCore(`/api/jobs/${jobId}/audit`, { ...audit });
    process.stdout.write(
      JSON.stringify(decision('deny', `FOREMAN gate denied (${ruleLabel}): ${tool} ${target}`)),
    );
    return;
  }
  // escalate: record an escalation; M2 blocks (deny) with an explanation. The real human
  // hold/round-trip (PreToolUse defer → dashboard + push) lands in M4.
  postToCore(`/api/jobs/${jobId}/escalations`, {
    question: `Approve ${tool}: ${target}?`,
    proposedAction: target,
    reason: ruleLabel,
  });
  postToCore(`/api/jobs/${jobId}/audit`, { ...audit });
  process.stdout.write(
    JSON.stringify(
      decision(
        'deny',
        `FOREMAN gate escalated (${ruleLabel}) — needs human approval (auto-held in M2; real hold in M4): ${tool} ${target}`,
      ),
    ),
  );
}

void main();
