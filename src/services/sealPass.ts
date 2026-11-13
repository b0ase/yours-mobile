/**
 * Seal with ONE approval (owner, 2 Nov 2026: "i dont like the seal asking the phone twice. The signature, then the
 * seal button. One smooth motion.").
 *
 * bit-sign's seal v2 makes two standard BRC-100 calls from the same site:
 *   1. createSignature({ protocolID: [2,'bitsign seal'], keyID: <nonce>, counterparty: 'anyone',
 *                        data: utf8(<canonical seal record>) })
 *   2. createAction({ outputs: [ one 0-sat OP_FALSE OP_RETURN <json> ] })   (the wallet pays only the network fee)
 * Each used to raise its own sheet (the protocol sheet, then the pay sheet). Now:
 *
 * - The wallet recognises call 1 as a seal by its exact shape (the record parses, is canonical, its nonce is the
 *   keyID and its key is this account's identity key) and shows ONE "Seal" sheet BEFORE signing: the document's
 *   fingerprint, who signs, the site, and the network fee cap. Nothing is stored by that sheet.
 * - Allow arms a pass for that site. The pass lets through exactly:
 *     a) the protocol request of THAT createSignature, once, with a one-use grant (stored already expired, so the
 *        next seal-protocol signature asks), only while it is the site's only call on the seal protocol; any other
 *        seal-protocol signature the site asks for meanwhile is refused (signing), and
 *     b) the spend of the site's VERY NEXT createAction, within SEAL_PASS_MS of the signature, if and only if that
 *        action is the seal of the record just signed: a single 0-sat OP_RETURN output whose payload's recordHash is
 *        sha256(the signed bytes) and whose origHash / svgHash / key / ref / ts are the record's own, no inputs of
 *        the site's, no labels, nothing but the two harmless options, and a spend of at most SEAL_MAX_SATS, while it
 *        is the site's only payment in flight.
 * - Anything else prompts exactly as before: another site, a different or late action, a second action, an amount
 *   over the cap, a different hash. The very next createAction from the site uses up the pass whether it matches or
 *   not, so a pass never waits around for a later payment.
 *
 * Standard BRC-100 throughout: bit-sign still makes the same two calls, so every other wallet (HandCash, Yours,
 * Metanet, older bWalletX) keeps working with its own two prompts. `bitsign.capabilities` says `oneApprovalSeal: true`
 * so bit-sign can word its status line; nothing else depends on it.
 *
 * Pure (no chrome APIs, clock injected) so it can be unit tested.
 */
import { Hash, Utils } from '@bsv/sdk';

/** The seal protocol bit-sign signs under (bit-sign src/lib/nds-seal-record.ts BITSIGN_SEAL_PROTOCOL). */
export const SEAL_PROTOCOL: readonly [2, string] = [2, 'bitsign seal'];
export const SEAL_RECORD_VERSION = 'bitsign-seal-2';
/** The pay step must follow the signature within this long, or it asks again. */
export const SEAL_PASS_MS = 60_000;
/** The most a seal may spend without its own sheet (a seal pays only the network fee, a few hundred sats at most). */
export const SEAL_MAX_SATS = 1_000;
/** The longest reference a seal record may carry (it goes on chain in the seal's output, so it sets the fee). */
export const SEAL_REF_MAX_CHARS = 200;
/** The longest handle, block id, party or role a seal record may carry. */
export const SEAL_TEXT_MAX_CHARS = 100;
/** The most blocks one seal may cover. */
export const SEAL_FIELDS_MAX = 50;
/** Synthetic sheet line id prefix: never sent to the permissions manager. */
export const SEAL_REQUEST_PREFIX = 'seal-';
/** Feature flag sites read from `bitsign.capabilities`. */
export const ONE_APPROVAL_SEAL = 'oneApprovalSeal';

export const isSealRequestId = (id: string | undefined): boolean => !!id && id.startsWith(SEAL_REQUEST_PREFIX);

const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

export type SealRecordField = { id: string; party: string; role: string };

/** What the person is about to seal, read from the canonical record the site asks the wallet to sign. */
export type SealSign = {
  nonce: string;
  /** sha256 hex of the exact bytes signed: the seal transaction must carry it as `recordHash`. */
  recordHash: string;
  /** sha256 hex of the original document (the phone shows its first 8 as "#…"). */
  doc: string;
  svg: string;
  key: string;
  ref: string;
  ts: string;
  handle: string;
  fields: SealRecordField[];
};

/** The words on the one Seal sheet. Display only. */
export type SealSheet = {
  title: string;
  ref: string;
  docHash: string;
  handle: string;
  roles: string[];
  maxSats: number;
  site: string;
};

/** Canonical JSON exactly as bit-sign writes it: sorted keys, no whitespace, string leaves only. */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error('not a string leaf');
};

const isProtocol = (p: unknown): boolean =>
  Array.isArray(p) && p.length === 2 && p[0] === SEAL_PROTOCOL[0] && p[1] === SEAL_PROTOCOL[1];
/** Is this protocolID bit-sign's seal protocol? */
export const isSealProtocol = isProtocol;
/** A seal-protocol signature asked for while an approved seal's own is being made (SealPasses.signing). */
export const SEAL_BUSY_REFUSAL = 'A seal is being signed for this site. Try again once it is done.';

/** A string of at most `max` characters with no control or direction-override characters. */
export const shortText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !CTRL.test(v);

const bytesOf = (data: unknown): number[] | null => {
  if (!Array.isArray(data) || data.length === 0 || data.length > 8192) return null;
  for (const b of data) if (!Number.isInteger(b) || b < 0 || b > 255) return null;
  return data as number[];
};

/**
 * Is this createSignature a bit-sign seal? Returns what is being sealed, or null for anything else (which then goes
 * through the normal sheets). `identityKey`: this account's identity public key; a record naming another key is not
 * treated as a seal.
 */
export const readSealSign = (args: unknown, identityKey: string): SealSign | null => {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (!isProtocol(a.protocolID) || a.counterparty !== 'anyone' || a.privileged) return null;
  if (a.hashToDirectlySign !== undefined) return null;
  if (typeof a.keyID !== 'string' || !NONCE.test(a.keyID)) return null;
  const bytes = bytesOf(a.data);
  if (!bytes) return null;
  let text: string;
  let r: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    r = JSON.parse(text) as Record<string, unknown>;
    // The exact bytes signed must be the canonical record, or the hash below would not be the one the chain carries.
    if (!r || typeof r !== 'object' || Array.isArray(r) || canonicalJson(r) !== text) return null;
  } catch {
    return null;
  }
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'doc,fields,handle,key,manifest,nonce,ref,svg,ts,v') return null;
  if (r.v !== SEAL_RECORD_VERSION || r.nonce !== a.keyID) return null;
  for (const k of ['doc', 'manifest', 'svg'] as const) if (typeof r[k] !== 'string' || !HEX64.test(r[k])) return null;
  if (typeof r.key !== 'string' || !IDENTITY_KEY.test(r.key)) return null;
  if (!identityKey || r.key !== identityKey.toLowerCase()) return null;
  if (!shortText(r.ref, SEAL_REF_MAX_CHARS) || !r.ref || !shortText(r.handle, SEAL_TEXT_MAX_CHARS) || !r.handle)
    return null;
  if (!shortText(r.ts, 40)) return null;
  if (!Array.isArray(r.fields) || r.fields.length === 0 || r.fields.length > SEAL_FIELDS_MAX) return null;
  const fields: SealRecordField[] = [];
  for (const f of r.fields as unknown[]) {
    const o = f as Record<string, unknown> | null;
    if (
      !o ||
      typeof o !== 'object' ||
      !shortText(o.id, SEAL_TEXT_MAX_CHARS) ||
      !shortText(o.party, SEAL_TEXT_MAX_CHARS) ||
      !shortText(o.role, SEAL_TEXT_MAX_CHARS)
    )
      return null;
    fields.push({ id: o.id, party: o.party, role: o.role });
  }
  return {
    nonce: a.keyID,
    recordHash: Utils.toHex(Hash.sha256(bytes)),
    doc: r.doc as string,
    svg: r.svg as string,
    key: r.key,
    ref: r.ref,
    ts: r.ts,
    handle: r.handle,
    fields,
  };
};

/** A ref that is only an id (uuid, long hex) says nothing: the sheet says "this document" instead. */
const looksLikeId = (ref: string) => /^[0-9a-f-]{24,}$/i.test(ref);

export const sealSheetFor = (seal: SealSign, site: string): SealSheet => ({
  title: looksLikeId(seal.ref) ? 'Seal this document' : `Seal ${seal.ref}`,
  ref: seal.ref,
  docHash: seal.doc,
  handle: seal.handle,
  roles: [...new Set(seal.fields.map((f) => f.role).filter(Boolean))],
  maxSats: SEAL_MAX_SATS,
  site,
});

/** The single push of an `OP_FALSE OP_RETURN <data>` script, or null for any other script. */
export const opReturnData = (scriptHex: unknown): Uint8Array | null => {
  if (typeof scriptHex !== 'string' || !/^([0-9a-f]{2})+$/i.test(scriptHex)) return null;
  let b: number[];
  try {
    b = Utils.toArray(scriptHex.toLowerCase(), 'hex');
  } catch {
    return null;
  }
  if (b[0] !== 0x00 || b[1] !== 0x6a || b.length < 3) return null;
  let i = 2;
  let len: number;
  const op = b[i++];
  if (op > 0 && op < 0x4c) len = op;
  else if (op === 0x4c) len = b[i++];
  else if (op === 0x4d) {
    len = b[i] | (b[i + 1] << 8);
    i += 2;
  } else if (op === 0x4e) {
    len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    i += 4;
  } else return null;
  if (len === undefined || i + len !== b.length) return null; // exactly one push, nothing after it
  return new Uint8Array(b.slice(i));
};

const ALLOWED_TOP = new Set(['description', 'outputs', 'options', 'labels']);
/**
 * The v2 seal payload's keys, exactly (bit-sign src/lib/nds-seal-record.ts SealPayloadV2 / buildSealPayloadV2). Review
 * 24 L3: a key outside this set (a site adding its own data to the one OP_RETURN the person approved) is refused.
 */
const SEAL_PAYLOAD_KEYS = 'docHash,fields,key,origHash,protocol,recordHash,ref,svgHash,ts,type,version';
const ALLOWED_OPTIONS = new Set(['acceptDelayedBroadcast', 'randomizeOutputs']);

/** Is this createAction exactly the seal of `seal`? Pure; no clock. */
export const sealActionMatches = (seal: SealSign, args: unknown): boolean => {
  if (!args || typeof args !== 'object') return false;
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) if (a[k] !== undefined && !ALLOWED_TOP.has(k)) return false; // no inputs, inputBEEF…
  if (a.labels !== undefined && !(Array.isArray(a.labels) && a.labels.length === 0)) return false;
  if (a.options !== undefined) {
    if (!a.options || typeof a.options !== 'object') return false;
    for (const [k, v] of Object.entries(a.options as Record<string, unknown>))
      if (v !== undefined && (!ALLOWED_OPTIONS.has(k) || typeof v !== 'boolean')) return false;
  }
  if (!Array.isArray(a.outputs) || a.outputs.length !== 1) return false;
  const out = a.outputs[0] as Record<string, unknown> | null;
  if (!out || typeof out !== 'object' || out.satoshis !== 0) return false;
  if (out.basket !== undefined || out.customInstructions !== undefined || out.tags !== undefined) return false;
  const data = opReturnData(out.lockingScript);
  if (!data) return false;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (Object.keys(p).sort().join(',') !== SEAL_PAYLOAD_KEYS) return false;
  return (
    p.protocol === 'b0ase-bitsign' &&
    p.version === '2.0' &&
    p.type === 'nds_field_seal' &&
    p.recordHash === seal.recordHash &&
    p.origHash === seal.doc &&
    p.svgHash === seal.svg &&
    p.key === seal.key &&
    p.ref === seal.ref &&
    p.ts === seal.ts &&
    typeof p.docHash === 'string' &&
    HEX64.test(p.docHash) &&
    p.fields ===
      seal.fields
        .map((f) => f.id)
        .sort()
        .join(',')
  );
};

/** The fields of a toolbox PermissionRequest read here. `originator` must already be normalised. */
export type SealPermissionRequest = {
  type: string;
  originator?: string;
  privileged?: boolean;
  protocolID?: unknown;
  counterparty?: string;
  spending?: { satoshis?: number };
};

type Pass = {
  seal: SealSign;
  state: 'approved' | 'signed' | 'paying';
  until: number;
  spent?: boolean;
  /** The seal's one protocol request has been answered: no other is (one use, b-Aware triage 6 Nov 2026). */
  protocolUsed?: boolean;
};

/**
 * One live pass per site (origins normalised by the caller). approve → signed → paying → gone.
 *
 *  approve(site, seal)     the person tapped Allow on the Seal sheet
 *  signing(site)           that seal's signature is still to be made (other seal-protocol signs are refused)
 *  coversProtocol(req, n)  the protocol request of that createSignature (n = the site's calls on the seal protocol);
 *                          once, answered with a one-use grant (oneShotGrant.ts oneUseGrant)
 *  signed(site, hash)      that createSignature answered
 *  beginAction(site, args) the site's next createAction started: true when it is the seal (the pass is used up
 *                          either way)
 *  coversSpend(req, n)     its spend (n = the site's payments in flight); at most once
 *  endAction(site)         that createAction finished
 */
export class SealPasses {
  private passes = new Map<string, Pass>();
  constructor(private readonly now: () => number = Date.now) {}

  private live(site: string): Pass | undefined {
    const p = this.passes.get(site);
    if (p && p.until < this.now()) {
      this.passes.delete(site);
      return undefined;
    }
    return p;
  }

  approve(site: string, seal: SealSign): void {
    this.passes.set(site, { seal, state: 'approved', until: this.now() + SEAL_PASS_MS });
  }

  signed(site: string, recordHash: string): void {
    const p = this.live(site);
    if (!p || p.state !== 'approved' || p.seal.recordHash !== recordHash) return;
    p.state = 'signed';
    p.until = this.now() + SEAL_PASS_MS;
  }

  drop(site: string): void {
    this.passes.delete(site);
  }

  /**
   * True while an approved seal's own signature is being made for this site. Every other createSignature on the seal
   * protocol from the site is refused until then, so nothing can share that one answer (background.ts).
   */
  signing(site: string): boolean {
    return this.live(site)?.state === 'approved';
  }

  coversProtocol(req: SealPermissionRequest, callsOnProtocol: number): boolean {
    const p = req.originator ? this.live(req.originator) : undefined;
    const covered =
      !!p &&
      p.state === 'approved' &&
      !p.protocolUsed &&
      req.type === 'protocol' &&
      !req.privileged &&
      isProtocol(req.protocolID) &&
      req.counterparty === 'anyone' &&
      callsOnProtocol === 1;
    if (covered) p.protocolUsed = true;
    return covered;
  }

  beginAction(site: string, args: unknown): boolean {
    const p = this.live(site);
    if (!p || p.state !== 'signed') return false;
    if (!sealActionMatches(p.seal, args)) {
      this.passes.delete(site); // the next payment was something else: it asks, and so does everything after it
      return false;
    }
    p.state = 'paying';
    p.until = this.now() + SEAL_PASS_MS;
    return true;
  }

  coversSpend(req: SealPermissionRequest, paymentsInFlight: number): boolean {
    const p = req.originator ? this.live(req.originator) : undefined;
    const sats = req.spending?.satoshis;
    if (
      !p ||
      p.state !== 'paying' ||
      p.spent ||
      req.type !== 'spending' ||
      paymentsInFlight !== 1 ||
      typeof sats !== 'number' ||
      !Number.isInteger(sats) ||
      sats < 0 ||
      sats > SEAL_MAX_SATS
    )
      return false;
    p.spent = true;
    return true;
  }

  endAction(site: string): void {
    if (this.passes.get(site)?.state === 'paying') this.passes.delete(site);
  }
}
