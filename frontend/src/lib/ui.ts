import { copyToClipboard, Notify } from 'quasar';

/** Copy text to the clipboard and toast a confirmation. Component-free (uses the Notify plugin). */
export async function copyText(text: string, label = 'Copied'): Promise<void> {
  try {
    await copyToClipboard(text);
    Notify.create({ message: `${label}: ${text}`, color: 'positive', position: 'top', timeout: 1400 });
  } catch {
    Notify.create({ message: 'Copy failed', color: 'negative', position: 'top', timeout: 1400 });
  }
}

/** Compact relative time: "now", "3m", "2h", "4d", else a date. `nowMs` lets callers tick it. */
export function timeAgo(iso: string, nowMs = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

/** True when focus is in a text field — used to ignore single-key shortcuts while typing. */
export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
