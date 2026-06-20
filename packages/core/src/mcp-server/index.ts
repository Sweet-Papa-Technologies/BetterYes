import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { requireSecret } from '../secrets/index.js';

// Resolve the local daemon API + token so the control-plane tools can call back into Core.
function coreApi(): { base: string; token: string } {
  const config = loadConfig();
  return {
    base: `http://127.0.0.1:${config.dashboard.port}`,
    token: requireSecret(config.dashboard.auth_token_env),
  };
}

async function callCore(path: string, init?: RequestInit): Promise<unknown> {
  const { base, token } = coreApi();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`core ${res.status}`);
  return res.json();
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * MCP bridge (DESIGN §3 / PRD FR2+FR4) — exposed back INTO the Coder session so it can call:
 *   - ask_director: request higher-level guidance
 *   - request_human_approval: pause for a human decision
 *
 * M1 status: HITL is a documented STUB. `request_human_approval` auto-resolves per the
 * profile's default so headless jobs don't wedge; the *real* round-trip (PreToolUse `defer`
 * → dashboard + Web Push → answer injected) lands in M4. `ask_director` returns a
 * proceed-per-brief nudge until the loopback broker wires it to the live Director.
 *
 * Wire it into a job with `--mcp-config` pointing claude at:
 *   { "mcpServers": { "foreman": { "command": "foreman", "args": ["mcp-server"] } } }
 */

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'foreman', version: '0.1.0' });

  server.tool(
    'ask_director',
    'Ask the FOREMAN Director for higher-level guidance when the task is ambiguous or stuck.',
    { question: z.string().describe('What you need direction on.') },
    async ({ question }) => ({
      content: [
        {
          type: 'text' as const,
          text: `Director (M1 stub): proceed with the most direct approach that satisfies the mission brief. Note for the operator: "${question}"`,
        },
      ],
    }),
  );

  server.tool(
    'request_human_approval',
    'Pause and ask the human operator to approve an action before proceeding.',
    {
      action: z.string().describe('The action you want approval for.'),
      reason: z.string().optional().describe('Why this needs a human.'),
    },
    async ({ action, reason }) => {
      // Real hold (M4): raise an escalation and block until the operator answers from the
      // dashboard/chat (a Web Push fires too). Mirrors the PreToolUse gate's hold.
      try {
        const job = process.env.FOREMAN_JOB_ID;
        if (!job) return textResult(`(no job context) Proceeding with: ${action}`);
        const esc = (await callCore(`/api/jobs/${job}/escalations`, {
          method: 'POST',
          body: JSON.stringify({ question: `Approve: ${action}`, proposedAction: action, reason }),
        })) as { id: string };
        const deadline = Date.now() + Number(process.env.FOREMAN_ESC_TIMEOUT_MS ?? 25 * 60 * 1000);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const cur = (await callCore(`/api/escalations/${esc.id}`)) as { state: string; decision?: string; answer?: string };
          if (cur.state === 'resolved') {
            return textResult(
              cur.decision === 'deny'
                ? `DENIED by the operator. Do not proceed with: ${action}.`
                : `APPROVED${cur.answer ? ` — operator note: "${cur.answer}"` : ''}. Proceed with: ${action}.`,
            );
          }
          if (cur.state === 'timed_out') return textResult(`No operator answer in time. Do not proceed with: ${action}.`);
        }
        return textResult(`No operator answer in time. Do not proceed with: ${action}.`);
      } catch (e) {
        return textResult(`Could not reach the operator (${(e as Error).message}). Hold and do not proceed.`);
      }
    },
  );

  // ── Control-plane tools exposed to Hermes (`hermes mcp add`) — never edits worktrees ──
  server.tool(
    'dispatch_job',
    'Launch a new FOREMAN coding job.',
    {
      brief: z.string().describe('What the job should do.'),
      repoPath: z.string().describe('Absolute path to the git repo.'),
      name: z.string().optional(),
    },
    async ({ brief, repoPath, name }) => {
      const job = (await callCore('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ brief, repoPath, name: name ?? brief.slice(0, 40) }),
      })) as { id: string; state: string };
      return textResult(`Launched ${job.id} (${job.state}).`);
    },
  );

  server.tool('status', 'Get the status of all FOREMAN jobs.', {}, async () => {
    const jobs = (await callCore('/api/jobs')) as { id: string; name: string; state: string }[];
    return textResult(jobs.map((j) => `${j.id} ${j.state} — ${j.name}`).join('\n') || 'No jobs.');
  });

  server.tool(
    'redirect',
    'Send a steering instruction to a running job.',
    { jobId: z.string(), message: z.string() },
    async ({ jobId, message }) => {
      await callCore(`/api/jobs/${jobId}/redirect`, { method: 'POST', body: JSON.stringify({ message }) });
      return textResult(`Redirect sent to ${jobId}.`);
    },
  );

  return server;
}

/** Run the bridge over stdio (invoked as `foreman mcp-server`). */
export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
