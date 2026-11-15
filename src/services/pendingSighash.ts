/**
 * Sighashes of a site's own pending action (owner, 15 Nov 2026: Bitcoin Writer saves and other app-locked spends
 * failed with "Sites cannot ask for a signature over a hash the wallet cannot read").
 *
 * The standard BRC-100 way to spend an input locked to a key the site names: createAction → signableTransaction, then
 * createSignature({ hashToDirectlySign: sha256d(BIP143 preimage) }) per input (or `data`: sha256(preimage), which
 * createSignature hashes once more: @bsv/sdk's PushDrop.unlock), then signAction({ spends }). The
 * cross-site guard refuses every bare hash from an outside site, because it can't read one. This is the one hash it
 * CAN read: the wallet recomputes it from its own copy of the transaction and never looks at the page's preimage.
 *
 * A hash is accepted only when every line holds; anything else keeps the guard's refusal, unchanged:
 *  - the action was created through this wallet by the SAME originator (exact string), is still pending (not signed,
 *    not aborted) and less than PENDING_SIGHASH_TTL_MS old;
 *  - the pay check ran on it: it takes more from the wallet than the inputs the site named bring (the permissions
 *    manager's computeNetSpend > 0, the only case where it calls ensureSpendingAuthorization: the pay sheet, or the
 *    site's envelope). An action that only moves app-locked coins shows no sheet, so its hashes stay refused;
 *  - the hash is SIGHASH_ALL|FORKID of one input the site named and must unlock itself (never an input the wallet
 *    funds and signs), over the wallet's transaction, with that input's real source satoshis and locking script;
 *  - that input's locking script is P2PKH, alone or after one inscription envelope (ordinals, BSV-21), or a key and
 *    OP_CHECKSIG with PushDrop's dropped fields before or after (BRC-48 tokens), and its key is the very key asked
 *    for (protocolID, keyID, counterparty). Any other script shape is refused:
 *    the wallet can't tell which key it needs, and a signature by an unrelated key over a real sighash is a blind
 *    signature by that key;
 *  - the protocol is one a site may sign with at all (reservedProtocols.ts: reserved, level-0 and BRC-29 keys stay
 *    refused, here as well as in the guard outside this one), is not a permission module's ("p …") and is not the
 *    posting key's; a protocol pinned to a site (pinnedProtocols.ts) only from that site;
 *  - the site ALREADY holds the user's grant for that protocol and counterparty (review 15 Nov 2026). Checked
 *    without asking, and before the hash is looked up or any key derived: a site with no grant gets the same answer
 *    whether it guessed a coin's key or not, and no sheet opens for a coin it merely named. A site spending its own
 *    coins got the grant when it asked for the key to lock them. This does not bind a coin to the site that made it:
 *    BRC-42 keys don't depend on the site, so a site the user gives another app's (unpinned) protocol to can spend
 *    that app's coins, here as anywhere else in BRC-100. Pinning the protocol is what stops that.
 *
 * Kept in memory, per wallet instance (guardCrossSiteSigning makes one): a lock or an account switch drops the wallet
 * and this with it. A restarted service worker has none, so the hash is refused; the toolbox can't finish that
 * action either (Wallet.signAction: "recovery of out-of-session signAction reference data is not yet implemented"),
 * so persisting it would only keep sighashes of a dead action on disk.
 */
import { Hash, OP, Transaction, TransactionSignature, Utils, type Script } from '@bsv/sdk';
import { canonicalOutpoint } from './canonicalOutpoint';
import { normalizeOriginator } from '@1sat/wallet';
import { pinnedProtocolRefusal } from './pinnedProtocols';
import { reservedProtocolRefusal } from './reservedProtocols';

/** How long after createAction its sighashes are accepted. A sign follows a create at once; a sheet may sit between. */
export const PENDING_SIGHASH_TTL_MS = 5 * 60 * 1000;
/** Most pending actions remembered (all sites together); the oldest goes first. A site's loop can't grow the map. */
export const MAX_PENDING_ACTIONS = 64;
/** Most remembered for one originator; its own oldest goes first, so one site's loop can't push out another's. */
export const MAX_PENDING_PER_SITE = 8;

const SIGHASH_ALL_FORKID = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
/** The toolbox's "whatever is left" output amount (verifyRequestedOutputsPresent): not an amount the wallet can add up. */
const SPEND_ALL_SENTINEL = 0x775f05a073fff;
const DIGEST_LENGTH = 32;

type Chunk = { op: number; data?: number[] };

/** A push of data or of a small number: all an unexecuted inscription envelope holds. */
const isPush = (c: Chunk) =>
  c.op === OP.OP_0 ||
  (c.op > 0 && c.op <= OP.OP_PUSHDATA4) ||
  c.op === OP.OP_1NEGATE ||
  (c.op >= OP.OP_1 && c.op <= OP.OP_16);

/** A compressed public key push. */
const isKeyPush = (c: Chunk | undefined) =>
  c?.op === 33 && c.data?.length === 33 && (c.data[0] === 2 || c.data[0] === 3);

/** PushDrop's fields: pushes, then OP_2DROP / OP_DROP taking exactly those off again (none at all is fine). */
const pushesAndDrops = (chunks: Chunk[]) => {
  let i = 0;
  while (i < chunks.length && isPush(chunks[i])) i++;
  let left = i;
  for (; i < chunks.length; i++) {
    if (chunks[i].op === OP.OP_2DROP) left -= 2;
    else if (chunks[i].op === OP.OP_DROP) left -= 1;
    else return false;
    if (left < 0) return false;
  }
  return left === 0;
};

/** <key> OP_CHECKSIG with PushDrop fields before or after it (@bsv/sdk PushDrop.lock, either lockPosition), or alone. */
const pushDropKey = (chunks: Chunk[]): number[] | null => {
  if (isKeyPush(chunks[0]) && chunks[1]?.op === OP.OP_CHECKSIG && pushesAndDrops(chunks.slice(2)))
    return chunks[0].data!;
  const n = chunks.length;
  if (isKeyPush(chunks[n - 2]) && chunks[n - 1]?.op === OP.OP_CHECKSIG && pushesAndDrops(chunks.slice(0, -2)))
    return chunks[n - 2].data!;
  return null;
};

/**
 * The hash (hex) of the one key a locking script needs a signature from, when the script is: P2PKH alone; P2PKH after
 * exactly one inscription envelope (OP_0 OP_IF <pushes> OP_ENDIF: never executed, so the script IS that P2PKH); or a
 * key and OP_CHECKSIG with PushDrop's fields. Null for every other shape. Read from the parsed chunks, never by
 * matching bytes at the end, so a P2PKH-looking tail inside a push is not one.
 */
export const lockKeyHash = (script: Script): string | null => {
  const chunks = script.chunks as Chunk[];
  const key = pushDropKey(chunks);
  if (key) return Utils.toHex(Hash.hash160(key));
  if (chunks.length < 5) return null;
  const [dup, hash160, pkh, equalverify, checksig] = chunks.slice(-5);
  if (
    dup.op !== OP.OP_DUP ||
    hash160.op !== OP.OP_HASH160 ||
    pkh.op !== 20 ||
    pkh.data?.length !== 20 ||
    equalverify.op !== OP.OP_EQUALVERIFY ||
    checksig.op !== OP.OP_CHECKSIG
  )
    return null;
  const before = chunks.slice(0, -5);
  if (before.length) {
    if (before.length < 3 || before[0].op !== OP.OP_0 || before[1].op !== OP.OP_IF) return null;
    if (before[before.length - 1].op !== OP.OP_ENDIF || !before.slice(2, -1).every(isPush)) return null;
  }
  return Utils.toHex(pkh.data);
};

type CreateArgs = {
  inputs?: { outpoint?: unknown; unlockingScript?: unknown }[];
  outputs?: { satoshis?: unknown }[];
};
type Signable = { tx?: unknown; reference?: unknown };

const isSats = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < SPEND_ALL_SENTINEL;

/**
 * Pure: the sighashes a site may ask for on this signable action, as digest (hex) → the key hash its input is locked
 * to. Null when nothing may be asked: the transaction can't be read, the site's inputs don't match it, or the pay
 * check did not run on it (see the file comment). An input whose script has no readable key is left out.
 */
export const callerSighashes = (args: CreateArgs | undefined, signableTx: unknown): Map<string, string> | null => {
  try {
    // The wallet's own AtomicBEEF of the action (a number[] from the toolbox; bytes either way).
    const beef = signableTx instanceof Uint8Array ? Array.from(signableTx) : signableTx;
    if (!Array.isArray(beef) || !Array.isArray(args?.inputs) || args.inputs.length === 0) return null;
    // The site's inputs, by canonical outpoint: true = the site still has to unlock it.
    const named = new Map<string, boolean>();
    for (const input of args.inputs) {
      const outpoint = canonicalOutpoint(input?.outpoint);
      if (outpoint === null || named.has(outpoint)) return null;
      named.set(outpoint, input.unlockingScript === undefined);
    }
    const tx = Transaction.fromAtomicBEEF(beef as number[]);
    const sources = tx.inputs.map((input) => {
      const txid = input.sourceTransaction?.id('hex');
      const output = input.sourceTransaction?.outputs[input.sourceOutputIndex];
      if (!txid || !output || !isSats(output.satoshis)) return null;
      if (input.sourceTXID !== undefined && input.sourceTXID.toLowerCase() !== txid) return null;
      return {
        txid,
        outpoint: `${txid}.${input.sourceOutputIndex}`,
        satoshis: output.satoshis,
        script: output.lockingScript,
      };
    });
    if (sources.some((s) => s === null)) return null;
    const seen = new Set(sources.map((s) => s!.outpoint));
    if (seen.size !== sources.length || [...named.keys()].some((o) => !seen.has(o))) return null;

    // What the action takes from the wallet, as the permissions manager counts it (computeNetSpend): the outputs the
    // site asked for, plus the fee, less the inputs it named. Only above 0 does the manager ask the user (or the
    // site's envelope) for the payment, so only then has the transaction been approved.
    let requested = 0;
    for (const o of args.outputs ?? []) {
      if (!isSats(o?.satoshis)) return null;
      requested += o.satoshis;
    }
    const paidIn = sources.reduce((n, s) => n + s!.satoshis, 0);
    const paidOut = tx.outputs.reduce((n, o) => n + (o.satoshis ?? 0), 0);
    const fromSite = sources.reduce((n, s) => n + (named.has(s!.outpoint) ? s!.satoshis : 0), 0);
    const fee = paidIn - paidOut;
    if (!isSats(fee) || requested > paidOut || !(requested + fee - fromSite > 0)) return null;

    const digests = new Map<string, string>();
    tx.inputs.forEach((input, index) => {
      const source = sources[index]!;
      // Only an input the site named and has yet to unlock. The wallet's own inputs are never in the map.
      if (named.get(source.outpoint) !== true || (input.unlockingScript?.chunks.length ?? 0) > 0) return;
      const keyHash = lockKeyHash(source.script);
      if (keyHash === null) return;
      const preimage = TransactionSignature.format({
        sourceTXID: source.txid,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: source.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, j) => j !== index),
        inputIndex: index,
        outputs: tx.outputs,
        inputSequence: input.sequence ?? 0xffffffff,
        subscript: source.script,
        lockTime: tx.lockTime,
        scope: SIGHASH_ALL_FORKID,
      });
      digests.set(Utils.toHex(Hash.hash256(preimage)), keyHash);
    });
    return digests.size ? digests : null;
  } catch {
    return null;
  }
};

type SignArgs = {
  data?: unknown;
  hashToDirectlySign?: unknown;
  protocolID?: unknown;
  keyID?: unknown;
  counterparty?: unknown;
  privileged?: unknown;
};

const digestHex = (hash: unknown): string | null => {
  if (!Array.isArray(hash) || Object.getPrototypeOf(hash) !== Array.prototype || hash.length !== DIGEST_LENGTH)
    return null;
  for (let i = 0; i < DIGEST_LENGTH; i++) {
    const b: unknown = i in hash ? hash[i] : undefined;
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return null;
  }
  return Utils.toHex(hash as number[]);
};

/** Protocols this door never opens for, whatever the input is locked to (the reserved ones are refused separately). */
const excludedProtocol = (protocolID: unknown) => {
  if (!Array.isArray(protocolID) || typeof protocolID[1] !== 'string') return true;
  const name = protocolID[1].trim().toLowerCase();
  // A permission module's keys ("p …") go to the module, which has its own check; the posting key signs posts only.
  return name.startsWith('p ') || (protocolID[0] === 1 && name === 'sigma');
};

type SigningKey = { protocolID: unknown; keyID: unknown; counterparty: unknown };
/** What the store asks the wallet about a key, as the wallet itself (nothing here goes back to the site). */
export type SigningKeyChecks = {
  /** Does this originator already hold the protocol grant createSignature would need? Never prompts. */
  granted: (key: SigningKey) => Promise<boolean>;
  /** The public key (hex) createSignature would sign with. */
  derive: (key: SigningKey) => Promise<string | undefined>;
};
/** request()'s answer for a site that has a pending action but no grant for the protocol it asks to sign with. */
export const UNGRANTED = 'ungranted';

type Pending = { originator: string; expires: number; digests: Map<string, string> };

/** The pending actions of one wallet instance and the sighashes each allows. */
export class PendingSighashes {
  private readonly pending = new Map<string, Pending>(); // by reference, oldest first

  constructor(private readonly now: () => number = Date.now) {}

  /** After a site's createAction came back signable (so every check and sheet on it has passed). */
  record(originator: string, args: unknown, signable: Signable | undefined): void {
    const reference = signable?.reference;
    if (!originator || typeof reference !== 'string' || !reference) return;
    this.pending.delete(reference);
    const digests = callerSighashes(args as CreateArgs, signable?.tx);
    if (!digests) return;
    const now = this.now();
    this.pending.set(reference, { originator, expires: now + PENDING_SIGHASH_TTL_MS, digests });
    // Expired ones first, then this site's own oldest, and only then the oldest of all.
    const mine: string[] = [];
    for (const [ref, p] of this.pending) {
      if (p.expires <= now) this.pending.delete(ref);
      else if (p.originator === originator) mine.push(ref);
    }
    for (const ref of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_SITE))) this.pending.delete(ref);
    while (this.pending.size > MAX_PENDING_ACTIONS) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** The action was signed or aborted (or the attempt failed, which aborts it): its sighashes are gone. */
  settle(reference: unknown): void {
    if (typeof reference === 'string') this.pending.delete(reference);
  }

  /** Who created this pending action, if it is one. */
  owner(reference: unknown): string | undefined {
    return typeof reference === 'string' ? this.pending.get(reference)?.originator : undefined;
  }

  /** The key hash this originator's live pending actions want for a digest (expired actions are dropped here). */
  private wanted(originator: string, digest?: string): { any: boolean; keyHash?: string } {
    const now = this.now();
    let any = false;
    let keyHash: string | undefined;
    for (const [reference, p] of this.pending) {
      if (p.expires <= now) this.pending.delete(reference);
      else if (p.originator === originator) {
        any = true;
        if (digest !== undefined) keyHash ??= p.digests.get(digest);
      }
    }
    return { any, keyHash };
  }

  /**
   * Is this createSignature a sighash of one of this originator's pending actions, asked with the input's own key?
   * Answers the request to sign, as a copy read once (what was checked is what is signed); UNGRANTED when the site
   * has something pending but not the protocol's grant; or null.
   */
  async request(
    originator: string,
    args: unknown,
    checks: SigningKeyChecks,
  ): Promise<object | typeof UNGRANTED | null> {
    if (!originator || !args || typeof args !== 'object') return null;
    const a: SignArgs = { ...(args as SignArgs) };
    if (a.privileged || (a.data !== undefined && a.hashToDirectlySign !== undefined)) return null;
    if (typeof a.keyID !== 'string' || (a.counterparty !== undefined && typeof a.counterparty !== 'string'))
      return null;
    // Either door: the digest itself, or 32 bytes of `data`, which createSignature hashes once more into the digest.
    const asData = a.hashToDirectlySign === undefined;
    const bytes = digestHex(asData ? a.data : a.hashToDirectlySign);
    if (bytes === null) return null;
    const digest = asData ? Utils.toHex(Hash.sha256(Utils.toArray(bytes, 'hex'))) : bytes;
    if (asData) a.data = Utils.toArray(bytes, 'hex');
    else a.hashToDirectlySign = Utils.toArray(bytes, 'hex');
    if (Array.isArray(a.protocolID)) a.protocolID = [...a.protocolID];
    if (excludedProtocol(a.protocolID) || reservedProtocolRefusal('createSignature', a) !== null) return null;
    if (pinnedProtocolRefusal('createSignature', a, normalizeOriginator(originator)) !== null) return null;
    if (!this.wanted(originator).any) return null;
    // createSignature's own default: no counterparty means 'anyone'.
    const key = { protocolID: a.protocolID, keyID: a.keyID, counterparty: a.counterparty ?? 'anyone' };
    try {
      // The grant first: nothing below (the lookup, the derivation) runs for a site that doesn't hold it, so a right
      // and a wrong guess of a coin's key are the same refusal.
      if ((await checks.granted(key)) !== true) return UNGRANTED;
      // Looked up after the wait: the action may have been signed or aborted meanwhile.
      const { keyHash } = this.wanted(originator, digest);
      if (keyHash === undefined) return null;
      const publicKey = await checks.derive(key);
      if (typeof publicKey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(publicKey)) return null;
      return Utils.toHex(Hash.hash160(Utils.toArray(publicKey, 'hex'))) === keyHash ? a : null;
    } catch {
      return null;
    }
  }

  /** Test hook. */
  get size(): number {
    return this.pending.size;
  }
}
