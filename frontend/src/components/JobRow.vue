<script setup lang="ts">
import { useRouter } from 'vue-router';
import { GitBranch } from 'lucide-vue-next';
import type { Job } from '@foreman/shared';
import { needsYou } from '../lib/status';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ job: Job }>();
const router = useRouter();
const go = () => router.push(`/jobs/${props.job.id}`);

const burnPct = () => (props.job.maxTurns ? Math.round((props.job.turns / props.job.maxTurns) * 100) : 0);
</script>

<template>
  <div class="job-row row items-center no-wrap cursor-pointer" :class="{ attn: needsYou(job.state) }" @click="go">
    <div class="col-title ellipsis">{{ job.name }}</div>
    <div class="col-id mono text-muted">{{ job.id }}</div>
    <div class="col-branch"><span class="code-chip"><GitBranch :size="11" /> {{ job.branch }}</span></div>
    <div class="col-status"><StatusPill :state="job.state" /></div>
    <div class="col-activity text-2 ellipsis">{{ job.lastActivity }}</div>
    <div class="col-files mono text-muted">{{ job.filesTouched }}</div>
    <div class="col-burn">
      <div class="burn-meter">
        <div class="fill" :style="{ width: burnPct() + '%', background: needsYou(job.state) ? 'var(--fg-accent)' : 'var(--fg-running)' }" />
      </div>
      <span class="mono text-muted burn-pct">{{ burnPct() }}%</span>
    </div>
  </div>
</template>

<style scoped>
.job-row {
  padding: 12px 16px;
  border-bottom: 1px solid var(--fg-border);
  font-size: 13px;
  gap: 12px;
}
.job-row:hover { background: var(--fg-surface-elevated); }
.job-row.attn { border-left: 2px solid var(--fg-accent); background: rgba(255, 176, 32, 0.04); }
.col-title { flex: 0 0 200px; font-weight: 600; }
.col-id { flex: 0 0 90px; font-size: 12px; }
.col-branch { flex: 0 0 150px; }
.col-status { flex: 0 0 120px; }
.col-activity { flex: 1 1 auto; min-width: 0; }
.col-files { flex: 0 0 50px; text-align: right; }
.col-burn { flex: 0 0 110px; display: flex; align-items: center; gap: 8px; }
.col-burn .burn-meter { flex: 1; }
.burn-pct { font-size: 11px; width: 34px; text-align: right; }
</style>
