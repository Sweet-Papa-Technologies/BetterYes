<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Send, Check, X, ExternalLink } from 'lucide-vue-next';
import type { Job } from '@foreman/shared';
import { api, chatStream } from '../lib/api';
import { useJobsStore } from '../stores/jobs';
import StatusPill from '../components/StatusPill.vue';

// S7 — "Talk to Hermes". When Hermes is configured it streams its session API (M4 bridge);
// without it, this is a structured-command console — start jobs, ask status, redirect, and
// answer escalations in the thread. Either way, FOREMAN actions show as inline cards.
const router = useRouter();
const store = useJobsStore();

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text?: string;
  jobs?: Job[];
}
const messages = ref<Msg[]>([]);
const input = ref('');
const thread = ref<HTMLElement | null>(null);
const hermes = ref(false);
let uid = 0;

const openEscalations = computed(() => store.escalations);

function push(m: Omit<Msg, 'id'>) {
  messages.value.push({ id: ++uid, ...m });
  void scroll();
}
async function scroll() {
  await nextTick();
  if (thread.value) thread.value.scrollTop = thread.value.scrollHeight;
}

const HELP = [
  'Commands:',
  '  status — list all jobs',
  '  new <repo> <brief…> — launch a job',
  '  redirect <id> <message…> — steer a job',
  '  pause | resume | kill <id>',
  '  allow <ESC-id> | deny <ESC-id> — answer an escalation',
].join('\n');

async function run(raw: string) {
  const text = raw.trim();
  if (!text) return;
  push({ role: 'user', text });
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  try {
    switch ((cmd ?? '').toLowerCase()) {
      case 'help':
        push({ role: 'assistant', text: HELP });
        break;
      case 'status':
      case 'jobs': {
        const jobs = store.list;
        push({ role: 'assistant', text: jobs.length ? `${jobs.length} job(s):` : 'No jobs yet.', jobs });
        break;
      }
      case 'new': {
        const repo = rest[0];
        const brief = rest.slice(1).join(' ');
        if (!repo || !brief) { push({ role: 'assistant', text: 'Usage: new <repo> <brief…>' }); break; }
        const job = await api.createJob({ name: brief.slice(0, 40), brief, repoPath: repo });
        push({ role: 'assistant', text: `Launched ${job.id}.`, jobs: [job] });
        break;
      }
      case 'redirect': {
        const id = rest[0]; const msg = rest.slice(1).join(' ');
        if (!id || !msg) { push({ role: 'assistant', text: 'Usage: redirect <id> <message…>' }); break; }
        await api.redirect(id, msg);
        push({ role: 'assistant', text: `Sent to ${id} — applies at the next turn boundary.` });
        break;
      }
      case 'pause': case 'resume': case 'kill': {
        if (!arg) { push({ role: 'assistant', text: `Usage: ${cmd} <id>` }); break; }
        await api[cmd as 'pause' | 'resume' | 'kill'](arg);
        push({ role: 'assistant', text: `${cmd} → ${arg}` });
        break;
      }
      case 'allow': case 'deny': {
        if (!arg) { push({ role: 'assistant', text: `Usage: ${cmd} <ESC-id>` }); break; }
        await store.resolveEscalation(arg, cmd as 'allow' | 'deny');
        push({ role: 'assistant', text: `Escalation ${arg} → ${cmd}` });
        break;
      }
      default:
        if (hermes.value) {
          await askHermes(text);
        } else {
          push({ role: 'assistant', text: `Unknown command. ${HELP}` });
        }
    }
  } catch {
    push({ role: 'assistant', text: 'That failed — check the id / token and try again.' });
  }
}

// Stream a free-text turn to Hermes, appending deltas live to one assistant bubble.
async function askHermes(text: string) {
  const msg: Msg = { id: ++uid, role: 'assistant', text: '' };
  messages.value.push(msg);
  const history = messages.value
    .filter((m) => m.text)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text! }));
  const r = await chatStream([...history, { role: 'user', content: text }], (d) => {
    msg.text = (msg.text ?? '') + d;
    void scroll();
  });
  if (r.disabled) msg.text = `Hermes isn't connected. Type 'help' for commands.`;
  else if (r.error) msg.text = `Hermes error: ${r.error}`;
}

async function answer(escId: string, decision: 'allow' | 'deny') {
  await store.resolveEscalation(escId, decision);
  push({ role: 'assistant', text: `Escalation ${escId} → ${decision}` });
}

function submit() {
  const t = input.value;
  input.value = '';
  void run(t);
}

onMounted(async () => {
  try {
    const cfg = await api.config();
    hermes.value = cfg.hermes.enabled;
  } catch { /* ignore */ }
  push({
    role: 'assistant',
    text: hermes.value
      ? "Connected to Hermes. Ask me anything, or use commands (type 'help')."
      : "Hermes isn't connected, so I'm in command mode. Type 'help' to see what I can do.",
  });
});
</script>

<template>
  <q-page class="chat column no-wrap">
    <div ref="thread" class="thread col q-px-md q-py-md">
      <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
        <div class="bubble" :class="m.role">
          <pre v-if="m.text" class="mono bubble-text">{{ m.text }}</pre>
          <div v-if="m.jobs" class="q-mt-xs column q-gutter-xs">
            <div v-for="j in m.jobs" :key="j.id" class="jobmini row items-center" @click="router.push(`/jobs/${j.id}`)">
              <span class="col ellipsis name">{{ j.name }}</span>
              <span class="mono text-muted id">{{ j.id }}</span>
              <StatusPill :state="j.state" />
              <ExternalLink :size="14" class="text-muted q-ml-xs" />
            </div>
          </div>
        </div>
      </div>

      <!-- Inline escalation answer cards (the design's amber answer card) -->
      <div v-for="e in openEscalations" :key="e.id" class="msg-row assistant">
        <div class="esc-card">
          <div class="row items-center q-gutter-xs head">
            <span class="dot" /> <span class="text-weight-600">{{ store.job(e.jobId)?.name ?? e.jobId }} needs you</span>
            <q-space /><span class="mono text-muted">{{ e.id }}</span>
          </div>
          <div class="q-mt-xs">{{ e.question }}</div>
          <pre v-if="e.proposedAction" class="mono esc-code">{{ e.proposedAction }}</pre>
          <div class="row q-gutter-sm q-mt-sm">
            <q-btn unelevated dense no-caps class="allow" @click="answer(e.id, 'allow')"><Check :size="15" class="q-mr-xs" /> Allow</q-btn>
            <q-btn outline dense no-caps class="deny" @click="answer(e.id, 'deny')"><X :size="15" class="q-mr-xs" /> Deny</q-btn>
          </div>
        </div>
      </div>
    </div>

    <div class="composer row items-center no-wrap q-pa-sm">
      <q-input v-model="input" dense borderless class="col composer-input mono" :placeholder="hermes ? 'Message Hermes…' : 'Type a command (try: status)'" @keyup.enter="submit" />
      <q-btn flat round dense class="send" @click="submit"><Send :size="18" /></q-btn>
    </div>
  </q-page>
</template>

<style scoped>
.chat { height: 100%; }
.thread { overflow-y: auto; }
.msg-row { display: flex; margin-bottom: 10px; }
.msg-row.user { justify-content: flex-end; }
.bubble { max-width: 80%; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--fg-border); }
.bubble.assistant { background: var(--fg-surface); border-bottom-left-radius: 2px; }
.bubble.user { background: var(--fg-surface-elevated); border-bottom-right-radius: 2px; }
.bubble-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--fg-text); font-family: 'JetBrains Mono', monospace; }
.jobmini { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 6px; padding: 8px 10px; gap: 8px; cursor: pointer; min-width: 240px; }
.jobmini .name { font-size: 13px; font-weight: 500; }
.jobmini .id { font-size: 11px; }
.esc-card { max-width: 86%; background: var(--fg-surface-elevated); border: 1px solid rgba(255, 176, 32, 0.5); border-radius: 10px; padding: 12px; }
.esc-card .head .dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--fg-accent); display: inline-block; }
.esc-code { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 120px; overflow: auto; margin: 8px 0 0; color: var(--fg-text-2); }
.allow { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.deny { color: var(--fg-text-2); border-color: var(--fg-border); border-radius: 4px; }
.composer { border-top: 1px solid var(--fg-border); background: var(--fg-surface); }
.composer-input { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.send { color: var(--fg-accent); }
</style>
