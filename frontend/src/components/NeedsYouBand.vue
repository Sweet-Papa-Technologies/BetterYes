<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { TriangleAlert, ChevronRight } from 'lucide-vue-next';
import type { Job } from '@foreman/shared';

const props = defineProps<{ jobs: Job[] }>();
const router = useRouter();

const text = computed(() => {
  if (props.jobs.length === 1) return `${props.jobs[0]!.name} needs a human decision`;
  return `${props.jobs.length} jobs need a human decision`;
});

function go() {
  if (props.jobs[0]) void router.push(`/jobs/${props.jobs[0].id}`);
}
</script>

<template>
  <div
    v-if="jobs.length"
    class="needs-you-band row items-center q-px-md q-py-sm cursor-pointer"
    @click="go"
  >
    <TriangleAlert :size="16" class="q-mr-sm" />
    <span class="col text-weight-medium">{{ text }}</span>
    <ChevronRight :size="16" />
  </div>
</template>
