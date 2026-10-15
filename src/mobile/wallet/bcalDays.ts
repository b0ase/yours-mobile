import type { HistoryRow } from './txHistory';
import { assetText } from './historyEvents';
import type { PodcastEpisode } from '../bradio/rssPodcasts';
import type { Podcast } from '../bradio/podcasts';

/**
 * bCal (owner, 15 Oct 2026): a month of the wallet's REAL activity. Every item comes from a real source (the
 * History rows, the bRadio podcast catalogue and RSS line-ups); nothing is made up, and a source with nothing in
 * it simply shows nothing. Pure helpers here (tested in bcalDays.test.ts); the screen is BCal.tsx.
 */
export type CalKind = 'buy' | 'sell' | 'episode' | 'podcast' | 'held';
export type CalItem = { id: string; at: number; kind: CalKind; title: string; sub: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a time, as YYYY-MM-DD. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Items grouped by local day, each day newest first. Items without a real time (0 / NaN) are dropped. */
export const groupByDay = (items: CalItem[]): Map<string, CalItem[]> => {
  const out = new Map<string, CalItem[]>();
  for (const it of items) {
    if (!Number.isFinite(it.at) || it.at <= 0) continue;
    const k = dayKey(it.at);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  for (const list of out.values()) list.sort((a, b) => b.at - a.at);
  return out;
};

export type GridCell = { key: string; day: number; inMonth: boolean };

/** A month as whole weeks (Monday first): leading/trailing days of the next/previous month have inMonth false. */
export const monthGrid = (year: number, month: number): GridCell[] => {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((lead + days) / 7) * 7;
  const cells: GridCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(year, month, 1 - lead + i);
    cells.push({ key: dayKey(d.getTime()), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return cells;
};

/** History rows → items bought and sold (the classified buy / sell events only). */
export const tradeItems = (rows: HistoryRow[]): CalItem[] =>
  rows
    .filter((r) => r.type === 'buy' || r.type === 'sell')
    .map((r) => ({
      id: `tx:${r.txid}`,
      at: r.time,
      kind: r.type as 'buy' | 'sell',
      title: (r.type === 'buy' ? 'Bought ' : 'Sold ') + (assetText(r.asset) || r.label || 'an item'),
      sub: `${Math.abs(r.amountSats).toLocaleString('en-US')} sats`,
    }));

/** RSS episodes → the podcast line-up (episodes without a published date are left out). */
export const episodeItems = (eps: PodcastEpisode[]): CalItem[] =>
  eps
    .filter((e) => e.at > 0)
    .map((e) => ({ id: `ep:${e.id}`, at: e.at, kind: 'episode', title: e.title, sub: e.showName }));

/** bRadio podcasts (recorded Spaces) → items; the ones this wallet holds are marked 'held'. */
export const podcastItems = (items: Podcast[], held: (p: Podcast) => boolean): CalItem[] =>
  items.map((p) => ({
    id: `pod:${p.id}`,
    at: Date.parse(p.createdAt),
    kind: held(p) ? 'held' : 'podcast',
    title: p.title,
    sub: p.host ? `@${p.host}` : 'bRadio',
  }));
