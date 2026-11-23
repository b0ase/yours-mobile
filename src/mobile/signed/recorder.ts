import { setSealRecordedHook, type SealRecorded } from '../chat/nativeSeal';
import { addLocal, loadCachedSync, loadLocal, type KV } from './localStore';

/**
 * Writes the wallet's own Signed record every time a seal is recorded on this device (a fresh seal on the native Sign
 * page, or a recovered one: nativeSeal.setSealRecordedHook). Installed once, at startup (signed/SignedMenuRow.tsx).
 *
 * The room is not part of the seal, so it is taken from where the seal ran: the Sign page's route
 * (/m/seal/<TICKER>/<doc>), else a row this wallet already knows for that document. Unknown → '' (the next sync with
 * bit-sign fills it in).
 */
export interface RecorderEnv {
  /** The router's current path (the seal page while a seal finishes). */
  path: () => string;
  /** The current account's identity key, for a record saved before keys were stored with it. */
  identityKey: () => string;
  now?: () => number;
  kv?: KV | null;
}

const SEAL_PATH = /^\/m\/seal\/([^/]+)\/([^/?#]+)/;

export const roomFor = (s: Pick<SealRecorded, 'documentId'>, identityKey: string, env: RecorderEnv): string => {
  const m = SEAL_PATH.exec(env.path() || '');
  if (m) {
    try {
      return decodeURIComponent(m[1]).replace(/^\$/, '').toUpperCase();
    } catch {
      /* fall through */
    }
  }
  const known = [...loadLocal(identityKey, env.kv), ...(loadCachedSync(identityKey, env.kv)?.rows ?? [])].find(
    (r) => r.documentId === s.documentId && r.room,
  );
  return known?.room ?? '';
};

/** One recorded seal → one local record. Pure over `env` (signed.test.ts). */
export const recordSeal = (s: SealRecorded, env: RecorderEnv): void => {
  const identityKey = s.identityKey || env.identityKey();
  if (!identityKey) return;
  addLocal(
    identityKey,
    {
      signatureId: s.signatureId,
      documentId: s.documentId,
      docHash: s.docHash,
      sealTxid: s.txid,
      room: roomFor(s, identityKey, env),
      title: s.title,
      at: (env.now ?? Date.now)(),
      complete: s.complete,
    },
    env.kv,
  );
};

let env: RecorderEnv | null = null;
/** Install (or re-point) the recorder. Idempotent: the hook is set once and reads the latest env. */
export const installSignedRecorder = (next: RecorderEnv): void => {
  const first = !env;
  env = next;
  if (first) setSealRecordedHook((s) => env && recordSeal(s, env));
};
