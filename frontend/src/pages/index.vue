<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { Plus, Search, X } from 'lucide-vue-next';
import { useJobsStore } from '../stores/jobs';
import { needsYou } from '../lib/status';
import JobCard from '../components/JobCard.vue';
import JobRow from '../components/JobRow.vue';
import NeedsYouBand from '../components/NeedsYouBand.vue';

const $q = useQuasar();
const router = useRouter();
const store = useJobsStore();

const s = computed(() => store.summary);
const query = ref('');
type StatusFilter = 'all' | 'running' | 'needs' | 'done';
const statusFilter = ref<StatusFilter>('all');
function toggleStatus(f: StatusFilter) {
  statusFilter.value = statusFilter.value === f ? 'all' : f;
}

const jobs = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.list.filter((j) => {
    if (term && !`${j.name} ${j.id} ${j.branch} ${j.lastActivity}`.toLowerCase().includes(term)) return false;
    if (statusFilter.value === 'running' && j.state !== 'running' && j.state !== 'planning') return false;
    if (statusFilter.value === 'needs' && !needsYou(j.state)) return false;
    if (statusFilter.value === 'done' && j.state !== 'done') return false;
    return true;
  });
});
const filtering = computed(() => !!query.value.trim() || statusFilter.value !== 'all');

const newJob = () => router.push('/new');
const retry = () => store.loadAndSubscribe();
</script>

<template>
  <q-page class="board">
    <!-- Top bar -->
    <div class="topbar row items-center justify-between q-px-md q-py-sm">
      <div class="row items-center q-gutter-md">
        <span v-if="!$q.screen.gt.sm" class="brand row items-center q-gutter-xs">
          FOREMAN
          <span class="conn" :class="store.live ? 'live' : 'down'" :title="store.live ? 'live' : 'reconnecting…'" />
        </span>
        <span class="mono summary">
          <button class="fchip text-running" :class="{ on: statusFilter === 'running' }" @click="toggleStatus('running')">{{ s.running }} running</button>
          <span class="text-muted"> · </span>
          <button class="fchip" :class="[s.needsYou ? 'text-accent' : 'text-muted', { on: statusFilter === 'needs' }]" @click="toggleStatus('needs')">{{ s.needsYou }} needs you</button>
          <span class="text-muted"> · </span>
          <button class="fchip text-2" :class="{ on: statusFilter === 'done' }" @click="toggleStatus('done')">{{ s.done }} done</button>
        </span>
      </div>
      <div class="row items-center q-gutter-sm">
        <div class="search row items-center no-wrap">
          <Search :size="14" class="text-muted" />
          <input v-model="query" class="search-input mono" placeholder="Filter jobs…" aria-label="Filter jobs" />
          <button v-if="query" class="search-clear" aria-label="Clear filter" @click="query = ''"><X :size="13" /></button>
        </div>
        <q-btn unelevated dense no-caps class="new-btn" @click="newJob">
          <Plus :size="16" class="q-mr-xs" /> New Job
        </q-btn>
      </div>
    </div>

    <div class="q-pa-md">
      <!-- Daemon-down / unauthorized banner (distinct from the empty state) -->
      <div v-if="store.loadError" class="needs-you-band q-pa-md q-mb-md row items-center justify-between">
        <span>
          {{ store.loadError === 'unauthorized'
            ? 'Unauthorized — set your dashboard token in Settings.'
            : 'Can\'t reach the FOREMAN daemon. Is it running?' }}
        </span>
        <q-btn flat dense no-caps :to="store.loadError === 'unauthorized' ? '/settings' : undefined" @click="retry">
          {{ store.loadError === 'unauthorized' ? 'Settings' : 'Retry' }}
        </q-btn>
      </div>

      <NeedsYouBand :jobs="store.needsYouJobs" class="q-mb-md" />

      <!-- Loading skeletons (brief §5) -->
      <div v-if="!store.loaded" class="column q-gutter-md">
        <div v-for="n in 4" :key="n" class="panel q-pa-md">
          <div class="row items-center justify-between">
            <q-skeleton type="text" width="40%" dark />
            <q-skeleton type="QChip" width="70px" dark />
          </div>
          <q-skeleton type="text" width="55%" class="q-mt-sm" dark />
          <q-skeleton type="rect" height="4px" class="q-mt-md" dark />
        </div>
      </div>

      <!-- Empty state — no jobs at all -->
      <div v-else-if="store.loaded && !store.loadError && !store.list.length" class="empty column flex-center q-pa-xl text-center">
        <div class="empty-grid q-mb-md" />
        <div class="text-h6 text-weight-600">No jobs yet</div>
        <div class="text-2 q-mt-xs">Launch your first one to start supervising.</div>
        <q-btn unelevated no-caps class="new-btn q-mt-lg" @click="newJob"><Plus :size="16" class="q-mr-xs" /> New Job</q-btn>
      </div>

      <!-- Filtered to nothing -->
      <div v-else-if="store.loaded && !store.loadError && filtering && !jobs.length" class="empty column flex-center q-pa-xl text-center">
        <div class="text-2">No jobs match this filter.</div>
        <q-btn flat no-caps class="q-mt-sm" @click="query = ''; statusFilter = 'all'">Clear filter</q-btn>
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
          <div class="col-folder">FOLDER</div>
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
.conn { width: 8px; height: 8px; border-radius: 9999px; display: inline-block; }
.conn.live { background: var(--fg-running); box-shadow: 0 0 6px var(--fg-running); }
.conn.down { background: var(--fg-muted); }
.summary { font-size: 13px; }
.fchip { background: none; border: none; padding: 1px 4px; border-radius: 4px; cursor: pointer; font: inherit; color: inherit; }
.fchip:hover { background: var(--fg-surface-elevated); }
.fchip.on { background: var(--fg-surface-elevated); outline: 1px solid var(--fg-border); }
.search { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 3px 8px; gap: 6px; }
.search-input { background: none; border: none; outline: none; color: var(--fg-text); font-size: 13px; width: 150px; }
.search-input::placeholder { color: var(--fg-muted); }
.search-clear { background: none; border: none; color: var(--fg-muted); cursor: pointer; display: flex; padding: 0; }
.search-clear:hover { color: var(--fg-text); }
.text-running { color: var(--fg-running); }
.text-accent { color: var(--fg-accent); }
.new-btn { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; padding: 4px 12px; }
.header-row { padding: 10px 16px; border-bottom: 1px solid var(--fg-border); font-size: 10px; letter-spacing: 0.05em; gap: 12px; }
.header-row .col-title { flex: 0 0 200px; }
.header-row .col-id { flex: 0 0 90px; }
.header-row .col-folder { flex: 0 0 140px; }
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
