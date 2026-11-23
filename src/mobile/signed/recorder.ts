import { setSealRecordedHook, type SealRecorded } from '../chat/nativeSeal';
import { addLocal, loadCachedSync, loadLocal, type KV } from './localStore';

/**
 * Writes the wallet's own Signed record every time a seal is recorded on this device (a fresh seal on the native Sign
 * page, or a recovered one: nativeSeal.setSealRecordedHook). Installed by MobileRoutes (signed/SignedMenu.tsx).
 *
 *   - Filed under the identity key the SEAL carries. A seal saved before keys were stored with it (before 6 Nov) is
 *     not filed under anyone: it can't be told whose it is, and bit-sign's list shows it to its owner anyway.
 *   - The room: the hook's own ticker when the seal flow passes one, else a row this wallet already knows for that
 *     document (its own list, or bit-sign's last list). Unknown → '' until the next sync fills it in. Never the screen
 *     that happens to be open.
 */
export interface RecorderEnv {
  now?: () => number;
  kv?: KV | null;
}

export const roomFor = (
  s: Pick<SealRecorded, 'documentId' | 'ticker'>,
  identityKey: string,
  kv?: KV | null,
): string => {
  const own = (s.ticker || '').trim().replace(/^\$/, '').toUpperCase();
  if (/^[A-Z0-9][A-Z0-9&._-]{0,31}$/.test(own)) return own;
  const known = [...loadLocal(identityKey, kv), ...(loadCachedSync(identityKey, kv)?.rows ?? [])].find(
    (r) => r.documentId === s.documentId && r.room,
  );
  return known?.room ?? '';
};

/** One recorded seal → one local record. Pure over `env` (signed.test.ts). */
export const recordSeal = (s: SealRecorded, env: RecorderEnv = {}): void => {
  const identityKey = (s.identityKey || '').trim();
  if (!identityKey) return;
  addLocal(
    identityKey,
    {
      signatureId: s.signatureId,
      documentId: s.documentId,
      docHash: s.docHash,
      sealTxid: s.txid,
      room: roomFor(s, identityKey, env.kv),
      title: s.title,
      at: (env.now ?? Date.now)(),
      complete: s.complete,
    },
    env.kv,
  );
};

let installed = false;
/** Install the recorder once (idempotent). */
export const installSignedRecorder = (): void => {
  if (installed) return;
  installed = true;
  setSealRecordedHook((s) => recordSeal(s));
};
