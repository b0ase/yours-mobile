/**
 * Keyboard shortcuts for a list of SwipeRows (desktop / web): j / k move, e archive, # or Delete delete,
 * u toggle read. Rows are found by their data-row-id; focus lands on the row's main button.
 */
import type { KeyboardEvent } from 'react';

export type ListKey = 'archive' | 'delete' | 'read';

export const keyToAction = (key: string, shift = false): ListKey | 'next' | 'prev' | null => {
  if (key === 'j' || key === 'ArrowDown') return 'next';
  if (key === 'k' || key === 'ArrowUp') return 'prev';
  if (key === 'e') return 'archive';
  if (key === '#' || key === 'Delete' || (shift && key === '3')) return 'delete';
  if (key === 'u') return 'read';
  return null;
};

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const focusRow = (row: Element | undefined) => {
  const b = row?.querySelector<HTMLElement>(
    '.bw-swipe-face > button, .bw-swipe-face [tabindex="0"], .bw-swipe-face button',
  );
  b?.focus();
  b?.scrollIntoView?.({ block: 'nearest' });
};

export const listShortcut = (e: KeyboardEvent<HTMLElement>, act: (rowId: string, a: ListKey) => void) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  if ((e.target as HTMLElement).closest?.('[role="menu"]')) return;
  const a = keyToAction(e.key, e.shiftKey);
  if (!a) return;
  const rows = [...e.currentTarget.querySelectorAll('[data-row-id]')];
  if (!rows.length) return;
  const cur = (e.target as HTMLElement).closest?.('[data-row-id]') ?? null;
  const i = cur ? rows.indexOf(cur) : -1;
  if (a === 'next' || a === 'prev') {
    // Arrow keys only steer between rows when a row already has focus (don't break page scrolling).
    if (e.key.startsWith('Arrow') && i < 0) return;
    e.preventDefault();
    focusRow(rows[a === 'next' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]);
    return;
  }
  if (!cur) return;
  e.preventDefault();
  const id = cur.getAttribute('data-row-id')!;
  // Keep the cursor in place: focus the row that takes this one's spot.
  const after = rows[i + 1] ?? rows[i - 1];
  act(id, a);
  if (a !== 'read') setTimeout(() => focusRow(after?.isConnected ? after : undefined), 0);
};
