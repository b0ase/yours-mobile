// bTrust restore with one box per slice: each box checks on its own, and restore turns on once enough
// different, matching slices are in. A box may hold several pasted lines; each line is read as a slice.

import { parseCard, type Parsed } from './slices';

export type BoxState =
  | { kind: 'empty' }
  | { kind: 'ok'; cards: (Parsed & { text: string })[]; label: string }
  | { kind: 'error'; message: string };

/** Slices needed, from the share itself (x.y.threshold.integrity), or null if unreadable. */
export const thresholdOf = (p: Parsed) => {
  const t = Number(p.share.split('.')[2]);
  return Number.isInteger(t) && t >= 2 ? t : null;
};

export function checkBox(text: string): BoxState {
  const lines = text
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { kind: 'empty' };
  try {
    const cards = lines.map((text) => ({ ...parseCard(text), text }));
    const label = cards.map((c) => `slice ${c.index} of ${c.total}`).join(', ');
    return { kind: 'ok', cards, label: `${label} · set ${cards[0].setId}` };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'not a bTrust slice' };
  }
}

export type RestoreState = {
  boxes: BoxState[];
  /** Slices needed (from the slices), else 2 until one is read. */
  threshold: number;
  /** Total slices in the set, so the page knows whether "Add another slice" makes sense. */
  total: number;
  /** Distinct slices from one set so far. */
  have: number;
  ready: boolean;
  /** Set-level problem (mixed sets), shown under the boxes. */
  problem: string;
  /** The slice texts to restore from, once ready. */
  texts: string[];
};

export function restoreState(texts: string[]): RestoreState {
  const boxes = texts.map(checkBox);
  const cards = boxes.flatMap((b) => (b.kind === 'ok' ? b.cards : []));
  const sets = new Set(cards.map((c) => c.setId));
  const threshold = cards.map(thresholdOf).find((t): t is number => t !== null) ?? 2;
  const total = cards[0]?.total ?? 3;
  const distinct = new Map(cards.map((c) => [c.index, c]));
  const problem = sets.size > 1 ? 'These slices are from different sets.' : '';
  const have = problem ? 0 : distinct.size;
  const ready = !problem && have >= threshold && boxes.every((b) => b.kind !== 'error');
  return {
    boxes,
    threshold,
    total,
    have,
    ready,
    problem,
    texts: ready ? [...distinct.values()].map((c) => c.text) : [],
  };
}
