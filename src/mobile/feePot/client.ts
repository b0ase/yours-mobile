/**
 * Fee pot client (docs/FEE-POT.md › Flow). Wraps one BRC-100 action so the pot pays its network fee:
 *
 *   1. reserve: POST /api/feepot/reserve {kind, identityKey, txBytes, sig} → a sponsor input (outpoint + BEEF,
 *      value V) and the pot's change output (value V − fee). The input is held for this user for 60 s.
 *   2. createAction(..., inputs += sponsor input with unlockingScriptLength 107, outputs += pot change,
 *      options.signAndProcess = false). The wallet signs nothing yet; the surplus V − change is exactly the fee,
 *      so the wallet adds no fee of its own.
 *   3. cosign: POST /api/feepot/cosign {reference, tx} → the service checks its input pays only the fee
 *      (contributionOk) and returns ONLY its own unlocking script (SIGHASH_ALL|FORKID).
 *   4. signAction({reference, spends: {[sponsorVin]: {unlockingScript}}}): the wallet signs the user's inputs
 *      itself and broadcasts. The user's keys never leave the wallet.
 *
 * Any failure (pot off, empty, capped) returns null and the caller does the action the normal way (user pays).
 */
import { FEE_POT_ENABLED } from '../storeBuild';
import { BMUSIC_URL } from '../media/stream/api';
import type { FeePotKind } from './feePot';

export type SponsorInput = {
  outpoint: string;
  inputBEEF: number[];
  satoshis: number;
  changeLockingScript: string;
  changeSatoshis: number;
  feeSats: number;
  reservation: string;
};

type Fetch = typeof fetch;

export const reserveFee = async (
  req: { kind: FeePotKind; identityKey: string; txBytes: number; sig: string; timestamp: number },
  f: Fetch = fetch,
  base = BMUSIC_URL,
  enabled = FEE_POT_ENABLED,
): Promise<SponsorInput | null> => {
  if (!enabled) return null;
  try {
    const r = await f(`${base}/api/feepot/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    return r.ok ? ((await r.json()) as SponsorInput) : null;
  } catch {
    return null;
  }
};

export const cosignFee = async (
  reservation: string,
  signableTxHex: string,
  f: Fetch = fetch,
  base = BMUSIC_URL,
  enabled = FEE_POT_ENABLED,
): Promise<{ vin: number; unlockingScript: string } | null> => {
  if (!enabled) return null;
  try {
    const r = await f(`${base}/api/feepot/cosign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservation, tx: signableTxHex }),
    });
    return r.ok ? ((await r.json()) as { vin: number; unlockingScript: string }) : null;
  } catch {
    return null;
  }
};

/** The fee pot's message the identity key signs for reserve. */
export const feePotProofMessage = (kind: string, identityKey: string, txBytes: number, timestamp: number) =>
  [
    'bwx-feepot',
    'v1',
    'reserve',
    `kind=${kind}`,
    `identityKey=${identityKey}`,
    `bytes=${txBytes}`,
    `timestamp=${timestamp}`,
  ].join('|');
