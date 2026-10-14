/**
 * Outpoints come as "txid.vout" or "txid_vout" depending on who wrote them (api.1sat.app answers with a dot).
 *
 * dkg, 14 Oct 2026 (sweep 9f66943b): OneSatServices.getUtxoStatus split api.1sat.app's "txid.vout" on '_', so vout
 * was NaN and it never sent satoshis. The toolbox rejected every answer as malformed, every UnFail output verdict
 * was "unknown", and a mined sweep's change stayed unspendable while the repair reported it restored.
 */

export type Outpoint = { txid: string; vout: number };

const RE = /^([0-9a-fA-F]{64})[._](\d{1,10})$/;

/** Parse "txid.vout" or "txid_vout"; null when it is neither. */
export function parseOutpoint(o: string | undefined | null): Outpoint | null {
  const m = RE.exec((o ?? '').trim());
  if (!m) return null;
  const vout = Number(m[2]);
  return Number.isSafeInteger(vout) ? { txid: m[1].toLowerCase(), vout } : null;
}

type TxoAnswer = { outpoint?: string; spend?: string | null; satoshis?: number; height?: number; blockHeight?: number };

export type UtxoStatusResult = {
  name: string;
  status: 'success' | 'error';
  isUtxo?: boolean;
  error?: Error;
  details: { txid: string; index: number; satoshis: number; height?: number }[];
};

/**
 * getUtxoStatus for the toolbox (UnFail, ReviewUtxos), from api.1sat.app's /1sat/txo/<outpoint>.
 * - Only a well-formed answer for the outpoint we asked about counts.
 * - "spend" present → spent; absent → unspent. Details are included only when complete (satoshis known), because
 *   the toolbox rejects a detail without satoshis; an empty details list with isUtxo is accepted.
 * - Not found, an error, or an answer for a different outpoint is INCONCLUSIVE (status 'error'): we never mark an
 *   output spent without the chain saying so.
 */
export async function utxoStatusFromTxo(
  get: (outpoint: string) => Promise<TxoAnswer>,
  outpoint: string | undefined,
): Promise<UtxoStatusResult> {
  const name = '1sat-api';
  const want = parseOutpoint(outpoint);
  if (!want) return { name, status: 'error', error: new Error('outpoint is required for getUtxoStatus'), details: [] };
  let a: TxoAnswer;
  try {
    a = await get(`${want.txid}_${want.vout}`);
  } catch (e) {
    return { name, status: 'error', error: e instanceof Error ? e : new Error(String(e)), details: [] };
  }
  const got = parseOutpoint(a?.outpoint);
  if (!got || got.txid !== want.txid || got.vout !== want.vout)
    return { name, status: 'error', error: new Error('txo answer is for another outpoint'), details: [] };
  const isUtxo = !a.spend;
  const sats = a.satoshis;
  const height = a.blockHeight ?? a.height;
  const details =
    isUtxo && Number.isSafeInteger(sats) && (sats as number) >= 0
      ? [
          {
            txid: want.txid,
            index: want.vout,
            satoshis: sats as number,
            ...(Number.isSafeInteger(height) ? { height: height as number } : {}),
          },
        ]
      : [];
  return { name, status: 'success', isUtxo, details };
}

/** Replace services.getUtxoStatus with utxoStatusFromTxo when the services object has the 1sat txo client. */
export function fixUtxoStatus(services: unknown): boolean {
  const s = services as {
    txo?: { get?: (o: string, opts?: unknown) => Promise<TxoAnswer> };
    getUtxoStatus?: unknown;
  } | null;
  const get = s?.txo?.get;
  if (!s || typeof get !== 'function') return false;
  s.getUtxoStatus = (_hash: string, _format: unknown, outpoint?: string) =>
    utxoStatusFromTxo((o) => get.call(s.txo, o, { sats: true, spend: true, block: true }), outpoint);
  return true;
}
