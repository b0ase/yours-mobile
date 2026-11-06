/**
 * What a failed sync says in the sync log: the error's name, message, the backup call that failed and the page it
 * carried, and where it was thrown. Owner's iPhone, 6 Nov 2026: every heal and push logged only "An internal error has
 * occurred.", which is what wallet.1sat.app's StorageServer answers for ANY error that is not a WalletError
 * (publicWalletErrorJson), so the log could not say which call failed or on what.
 *
 * Nothing secret goes in: no row contents, no arguments, only counts and sizes. Anything in a message or stack that could
 * be key material (a seed's words, bytes, hex, base64) is cut (scrub, below).
 */

const CALL = Symbol.for('bwx.storageCall');
const WRAPPED = Symbol.for('bwx.storageCall.wrapped');

export type StorageCall = { method: string; page?: string };

/** Note on an error which backup call it came from (the first note wins: the innermost call). */
export function tagStorageCall<E>(e: E, call: StorageCall): E {
  if (e !== null && typeof e === 'object' && !(CALL in e))
    try {
      Object.defineProperty(e, CALL, { value: call, enumerable: false });
    } catch {
      // a frozen error: logged without the call
    }
  return e;
}

export const storageCallOf = (e: unknown): StorageCall | undefined =>
  e !== null && typeof e === 'object' ? ((e as Record<symbol, unknown>)[CALL] as StorageCall | undefined) : undefined;

const ENTITIES = [
  'provenTxs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'outputs',
  'txLabelMaps',
  'outputTagMaps',
  'certificates',
  'certificateFields',
  'commissions',
  'provenTxReqs',
] as const;
const BYTE_FIELDS = ['rawTx', 'inputBEEF', 'merklePath', 'lockingScript'] as const;

/**
 * The shape of a sync page: how many rows of each kind, the longest byte array in it (a raw transaction or BEEF sent as
 * a JSON number array counts one array item per byte against the server's RPC budget), and its rough size.
 */
export function pageShape(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== 'object') return undefined;
  const c = chunk as Record<string, unknown>;
  const parts: string[] = [];
  let longest = 0;
  let longestAt = '';
  let bytes = 0;
  for (const k of ENTITIES) {
    const rows = c[k];
    if (!Array.isArray(rows) || !rows.length) continue;
    parts.push(`${k} ${rows.length}`);
    for (const r of rows as Record<string, unknown>[])
      for (const f of BYTE_FIELDS) {
        const v = r?.[f] as { length?: number } | undefined;
        const n = typeof v?.length === 'number' ? v.length : 0;
        bytes += n;
        if (n > longest) {
          longest = n;
          longestAt = `${k}.${f}`;
        }
      }
  }
  if (c.user) parts.push('user');
  if (!parts.length) return 'empty page';
  if (longest) parts.push(`longest ${longestAt} ${longest}`);
  parts.push(`~${Math.round(bytes / 1024)} KB`);
  return parts.join(', ');
}

/**
 * Tag every error a backup store's RPC raises with its method (and, for a sync page, the page's shape). Patches the
 * StorageClient class once; returns the undo.
 */
export function tagStorageClientErrors(cls: { prototype: object }): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  const original = proto.rpcCall as ((method: string, params: unknown[]) => Promise<unknown>) | undefined;
  if (typeof original !== 'function' || proto[WRAPPED]) return () => undefined;
  const wrapped = async function (this: unknown, method: string, params: unknown[]) {
    try {
      return await original.call(this, method, params);
    } catch (e) {
      let page: string | undefined;
      try {
        if (method === 'processSyncChunk') page = pageShape(params?.[1]);
      } catch {
        // diagnostics never change behaviour
      }
      throw tagStorageCall(e, { method, ...(page ? { page } : {}) });
    }
  };
  proto.rpcCall = wrapped;
  proto[WRAPPED] = true;
  return () => {
    if (proto.rpcCall === wrapped) proto.rpcCall = original;
    delete proto[WRAPPED];
  };
}

const cut = (m: string) => `${m.slice(0, 4)}…`;
/**
 * Anything that could be key material is cut (review, 6 Nov 2026): a run of 6 or more lowercase 3-8 letter words (a seed
 * phrase's words),
 * a byte array of more than 8 numbers, 16 or more hex characters, and 16 or more base64 characters that carry a digit,
 * + or / (so a long name like TransactionInactiveError stays readable).
 */
const scrub = (s: string) =>
  s
    .replace(/\b[a-z]{3,8}(?:[\s,]+[a-z]{3,8}){5,}\b/g, '[words cut]')
    .replace(/\[\s*\d+(?:\s*,\s*\d+){8,}\s*(?:,\s*)?\]?/g, '[bytes cut]')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, cut)
    .replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (m) => (/[0-9+/]/.test(m) ? cut(m) : m));

/** The first few frames of a stack, each as "function@file:line" (Safari's and V8's formats). */
function frames(stack: string | undefined, max = 4): string | undefined {
  if (!stack) return undefined;
  const out: string[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    const v8 = /^at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    const wk = /^(.*?)@(.+?):(\d+):\d+$/.exec(line);
    const m = v8 ?? wk;
    if (!m) continue;
    const fn = (m[1] || '?').replace(/^async /, '').slice(0, 40);
    // The file's name alone: never its query string or hash (a token in a script URL).
    const file = m[2].split(/[?#]/)[0].split('/').pop() || '?';
    out.push(`${fn}@${file.slice(0, 40)}:${m[3]}`);
    if (out.length >= max) break;
  }
  return out.length ? out.join(' < ') : undefined;
}

/** WebKit ended the transaction in its storage process (iOS suspended the app, or the IndexedDB server was lost). */
export const isWebKitIdbAbort = (message: string) =>
  /without an in-progress transaction|Connection to Indexed Database server lost/i.test(message);

const UNREADABLE = 'an error that could not be read';

/** One line for the sync log: name: message · in <call> (<page>) · at <frames>. At most `max` characters. Never throws. */
export function syncErrorDetail(e: unknown, max = 700): string {
  try {
    const err = e as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
    const name = typeof err?.name === 'string' && err.name ? err.name : typeof e;
    const message =
      e instanceof Error || typeof err?.message === 'string' ? String(err?.message ?? '') : String(e ?? 'unknown');
    // What came with the error is scrubbed; the call's name, the page's counts and our own notes are ours.
    const parts = [scrub(`${name}: ${message}`)];
    const call = storageCallOf(e);
    if (call) parts.push(`in ${call.method}${call.page ? ` (${call.page})` : ''}`);
    if (isWebKitIdbAbort(message))
      parts.push('WebKit ended this IndexedDB transaction (the app was suspended, or its storage process was lost)');
    const at = frames(typeof err?.stack === 'string' ? err.stack : undefined);
    if (at) parts.push(`at ${scrub(at)}`);
    const line = parts.join(' · ');
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  } catch {
    return UNREADABLE;
  }
}
