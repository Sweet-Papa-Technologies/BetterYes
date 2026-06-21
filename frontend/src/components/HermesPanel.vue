<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useQuasar } from 'quasar';
import { api, ApiError, type HermesStatus } from '../lib/api';

// Manage the Hermes Agent that powers the chat panel: set up a local isolated instance,
// start/stop it, or point at a remote endpoint — all without restarting the daemon.
const $q = useQuasar();
const status = ref<HermesStatus | null>(null);
const busy = ref(false);
const remoteUrl = ref('');
const remoteKey = ref('');
const modelInput = ref('');
// Gemini ids Hermes can use directly (it bypasses LiteLLM). Lite = cheap/fast, flash = smarter.
const MODEL_PRESETS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
let poll: ReturnType<typeof setInterval> | null = null;

const source = computed(() => status.value?.active.source ?? 'off');

async function load() {
  try {
    status.value = await api.hermes.status();
    if (status.value.active.source === 'remote') remoteUrl.value ||= status.value.active.baseUrl;
    if (status.value.managed.setUp) modelInput.value ||= status.value.managed.model;
    // Poll while the background installer runs so the UI flips to "installed" on its own.
    if (status.value.installing && !poll) poll = setInterval(load, 2500);
    if (!status.value.installing && poll) { clearInterval(poll); poll = null; }
  } catch {
    /* token / daemon issues are surfaced by the parent Settings page */
  }
}

function toast(message: string, color = 'positive') {
  $q.notify({ message, color, position: 'top', timeout: 2200 });
}

async function run(fn: () => Promise<unknown>, ok: string) {
  busy.value = true;
  try {
    await fn();
    toast(ok);
    await load();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Action failed', 'negative');
  } finally {
    busy.value = false;
  }
}

const setup = () =>
  run(async () => {
    try {
      await api.hermes.setup({ start: true });
    } catch (e) {
      if (e instanceof ApiError && e.message === 'hermes_not_installed') {
        await api.hermes.install();
        throw new ApiError('Installing Hermes in the background — this takes a minute.', 409);
      }
      throw e;
    }
  }, 'Managed Hermes set up & started');

const install = () => run(() => api.hermes.install(), 'Installing Hermes in the background…');
const start = () => run(() => api.hermes.start(), 'Hermes gateway started');
const stop = () => run(() => api.hermes.stop(), 'Hermes gateway stopped');
const useManaged = () => run(() => api.hermes.select({ source: 'managed' }), 'Chat now uses the managed instance');
const setModel = () =>
  run(async () => {
    const r = await api.hermes.setModel(modelInput.value.trim());
    return r;
  }, 'Hermes model updated');
const turnOff = () => run(() => api.hermes.select({ source: 'off' }), 'Chat bridge disabled');
const saveRemote = () =>
  run(
    () => api.hermes.select({ source: 'remote', baseUrl: remoteUrl.value.trim(), apiKey: remoteKey.value.trim() }),
    'Chat now uses the remote endpoint',
  );

onMounted(load);
onUnmounted(() => poll && clearInterval(poll));
</script>

<template>
  <section class="panel q-pa-md" v-if="status">
    <div class="row items-center justify-between">
      <div class="sec-title mono">HERMES (CHAT BRAIN)</div>
      <span class="row items-center q-gutter-xs">
        <span class="dot" :class="status.active.healthy ? 'on' : 'off'" />
        <span class="mono text-muted sm">{{ status.active.healthy ? 'live' : status.active.enabled ? 'unreachable' : 'off' }}</span>
      </span>
    </div>

    <!-- Source selector -->
    <label class="lbl mono q-mt-sm">CHAT SOURCE</label>
    <div class="seg row">
      <button class="seg-btn" :class="{ on: source === 'managed' }" :disabled="busy" @click="useManaged">Managed (local)</button>
      <button class="seg-btn" :class="{ on: source === 'remote' }" :disabled="busy" @click="source !== 'remote' && saveRemote()">Remote</button>
      <button class="seg-btn" :class="{ on: source === 'off' }" :disabled="busy" @click="turnOff">Off</button>
    </div>

    <!-- Managed instance -->
    <div class="block q-mt-md">
      <div class="block-head row items-center justify-between">
        <span class="text-2">Managed instance <span class="text-muted sm">(own home + port, never touches ~/.hermes)</span></span>
        <span v-if="status.managed.setUp" class="row items-center q-gutter-xs">
          <span class="dot" :class="status.managed.reachable ? 'on' : status.managed.running ? 'warn' : 'off'" />
          <span class="mono text-muted sm">{{ status.managed.reachable ? 'running' : status.managed.running ? 'starting' : 'stopped' }}</span>
        </span>
      </div>

      <template v-if="!status.installed">
        <div class="text-muted hint q-mt-xs">
          Hermes isn't installed.
          <span v-if="status.installing">Installing in the background…</span>
        </div>
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn unelevated no-caps class="save" :loading="busy || status.installing" @click="install">Install Hermes</q-btn>
        </div>
        <div class="text-muted hint q-mt-xs">Or in a terminal: <span class="mono">foreman hermes setup --install</span></div>
        <div v-if="status.installError" class="text-negative hint q-mt-xs">{{ status.installError }}</div>
      </template>

      <template v-else-if="!status.managed.setUp">
        <div class="text-muted hint q-mt-xs">Hermes is installed but no isolated instance is provisioned yet.</div>
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn unelevated no-caps class="save" :loading="busy" @click="setup">Set up &amp; start</q-btn>
        </div>
      </template>

      <template v-else>
        <div class="kv"><span class="text-2">Endpoint</span><span class="code-chip">{{ status.managed.baseUrl }}</span></div>
        <label class="lbl mono q-mt-sm">MODEL <span class="text-muted">(Gemini id — Hermes calls Gemini directly)</span></label>
        <div class="row q-gutter-sm items-center">
          <q-input v-model="modelInput" dense borderless class="fld col mono" list="hermes-models" placeholder="gemini-3.1-flash-lite" />
          <datalist id="hermes-models"><option v-for="m in MODEL_PRESETS" :key="m" :value="m" /></datalist>
          <q-btn unelevated no-caps class="save" :loading="busy" :disable="modelInput.trim() === status.managed.model" @click="setModel">Set model</q-btn>
        </div>
        <div class="text-muted hint q-mt-xs">Lite is cheap + fast; <span class="mono">gemini-3.5-flash</span> is smarter. Changing it restarts the gateway.</div>
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn v-if="!status.managed.running" unelevated no-caps class="save" :loading="busy" @click="start">Start</q-btn>
          <q-btn v-else flat no-caps class="ghost" :loading="busy" @click="stop">Stop</q-btn>
          <q-btn v-if="source !== 'managed'" flat no-caps class="ghost" :loading="busy" @click="useManaged">Use this</q-btn>
        </div>
      </template>
    </div>

    <!-- Remote (advanced) -->
    <div class="block q-mt-md">
      <div class="block-head"><span class="text-2">Remote endpoint <span class="text-muted sm">(advanced)</span></span></div>
      <label class="lbl mono q-mt-xs">BASE URL</label>
      <q-input v-model="remoteUrl" dense borderless class="fld mono" placeholder="https://hermes.example.com" />
      <label class="lbl mono q-mt-sm">API KEY <span class="text-muted">(optional — stored in your keychain)</span></label>
      <div class="row q-gutter-sm items-center">
        <q-input v-model="remoteKey" dense borderless type="password" class="fld col mono" :placeholder="status.active.source === 'remote' && status.active.hasKey ? '•••••• (saved)' : 'paste key'" />
        <q-btn unelevated no-caps class="save" :loading="busy" @click="saveRemote">Use remote</q-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec-title { font-size: 11px; letter-spacing: 0.06em; color: var(--fg-muted); }
.lbl { display: block; font-size: 10px; letter-spacing: 0.05em; color: var(--fg-muted); margin-bottom: 6px; }
.fld { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 10px; }
.save { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.ghost { color: var(--fg-text-2); border: 1px solid var(--fg-border); border-radius: 4px; }
.seg { gap: 0; border: 1px solid var(--fg-border); border-radius: 4px; overflow: hidden; width: fit-content; }
.seg-btn { background: var(--fg-surface); border: none; color: var(--fg-text-2); padding: 7px 16px; cursor: pointer; font-size: 13px; border-right: 1px solid var(--fg-border); }
.seg-btn:last-child { border-right: none; }
.seg-btn.on { background: var(--fg-accent); color: #0e0f11; font-weight: 600; }
.seg-btn:disabled { opacity: 0.6; cursor: default; }
.block { border: 1px solid var(--fg-border); border-radius: 6px; padding: 12px; }
.block-head { font-size: 13px; margin-bottom: 4px; }
.kv { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--fg-border); font-size: 13px; }
.kv:last-child { border-bottom: none; }
.hint { font-size: 12px; }
.sm { font-size: 11px; }
.dot { width: 8px; height: 8px; border-radius: 9999px; display: inline-block; }
.dot.on { background: var(--fg-running); box-shadow: 0 0 6px var(--fg-running); }
.dot.warn { background: var(--fg-accent); }
.dot.off { background: var(--fg-muted); }
</style>
