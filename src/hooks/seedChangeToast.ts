import type { SnackbarType } from '../contexts/SnackbarContext';

/**
 * The toast after Recover change from my 12 words (release click-through, 4 Nov 2026): one short line. The full result
 * is already under the button in Settings › Troubleshooting; repeating it in a long toast covered the tab bar.
 */
export function seedChangeToast(r: { success?: boolean; data?: { paused?: boolean } } | undefined): {
  text: string;
  type: SnackbarType;
} {
  if (!r) return { text: "Recover change didn't answer. Try again.", type: 'error' };
  if (!r.success) return { text: "Recover change didn't finish. The note under it says why.", type: 'error' };
  if (r.data?.paused) return { text: 'Recover change paused. Tap Carry on.', type: 'info' };
  return { text: 'Recover change finished.', type: 'success' };
}
