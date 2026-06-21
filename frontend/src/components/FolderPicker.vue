<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { Folder, FolderGit2, CornerLeftUp, Check, FolderPlus, GitBranchPlus } from 'lucide-vue-next';
import { api, ApiError, type DirListing } from '../lib/api';

// Browses the DAEMON's filesystem (that's where jobs run) so you can pick a repo folder.
const emit = defineEmits<{ (e: 'select', path: string): void; (e: 'close'): void }>();
const $q = useQuasar();

const open = ref(true);
const listing = ref<DirListing | null>(null);
const loading = ref(false);
const busy = ref(false);
const manual = ref('');

async function go(path?: string) {
  loading.value = true;
  try {
    listing.value = await api.fsList(path);
    manual.value = listing.value.path;
  } catch {
    $q.notify({ message: 'Can\'t open that folder', color: 'negative', position: 'top' });
  } finally {
    loading.value = false;
  }
}
function choose() {
  if (listing.value) emit('select', listing.value.path);
  open.value = false;
}
// Create a new subfolder in the current directory, then step into it.
function newFolder() {
  if (!listing.value) return;
  $q.dialog({
    title: 'New folder',
    message: `Create inside ${listing.value.path}`,
    prompt: { model: '', type: 'text', label: 'Folder name' },
    cancel: true,
    ok: { label: 'Create', color: 'amber', noCaps: true },
  }).onOk(async (name: string) => {
    if (!name?.trim()) return;
    busy.value = true;
    try {
      const r = await api.fsMkdir(listing.value!.path, name.trim());
      await go(r.path);
    } catch (e) {
      $q.notify({ message: e instanceof ApiError ? e.message : 'Could not create folder', color: 'negative', position: 'top' });
    } finally {
      busy.value = false;
    }
  });
}
// Turn the current (non-repo) folder into a git repo so it can be used.
async function initHere() {
  if (!listing.value) return;
  busy.value = true;
  try {
    await api.fsInitRepo(listing.value.path);
    $q.notify({ message: 'Initialized git repo', color: 'positive', position: 'top' });
    await go(listing.value.path);
  } catch (e) {
    $q.notify({ message: e instanceof ApiError ? e.message : 'Could not init repo', color: 'negative', position: 'top' });
  } finally {
    busy.value = false;
  }
}
onMounted(() => go('~'));
</script>

<template>
  <q-dialog v-model="open" @hide="emit('close')">
    <div class="picker panel-elevated">
      <div class="head row items-center q-gutter-sm">
        <Folder :size="18" class="amber" />
        <span class="text-weight-600">Choose a repository folder</span>
      </div>

      <div class="row items-center q-gutter-xs q-mt-sm">
        <q-btn flat dense size="sm" class="up" :disable="!listing" @click="go(listing?.parent)" aria-label="Up one folder">
          <CornerLeftUp :size="16" />
        </q-btn>
        <q-input
          v-model="manual"
          dense borderless
          class="col path-input mono"
          placeholder="~/code/…  (type a path or browse)"
          @keyup.enter="go(manual)"
        />
        <q-btn flat dense no-caps size="sm" class="goto" @click="go(manual)">Go</q-btn>
      </div>

      <div class="row items-center q-gutter-xs q-mt-xs">
        <q-btn flat dense no-caps size="sm" class="action" :loading="busy" :disable="!listing" @click="newFolder">
          <FolderPlus :size="14" class="q-mr-xs" /> New folder
        </q-btn>
        <q-btn v-if="listing && !listing.isGitRepo" flat dense no-caps size="sm" class="action" :loading="busy" @click="initHere">
          <GitBranchPlus :size="14" class="q-mr-xs" /> Make git repo here
        </q-btn>
      </div>

      <div class="list q-mt-sm">
        <div v-if="loading" class="text-muted q-pa-md">Loading…</div>
        <div v-else-if="!listing?.entries.length" class="text-muted q-pa-md">No subfolders here.</div>
        <div
          v-for="d in listing?.entries"
          :key="d.path"
          class="entry row items-center q-gutter-sm"
          @dblclick="go(d.path)"
          @click="manual = d.path"
        >
          <component :is="d.isGitRepo ? FolderGit2 : Folder" :size="16" :class="d.isGitRepo ? 'amber' : 'text-muted'" />
          <span class="col name">{{ d.name }}</span>
          <span v-if="d.isGitRepo" class="git-badge mono">git</span>
          <q-btn v-if="d.isGitRepo" flat dense no-caps size="sm" class="pick" @click.stop="emit('select', d.path); open = false">use</q-btn>
        </div>
      </div>

      <div class="row items-center justify-between q-mt-md foot">
        <span class="mono cur ellipsis" :class="listing?.isGitRepo ? 'text-muted' : 'text-accent'">
          {{ listing?.path }}<span v-if="listing && !listing.isGitRepo"> · not a git repo (will init on launch)</span>
        </span>
        <div class="row q-gutter-sm">
          <q-btn flat no-caps @click="open = false">Cancel</q-btn>
          <q-btn unelevated no-caps class="select" :disable="!listing" @click="choose">
            <Check :size="15" class="q-mr-xs" /> Use this folder
          </q-btn>
        </div>
      </div>
    </div>
  </q-dialog>
</template>

<style scoped>
.picker { width: 560px; max-width: 94vw; padding: 18px; border: 1px solid var(--fg-border); }
.amber { color: var(--fg-accent); }
.path-input { background: var(--fg-bg); border: 1px solid var(--fg-border); border-radius: 4px; padding: 2px 8px; }
.up, .goto { border: 1px solid var(--fg-border); border-radius: 4px; color: var(--fg-text-2); }
.action { border: 1px solid var(--fg-border); border-radius: 4px; color: var(--fg-text-2); }
.text-accent { color: var(--fg-accent); }
.list { max-height: 46vh; overflow-y: auto; border: 1px solid var(--fg-border); border-radius: 4px; }
.entry { padding: 8px 10px; border-bottom: 1px solid var(--fg-border); cursor: pointer; font-size: 13px; }
.entry:last-child { border-bottom: none; }
.entry:hover { background: var(--fg-surface); }
.git-badge { font-size: 10px; color: var(--fg-accent); border: 1px solid rgba(255,176,32,0.4); border-radius: 2px; padding: 1px 5px; }
.pick { color: var(--fg-accent); }
.cur { font-size: 11px; max-width: 50%; }
.select { background: var(--fg-accent); color: #0e0f11; font-weight: 600; border-radius: 4px; }
.select:disabled { opacity: 0.4; }
</style>
