<script setup lang="ts">
import { MessageSquare } from 'lucide-vue-next';
</script>

<template>
  <q-page class="flex flex-center column text-center q-pa-xl">
    <MessageSquare :size="40" class="text-muted q-mb-md" />
    <div class="text-h6 text-weight-600">Talk to Hermes</div>
    <div class="text-2 q-mt-sm" style="max-width: 360px">
      The conversational control surface — start jobs, ask status, and answer escalations in plain
      language — arrives in <span class="mono text-accent">M4</span> with the Hermes bridge.
    </div>
  </q-page>
</template>

<style scoped>
.text-accent { color: var(--fg-accent); }
</style>
