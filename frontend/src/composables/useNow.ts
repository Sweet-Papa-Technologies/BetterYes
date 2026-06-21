import { ref } from 'vue';

// One shared, slowly-ticking clock so relative timestamps ("2m ago") update across the app
// without every component spinning up its own interval.
const now = ref(Date.now());
let started = false;

export function useNow() {
  if (!started) {
    started = true;
    setInterval(() => (now.value = Date.now()), 30_000);
  }
  return now;
}
