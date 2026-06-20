<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { ShieldCheck, Plus, Trash2, Save } from 'lucide-vue-next';
import { api, type RulesFile } from '../lib/api';

// S5 — the Rules editor. Edit/add/delete rules in place; save writes rules.yaml, which the
// PreToolUse gate reads fresh on the next tool call (hot-reload).
const $q = useQuasar();
const rules = ref<RulesFile | null>(null);
const dirty = ref(false);
const saving = ref(false);
const error = ref('');

type PatternKind = 'path_glob' | 'cmd_regex' | 'path_outside_worktree';
const actions = ['allow', 'deny', 'escalate'] as const;
const actionCls: Record<string, string> = { allow: 'status-running', deny: 'status-failed', escalate: 'status-blocked' };

interface EditRow {
  tool: string;
  kind: PatternKind;
  value: string;
  action: 'allow' | 'deny' | 'escalate';
}
const rows = ref<EditRow[]>([]);
const defaultAction = ref<'allow' | 'deny' | 'escalate'>('allow');
const onError = ref<'allow' | 'deny' | 'escalate'>('escalate');

function toRow(r: RulesFile['rules'][number]): EditRow {
  const m = r.match;
  if (m.cmd_regex !== undefined) return { tool: m.tool ?? 'Bash', kind: 'cmd_regex', value: m.cmd_regex, action: r.action };
  if (m.path_outside_worktree) return { tool: m.tool ?? 'Edit|Write', kind: 'path_outside_worktree', value: '', action: r.action };
  return { tool: m.tool ?? '*', kind: 'path_glob', value: (m.path_glob ?? []).join(', '), action: r.action };
}

function build(): RulesFile {
  return {
    default_action: defaultAction.value,
    on_error: onError.value,
    rules: rows.value.map((row) => {
      const match: RulesFile['rules'][number]['match'] = { tool: row.tool || '*' };
      if (row.kind === 'cmd_regex') match.cmd_regex = row.value;
      else if (row.kind === 'path_outside_worktree') match.path_outside_worktree = true;
      else match.path_glob = row.value.split(',').map((s) => s.trim()).filter(Boolean);
      return { match, action: row.action };
    }),
  };
}

function addRow() {
  rows.value.push({ tool: 'Bash', kind: 'cmd_regex', value: '', action: 'deny' });
  dirty.value = true;
}
function removeRow(i: number) {
  rows.value.splice(i, 1);
  dirty.value = true;
}

async function load() {
  try {
    const r = await api.getRules();
    rules.value = r.parsed;
    rows.value = r.parsed.rules.map(toRow);
    defaultAction.value = r.parsed.default_action;
    onError.value = r.parsed.on_error;
    dirty.value = false;
  } catch {
    error.value = 'Could not load rules (check token / daemon).';
  }
}
async function save() {
  saving.value = true;
  try {
    await api.putRules(build());
    dirty.value = false;
    $q.notify({ message: 'rules hot-reloaded', color: 'positive', position: 'top', timeout: 1500 });
  } catch {
    $q.notify({ message: 'Save failed — check patterns', color: 'negative', position: 'top' });
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>

<template>
  <q-page class="q-pa-md">
    <div class="wrap column q-gutter-md">
      <div class="row items-center q-gutter-sm">
        <ShieldCheck :size="20" />
        <span class="text-h6 text-weight-600">Tool Rules</span>
        <span class="status-pill status-running"><span class="pip pip-pulse" /> enforced · M3</span>
        <q-space />
        <q-btn flat dense no-caps class="addbtn" @click="addRow"><Plus :size="16" class="q-mr-xs" /> Add rule</q-btn>
        <q-btn unelevated dense no-caps class="savebtn" :loading="saving" :disable="!dirty" @click="save">
          <Save :size="16" class="q-mr-xs" /> Save
        </q-btn>
      </div>
      <div class="text-2">First match wins. Edits write <span class="mono">rules.yaml</span>; the gate hot-reloads on the next tool call.</div>

      <div v-if="error" class="needs-you-band q-pa-sm">{{ error }}</div>

      <div class="row q-gutter-md globals">
        <div class="g"><span class="lbl mono">DEFAULT</span>
          <select v-model="defaultAction" class="sel mono" @change="dirty = true">
            <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>
        <div class="g"><span class="lbl mono">ON ERROR</span>
          <select v-model="onError" class="sel mono" @change="dirty = true">
            <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>
      </div>

      <div class="panel rules">
        <div class="row header mono text-muted">
          <div class="c-tool">TOOL</div><div class="c-kind">MATCH</div><div class="c-val">PATTERN</div><div class="c-act">ACTION</div><div class="c-del" />
        </div>
        <div v-for="(row, i) in rows" :key="i" class="row rrow items-center">
          <input v-model="row.tool" class="inp mono c-tool" @input="dirty = true" />
          <select v-model="row.kind" class="sel mono c-kind" @change="dirty = true">
            <option value="path_glob">path glob</option>
            <option value="cmd_regex">cmd regex</option>
            <option value="path_outside_worktree">outside worktree</option>
          </select>
          <input v-if="row.kind !== 'path_outside_worktree'" v-model="row.value" class="inp mono c-val" placeholder="pattern…" @input="dirty = true" />
          <span v-else class="c-val text-muted mono">— (any path outside the worktree)</span>
          <select v-model="row.action" class="sel mono c-act" :class="actionCls[row.action]" @change="dirty = true">
            <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
          </select>
          <q-btn flat round dense size="sm" class="c-del del" @click="removeRow(i)"><Trash2 :size="15" /></q-btn>
        </div>
        <div v-if="!rows.length" class="empty text-muted q-pa-md">No rules — every call follows the default action.</div>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.wrap { max-width: 880px; margin: 0 auto; }
.addbtn { border: 1px solid var(--fg-border); border-radius: 4px; color: var(--fg-text-2); }
.savebtn { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.savebtn:disabled { opacity: 0.4; }
.globals .g { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: 10px; letter-spacing: 0.05em; color: var(--fg-muted); }
.sel, .inp {
  background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px;
  color: var(--fg-text); padding: 6px 8px; font-size: 12px; outline: none;
}
.sel { cursor: pointer; }
.rules { overflow: hidden; }
.row.header { padding: 10px 14px; border-bottom: 1px solid var(--fg-border); font-size: 10px; letter-spacing: 0.05em; gap: 10px; }
.rrow { padding: 10px 14px; border-bottom: 1px solid var(--fg-border); gap: 10px; }
.rrow:last-child { border-bottom: none; }
.c-tool { flex: 0 0 130px; }
.c-kind { flex: 0 0 130px; }
.c-val { flex: 1 1 auto; min-width: 0; }
.c-act { flex: 0 0 110px; }
.c-del { flex: 0 0 32px; }
.del { color: var(--fg-muted); }
</style>
