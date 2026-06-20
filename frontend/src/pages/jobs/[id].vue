<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { ArrowLeft, Pause, Play, Square, Check, GitBranch, Send } from 'lucide-vue-next';
import { useJobsStore } from '../../stores/jobs';
import { api } from '../../lib/api';
import StatusPill from '../../components/StatusPill.vue';
import BurnMeter from '../../components/BurnMeter.vue';
import LogConsole from '../../components/LogConsole.vue';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const store = useJobsStore();

const id = computed(() => String((route.params as Record<string, string>).id ?? ''));
const job = computed(() => store.job(id.value));
const events = computed(() => store.detailEvents);
const tab = ref<'log' | 'plan' | 'files' | 'audit'>('log');
const redirectText = ref('');
const paused = ref(false);

const planText = computed(() => {
  const p = [...events.value].reverse().find((e) => e.type === 'plan' || e.type === 'director');
  return p?.message ?? 'No plan yet.';
});
// The real changed-file list comes from the latest 'file' event the orchestrator emits.
const files = computed(() => {
  const fe = [...events.value].reverse().find((e) => e.type === 'file');
  return ((fe?.data?.files as string[] | undefined) ?? []).filter(Boolean);
});
// Audit = the gate's per-call rule decisions + router verdicts + escalations + state changes.
const auditEvents = computed(() =>
  events.value.filter(
    (e) => e.type === 'tool' || e.type === 'router' || e.type === 'escalation' || e.type === 'state',
  ),
);

watch(id, (v) => v && store.openDetail(v), { immediate: false });
onMounted(() => store.openDetail(id.value));
onUnmounted(() => store.closeDetail());

async function doRedirect() {
  const msg = redirectText.value.trim();
  if (!msg) return;
  redirectText.value = '';
  await api.redirect(id.value, msg).catch(() => notify('Redirect failed', 'negative'));
  notify('Redirect sent — applies at the next turn boundary');
}
async function pauseResume() {
  if (paused.value) {
    await api.resume(id.value);
    paused.value = false;
  } else {
    await api.pause(id.value);
    paused.value = true;
  }
}
async function kill() {
  await api.kill(id.value);
  notify('Kill signal sent', 'warning');
}
async function approvePlan() {
  await api.redirect(id.value, 'Plan approved — proceed.');
  notify('Plan approved');
}
function notify(message: string, color = 'positive') {
  $q.notify({ message, color, position: 'top', timeout: 1800 });
}
function hhmmss(ts: string) {
  return new Date(ts).toTimeString().slice(0, 8);
}
</script>

<template>
  <q-page class="detail column no-wrap" v-if="job">
    <!-- Header -->
    <div class="dheader q-px-md q-py-sm">
      <div class="row items-center no-wrap q-gutter-sm">
        <q-btn flat round dense size="sm" @click="router.back()"><ArrowLeft :size="18" /></q-btn>
        <div class="col">
          <div class="row items-center q-gutter-sm">
            <span class="text-weight-600 jname ellipsis">{{ job.name }}</span>
            <StatusPill :state="job.state" />
          </div>
          <div class="row items-center q-gutter-sm q-mt-xs">
            <span class="mono text-muted jid">{{ job.id }}</span>
            <span class="code-chip"><GitBranch :size="11" /> {{ job.branch }}</span>
          </div>
        </div>
        <div class="row items-center q-gutter-xs controls">
          <q-btn flat dense no-caps size="sm" class="ctrl" @click="pauseResume">
            <component :is="paused ? Play : Pause" :size="15" /> <span class="gt-xs q-ml-xs">{{ paused ? 'Resume' : 'Pause' }}</span>
          </q-btn>
          <q-btn flat dense no-caps size="sm" class="ctrl ctrl-danger" @click="kill">
            <Square :size="15" /> <span class="gt-xs q-ml-xs">Kill</span>
          </q-btn>
          <q-btn v-if="job.state === 'review'" unelevated dense no-caps size="sm" class="ctrl-approve" @click="approvePlan">
            <Check :size="15" /> <span class="q-ml-xs">Approve</span>
          </q-btn>
        </div>
      </div>

      <!-- Burn meters -->
      <div class="row q-gutter-lg q-mt-sm burns">
        <BurnMeter label="TURNS" :value="job.turns" :max="job.maxTurns" />
        <BurnMeter label="TOKENS" :value="job.tokens" :max="Math.max(job.tokens, 100000)" color="var(--fg-planning)" />
        <div class="cost mono text-muted">${{ job.costUsd.toFixed(4) }}</div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs row q-px-md">
      <button v-for="t in (['log','plan','files','audit'] as const)" :key="t" class="tabbtn mono" :class="{ on: tab === t }" @click="tab = t">
        {{ t === 'log' ? 'LOG.CONSOLE' : t === 'plan' ? 'PLAN' : t === 'files' ? `FILES(${files.length})` : 'AUDIT' }}
      </button>
    </div>

    <!-- Body -->
    <div class="col body">
      <LogConsole v-show="tab === 'log'" :events="events" />
      <div v-show="tab === 'plan'" class="q-pa-md plan-pane">
        <pre class="mono plan-text">{{ planText }}</pre>
      </div>
      <div v-show="tab === 'files'" class="q-pa-md">
        <div v-if="!files.length" class="text-muted">No files changed yet.</div>
        <div v-for="f in files" :key="f" class="code-chip file-row q-mb-xs">{{ f }}</div>
      </div>
      <div v-show="tab === 'audit'" class="q-pa-md audit">
        <div v-for="e in auditEvents" :key="e.id" class="audit-row row no-wrap q-py-xs">
          <span class="mono text-muted ts">{{ hhmmss(e.ts) }}</span>
          <span class="mono tag" :class="`t-${e.type}`">{{ e.type.toUpperCase() }}</span>
          <span class="col msg">{{ e.message }}</span>
        </div>
      </div>
    </div>

    <!-- Command input -->
    <div class="composer row items-center no-wrap q-pa-sm">
      <q-input
        v-model="redirectText"
        dense borderless
        class="col composer-input mono"
        placeholder="Tell this job to…"
        @keyup.enter="doRedirect"
      />
      <q-btn flat round dense class="send" @click="doRedirect"><Send :size="18" /></q-btn>
    </div>
  </q-page>

  <q-page v-else class="flex flex-center text-muted">Loading {{ id }}…</q-page>
</template>

<style scoped>
.detail { height: 100%; }
.dheader { border-bottom: 1px solid var(--fg-border); background: var(--fg-surface); }
.jname { font-size: 16px; max-width: 40vw; }
.jid { font-size: 12px; }
.controls .ctrl { border: 1px solid var(--fg-border); border-radius: 4px; color: var(--fg-text-2); }
.ctrl-danger { color: var(--fg-failed) !important; }
.ctrl-approve { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.burns { align-items: center; }
.cost { font-size: 12px; align-self: flex-end; }
.tabs { border-bottom: 1px solid var(--fg-border); gap: 18px; }
.tabbtn { background: none; border: none; color: var(--fg-muted); padding: 10px 0; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; }
.tabbtn.on { color: var(--fg-text); border-bottom-color: var(--fg-accent); }
.body { overflow: hidden; position: relative; min-height: 240px; }
.body > * { position: absolute; inset: 0; overflow-y: auto; }
.plan-text { white-space: pre-wrap; font-size: 12px; color: var(--fg-text-2); line-height: 1.6; }
.file-row { display: block; width: fit-content; }
.audit-row { gap: 10px; border-bottom: 1px solid var(--fg-border); font-size: 12px; }
.audit .ts { width: 64px; }
.audit .tag { width: 70px; }
.t-router { color: var(--fg-planning); }
.t-escalation { color: var(--fg-accent); }
.t-state { color: var(--fg-review); }
.t-tool { color: var(--fg-running); }
.composer { border-top: 1px solid var(--fg-border); background: var(--fg-surface); }
.composer-input { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.send { color: var(--fg-accent); }
</style>
