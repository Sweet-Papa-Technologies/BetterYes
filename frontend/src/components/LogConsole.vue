<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { ChevronsDown } from 'lucide-vue-next';
import type { JobEvent } from '@foreman/shared';
import { LOG_LEVEL_CLASS } from '../lib/status';

const props = defineProps<{ events: JobEvent[] }>();
const scroller = ref<HTMLElement | null>(null);
// Follow the tail only while the user is already at the bottom; if they scroll up to read
// history, stop yanking them down and offer a "jump to latest" button instead.
const atBottom = ref(true);
function onScroll() {
  const el = scroller.value;
  if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function toBottom() {
  const el = scroller.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    atBottom.value = true;
  }
}

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
    if (!atBottom.value) return; // user is reading history — don't interrupt
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div class="log-wrap">
    <div ref="scroller" class="log-console q-pa-md" @scroll="onScroll">
      <div v-for="e in lines" :key="e.id" class="log-line">
        <span class="log-ts">{{ hhmmss(e.ts) }}</span>
        <span class="gutter" :class="levelClass(e)"> [{{ gutter(e) }}]</span>
        <span class="msg" :class="levelClass(e)"> {{ e.message }}</span>
      </div>
      <!-- Skeleton while the session boots and no output has arrived yet (brief §5). -->
      <div v-if="!lines.length" class="column q-gutter-xs">
        <q-skeleton v-for="n in 6" :key="n" type="text" :width="`${40 + ((n * 13) % 50)}%`" dark />
        <div class="text-muted q-mt-sm">Waiting for output…</div>
      </div>
      <span v-else class="cursor">▋</span>
    </div>
    <transition name="fade">
      <button v-if="!atBottom" class="jump mono" @click="toBottom">
        <ChevronsDown :size="14" /> Latest
      </button>
    </transition>
  </div>
</template>

<style scoped>
.log-wrap { position: absolute; inset: 0; }
.log-console { height: 100%; overflow-y: auto; }
.jump {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 5px;
  background: var(--fg-accent); color: #0e0f11; font-weight: 600; font-size: 12px;
  border: none; border-radius: 9999px; padding: 5px 12px; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.gutter { font-weight: 500; }
.cursor { color: var(--fg-accent); animation: blink 1s steps(2) infinite; }
@keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
</style>
