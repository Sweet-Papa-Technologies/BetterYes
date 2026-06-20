import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
    async ({ action }) => ({
      content: [
        {
          type: 'text' as const,
          // Stub: auto-approve so M1 jobs run unattended. M4 replaces this with a real hold.
          text: `APPROVED (M1 auto-approval stub). You may proceed with: ${action}. In M4 this will route to the operator's dashboard + push notification.`,
        },
      ],
    }),
  );

  return server;
}

/** Run the bridge over stdio (invoked as `foreman mcp-server`). */
export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
