import { BigNumber, BSM, HD, Mnemonic, OP, PrivateKey, Script, Signature, Utils } from '@bsv/sdk';
import { AIP_PREFIX, B_PREFIX, MAP_PREFIX } from '../feed/post';

/**
 * Post to Twetch from a Twetch account restored into bWalletX (owner, 14 Oct 2026).
 *
 * Pure parts (no network, no storage) so they are unit-tested against fixtures. Mirrors the
 * bwalletx-x auto-poster (twetch.mjs), which Twetch accepts as @bWalletX since 13 Oct 2026:
 *
 *   output 0: OP_FALSE OP_RETURN B <text> text/markdown UTF-8
 *             | MAP SET app twetch type post [reply <parent txid>]
 *             | AIP BITCOIN_ECDSA <address> <base64 BSM signature>
 *   output 1: OP_FALSE OP_RETURN B <image bytes> <mime>          (optional photo, as Twetch's app does)
 *   change back to the Twetch key's own address (Twetch only shows posts paid by the account)
 *
 * then POST api.twetch.com/v1/posts with x-twetch-user / x-twetch-ts / x-twetch-sig headers,
 * sig = BSM base64 over "METHOD\npath\nuserId\nts\nbody". Twetch doesn't index broadcast-only posts.
 *
 * Which key: Twetch's app derives the account key inside its wasm (deriveWallet → accountPubkey).
 * Its strings list m/0/0 and m/0/1 next to accountAddress / accountPubkey, and legacy Twetch paid
 * from m/0/0 (DEFAULT_TWETCH_WALLET_PATH). We don't guess: every candidate key is looked up on
 * Twetch's public API (/v1/auth/user-by-pubkey/{pubkey}, the call its own app makes on restore),
 * and the account is linked only when /v1/users/{id}.publicKey equals the derived key.
 */

export const TWETCH_API = 'https://api.twetch.com';
export const TWETCH_POSTS_PATH = '/v1/posts';

/** Paths tried at link time, in order. */
export const TWETCH_CANDIDATE_PATHS = ['m/0/0', 'm/0/1', 'm/0', "m/44'/0'/0'/0/0", "m/44'/236'/0'/0/0"] as const;

/** Stored on the account (Account.twetch). Never a key: the key is re-derived from the encrypted seed. */
export type TwetchLink = {
  userId: number;
  /** Twetch's signing public key for the user, as /v1/users/{id}.publicKey. */
  pubkey: string;
  /** Where the key came from: a derivation path of the seed, or 'wallet' / 'identity' for WIF imports. */
  path: string;
  name: string;
  linkedAt: number;
};

const PIPE = 0x7c;
const { toArray } = Utils;
const pushStr = (s: Script, v: string) => s.writeBin(toArray(v, 'utf8'));

// ── request signature ────────────────────────────────────────────────────────

/** The string Twetch's API signs: "METHOD\npath\nuserId\nts\nbody" (path without the query). */
export const apiSigMessage = (method: string, path: string, userId: number, ts: number, body: string) =>
  `${method.toUpperCase()}\n${path.split('?')[0]}\n${userId}\n${ts}\n${body}`;

/** Bitcoin Signed Message, compact + base64 (with recovery), as twetch.mjs apiSign. */
export function bsmBase64(key: PrivateKey, message: string | number[]): string {
  const m = typeof message === 'string' ? toArray(message, 'utf8') : message;
  const sig = BSM.sign(m, key, 'raw') as Signature;
  const rec = sig.CalculateRecoveryFactor(key.toPublicKey(), new BigNumber(BSM.magicHash(m)));
  return sig.toCompact(rec, true, 'base64') as string;
}

export type TwetchHeaders = Record<string, string>;

/** Headers for one signed Twetch API call. */
export function twetchHeaders(
  key: PrivateKey,
  userId: number,
  method: string,
  path: string,
  body: string,
  ts: number = Date.now(),
): TwetchHeaders {
  return {
    ...(body ? { 'content-type': 'application/json' } : {}),
    accept: 'application/json',
    'x-twetch-user': String(userId),
    'x-twetch-ts': String(ts),
    'x-twetch-sig': bsmBase64(key, apiSigMessage(method, path, userId, ts, body)),
  };
}

/** The JSON body of POST /v1/posts (what twetch.com sends after broadcasting). */
export const registerBody = (o: {
  userId: number;
  text: string;
  rawTx: string;
  paidSats: number;
  replyPostId?: number | null;
}) =>
  JSON.stringify({
    userId: o.userId,
    content: o.text.trim(),
    txHex: o.rawTx,
    paidSats: o.paidSats,
    ...(o.replyPostId ? { replyPostId: o.replyPostId } : {}),
  });

// ── post scripts ─────────────────────────────────────────────────────────────

const opReturn = () => new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);

/** AIP over OP_RETURN + every data push after it + a trailing '|' (bchat.mjs aipSign), base64 signature. */
export function aipMessage(script: Script): number[] {
  const msg: number[] = [];
  let found = false;
  for (const c of script.chunks) {
    if (c.op === OP.OP_RETURN) {
      msg.push(OP.OP_RETURN);
      found = true;
      continue;
    }
    if (found && c.data?.length) msg.push(...c.data);
  }
  msg.push(PIPE);
  return msg;
}

export function aipSignBase64(script: Script, key: PrivateKey): Script {
  const sig = bsmBase64(key, aipMessage(script));
  const out = new Script(script.chunks.slice());
  out.writeBin([PIPE]);
  pushStr(out, AIP_PREFIX);
  pushStr(out, 'BITCOIN_ECDSA');
  pushStr(out, key.toPublicKey().toAddress());
  pushStr(out, sig);
  return out;
}

/** Signed output 0. `replyTxid` adds MAP `reply <txid>` (how Twetch's app marks a reply on chain). */
export function twetchPostScript(text: string, key: PrivateKey, replyTxid?: string | null): Script {
  const t = text.trim();
  if (!t) throw new Error('Write something first.');
  if (replyTxid != null && !/^[0-9a-f]{64}$/i.test(replyTxid)) throw new Error('That post id is not valid.');
  const s = opReturn();
  pushStr(s, B_PREFIX);
  pushStr(s, t);
  pushStr(s, 'text/markdown');
  pushStr(s, 'UTF-8');
  s.writeBin([PIPE]);
  pushStr(s, MAP_PREFIX);
  pushStr(s, 'SET');
  for (const v of ['app', 'twetch', 'type', 'post']) pushStr(s, v);
  if (replyTxid) {
    pushStr(s, 'reply');
    pushStr(s, replyTxid.toLowerCase());
  }
  return aipSignBase64(s, key);
}

/** Output 1: the photo, `B <bytes> <mime>` (no encoding, no name), outside the AIP signature. */
export function twetchImageScript(bytes: number[], mime: string): Script {
  const s = opReturn();
  pushStr(s, B_PREFIX);
  s.writeBin(bytes);
  pushStr(s, mime);
  return s;
}

/** Decoded pushes of a script (utf8 where printable), for tests and checks. */
export function scriptTexts(script: Script): string[] {
  return script.chunks.map((c) => {
    if (!c.data) return `OP_${c.op}`;
    const t = Utils.toUTF8(c.data);
    const printable = [...t].every((ch) => ch === '\n' || ch.charCodeAt(0) >= 0x20) && !t.includes('\ufffd');
    return printable ? t : Utils.toHex(c.data);
  });
}

/** Check an AIP-signed post script: the signature recovers to the AIP address over the signed part. */
export function verifyAip(script: Script): boolean {
  const chunks = script.chunks;
  const at = chunks.findIndex((c) => c.data && Utils.toUTF8(c.data) === AIP_PREFIX);
  if (at < 2) return false;
  const signed = new Script(chunks.slice(0, at - 1)); // drop the '|' before AIP
  const address = Utils.toUTF8(chunks[at + 2]?.data ?? []);
  const sigB64 = Utils.toUTF8(chunks[at + 3]?.data ?? []);
  try {
    const msg = aipMessage(signed);
    const sig = Utils.toArray(sigB64, 'base64');
    // Compact sig: recover the public key and compare addresses.
    const s = Signature.fromCompact(sig);
    const recId = (sig[0] - 27) & 3;
    const pub = s.RecoverPublicKey(recId, new BigNumber(BSM.magicHash(msg)));
    return pub.toAddress() === address;
  } catch {
    return false;
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────

export type CandidateKey = { path: string; key: PrivateKey };

/** Candidate Twetch keys from a seed phrase (and the account's own wallet / identity keys, for WIF imports). */
export function candidateKeys(
  mnemonic: string | undefined | null,
  wifs: { walletWif?: string; identityWif?: string } = {},
): CandidateKey[] {
  const out: CandidateKey[] = [];
  const seen = new Set<string>();
  const add = (path: string, key: PrivateKey) => {
    const pub = key.toPublicKey().toString();
    if (seen.has(pub)) return;
    seen.add(pub);
    out.push({ path, key });
  };
  if (mnemonic?.trim()) {
    const master = HD.fromSeed(Mnemonic.fromString(mnemonic.trim()).toSeed());
    for (const p of TWETCH_CANDIDATE_PATHS) add(p, master.derive(p).privKey);
  }
  if (wifs.walletWif) add('wallet', PrivateKey.fromWif(wifs.walletWif));
  if (wifs.identityWif) add('identity', PrivateKey.fromWif(wifs.identityWif));
  return out;
}

/** The key a link points at, re-derived. Throws if it no longer matches the linked public key. */
export function keyForLink(
  link: Pick<TwetchLink, 'path' | 'pubkey'>,
  mnemonic: string | undefined | null,
  wifs: { walletWif?: string; identityWif?: string } = {},
): PrivateKey {
  const c = candidateKeys(mnemonic, wifs).find((k) => k.path === link.path);
  if (!c || c.key.toPublicKey().toString().toLowerCase() !== link.pubkey.toLowerCase())
    throw new Error('This account’s keys no longer match the linked Twetch account. Link it again in Settings.');
  return c.key;
}

// ── network seam ─────────────────────────────────────────────────────────────

export type TwetchUser = { id: number; name: string; publicKey: string };
export type RegisterResult = { ok: true; id: number | null } | { ok: false; status: number; reason: string };

/** Everything Twetch-on-the-network, behind one small interface (tests pass fixtures). */
export interface TwetchClient {
  /** GET /v1/auth/user-by-pubkey/{pubkey} → user id, or null when no Twetch user has that key. */
  userIdByPubkey(pubkey: string): Promise<number | null>;
  /** GET /v1/users/{id}. */
  user(id: number): Promise<TwetchUser | null>;
  /** POST /v1/posts with the given signed headers and body. */
  registerPost(headers: TwetchHeaders, body: string): Promise<RegisterResult>;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const reasonOf = (status: number, text: string) => {
  try {
    const j = JSON.parse(text) as { error?: string; message?: string };
    if (j.error || j.message) return String(j.error || j.message).slice(0, 160);
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 160) || `HTTP ${status}`;
};

export function httpTwetchClient(f: Fetch = (u, i) => fetch(u, i), base = TWETCH_API): TwetchClient {
  return {
    async userIdByPubkey(pubkey) {
      const r = await f(`${base}/v1/auth/user-by-pubkey/${encodeURIComponent(pubkey)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 404) return null;
      if (r.status === 403) throw new Error('This Twetch account has been banned.');
      if (!r.ok) throw new Error(`Twetch lookup failed (${r.status})`);
      const j = (await r.json()) as { userId?: unknown };
      const id = Number(j.userId);
      return Number.isSafeInteger(id) && id >= 0 ? id : null;
    },
    async user(id) {
      const r = await f(`${base}/v1/users/${id}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Twetch lookup failed (${r.status})`);
      const j = (await r.json()) as { id?: unknown; name?: unknown; publicKey?: unknown };
      return { id: Number(j.id), name: String(j.name ?? ''), publicKey: String(j.publicKey ?? '') };
    },
    async registerPost(headers, body) {
      for (let attempt = 0; ; attempt++) {
        const r = await f(`${base}${TWETCH_POSTS_PATH}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await r.text();
        // Cloudflare 502s now and then; registering the same tx again is safe.
        if (r.status >= 500 && attempt < 2) {
          await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1)));
          continue;
        }
        if (!r.ok) return { ok: false, status: r.status, reason: reasonOf(r.status, text) };
        try {
          const j = JSON.parse(text) as { id?: unknown; post?: { id?: unknown } };
          const id = Number(j.id ?? j.post?.id);
          return { ok: true, id: Number.isSafeInteger(id) && id > 0 ? id : null };
        } catch {
          return { ok: true, id: null };
        }
      }
    },
  };
}

// ── verification ─────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; link: TwetchLink }
  | { ok: false; reason: 'not-found' | 'mismatch'; message: string };

/**
 * Find the Twetch account these keys sign for. A candidate counts only when Twetch maps its public key to a
 * user AND that user's published signing key is exactly this key.
 */
export async function verifyTwetchAccount(
  client: TwetchClient,
  candidates: CandidateKey[],
  now: number = Date.now(),
): Promise<VerifyResult> {
  let mismatch = false;
  for (const c of candidates) {
    const pubkey = c.key.toPublicKey().toString().toLowerCase();
    const id = await client.userIdByPubkey(pubkey);
    if (id == null) continue;
    const u = await client.user(id);
    if (!u || u.publicKey.toLowerCase() !== pubkey) {
      mismatch = true;
      continue;
    }
    return { ok: true, link: { userId: id, pubkey, path: c.path, name: u.name || `Twetch user ${id}`, linkedAt: now } };
  }
  return mismatch
    ? {
        ok: false,
        reason: 'mismatch',
        message: 'Twetch knows this key, but it isn’t the account’s current signing key, so posts would be refused.',
      }
    : {
        ok: false,
        reason: 'not-found',
        message: 'No Twetch account uses these 12 words. Restore the account with your Twetch recovery phrase.',
      };
}

/** "Twetch: linked as @name (#id)". */
export const linkLabel = (l: Pick<TwetchLink, 'name' | 'userId'>) => `Twetch: linked as @${l.name} (#${l.userId})`;

/** What the composer says when the chain post worked but Twetch said no. */
export const notAcceptedNote = (reason: string) => `Posted on chain; Twetch didn't accept it (${reason})`;
