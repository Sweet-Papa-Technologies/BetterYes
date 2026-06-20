<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ShieldCheck } from 'lucide-vue-next';
import { api, type RulesFile, type RuleMatch } from '../lib/api';

// M2: the gate is live and enforced. This view reads the actual rules.yaml the gate uses.
// The in-place editor (add/edit/delete rows) lands in M3.
const rules = ref<RulesFile | null>(null);
const error = ref('');

const actionCls: Record<string, string> = {
  allow: 'status-running',
  deny: 'status-failed',
  escalate: 'status-blocked',
};

function patternOf(m: RuleMatch): string {
  if (m.path_glob) return m.path_glob.join(', ');
  if (m.cmd_regex) return m.cmd_regex;
  if (m.path_outside_worktree) return 'outside the worktree';
  return '—';
}

const rows = computed(() => rules.value?.rules ?? []);

onMounted(async () => {
  try {
    const r = await api.getRules();
    rules.value = r.parsed;
  } catch {
    error.value = 'Could not load rules (check token / daemon).';
  }
});
</script>

<template>
  <q-page class="q-pa-md">
    <div class="wrap column q-gutter-md">
      <div class="row items-center q-gutter-sm">
        <ShieldCheck :size="20" />
        <span class="text-h6 text-weight-600">Tool Rules</span>
        <span class="status-pill status-running"><span class="pip pip-pulse" /> enforced · M2</span>
      </div>
      <div class="text-2">
        The PreToolUse gate evaluates every tool call against these rules (first match wins).
        Editing in-place arrives in M3 — for now edit <span class="mono">rules.yaml</span> (hot-reloaded).
      </div>

      <div v-if="error" class="needs-you-band q-pa-sm">{{ error }}</div>

      <div v-if="rules" class="row q-gutter-sm">
        <span class="code-chip">default: {{ rules.default_action }}</span>
        <span class="code-chip">on_error: {{ rules.on_error }}</span>
      </div>

      <div v-if="rules" class="panel rules">
        <div class="row header mono text-muted">
          <div class="c-tool">TOOL</div><div class="c-pat">PATTERN</div><div class="c-act">ACTION</div>
        </div>
        <div v-for="(r, i) in rows" :key="i" class="row rrow">
          <div class="c-tool mono">{{ r.match.tool ?? '*' }}</div>
          <div class="c-pat"><span class="code-chip">{{ patternOf(r.match) }}</span></div>
          <div class="c-act">
            <span class="status-pill" :class="actionCls[r.action]"><span class="pip" /> {{ r.action }}</span>
          </div>
        </div>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.wrap { max-width: 820px; margin: 0 auto; }
.rules { overflow: hidden; }
.row.header { padding: 10px 14px; border-bottom: 1px solid var(--fg-border); font-size: 10px; letter-spacing: 0.05em; }
.rrow { padding: 12px 14px; border-bottom: 1px solid var(--fg-border); align-items: center; }
.rrow:last-child { border-bottom: none; }
.c-tool { flex: 0 0 120px; font-size: 12px; }
.c-pat { flex: 1 1 auto; min-width: 0; word-break: break-all; }
.c-act { flex: 0 0 110px; text-align: right; }
</style>
