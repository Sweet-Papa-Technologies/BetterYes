<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { JobEvent } from '@foreman/shared';
import { LOG_LEVEL_CLASS } from '../lib/status';

const props = defineProps<{ events: JobEvent[] }>();
const scroller = ref<HTMLElement | null>(null);

// Only log/router/director-style lines belong in the console.
const lines = computed(() =>
  props.events.filter((e) => e.type === 'log' || e.type === 'router' || e.type === 'director' || e.type === 'error'),
);

function hhmmss(ts: string): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
function levelClass(e: JobEvent): string {
  if (e.type === 'router') return LOG_LEVEL_CLASS.info;
  if (e.type === 'director') return LOG_LEVEL_CLASS.plan;
  if (e.type === 'error') return LOG_LEVEL_CLASS.error;
  return e.level ? LOG_LEVEL_CLASS[e.level] : LOG_LEVEL_CLASS.info;
}
function gutter(e: JobEvent): string {
  if (e.type === 'router') return 'RTR';
  if (e.type === 'director') return 'DIR';
  return (e.level ?? 'info').toUpperCase().slice(0, 4);
}

watch(
  () => props.events.length,
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div ref="scroller" class="log-console q-pa-md">
    <div v-for="e in lines" :key="e.id" class="log-line">
      <span class="log-ts">{{ hhmmss(e.ts) }}</span>
      <span class="gutter" :class="levelClass(e)"> [{{ gutter(e) }}]</span>
      <span class="msg" :class="levelClass(e)"> {{ e.message }}</span>
    </div>
    <div v-if="!lines.length" class="text-muted">Waiting for output…</div>
    <span class="cursor">▋</span>
  </div>
</template>

<style scoped>
.log-console { height: 100%; overflow-y: auto; }
.gutter { font-weight: 500; }
.cursor { color: var(--fg-accent); animation: blink 1s steps(2) infinite; }
@keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
</style>
