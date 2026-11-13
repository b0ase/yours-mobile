import { Hash, Utils } from '@bsv/sdk';
import { SEAL_FIELDS_MAX, SEAL_REF_MAX_CHARS, SEAL_TEXT_MAX_CHARS, shortText } from '../../services/sealPass';

/**
 * THE WALLET DECIDES WHAT IT SIGNS (native seal, chat/nativeSeal.ts). bit-sign's compose step answers with how to sign
 * (`signing`), what to sign (`recordCanonical`) and the output to pay for (`lockingScriptHex`). None of it is taken on
 * trust: the wallet rebuilds the record and the output from what it has itself (the document it shows, the drawn
 * signature it sends, its own identity key, the session nonce from prepare) and refuses anything else.
 *
 * Mirrors bit-sign's pure seal definitions byte for byte (bit-sign src/lib/nds-seal-record.ts buildSealRecord,
 * canonicalSealRecord, buildSealPayloadV2; src/lib/seal-inscription.ts sealLockingScriptHex; src/lib/nds.ts
 * embeddedManifestText). sealCheck.test.ts holds a vector made with bit-sign's own code.
 *
 *   signing        = exactly { protocolID: [2, 'bitsign seal'], keyID: <prepare's nonce>, counterparty: 'anyone' }:
 *                    a key used for nothing but seals, and one key per signing session.
 *   recordCanonical = the canonical record of THIS document: doc = sha256 of the html on screen, manifest = sha256 of
 *                    its embedded manifest, ref and blocks from that manifest, svg = sha256 of the drawn signature,
 *                    key = this wallet's identity key, nonce = the session's. Only `handle` (the name shown) and `ts`
 *                    (prepare's time) are bit-sign's, checked for shape (and ts against prepare's).
 *   lockingScriptHex = OP_FALSE OP_RETURN <hashes-only payload> rebuilt here; the wallet pays for its own copy, a
 *                    0-sat data output. No payee, no amount: the only cost is the miner fee the wallet sets.
 *   sizes          = the ref, handle, block ids, parties and roles within the web/extension seal pass's limits
 *                    (services/sealPass.ts): the ref goes on chain, so a long one would set the fee.
 *
 * PURE: no network, no wallet, no clock.
 */

export const SEAL_PROTOCOL_ID: [2, string] = [2, 'bitsign seal'];
export const SEAL_COUNTERPARTY = 'anyone';
export const SEAL_RECORD_VERSION = 'bitsign-seal-2';

/** Shown when compose's answer is not the seal of the document on screen. Nothing was signed or paid. */
export const SEAL_MISMATCH_MESSAGE =
  'Not sealed: what bit-sign asked this wallet to sign does not match this document. Nothing was signed or paid.';
/** Shown when prepare names a different document version or another wallet. Nothing was signed or paid. */
export const SEAL_PREPARE_MISMATCH_MESSAGE =
  'Not sealed: bit-sign is preparing a different document or wallet than the one open here. Nothing was signed or paid.';

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** bit-sign nds.ts MANIFEST_RE, unchanged. */
const MANIFEST_RE = /<script[^>]*type=["']application\/npg-sig-manifest\+json["'][^>]*>([\s\S]*?)<\/script>/i;

export const sha256Hex = (text: string): string => Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')));

const normKey = (k: unknown): string => (typeof k === 'string' ? k.trim().toLowerCase() : '');

/** bit-sign canonicalJson: sorted keys, no whitespace, string leaves only (anything else throws). */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  throw new Error('A seal record may only contain strings.');
}

/** What the wallet knows by itself about the seal it is about to sign. */
export interface SealExpect {
  documentId: string;
  /** The document as shown to the signer (the room's pending html, exact). */
  documentHtml: string;
  /** The drawn signature exactly as sent to compose. */
  svg: string;
  fieldIds: readonly string[];
  /** This wallet's identity key: the record's signer. */
  identityKey: string;
  /** prepare's nonce: the record's nonce and the signing keyID. */
  nonce: string;
  /** prepare's ts, when it gave one. */
  ts?: string;
}

type RecordField = { id: string; party: string; role: string };
export type SealRecord = {
  v: string;
  doc: string;
  manifest: string;
  ref: string;
  fields: RecordField[];
  svg: string;
  key: string;
  handle: string;
  ts: string;
  nonce: string;
};

type Manifest = { documentRef?: unknown; signatureFields?: unknown };
const parseManifest = (text: string | null): Manifest | null => {
  if (text == null) return null;
  try {
    const m = JSON.parse(text) as unknown;
    return m && typeof m === 'object' ? (m as Manifest) : null;
  } catch {
    return null;
  }
};

const manifestOf = (html: string): { text: string | null; manifest: Manifest | null } => {
  const text = html.includes('npg-sig-manifest') ? (MANIFEST_RE.exec(html)?.[1] ?? null) : null;
  return { text, manifest: parseManifest(text) };
};

/** The reference the seal record (and its on-chain output) will carry for this document: what the sheet's fee uses. */
export const sealRef = (documentHtml: string, documentId: string): string =>
  String(manifestOf(documentHtml).manifest?.documentRef || documentId);

/**
 * The record bit-sign must have built for this document (bit-sign composeSeal → buildSealRecord), with bit-sign's
 * `handle` and `ts`. Throws a plain reason when the document has no manifest or a block isn't in it.
 */
export function expectedSealRecord(e: SealExpect, handle: string, ts: string): SealRecord {
  const { text, manifest } = manifestOf(e.documentHtml);
  const sigFields: unknown[] | null =
    manifest && Array.isArray(manifest.signatureFields) ? manifest.signatureFields : null;
  if (!manifest || !sigFields) throw new Error('the document has no signature manifest');
  const fields = e.fieldIds
    .map((id) => {
      const f = sigFields.find((x: unknown) => (x as { id?: unknown } | null)?.id === id) as
        | { party?: unknown; role?: unknown }
        | undefined;
      if (!f) throw new Error(`block ${id} is not in the document`);
      return { id, party: String(f.party ?? ''), role: String(f.role ?? '') };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    v: SEAL_RECORD_VERSION,
    doc: sha256Hex(e.documentHtml),
    manifest: sha256Hex(text ?? ''),
    ref: String(manifest.documentRef || e.documentId),
    fields,
    svg: sha256Hex(e.svg),
    key: normKey(e.identityKey),
    handle,
    ts,
    nonce: e.nonce,
  };
}

/** bit-sign seal-inscription.ts pushdata. */
function pushdata(len: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  if (len < 0x4c) return h(len);
  if (len <= 0xff) return `4c${h(len)}`;
  if (len <= 0xffff) return `4d${h(len & 0xff)}${h((len >> 8) & 0xff)}`;
  return `4e${h(len & 0xff)}${h((len >> 8) & 0xff)}${h((len >> 16) & 0xff)}${h((len >> 24) & 0xff)}`;
}

/** The seal's output: OP_FALSE OP_RETURN <bit-sign buildSealPayloadV2 JSON>, hashes only. */
export function sealScriptHex(docHash: string, record: SealRecord): string {
  // ⚠ Key ORDER is part of the bytes (JSON.stringify keeps insertion order): exactly buildSealPayloadV2's.
  const payload = {
    protocol: 'b0ase-bitsign',
    version: '2.0',
    type: 'nds_field_seal',
    docHash,
    origHash: record.doc,
    recordHash: sha256Hex(canonicalJson(record)),
    svgHash: record.svg,
    fields: record.fields.map((f) => f.id).join(','),
    key: record.key,
    ref: record.ref,
    ts: record.ts,
  };
  const bytes = Utils.toArray(JSON.stringify(payload), 'utf8');
  return `006a${pushdata(bytes.length)}${Utils.toHex(bytes)}`;
}

/**
 * prepare's answer, before the one approval: its nonce is usable, and when it names the document hash or the signing
 * key they are this document's and this wallet's. Null = fine; else the reason (for the log).
 */
export function checkPrepared(
  prepared: { nonce?: unknown; origHash?: unknown; identityKey?: unknown },
  e: Pick<SealExpect, 'documentHtml' | 'identityKey'>,
): string | null {
  if (typeof prepared.nonce !== 'string' || !prepared.nonce) return 'no session nonce';
  if (!normKey(e.identityKey)) return "this wallet's identity key is unknown";
  if (typeof prepared.origHash === 'string' && prepared.origHash.toLowerCase() !== sha256Hex(e.documentHtml))
    return 'prepare names another version of the document';
  if (typeof prepared.identityKey === 'string' && normKey(prepared.identityKey) !== normKey(e.identityKey))
    return 'prepare names another wallet';
  return null;
}

export type ComposeCheck =
  | {
      ok: true;
      signing: { protocolID: [2, string]; keyID: string; counterparty: string };
      recordCanonical: string;
      lockingScriptHex: string;
    }
  | { ok: false; why: string };

/** compose's answer, checked field by field against what the wallet rebuilt (see the top of this file). */
export function checkComposed(composed: Record<string, unknown>, e: SealExpect): ComposeCheck {
  const no = (why: string): ComposeCheck => ({ ok: false, why });
  if (!e.nonce) return no('no session nonce');
  if (!normKey(e.identityKey)) return no("this wallet's identity key is unknown");

  const s = composed.signing as { protocolID?: unknown; keyID?: unknown; counterparty?: unknown } | null | undefined;
  const p = s?.protocolID;
  if (!Array.isArray(p) || p.length !== 2 || p[0] !== SEAL_PROTOCOL_ID[0] || p[1] !== SEAL_PROTOCOL_ID[1])
    return no('signing protocol is not the seal protocol');
  if (s?.keyID !== e.nonce) return no("signing key id is not this session's");
  if (s?.counterparty !== SEAL_COUNTERPARTY) return no('signing counterparty is not "anyone"');

  const text = composed.recordCanonical;
  if (typeof text !== 'string') return no('no record');
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return no('record is not JSON');
  }
  if (!got || typeof got !== 'object' || Array.isArray(got)) return no('record is not an object');
  const { handle, ts } = got;
  if (
    typeof handle !== 'string' ||
    !handle.trim() ||
    handle !== handle.trim() ||
    !shortText(handle, SEAL_TEXT_MAX_CHARS)
  )
    return no('record handle is malformed');
  if (typeof ts !== 'string' || !ISO_INSTANT.test(ts) || Number.isNaN(Date.parse(ts)))
    return no('record time is malformed');
  if (e.ts !== undefined && ts !== e.ts) return no("record time is not prepare's");

  let want: SealRecord;
  try {
    want = expectedSealRecord(e, handle, ts);
  } catch (err) {
    return no(err instanceof Error ? err.message : 'record cannot be rebuilt');
  }
  // ⚠ The ref is on chain in the output: an unbounded one (from the document's manifest) would set the fee.
  if (!shortText(want.ref, SEAL_REF_MAX_CHARS)) return no('reference is too long');
  if (!want.fields.length || want.fields.length > SEAL_FIELDS_MAX) return no('block count is out of range');
  for (const f of want.fields)
    if (![f.id, f.party, f.role].every((t) => shortText(t, SEAL_TEXT_MAX_CHARS))) return no('a block is too long');
  const wantText = canonicalJson(want);
  if (text !== wantText) {
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    const diff = [...keys].filter((k) => {
      try {
        return canonicalJson((want as Record<string, unknown>)[k]) !== canonicalJson(got[k]);
      } catch {
        return true;
      }
    });
    return no(`record differs (${diff.join(', ') || 'form'})`);
  }

  const docHash = composed.docHash;
  if (typeof docHash !== 'string' || !HEX64.test(docHash)) return no('docHash is malformed');
  const script = sealScriptHex(docHash, want);
  if (typeof composed.lockingScriptHex !== 'string' || composed.lockingScriptHex.toLowerCase() !== script)
    return no('output is not the seal of this record');

  return {
    ok: true,
    signing: {
      protocolID: [SEAL_PROTOCOL_ID[0], SEAL_PROTOCOL_ID[1]],
      keyID: e.nonce,
      counterparty: SEAL_COUNTERPARTY,
    },
    recordCanonical: wantText,
    lockingScriptHex: script,
  };
}
