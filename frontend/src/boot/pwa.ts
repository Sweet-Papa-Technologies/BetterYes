import { defineBoot } from '#q-app';

// Register the FOREMAN service worker so the dashboard is installable (Add to Home Screen).
// Served same-origin by the daemon; skipped in dev to avoid stale-cache friction.
export default defineBoot(() => {
  if (import.meta.env.DEV) return;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* SW registration is best-effort */
      });
    });
  }
});
