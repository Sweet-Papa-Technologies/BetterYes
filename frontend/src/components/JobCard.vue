<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { GitBranch, FileText, Folder } from 'lucide-vue-next';
import type { Job } from '@foreman/shared';
import { needsYou } from '../lib/status';
import { timeAgo, folderName } from '../lib/ui';
import { useNow } from '../composables/useNow';
import StatusPill from './StatusPill.vue';
import BurnMeter from './BurnMeter.vue';

const props = defineProps<{ job: Job }>();
const router = useRouter();
const now = useNow();
const ago = computed(() => timeAgo(props.job.updatedAt, now.value));
const go = () => router.push(`/jobs/${props.job.id}`);
</script>

<template>
  <div
    class="panel q-pa-md job-card cursor-pointer"
    :class="{ 'attn': needsYou(job.state) }"
    @click="go"
  >
    <div class="row items-start justify-between no-wrap">
      <div class="col">
        <div class="text-weight-600 ellipsis job-name">{{ job.name }}</div>
        <div class="mono text-muted job-id q-mt-xs">ID: {{ job.id }}</div>
      </div>
      <StatusPill :state="job.state" />
    </div>

    <div class="row items-center q-gutter-xs q-mt-sm">
      <span class="code-chip" :title="job.repoPath"><Folder :size="11" /> {{ folderName(job.repoPath) }}</span>
      <span class="code-chip"><GitBranch :size="11" /> {{ job.branch }}</span>
    </div>

    <div class="text-2 q-mt-sm job-activity ellipsis-2-lines">{{ job.lastActivity }}</div>

    <div class="row items-center justify-between q-mt-md no-wrap">
      <span class="mono text-muted files"><FileText :size="12" /> {{ job.filesTouched }} files · {{ ago }}</span>
      <BurnMeter
        class="burn-col"
        label="TURNS"
        :value="job.turns"
        :max="job.maxTurns"
        :color="needsYou(job.state) ? 'var(--fg-accent)' : 'var(--fg-running)'"
      />
    </div>
  </div>
</template>

<style scoped>
.job-card.attn { border-color: rgba(255, 176, 32, 0.55); background: rgba(255, 176, 32, 0.04); }
.job-name { font-size: 15px; }
.job-id, .files { font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.job-activity { font-size: 13px; min-height: 18px; }
.burn-col { width: 120px; }
.ellipsis-2-lines {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
</style>
