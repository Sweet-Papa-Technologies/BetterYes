<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { TriangleAlert, Check, X, CornerDownLeft } from 'lucide-vue-next';
import type { Escalation } from '@foreman/shared';
import { useJobsStore } from '../stores/jobs';

// S3 — "the single most important moment in the whole app." A job stopped to ask the human.
// Mobile: bottom sheet over a dimmed board. Desktop: centered modal. Two-tap to resolve.
const props = defineProps<{ escalation: Escalation }>();
const $q = useQuasar();
const store = useJobsStore();

const open = ref(true);
const answer = ref('');
const busy = ref(false);

const job = computed(() => store.job(props.escalation.jobId));
const HOLD_MS = 30 * 60 * 1000;
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => timer && clearInterval(timer));

const remaining = computed(() => {
  const ms = Math.max(0, new Date(props.escalation.createdAt).getTime() + HOLD_MS - now.value);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
});

async function resolve(decision: 'allow' | 'deny') {
  busy.value = true;
  try {
    await store.resolveEscalation(props.escalation.id, decision, answer.value.trim() || undefined);
    open.value = false;
  } catch {
    $q.notify({ message: 'Could not resolve — try again', color: 'negative', position: 'top' });
  } finally {
    busy.value = false;
  }
}
function sendAnswer() {
  if (!answer.value.trim()) return;
  void resolve('allow'); // a typed instruction proceeds with that guidance
}
</script>

<template>
  <q-dialog
    v-model="open"
    :position="$q.screen.gt.sm ? 'standard' : 'bottom'"
    persistent
    no-route-dismiss
  >
    <div class="esc panel-elevated" :class="$q.screen.gt.sm ? 'esc-modal' : 'esc-sheet'">
      <div class="row items-center q-gutter-sm header">
        <TriangleAlert :size="18" class="amber" />
        <div class="col">
          <div class="text-weight-600">{{ job?.name ?? 'A job' }} needs you</div>
          <div class="mono text-muted jid">{{ escalation.jobId }}</div>
        </div>
        <span class="mono text-muted hold">auto-holds in {{ remaining }}</span>
      </div>

      <div class="q-mt-md question">{{ escalation.question }}</div>

      <div v-if="escalation.proposedAction" class="q-mt-sm">
        <div class="lbl mono">PROPOSED</div>
        <pre class="code-block mono">{{ escalation.proposedAction }}</pre>
      </div>

      <div v-if="escalation.reason" class="why q-mt-sm">
        <div class="lbl mono">WHY</div>
        <div class="text-2">{{ escalation.reason }}</div>
      </div>

      <div class="q-mt-md">
        <q-input
          v-model="answer"
          dense borderless
          class="answer mono"
          placeholder="…or tell it what to do instead"
          @keyup.enter="sendAnswer"
        >
          <template #append>
            <q-btn flat round dense :disable="!answer.trim()" @click="sendAnswer"><CornerDownLeft :size="16" /></q-btn>
          </template>
        </q-input>
      </div>

      <div class="row q-gutter-sm q-mt-md actions">
        <q-btn unelevated no-caps class="allow col" :loading="busy" @click="resolve('allow')">
          <Check :size="18" class="q-mr-xs" /> Allow
        </q-btn>
        <q-btn outline no-caps class="deny" :loading="busy" @click="resolve('deny')">
          <X :size="18" class="q-mr-xs" /> Deny
        </q-btn>
      </div>
    </div>
  </q-dialog>
</template>

<style scoped>
.esc {
  background: var(--fg-surface-elevated);
  border: 1px solid rgba(255, 176, 32, 0.5);
  padding: 20px;
}
.esc-sheet { width: 100vw; border-radius: 12px 12px 0 0; border-bottom: none; }
.esc-modal { width: 460px; max-width: 92vw; border-radius: 8px; }
.amber { color: var(--fg-accent); }
.jid { font-size: 11px; }
.hold { font-size: 11px; }
.question { font-size: 15px; line-height: 1.5; }
.lbl { font-size: 10px; letter-spacing: 0.05em; color: var(--fg-muted); margin-bottom: 4px; }
.code-block {
  background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px;
  padding: 10px; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--fg-text-2);
  max-height: 160px; overflow: auto; margin: 0;
}
.answer { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.allow { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; padding: 10px; }
.deny { color: var(--fg-text-2); border-color: var(--fg-border); border-radius: 4px; padding: 10px; }
.actions { flex-wrap: nowrap; }
</style>
