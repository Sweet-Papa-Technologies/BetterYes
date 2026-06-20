<script setup lang="ts">
import { onMounted } from 'vue';
import { useJobsStore } from './stores/jobs';
import AppShell from './components/AppShell.vue';

// Boot the live job board subscription once for the whole app.
const store = useJobsStore();
onMounted(() => {
  store.loadAndSubscribe().catch(() => {
    /* unauthorized / daemon down — pages surface this */
  });
});
</script>

<template>
  <AppShell />
</template>
