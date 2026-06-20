<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { Folder, FolderGit2, CornerLeftUp, Check } from 'lucide-vue-next';
import { api, type DirListing } from '../lib/api';

// Browses the DAEMON's filesystem (that's where jobs run) so you can pick a repo folder.
const emit = defineEmits<{ (e: 'select', path: string): void; (e: 'close'): void }>();
const $q = useQuasar();

const open = ref(true);
const listing = ref<DirListing | null>(null);
const loading = ref(false);
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
        <span class="mono text-muted cur ellipsis">{{ listing?.path }}</span>
        <div class="row q-gutter-sm">
          <q-btn flat no-caps @click="open = false">Cancel</q-btn>
          <q-btn unelevated no-caps class="select" :disable="!listing?.isGitRepo" @click="choose">
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
