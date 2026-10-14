import { inRange, type HistoryRow, type Range } from './txHistory';

/** "Updated just now" / "Updated 5 min ago" / "Updated 14:02" for the History screen's last load. */
export const updatedText = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'Updated just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const d = new Date(at);
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return now - at < 86_400_000 ? `Updated ${hhmm}` : `Updated ${d.toLocaleDateString()} ${hhmm}`;
};

/**
 * Rows outside the chosen range (before or after it). The default range is 30 days, so a wallet whose last
 * payment is older read "0 transactions" with an opening balance equal to the closing one, and a refresh changed
 * nothing on screen: the history had loaded, the range hid it. The screen offers "All time" with this count.
 */
export const hiddenByRange = (all: HistoryRow[], r: Range) => all.filter((x) => !inRange(x.time, r)).length;
