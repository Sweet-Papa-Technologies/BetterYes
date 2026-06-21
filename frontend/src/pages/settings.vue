<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import type { PublicConfig } from '@foreman/shared';
import { api } from '../lib/api';
import { getToken, setToken } from '../lib/api';
import { enablePush, pushSupported } from '../lib/push';
import { useJobsStore } from '../stores/jobs';
import HermesPanel from '../components/HermesPanel.vue';

const $q = useQuasar();
const store = useJobsStore();
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
  void store.loadAndSubscribe(); // recover the board after fixing the token
}

const pushBusy = ref(false);
const pushOn = ref(false);
async function turnOnPush() {
  pushBusy.value = true;
  try {
    const r = await enablePush();
    if (r.ok) {
      pushOn.value = true;
      $q.notify({ message: 'Push enabled on this device', color: 'positive', position: 'top' });
    } else {
      $q.notify({ message: r.reason ?? 'Could not enable push', color: 'warning', position: 'top' });
    }
  } finally {
    pushBusy.value = false;
  }
}
async function testPush() {
  await api.testPush();
  $q.notify({ message: 'Test notification sent', color: 'positive', position: 'top' });
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
        <div class="text-muted hint q-mt-xs">Stored in this browser only. From the daemon: <span class="mono">pnpm -s foreman secret get FOREMAN_TOKEN --raw</span></div>
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
        <div class="kv"><span class="text-2">Version</span><span class="mono">{{ config.version }}</span></div>
      </section>

      <!-- Hermes: set up / start-stop / choose managed vs remote -->
      <HermesPanel />

      <section class="panel q-pa-md">
        <div class="sec-title mono">NOTIFICATIONS</div>
        <div v-if="!pushSupported()" class="text-muted hint">
          This browser doesn't support Web Push. Install the app to your home screen (iOS) or use a desktop browser.
        </div>
        <template v-else>
          <div class="row items-center q-gutter-sm">
            <q-btn unelevated no-caps class="save" :loading="pushBusy" @click="turnOnPush">
              {{ pushOn ? 'Re-enable push' : 'Enable push on this device' }}
            </q-btn>
            <q-btn flat no-caps class="ghost" @click="testPush">Send test</q-btn>
          </div>
          <div class="text-muted hint q-mt-sm">
            You'll get a notification when a job needs you (escalation) and when one finishes. Works on
            the installed PWA; iOS requires Add to Home Screen.
          </div>
        </template>
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
.ghost { color: var(--fg-text-2); }
.kv { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--fg-border); font-size: 13px; }
.kv:last-child { border-bottom: none; }
.hint { font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 9999px; }
.dot.on { background: var(--fg-running); box-shadow: 0 0 6px var(--fg-running); }
.dot.off { background: var(--fg-muted); }
</style>
