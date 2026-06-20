<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import type { PublicConfig } from '@foreman/shared';
import { api } from '../lib/api';
import { getToken, setToken } from '../lib/api';

const $q = useQuasar();
const token = ref(getToken());
const config = ref<PublicConfig | null>(null);
const error = ref('');

async function load() {
  try {
    config.value = await api.config();
    error.value = '';
  } catch {
    error.value = 'Could not reach the daemon (check token + that `foreman serve` is running).';
  }
}
function saveToken() {
  setToken(token.value);
  $q.notify({ message: 'Token saved', color: 'positive', position: 'top' });
  void load();
}
onMounted(load);
</script>

<template>
  <q-page class="q-pa-md">
    <div class="wrap column q-gutter-lg">
      <div class="text-h6 text-weight-600">Settings</div>

      <!-- Access -->
      <section class="panel q-pa-md">
        <div class="sec-title mono">ACCESS</div>
        <label class="lbl mono">DASHBOARD TOKEN</label>
        <div class="row q-gutter-sm items-center">
          <q-input v-model="token" dense borderless type="password" class="fld col mono" placeholder="paste FOREMAN_TOKEN" />
          <q-btn unelevated no-caps class="save" @click="saveToken">Save</q-btn>
        </div>
        <div class="text-muted hint q-mt-xs">Stored in this browser only. From the daemon: <span class="mono">foreman secret get FOREMAN_TOKEN</span></div>
      </section>

      <div v-if="error" class="needs-you-band q-pa-sm">{{ error }}</div>

      <!-- Models -->
      <section v-if="config" class="panel q-pa-md">
        <div class="sec-title mono">MODELS</div>
        <div class="kv"><span class="text-2">Director</span><span class="code-chip">{{ config.models.director }}</span></div>
        <div class="kv"><span class="text-2">Router</span><span class="code-chip">{{ config.models.router }}</span></div>
        <div class="kv"><span class="text-2">Endpoint</span><span class="code-chip">{{ config.endpoint.baseUrl }}</span></div>
        <div class="text-muted hint q-mt-sm">Edit models in <span class="mono">foreman.yaml</span> (hot-swap, FR7).</div>
      </section>

      <!-- Concurrency / Hermes -->
      <section v-if="config" class="panel q-pa-md">
        <div class="sec-title mono">RUNTIME</div>
        <div class="kv"><span class="text-2">Max parallel jobs</span><span class="mono">{{ config.concurrency.maxParallelJobs }}</span></div>
        <div class="kv"><span class="text-2">Coder command</span><span class="code-chip">{{ config.coder.command }}</span></div>
        <div class="kv"><span class="text-2">Bind</span><span class="mono">{{ config.dashboard.bind }}:{{ config.dashboard.port }}</span></div>
        <div class="kv">
          <span class="text-2">Hermes</span>
          <span class="row items-center q-gutter-xs"><span class="dot" :class="config.hermes.enabled ? 'on' : 'off'" /> <span class="mono">{{ config.hermes.enabled ? 'connected' : 'disabled (M4)' }}</span></span>
        </div>
        <div class="kv"><span class="text-2">Version</span><span class="mono">{{ config.version }}</span></div>
      </section>

      <section class="panel q-pa-md">
        <div class="sec-title mono">NOTIFICATIONS</div>
        <div class="text-muted hint">Web Push / ntfy arrive in M4. Escalations currently surface in the board's needs-you band and on the job view.</div>
      </section>
    </div>
  </q-page>
</template>

<style scoped>
.wrap { max-width: 640px; margin: 0 auto; }
.sec-title { font-size: 11px; letter-spacing: 0.06em; color: var(--fg-muted); margin-bottom: 12px; }
.lbl { display: block; font-size: 10px; letter-spacing: 0.05em; color: var(--fg-muted); margin-bottom: 6px; }
.fld { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.save { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.kv { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--fg-border); font-size: 13px; }
.kv:last-child { border-bottom: none; }
.hint { font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 9999px; }
.dot.on { background: var(--fg-running); box-shadow: 0 0 6px var(--fg-running); }
.dot.off { background: var(--fg-muted); }
</style>
