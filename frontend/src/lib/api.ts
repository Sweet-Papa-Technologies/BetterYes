// Typed client for the FOREMAN Core API (REST + WebSocket), sharing DTOs with the daemon.
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  ConversationSummary,
  CreateJobRequest,
  Escalation,
  Job,
  JobEvent,
  PublicConfig,
  WsMessage,
} from '@foreman/shared';

export interface RuleMatch {
  tool?: string;
  path_glob?: string[];
  path_outside_worktree?: boolean;
  cmd_regex?: string;
}
export interface RulesFile {
  default_action: 'allow' | 'deny' | 'escalate';
  on_error: 'allow' | 'deny' | 'escalate';
  rules: Array<{ match: RuleMatch; action: 'allow' | 'deny' | 'escalate' }>;
}

// In dev the SPA runs on :9000 and the daemon on :7777; built, it's served same-origin.
const API_BASE = import.meta.env.DEV
  ? (import.meta.env.VITE_FOREMAN_API ?? 'http://localhost:7777')
  : '';

const TOKEN_KEY = 'foreman_token';

// One-time token handoff via URL (?token=…) — used by `foreman tunnel`'s QR code so scanning
// it on your phone logs you straight in. Store it, then scrub it from the address bar so the
// token isn't left sitting in history. Runs once when this module is first imported.
(function captureTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (t) {
      localStorage.setItem(TOKEN_KEY, t.trim());
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  } catch {
    /* SSR / no window */
  }
})();

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_FOREMAN_TOKEN ?? '';
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

function wsBase(): string {
  const http = API_BASE || window.location.origin;
  return http.replace(/^http/, 'ws');
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new ApiError('unauthorized', 401);
  if (!res.ok) {
    // Surface the server's `{ error }` message when present, so toasts are actionable.
    let serverMsg = '';
    try {
      serverMsg = ((await res.clone().json()) as { error?: string })?.error ?? '';
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(serverMsg || `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Stream a chat completion from Hermes via the daemon's SSE proxy. Resolves when done. */
export async function chatStream(
  messages: { role: string; content: string }[],
  onDelta: (t: string) => void,
): Promise<{ disabled?: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ messages }),
  });
  if (!res.body) return { error: 'no stream' };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result: { disabled?: boolean; error?: string } = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const evt = JSON.parse(t.slice(5).trim());
        if (evt.type === 'delta') onDelta(evt.delta);
        else if (evt.type === 'disabled') result = { disabled: true };
        else if (evt.type === 'error') result = { error: evt.error };
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

export interface MergeResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  baseBranch?: string;
  committed?: boolean;
  cleanedUp?: boolean;
  nothingToMerge?: boolean;
}

export interface HermesStatus {
  installed: boolean;
  installing: boolean;
  installError: string | null;
  installUrl: string;
  managed:
    | { setUp: true; running: boolean; reachable: boolean; baseUrl: string; port: number; model: string }
    | { setUp: false; running: false; reachable: false };
  active: {
    enabled: boolean;
    source: 'managed' | 'remote' | 'off';
    baseUrl: string;
    apiKeyEnv: string;
    hasKey: boolean;
    healthy: boolean;
  };
}

export interface ChatStreamHandlers {
  onUser?: (m: ChatMessage) => void;
  onDelta?: (t: string) => void;
  onTool?: (name: string) => void;
  onDone?: (m: ChatMessage) => void;
  onDisabled?: () => void;
  onError?: (e: string) => void;
}

/** Send a message to a conversation and stream the persisted reply (SSE). */
export async function sendConversationMessage(
  conversationId: string,
  body: { content: string; attachments?: ChatAttachment[] },
  h: ChatStreamHandlers,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.body) return h.onError?.('no stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const e = JSON.parse(t.slice(5).trim());
        if (e.type === 'user') h.onUser?.(e.message);
        else if (e.type === 'delta') h.onDelta?.(e.delta);
        else if (e.type === 'tool') h.onTool?.(e.name);
        else if (e.type === 'done') h.onDone?.(e.message);
        else if (e.type === 'disabled') h.onDisabled?.();
        else if (e.type === 'error') h.onError?.(e.error);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}
export interface DirListing {
  path: string;
  parent: string;
  isGitRepo: boolean;
  entries: DirEntry[];
}

export const api = {
  config: () => req<PublicConfig>('/api/config'),
  fsList: (path?: string) =>
    req<DirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  fsMkdir: (path: string, name: string) =>
    req<{ path: string; isGitRepo: boolean }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ path, name }) }),
  fsInitRepo: (path: string) =>
    req<{ path: string; isGitRepo: boolean }>('/api/fs/init-repo', { method: 'POST', body: JSON.stringify({ path }) }),
  listJobs: () => req<Job[]>('/api/jobs'),
  getJob: (id: string) => req<{ job: Job; events: JobEvent[] }>(`/api/jobs/${id}`),
  createJob: (body: CreateJobRequest) =>
    req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  redirect: (id: string, message: string) =>
    req<{ ok: boolean }>(`/api/jobs/${id}/redirect`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  pause: (id: string) => req<{ ok: boolean }>(`/api/jobs/${id}/pause`, { method: 'POST' }),
  resume: (id: string) => req<{ ok: boolean }>(`/api/jobs/${id}/resume`, { method: 'POST' }),
  kill: (id: string) => req<{ ok: boolean }>(`/api/jobs/${id}/kill`, { method: 'POST' }),
  retry: (id: string) => req<Job>(`/api/jobs/${id}/retry`, { method: 'POST' }),
  followUp: (id: string, message: string) =>
    req<Job>(`/api/jobs/${id}/followup`, { method: 'POST', body: JSON.stringify({ message }) }),
  merge: (id: string, cleanup = true) =>
    req<MergeResult>(`/api/jobs/${id}/merge`, { method: 'POST', body: JSON.stringify({ cleanup }) }),
  escalations: (state?: string) =>
    req<Escalation[]>(`/api/escalations${state ? `?state=${state}` : ''}`),
  resolveEscalation: (id: string, decision: 'allow' | 'deny', answer?: string, remember?: boolean) =>
    req<Escalation>(`/api/escalations/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision, ...(answer ? { answer } : {}), ...(remember ? { remember } : {}) }),
    }),
  vapidKey: () => req<{ publicKey: string }>('/api/push/vapid'),
  subscribePush: (sub: PushSubscriptionJSON) =>
    req<{ ok: boolean }>('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
  testPush: () => req<{ ok: boolean }>('/api/push/test', { method: 'POST' }),
  hermes: {
    status: () => req<HermesStatus>('/api/hermes'),
    setup: (body: { port?: number; model?: string; start?: boolean } = {}) =>
      req<unknown>('/api/hermes/setup', { method: 'POST', body: JSON.stringify(body) }),
    install: () => req<{ started: boolean; alreadyInstalled: boolean }>('/api/hermes/install', { method: 'POST' }),
    start: () => req<{ ok: boolean; port?: number; error?: string }>('/api/hermes/start', { method: 'POST' }),
    stop: () => req<{ ok: boolean }>('/api/hermes/stop', { method: 'POST' }),
    select: (body: { source: 'managed' | 'remote' | 'off'; baseUrl?: string; apiKey?: string }) =>
      req<{ ok: boolean; error?: string; note?: string }>('/api/hermes/select', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    setModel: (model: string) =>
      req<{ ok: boolean; model?: string; restarted?: boolean; error?: string }>('/api/hermes/model', {
        method: 'POST',
        body: JSON.stringify({ model }),
      }),
  },
  conversations: {
    list: () => req<ConversationSummary[]>('/api/conversations'),
    create: (title?: string) =>
      req<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
    get: (id: string) => req<{ conversation: Conversation; messages: ChatMessage[] }>(`/api/conversations/${id}`),
    rename: (id: string, title: string) =>
      req<Conversation>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    remove: (id: string) => req<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  },
  upload: (body: { conversationId?: string; name: string; type: string; dataBase64: string }) =>
    req<ChatAttachment>('/api/uploads', { method: 'POST', body: JSON.stringify(body) }),
  getRules: () => req<{ text: string; parsed: RulesFile; path: string }>('/api/rules'),
  putRules: (parsed: RulesFile) =>
    req<{ ok: boolean }>('/api/rules', { method: 'PUT', body: JSON.stringify({ parsed }) }),
};

/**
 * Auto-reconnecting WebSocket. `onMessage` gets parsed WsMessage envelopes; `onStatus`
 * reports the live/reconnecting state that drives the connection dot.
 */
export function connectWs(
  path: string,
  onMessage: (m: WsMessage) => void,
  onStatus?: (live: boolean) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const sep = path.includes('?') ? '&' : '?';
    socket = new WebSocket(`${wsBase()}${path}${sep}token=${encodeURIComponent(getToken())}`);
    socket.onopen = () => onStatus?.(true);
    socket.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as WsMessage);
      } catch {
        /* ignore malformed frame */
      }
    };
    socket.onclose = () => {
      onStatus?.(false);
      if (!closed) retry = setTimeout(open, 1500);
    };
    socket.onerror = () => socket?.close();
  };
  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
