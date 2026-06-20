<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { LayoutGrid, MessageSquare, ShieldCheck, Settings as SettingsIcon } from 'lucide-vue-next';
import { useJobsStore } from '../stores/jobs';
import EscalationSheet from './EscalationSheet.vue';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const store = useJobsStore();

const nav = [
  { to: '/', label: 'Board', icon: LayoutGrid },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/rules', label: 'Rules', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const needsYou = computed(() => store.summary.needsYou);
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));
const go = (to: string) => router.push(to);
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <!-- Desktop sidebar -->
    <q-drawer
      v-if="$q.screen.gt.sm"
      show-if-above
      :width="220"
      :breakpoint="0"
      bordered
      class="sidebar column"
    >
      <div class="wordmark q-px-md q-py-md row items-center justify-between">
        <span class="brand">FOREMAN</span>
        <span class="conn" :class="store.live ? 'live' : 'down'" :title="store.live ? 'live' : 'reconnecting…'" />
      </div>

      <q-list class="col">
        <q-item
          v-for="n in nav.slice(0, 3)"
          :key="n.to"
          clickable
          :active="isActive(n.to)"
          active-class="nav-active"
          class="nav-item"
          @click="go(n.to)"
        >
          <q-item-section avatar><component :is="n.icon" :size="18" /></q-item-section>
          <q-item-section>{{ n.label }}</q-item-section>
          <q-item-section v-if="n.to === '/' && needsYou" side>
            <span class="needs-badge">{{ needsYou }}</span>
          </q-item-section>
        </q-item>
      </q-list>

      <q-list>
        <q-item clickable :active="isActive('/settings')" active-class="nav-active" class="nav-item" @click="go('/settings')">
          <q-item-section avatar><SettingsIcon :size="18" /></q-item-section>
          <q-item-section>Settings</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- Mobile bottom tab bar -->
    <q-footer v-if="!$q.screen.gt.sm" class="bottom-bar">
      <q-tabs no-caps active-color="primary" indicator-color="transparent" class="text-grey-6">
        <q-tab
          v-for="n in nav"
          :key="n.to"
          :name="n.to"
          @click="go(n.to)"
          :class="{ 'tab-active': isActive(n.to) }"
        >
          <div class="column items-center tab-inner">
            <div class="relative-position">
              <component :is="n.icon" :size="20" />
              <span v-if="n.to === '/' && needsYou" class="needs-dot" />
            </div>
            <span class="tab-label">{{ n.label }}</span>
          </div>
        </q-tab>
      </q-tabs>
    </q-footer>

    <!-- The escalation surface overlays everything when a job needs a human (S3) — except on
         the Chat route, where escalations are answered inline in the thread. -->
    <EscalationSheet
      v-if="store.topEscalation && route.path !== '/chat'"
      :key="store.topEscalation.id"
      :escalation="store.topEscalation"
    />
  </q-layout>
</template>

<style scoped>
.sidebar { background: var(--fg-surface); border-right: 1px solid var(--fg-border) !important; }
.brand {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; letter-spacing: 0.06em;
  color: var(--fg-accent); font-size: 15px;
}
.conn { width: 8px; height: 8px; border-radius: 9999px; }
.conn.live { background: var(--fg-running); box-shadow: 0 0 6px var(--fg-running); }
.conn.down { background: var(--fg-muted); }
.nav-item { border-radius: 4px; margin: 2px 8px; min-height: 40px; color: var(--fg-text-2); }
.nav-active { background: var(--fg-surface-elevated); color: var(--fg-text); }
.needs-badge {
  background: var(--fg-accent); color: #0e0f11; font-weight: 700; font-size: 11px;
  border-radius: 9999px; padding: 1px 7px; font-family: 'JetBrains Mono', monospace;
}
.bottom-bar { background: var(--fg-surface); border-top: 1px solid var(--fg-border); }
.tab-inner { padding: 4px 0; gap: 2px; }
.tab-label { font-size: 10px; }
.tab-active { color: var(--fg-accent); }
.needs-dot {
  position: absolute; top: -2px; right: -4px; width: 8px; height: 8px;
  background: var(--fg-accent); border-radius: 9999px;
}
</style>
