<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { Rocket } from 'lucide-vue-next';
import type { PolicyProfile } from '@foreman/shared';
import { api, ApiError } from '../lib/api';

const router = useRouter();
const $q = useQuasar();

const name = ref('');
const repoPath = ref('');
const brief = ref('');
const profile = ref<PolicyProfile>('standard');
const requirePlanApproval = ref(false);
const agentTeams = ref(false);
const launching = ref(false);
const showAdvanced = ref(false);
const directorModel = ref('');
const routerModel = ref('');

async function launch() {
  if (!brief.value.trim() || !repoPath.value.trim()) {
    $q.notify({ message: 'Repo path and brief are required', color: 'negative', position: 'top' });
    return;
  }
  launching.value = true;
  try {
    const job = await api.createJob({
      name: name.value.trim() || brief.value.trim().slice(0, 40),
      brief: brief.value.trim(),
      repoPath: repoPath.value.trim(),
      profile: profile.value,
      requirePlanApproval: requirePlanApproval.value,
      agentTeams: agentTeams.value,
      ...(directorModel.value.trim() ? { directorModel: directorModel.value.trim() } : {}),
      ...(routerModel.value.trim() ? { routerModel: routerModel.value.trim() } : {}),
    });
    await router.push(`/jobs/${job.id}`);
  } catch (e) {
    const msg = e instanceof ApiError && e.status === 401 ? 'Unauthorized — set your token in Settings' : 'Launch failed';
    $q.notify({ message: msg, color: 'negative', position: 'top' });
  } finally {
    launching.value = false;
  }
}
</script>

<template>
  <q-page class="q-pa-md new-job">
    <div class="wrap column q-gutter-md">
      <div class="text-h6 text-weight-600">New Job</div>

      <div>
        <label class="lbl mono">REPOSITORY</label>
        <q-input v-model="repoPath" dense borderless class="fld mono" placeholder="/path/to/your/git/repo" />
      </div>

      <div>
        <label class="lbl mono">BRIEF</label>
        <q-input
          v-model="brief"
          type="textarea"
          dense borderless
          class="fld brief"
          placeholder="Rebuild the Moods app: …  Describe what you want done."
          autogrow
        />
      </div>

      <div>
        <label class="lbl mono">NAME <span class="text-muted">(optional)</span></label>
        <q-input v-model="name" dense borderless class="fld" placeholder="Short label for the board" />
      </div>

      <div>
        <label class="lbl mono">POLICY PROFILE</label>
        <div class="seg row">
          <button v-for="p in (['throwaway','standard','strict'] as const)" :key="p" class="seg-btn" :class="{ on: profile === p }" @click="profile = p">
            {{ p.charAt(0).toUpperCase() + p.slice(1) }}
          </button>
        </div>
      </div>

      <q-toggle v-model="requirePlanApproval" label="Require my approval of the plan before starting" color="primary" />
      <q-toggle v-model="agentTeams" label="Enable parallel sub-agents (Agent Teams)" color="primary" />

      <!-- Advanced: model overrides (defaults come from foreman.yaml) -->
      <div class="advanced">
        <button class="adv-toggle mono" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '▾' : '▸' }} Advanced: model overrides
        </button>
        <div v-if="showAdvanced" class="column q-gutter-sm q-mt-sm">
          <div>
            <label class="lbl mono">DIRECTOR MODEL <span class="text-muted">(optional)</span></label>
            <q-input v-model="directorModel" dense borderless class="fld mono" placeholder="director (default)" />
          </div>
          <div>
            <label class="lbl mono">ROUTER MODEL <span class="text-muted">(optional)</span></label>
            <q-input v-model="routerModel" dense borderless class="fld mono" placeholder="router (default)" />
          </div>
        </div>
      </div>

      <q-btn unelevated no-caps :loading="launching" class="launch" @click="launch" aria-label="Launch job">
        <Rocket :size="16" class="q-mr-sm" /> Launch job
      </q-btn>
    </div>
  </q-page>
</template>

<style scoped>
.wrap { max-width: 640px; margin: 0 auto; }
.lbl { display: block; font-size: 10px; letter-spacing: 0.05em; color: var(--fg-muted); margin-bottom: 6px; }
.fld { background: var(--fg-surface); border: 1px solid var(--fg-border); border-radius: 4px; padding: 4px 12px; }
.brief :deep(textarea) { min-height: 120px; font-size: 15px; }
.seg { gap: 0; border: 1px solid var(--fg-border); border-radius: 4px; overflow: hidden; width: fit-content; }
.seg-btn { background: var(--fg-surface); border: none; color: var(--fg-text-2); padding: 7px 18px; cursor: pointer; font-size: 13px; border-right: 1px solid var(--fg-border); }
.seg-btn:last-child { border-right: none; }
.seg-btn.on { background: var(--fg-accent); color: #0e0f11; font-weight: 600; }
.launch { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; padding: 10px; font-size: 15px; }
.adv-toggle { background: none; border: none; color: var(--fg-text-2); cursor: pointer; font-size: 12px; padding: 0; }
</style>
