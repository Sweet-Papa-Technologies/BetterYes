<script setup lang="ts">
import { ShieldCheck } from 'lucide-vue-next';

// M1 ships the default rule set (rules.yaml) read-only; the editor + live PreToolUse
// enforcement land in M2. Shown here so the nav + IA match the design.
const defaults = [
  { tool: '*', pattern: '~/.ssh/**, **/.env, **/secrets/**', action: 'Deny', cls: 'status-failed' },
  { tool: 'Edit|Write', pattern: 'outside the worktree', action: 'Deny', cls: 'status-failed' },
  { tool: 'Bash', pattern: 'rm -rf /, git push --force, curl|sh, npm publish', action: 'Deny', cls: 'status-failed' },
  { tool: 'Bash', pattern: 'docker|systemctl|gcloud|kubectl', action: 'Escalate', cls: 'status-blocked' },
];
</script>

<template>
  <q-page class="q-pa-md">
    <div class="wrap column q-gutter-md">
      <div class="row items-center q-gutter-sm">
        <ShieldCheck :size="20" />
        <span class="text-h6 text-weight-600">Tool Rules</span>
        <span class="status-pill status-planning"><span class="pip" /> preview · M2</span>
      </div>
      <div class="text-2">The default rule set ships now; the live editor and PreToolUse enforcement arrive in M2.</div>

      <div class="panel rules">
        <div class="row header mono text-muted">
          <div class="c-tool">TOOL</div><div class="c-pat">PATTERN</div><div class="c-act">ACTION</div>
        </div>
        <div v-for="(r, i) in defaults" :key="i" class="row rrow">
          <div class="c-tool mono">{{ r.tool }}</div>
          <div class="c-pat"><span class="code-chip">{{ r.pattern }}</span></div>
          <div class="c-act"><span class="status-pill" :class="r.cls"><span class="pip" /> {{ r.action }}</span></div>
        </div>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.wrap { max-width: 760px; margin: 0 auto; }
.rules { overflow: hidden; }
.row.header { padding: 10px 14px; border-bottom: 1px solid var(--fg-border); font-size: 10px; letter-spacing: 0.05em; }
.rrow { padding: 12px 14px; border-bottom: 1px solid var(--fg-border); align-items: center; }
.rrow:last-child { border-bottom: none; }
.c-tool { flex: 0 0 120px; font-size: 12px; }
.c-pat { flex: 1 1 auto; min-width: 0; }
.c-act { flex: 0 0 110px; text-align: right; }
</style>
