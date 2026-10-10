/**
 * bWalletX extension: ring when the side panel is closed.
 *
 * In the panel, calls ring by polling (calls/store.ts). With the panel shut nothing was listening, so a
 * call just went unanswered. The background now checks every 30 seconds (Chrome's shortest alarm)
 * while the wallet is unlocked and no panel or calls window is open, and shows a notification for
 * each new incoming call. Clicking it opens the Calls window, which rings and answers as usual.
 *
 * Limits, stated: up to ~30 s late; nothing rings while the wallet is locked (no keys to sign the
 * calls session with).
 */
export const CALL_RING_ALARM = 'calls-ring';
export const CALL_NOTIFICATION_PREFIX = 'bwx-call:';

export interface RingCandidate {
  id: string;
  peer_label?: string | null;
}

/** The calls to announce now: new ones only, and none while a panel/window is open (it rings itself). */
export function callsToAnnounce(
  incoming: RingCandidate[],
  seen: ReadonlySet<string>,
  panelOpen: boolean,
): RingCandidate[] {
  if (panelOpen) return [];
  return incoming.filter((c) => c && typeof c.id === 'string' && !seen.has(c.id));
}

/** The notification for one incoming call. */
export function callNotification(c: RingCandidate) {
  const who = String(c.peer_label || '')
    .replace(/^\$/, '')
    .trim();
  return {
    id: `${CALL_NOTIFICATION_PREFIX}${c.id}`,
    options: {
      type: 'basic' as const,
      iconUrl: 'icons/icon128.png',
      title: 'Incoming call',
      message: who ? `${who} is calling you on bWalletX` : 'Someone is calling you on bWalletX',
      requireInteraction: true,
      priority: 2,
    },
  };
}

/**
 * The calls API, as the background reaches it. Kept free of the app's chat client because that pulls
 * in @capacitor/core, which a service worker must not load. Same requests as calls/api.ts CallsClient
 * (session proof format is pinned to it by callRinger.test.ts).
 */
export const RING_ORIGIN = 'https://www.bitcoinchat.online';
export const ringProofMessage = (identityKey: string, timestamp: number, nonce: string) =>
  ['bwallet-calls', 'v1', 'session', `identityKey=${identityKey}`, `nonce=${nonce}`, `timestamp=${timestamp}`].join(
    '|',
  );

export interface RingSigner {
  identityKey: () => Promise<string>;
  /** Hex signature by the identity key over `message` (protocol [2,'bwallet calls'], key '1', counterparty 'anyone'). */
  sign: (message: string) => Promise<string>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<{ status: number; json: () => Promise<unknown> }>;

let ringToken: { token: string; key: string; exp: number } | null = null;

const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

async function ringSession(f: FetchFn, s: RingSigner, origin: string, force = false): Promise<string> {
  const key = (await s.identityKey()).toLowerCase();
  if (!force && ringToken && ringToken.key === key && ringToken.exp - 60_000 > Date.now()) return ringToken.token;
  const timestamp = Date.now();
  const nonce = hex(16);
  const signature = await s.sign(ringProofMessage(key, timestamp, nonce));
  const r = await f(`${origin}/api/bitsign/wallet-calls/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identity_key: key, timestamp, nonce, signature }),
  });
  const d = (await r.json().catch(() => ({}))) as { token?: string; expires_at?: string };
  if (r.status !== 200 || !d.token) throw new Error(`calls session ${r.status}`);
  ringToken = { token: d.token, key, exp: Date.parse(d.expires_at || '') || Date.now() + 10 * 60_000 };
  return d.token;
}

/** The calls ringing this wallet now. One re-sign on 401. */
export async function fetchIncoming(f: FetchFn, s: RingSigner, origin = RING_ORIGIN): Promise<RingCandidate[]> {
  for (const force of [false, true]) {
    const token = await ringSession(f, s, origin, force);
    const r = await f(`${origin}/api/bitsign/wallet-calls`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (r.status === 401 && !force) continue;
    if (r.status !== 200) throw new Error(`calls list ${r.status}`);
    const d = (await r.json().catch(() => ({}))) as { incoming?: RingCandidate[] };
    return Array.isArray(d.incoming) ? d.incoming : [];
  }
  return [];
}

/** Tests only. */
export const resetRingSession = () => {
  ringToken = null;
};
