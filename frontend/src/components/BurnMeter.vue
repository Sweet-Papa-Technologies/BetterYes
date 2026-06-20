<script setup lang="ts">
import { computed } from 'vue';

// A thin progress bar for resource consumption (turns / tokens). STITCH_BRIEF: "burn meter".
const props = defineProps<{
  label: string;
  value: number;
  max: number;
  /** Optional override; defaults to amber. */
  color?: string;
}>();

const pct = computed(() => {
  if (!props.max) return 0;
  return Math.min(100, Math.round((props.value / props.max) * 100));
});
</script>

<template>
  <div class="burn">
    <div class="row items-center justify-between burn-head">
      <span class="mono text-muted">{{ label }}</span>
      <span class="mono text-2">{{ value }}<span class="text-muted">/{{ max }}</span></span>
    </div>
    <div class="burn-meter">
      <div class="fill" :style="{ width: pct + '%', background: color ?? 'var(--fg-accent)' }" />
    </div>
  </div>
</template>

<style scoped>
.burn { min-width: 96px; }
.burn-head { font-size: 10px; margin-bottom: 3px; }
</style>
