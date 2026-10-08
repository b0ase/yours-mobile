/**
 * Address-poisoning defence (owner, 8 Oct 2026). Attackers send a dust payment or an unsolicited token from an
 * address that looks like one you pay (same first and last characters), hoping you copy it from History.
 * Warn when the recipient is, or looks like, an address that sent you something tiny or unsolicited and is not
 * an address you have sent to before.
 */
export const DUST_SATS = 1000;
const EDGE = 4;

export type PoisonData = { suspects: string[]; sentTo: string[] };

/** Same first and last EDGE characters, but a different address. */
export const looksLike = (a: string, b: string) =>
  a !== b && a.length > 2 * EDGE && b.length > 2 * EDGE && a.slice(0, EDGE) === b.slice(0, EDGE) && a.slice(-EDGE) === b.slice(-EDGE);

/** The warning to show for `recipient`, or null. */
export const poisonWarning = (recipient: string, d: PoisonData): string | null => {
  const r = recipient.trim();
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{24,40}$/.test(r) || d.sentTo.includes(r)) return null;
  const hit = d.suspects.find((s) => s === r || looksLike(s, r));
  if (!hit) return null;
  const lookalike = d.sentTo.find((s) => looksLike(s, r));
  return lookalike
    ? `Check this address carefully. It looks like ${lookalike.slice(0, 6)}…${lookalike.slice(-6)}, which you've paid before, but it's a different address that sent you a tiny or unsolicited payment. It may be a copycat.`
    : "Check this address carefully: you've never sent to it, and it recently sent you a tiny or unsolicited payment. Scammers do this so you copy their address from History.";
};

/** Suspects and past recipients from History rows. */
export const poisonDataFrom = (
  rows: { direction: string; amountSats: number; counterparty: string; type?: string }[],
): PoisonData => {
  const suspects = new Set<string>();
  const sentTo = new Set<string>();
  for (const r of rows) {
    if (!r.counterparty) continue;
    if (r.direction === 'out') sentTo.add(r.counterparty);
    else if (r.direction === 'in' && (r.type === 'transfer-in' || (r.amountSats > 0 && r.amountSats <= DUST_SATS)))
      suspects.add(r.counterparty);
  }
  return { suspects: [...suspects].filter((s) => !sentTo.has(s)), sentTo: [...sentTo] };
};

const KEY = (account: string) => `bw-poison:${account}`;
export const savePoisonData = (account: string, d: PoisonData) => {
  try {
    localStorage.setItem(KEY(account), JSON.stringify({ suspects: d.suspects.slice(0, 300), sentTo: d.sentTo.slice(0, 2000) }));
  } catch {
    /* ignore */
  }
};
export const loadPoisonData = (account: string): PoisonData => {
  try {
    const j = JSON.parse(localStorage.getItem(KEY(account)) ?? 'null') as PoisonData | null;
    return j && Array.isArray(j.suspects) && Array.isArray(j.sentTo) ? j : { suspects: [], sentTo: [] };
  } catch {
    return { suspects: [], sentTo: [] };
  }
};
