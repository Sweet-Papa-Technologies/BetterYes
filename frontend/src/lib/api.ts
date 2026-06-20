// Typed client for the FOREMAN Core API (REST + WebSocket), sharing DTOs with the daemon.
import type {
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
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
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

export const api = {
  config: () => req<PublicConfig>('/api/config'),
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
  escalations: (state?: string) =>
    req<Escalation[]>(`/api/escalations${state ? `?state=${state}` : ''}`),
  getRules: () => req<{ text: string; parsed: RulesFile; path: string }>('/api/rules'),
  putRules: (text: string) =>
    req<{ ok: boolean }>('/api/rules', { method: 'PUT', body: JSON.stringify({ text }) }),
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
