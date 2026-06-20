<script setup lang="ts">
import { computed } from 'vue';
import type { JobState } from '@foreman/shared';
import { STATUS_META } from '../lib/status';

const props = defineProps<{ state: JobState }>();
const meta = computed(() => STATUS_META[props.state]);
const pipClass = computed(() =>
  meta.value.pulse === 'fast' ? 'pip pip-pulse-fast' : meta.value.pulse ? 'pip pip-pulse' : 'pip',
);
</script>

<template>
  <span class="status-pill" :class="meta.cls">
    <span :class="pipClass" />
    {{ meta.label }}
  </span>
</template>
