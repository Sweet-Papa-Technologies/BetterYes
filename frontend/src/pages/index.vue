<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { Plus } from 'lucide-vue-next';
import { useJobsStore } from '../stores/jobs';
import JobCard from '../components/JobCard.vue';
import JobRow from '../components/JobRow.vue';
import NeedsYouBand from '../components/NeedsYouBand.vue';

const $q = useQuasar();
const router = useRouter();
const store = useJobsStore();

const s = computed(() => store.summary);
const jobs = computed(() => store.list);
const newJob = () => router.push('/new');
</script>

<template>
  <q-page class="board">
    <!-- Top bar -->
    <div class="topbar row items-center justify-between q-px-md q-py-sm">
      <div class="row items-center q-gutter-md">
        <span v-if="!$q.screen.gt.sm" class="brand">FOREMAN</span>
        <span class="mono summary">
          <span class="text-running">{{ s.running }} running</span>
          <span class="text-muted"> · </span>
          <span :class="s.needsYou ? 'text-accent' : 'text-muted'">{{ s.needsYou }} needs you</span>
          <span class="text-muted"> · </span>
          <span class="text-2">{{ s.done }} done</span>
        </span>
      </div>
      <q-btn unelevated dense no-caps class="new-btn" @click="newJob">
        <Plus :size="16" class="q-mr-xs" /> New Job
      </q-btn>
    </div>

    <div class="q-pa-md">
      <NeedsYouBand :jobs="store.needsYouJobs" class="q-mb-md" />

      <!-- Empty state -->
      <div v-if="store.loaded && !jobs.length" class="empty column flex-center q-pa-xl text-center">
        <div class="empty-grid q-mb-md" />
        <div class="text-h6 text-weight-600">No jobs yet</div>
        <div class="text-2 q-mt-xs">Launch your first one to start supervising.</div>
        <q-btn unelevated no-caps class="new-btn q-mt-lg" @click="newJob"><Plus :size="16" class="q-mr-xs" /> New Job</q-btn>
      </div>

      <!-- Mobile: cards -->
      <div v-else-if="!$q.screen.gt.sm" class="column q-gutter-md">
        <JobCard v-for="j in jobs" :key="j.id" :job="j" />
      </div>

      <!-- Desktop: dense rows -->
      <div v-else class="panel rows">
        <div class="row items-center no-wrap header-row mono text-muted">
          <div class="col-title">JOB TITLE</div>
          <div class="col-id">ID</div>
          <div class="col-branch">BRANCH</div>
          <div class="col-status">STATUS</div>
          <div class="col-activity">LAST ACTIVITY</div>
          <div class="col-files">FILES</div>
          <div class="col-burn">BURN</div>
        </div>
        <JobRow v-for="j in jobs" :key="j.id" :job="j" />
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.topbar { border-bottom: 1px solid var(--fg-border); background: var(--fg-surface); position: sticky; top: 0; z-index: 5; }
.brand { font-family: 'JetBrains Mono', monospace; font-weight: 600; letter-spacing: 0.06em; color: var(--fg-accent); }
.summary { font-size: 13px; }
.text-running { color: var(--fg-running); }
.text-accent { color: var(--fg-accent); }
.new-btn { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; padding: 4px 12px; }
.header-row { padding: 10px 16px; border-bottom: 1px solid var(--fg-border); font-size: 10px; letter-spacing: 0.05em; gap: 12px; }
.header-row .col-title { flex: 0 0 200px; }
.header-row .col-id { flex: 0 0 90px; }
.header-row .col-branch { flex: 0 0 150px; }
.header-row .col-status { flex: 0 0 120px; }
.header-row .col-activity { flex: 1 1 auto; }
.header-row .col-files { flex: 0 0 50px; text-align: right; }
.header-row .col-burn { flex: 0 0 110px; }
.rows { overflow: hidden; }
.empty-grid {
  width: 80px; height: 80px; opacity: 0.5;
  background-image: linear-gradient(var(--fg-border) 1px, transparent 1px), linear-gradient(90deg, var(--fg-border) 1px, transparent 1px);
  background-size: 16px 16px;
  border: 1px solid var(--fg-accent);
}
</style>
