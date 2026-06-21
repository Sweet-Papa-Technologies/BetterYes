<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { Send, Plus, Search, Paperclip, Trash2, X, Check, Wrench, ExternalLink, MessagesSquare } from 'lucide-vue-next';
import type { ChatAttachment, ChatMessage, ConversationSummary } from '@foreman/shared';
import { api, sendConversationMessage } from '../lib/api';
import { useJobsStore } from '../stores/jobs';
import { timeAgo } from '../lib/ui';
import { useNow } from '../composables/useNow';

// S7 — persistent Hermes chat. Conversations are stored in the daemon; Hermes can act on
// FOREMAN over MCP (dispatch / status / redirect), so this is both a chat and a control surface.
const router = useRouter();
const store = useJobsStore();
const $q = useQuasar();
const now = useNow();

const hermesEnabled = ref(true);
const conversations = ref<ConversationSummary[]>([]);
const search = ref('');
const activeId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref('');
const pending = ref<ChatAttachment[]>([]);
const sending = ref(false);
const toolStatus = ref<string | null>(null);
const thread = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const showList = ref(false); // mobile: conversation list drawer

const openEscalations = computed(() => store.escalations);
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return conversations.value;
  return conversations.value.filter((c) => `${c.title} ${c.lastMessage ?? ''}`.toLowerCase().includes(q));
});

async function scroll() {
  await nextTick();
  if (thread.value) thread.value.scrollTop = thread.value.scrollHeight;
}

async function loadConversations() {
  try {
    conversations.value = await api.conversations.list();
  } catch {
    /* token / daemon */
  }
}

async function openConversation(id: string) {
  activeId.value = id;
  showList.value = false;
  try {
    messages.value = (await api.conversations.get(id)).messages;
    void scroll();
  } catch {
    messages.value = [];
  }
}

async function newConversation() {
  const c = await api.conversations.create();
  conversations.value.unshift(c);
  activeId.value = c.id;
  messages.value = [];
  showList.value = false;
}

function confirmDelete(id: string) {
  $q.dialog({ title: 'Delete chat', message: 'Delete this conversation? This cannot be undone.', cancel: true, ok: { label: 'Delete', color: 'negative', noCaps: true } })
    .onOk(async () => {
      await api.conversations.remove(id);
      conversations.value = conversations.value.filter((c) => c.id !== id);
      if (activeId.value === id) {
        activeId.value = null;
        messages.value = [];
      }
    });
}

// ── Attachments ──────────────────────────────────────────────────────────────
function pickFiles() {
  fileInput.value?.click();
}
async function onFiles(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (file.size > 5 * 1024 * 1024) {
      $q.notify({ message: `${file.name} is over 5 MB`, color: 'warning', position: 'top' });
      continue;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const att = await api.upload({ ...(activeId.value ? { conversationId: activeId.value } : {}), name: file.name, type: file.type, dataBase64 });
      pending.value.push(att);
    } catch {
      $q.notify({ message: `Couldn't attach ${file.name}`, color: 'negative', position: 'top' });
    }
  }
  (e.target as HTMLInputElement).value = '';
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// ── Send ─────────────────────────────────────────────────────────────────────
async function send() {
  const content = input.value.trim();
  if ((!content && !pending.value.length) || sending.value) return;
  if (!activeId.value) await newConversation();
  const attachments = pending.value.slice();
  input.value = '';
  pending.value = [];
  sending.value = true;
  toolStatus.value = null;

  // `live` is the reactive array element (a proxy) — mutate THROUGH it so Vue re-renders each
  // streamed chunk (mutating a raw pushed object wouldn't trigger reactivity).
  let live: ChatMessage | null = null;

  await sendConversationMessage(
    activeId.value!,
    { content, attachments },
    {
      onUser: (m) => {
        messages.value.push(m);
        messages.value.push({ id: -Date.now(), conversationId: activeId.value!, role: 'assistant', content: '', createdAt: new Date().toISOString(), toolCalls: [] });
        live = messages.value[messages.value.length - 1]!;
        void scroll();
      },
      onDelta: (d) => { if (live) live.content += d; void scroll(); },
      onTool: (name) => { toolStatus.value = name; if (live) (live.toolCalls ??= []).push(name); },
      onDone: (m) => { if (live) Object.assign(live, m); finishSend(); },
      onDisabled: () => { if (live) live.content = "Hermes isn't connected. Enable it in Settings to chat."; finishSend(); },
      onError: (e) => { if (live && !live.content) live.content = `Error: ${e}`; finishSend(); },
    },
  );
}
function finishSend() {
  sending.value = false;
  toolStatus.value = null;
  void loadConversations(); // refresh titles / order
  void scroll();
}

async function answer(escId: string, decision: 'allow' | 'deny') {
  await store.resolveEscalation(escId, decision);
}

onMounted(async () => {
  try {
    hermesEnabled.value = (await api.config()).hermes.enabled;
  } catch {
    /* ignore */
  }
  await loadConversations();
  if (conversations.value[0]) await openConversation(conversations.value[0].id);
});
</script>

<template>
  <q-page class="chat row no-wrap">
    <!-- Conversation list -->
    <aside class="convos column no-wrap" :class="{ open: showList }">
      <div class="convos-head row items-center q-gutter-xs">
        <q-btn unelevated dense no-caps class="new-convo col" @click="newConversation"><Plus :size="15" class="q-mr-xs" /> New chat</q-btn>
      </div>
      <div class="search row items-center no-wrap q-mx-sm q-mb-sm">
        <Search :size="14" class="text-muted" />
        <input v-model="search" class="search-input mono" placeholder="Search chats…" />
      </div>
      <div class="convo-list col">
        <div v-if="!filtered.length" class="text-muted q-pa-md text-center sm">No conversations yet.</div>
        <div
          v-for="c in filtered" :key="c.id"
          class="convo row items-center no-wrap" :class="{ active: c.id === activeId }"
          @click="openConversation(c.id)"
        >
          <MessagesSquare :size="14" class="text-muted q-mr-sm" />
          <div class="col convo-meta">
            <div class="convo-title ellipsis">{{ c.title }}</div>
            <div class="convo-sub ellipsis mono text-muted">{{ timeAgo(c.updatedAt, now) }} · {{ c.lastMessage ?? '—' }}</div>
          </div>
          <q-btn flat round dense size="xs" class="del" @click.stop="confirmDelete(c.id)"><Trash2 :size="13" /></q-btn>
        </div>
      </div>
    </aside>

    <!-- Thread -->
    <section class="pane col column no-wrap">
      <div class="pane-head row items-center no-wrap q-px-md q-py-sm">
        <q-btn flat dense size="sm" class="lt-md convos-toggle q-mr-sm" @click="showList = !showList"><MessagesSquare :size="16" /></q-btn>
        <span class="col ellipsis title">{{ conversations.find(c => c.id === activeId)?.title ?? 'Chat' }}</span>
        <span v-if="!hermesEnabled" class="hermes-off mono" @click="router.push('/settings')">Hermes off — enable in Settings</span>
      </div>

      <div ref="thread" class="thread col q-px-md q-py-md">
        <div v-if="!activeId && !messages.length" class="empty column flex-center text-center q-pa-xl">
          <MessagesSquare :size="40" class="text-muted q-mb-sm" />
          <div class="text-2">Start a conversation with Hermes.</div>
          <div class="text-muted sm q-mt-xs">It can answer questions and run FOREMAN actions (dispatch, status, redirect).</div>
        </div>

        <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
          <div class="bubble" :class="m.role">
            <div v-if="m.attachments?.length" class="atts row q-gutter-xs q-mb-xs">
              <span v-for="a in m.attachments" :key="a.name" class="att-chip mono"><Paperclip :size="11" /> {{ a.name }}</span>
            </div>
            <pre v-if="m.content" class="mono bubble-text">{{ m.content }}</pre>
            <span v-else-if="m.role === 'assistant' && sending" class="thinking row items-center q-gutter-xs">
              <q-spinner-dots size="18px" color="amber" />
              <span v-if="toolStatus" class="tool-now mono"><Wrench :size="12" /> {{ toolStatus }}…</span>
            </span>
            <div v-if="m.toolCalls?.length" class="tools row q-gutter-xs q-mt-xs">
              <span v-for="t in m.toolCalls" :key="t" class="tool-chip mono"><Wrench :size="11" /> {{ t }}</span>
            </div>
          </div>
        </div>

        <!-- Live escalation answer cards -->
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

      <!-- Composer -->
      <div class="composer column q-pa-sm">
        <div v-if="pending.length" class="pending row q-gutter-xs q-mb-xs">
          <span v-for="(a, i) in pending" :key="a.name + i" class="att-chip mono">
            <Paperclip :size="11" /> {{ a.name }}
            <X :size="12" class="rm" @click="pending.splice(i, 1)" />
          </span>
        </div>
        <div class="row items-center no-wrap">
          <input ref="fileInput" type="file" multiple class="hidden-file" @change="onFiles" />
          <q-btn flat round dense class="attach" :disable="sending" @click="pickFiles" aria-label="Attach files"><Paperclip :size="18" /></q-btn>
          <q-input
            v-model="input" dense borderless type="textarea" autogrow :max-rows="5"
            class="col composer-input mono"
            :placeholder="hermesEnabled ? 'Message Hermes…  (Enter to send, Shift+Enter for newline)' : 'Enable Hermes in Settings to chat'"
            @keydown.enter.exact.prevent="send"
          />
          <q-btn flat round dense class="send" :loading="sending" :disable="!input.trim() && !pending.length" @click="send"><Send :size="18" /></q-btn>
        </div>
      </div>
    </section>
  </q-page>
</template>

<style scoped>
.chat { height: 100%; }
.convos { width: 260px; border-right: 1px solid var(--fg-border); background: var(--fg-surface); }
.convos-head { padding: 10px; }
.new-convo { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.search { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 3px 8px; gap: 6px; }
.search-input { background: none; border: none; outline: none; color: var(--fg-text); font-size: 13px; width: 100%; }
.search-input::placeholder { color: var(--fg-muted); }
.convo-list { overflow-y: auto; }
.convo { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--fg-border); }
.convo:hover { background: var(--fg-surface-elevated); }
.convo.active { background: var(--fg-surface-elevated); border-left: 2px solid var(--fg-accent); }
.convo-meta { min-width: 0; }
.convo-title { font-size: 13px; font-weight: 500; }
.convo-sub { font-size: 10px; }
.del { color: var(--fg-muted); opacity: 0; }
.convo:hover .del { opacity: 1; }
.pane { min-width: 0; }
.pane-head { border-bottom: 1px solid var(--fg-border); background: var(--fg-surface); }
.title { font-size: 14px; font-weight: 600; }
.hermes-off { font-size: 11px; color: var(--fg-accent); cursor: pointer; }
.thread { overflow-y: auto; }
.msg-row { display: flex; margin-bottom: 10px; }
.msg-row.user { justify-content: flex-end; }
.bubble { max-width: 80%; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--fg-border); }
.bubble.assistant { background: var(--fg-surface); border-bottom-left-radius: 2px; }
.bubble.user { background: var(--fg-surface-elevated); border-bottom-right-radius: 2px; }
.bubble-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--fg-text); font-family: 'JetBrains Mono', monospace; }
.thinking { color: var(--fg-muted); }
.tool-now { font-size: 11px; color: var(--fg-accent); display: inline-flex; align-items: center; gap: 3px; }
.att-chip, .tool-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 1px 6px; color: var(--fg-text-2); }
.tool-chip { color: var(--fg-accent); border-color: rgba(255,176,32,0.4); }
.att-chip .rm { cursor: pointer; }
.esc-card { max-width: 86%; background: var(--fg-surface-elevated); border: 1px solid rgba(255, 176, 32, 0.5); border-radius: 10px; padding: 12px; }
.esc-card .head .dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--fg-accent); display: inline-block; }
.esc-code { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 120px; overflow: auto; margin: 8px 0 0; color: var(--fg-text-2); }
.allow { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.deny { color: var(--fg-text-2); border-color: var(--fg-border); border-radius: 4px; }
.composer { border-top: 1px solid var(--fg-border); background: var(--fg-surface); }
.composer-input { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.attach { color: var(--fg-text-2); }
.send { color: var(--fg-accent); }
.hidden-file { display: none; }
.sm { font-size: 12px; }
/* Mobile: conversation list slides over */
@media (max-width: 1023px) {
  .convos { position: absolute; z-index: 20; height: 100%; transform: translateX(-100%); transition: transform 0.2s; }
  .convos.open { transform: translateX(0); }
}
</style>
