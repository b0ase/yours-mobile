import { Hash, ProtoWallet, Script, Utils, type WalletInterface } from '@bsv/sdk';
import type { DocContent } from './api';

/**
 * Bureau agreements: a document that travels inside a bMail envelope (bmail/envelope.ts `Sealed.agreement`),
 * so it is BRC-2 encrypted to each party and posted with bMail's normal postage. Nothing here needs a server.
 *
 *   doc   the terms: plain text, HTML or a small PDF (base64), with the sha256 of its bytes
 *   sigs  one per party: the drawn signature (the card signature, signature/signature.ts) + an identity-key
 *         signature over a record binding the document hash and the drawing's hash
 *   seal  an on-chain receipt: a 0-sat OP_FALSE OP_RETURN carrying hashes only (no content), paid by the sealer
 *
 * Each party's copy is merged by agreement id (mergeParts); a part whose document hash differs is ignored, and a
 * signature counts only if it verifies against the signer's identity key.
 */
export const AGREEMENT_PROTOCOL: [2, string] = [2, 'bwallet agreement'];
export const SEAL_TAG = 'bwallet.agreement.seal';
/** Document content cap (characters of text, HTML or base64): keeps the whole bMail envelope under its limit. */
export const CONTENT_MAX = 30_000;
const KEY_RE = /^0[23][0-9a-f]{64}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;

export type DocMime = 'text/plain' | 'text/html' | 'application/pdf';
export type AgreementDoc = {
  v: 1;
  id: string;
  title: string;
  mime: DocMime;
  /** Text / HTML as is; PDF as base64. */
  content: string;
  /** sha256 (hex) of the document bytes. */
  sha256: string;
  author: string;
  /** Identity keys expected to sign (author included). */
  parties: string[];
  createdAt: number;
};
export type AgreementSig = { key: string; svgSha256: string; svgPath: string; at: number; sig: string };
export type AgreementSeal = { txid: string; at: number; by: string };
export type AgreementPart = { doc: AgreementDoc; sigs: AgreementSig[]; seal?: AgreementSeal };

const sha256Hex = (bytes: number[]) => Utils.toHex(Hash.sha256(bytes));
export const docBytes = (d: Pick<AgreementDoc, 'mime' | 'content'>): number[] =>
  d.mime === 'application/pdf' ? Utils.toArray(d.content, 'base64') : Utils.toArray(d.content, 'utf8');

export const makeDoc = (a: Omit<AgreementDoc, 'v' | 'sha256'>): AgreementDoc => {
  if (!a.title.trim()) throw new Error('Give the agreement a title.');
  if (!a.content) throw new Error('The agreement is empty.');
  if (a.content.length > CONTENT_MAX) throw new Error('This document is too large to send by bMail yet (about 22 KB).');
  const doc = { ...a, v: 1 as const, title: a.title.trim().slice(0, 120), sha256: '' };
  doc.sha256 = sha256Hex(docBytes(doc));
  doc.parties = [...new Set([a.author, ...a.parties])];
  return doc;
};

/** The exact text the identity key signs. */
export const signRecord = (doc: Pick<AgreementDoc, 'id' | 'sha256'>, svgSha256: string, at: number) =>
  `bwallet agreement|v1|id=${doc.id}|doc=${doc.sha256}|sig=${svgSha256}|at=${at}`;

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Parse an untrusted part (from a decrypted envelope). Null unless every field is well formed and the hash matches. */
export const parsePart = (raw: unknown): AgreementPart | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = r.doc as Record<string, unknown> | undefined;
  if (!d || d.v !== 1) return null;
  const mime = d.mime === 'text/plain' || d.mime === 'text/html' || d.mime === 'application/pdf' ? d.mime : null;
  const id = str(d.id, 64);
  const title = str(d.title, 120);
  const content = str(d.content, CONTENT_MAX);
  const sha = str(d.sha256, 64);
  const author = str(d.author, 66);
  const createdAt = num(d.createdAt);
  const parties = Array.isArray(d.parties) ? d.parties.filter((p): p is string => typeof p === 'string') : [];
  if (!mime || !id || !/^[0-9a-f]{8,64}$/i.test(id) || !title || !content || !sha || !HEX64.test(sha)) return null;
  if (!author || !KEY_RE.test(author) || createdAt === null || !parties.every((p) => KEY_RE.test(p))) return null;
  if (parties.length === 0 || parties.length > 20) return null;
  const doc: AgreementDoc = { v: 1, id, title, mime, content, sha256: sha.toLowerCase(), author, parties, createdAt };
  try {
    if (sha256Hex(docBytes(doc)) !== doc.sha256) return null;
  } catch {
    return null;
  }
  const sigs: AgreementSig[] = (Array.isArray(r.sigs) ? r.sigs : []).flatMap((x) => {
    const s = x as Record<string, unknown>;
    const key = str(s?.key, 66);
    const svgSha256 = str(s?.svgSha256, 64);
    const svgPath = str(s?.svgPath, 9000);
    const at = num(s?.at);
    const sig = str(s?.sig, 200);
    return key && KEY_RE.test(key) && svgSha256 && HEX64.test(svgSha256) && svgPath && at !== null && sig
      ? [{ key, svgSha256, svgPath, at, sig }]
      : [];
  });
  const sl = r.seal as Record<string, unknown> | undefined;
  const txid = str(sl?.txid, 64);
  const by = str(sl?.by, 66);
  const sealAt = num(sl?.at);
  const seal =
    txid && HEX64.test(txid) && by && KEY_RE.test(by) && sealAt !== null ? { txid, at: sealAt, by } : undefined;
  return { doc, sigs, ...(seal ? { seal } : {}) };
};

/** Does this signature verify against its signer's identity key, for this document? */
export const verifySig = async (doc: AgreementDoc, s: AgreementSig): Promise<boolean> => {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(signRecord(doc, s.svgSha256, s.at), 'utf8'),
      signature: Utils.toArray(s.sig, 'hex'),
      protocolID: AGREEMENT_PROTOCOL,
      keyID: doc.id,
      counterparty: s.key,
    });
    return valid && doc.parties.includes(s.key);
  } catch {
    return false;
  }
};

/** Merge every copy of each agreement (by id). Copies whose document hash differs from the first seen are dropped. */
export const mergeParts = (parts: AgreementPart[]): AgreementPart[] => {
  const byId = new Map<string, AgreementPart>();
  for (const p of parts) {
    const cur = byId.get(p.doc.id);
    if (!cur) {
      byId.set(p.doc.id, { doc: p.doc, sigs: [...p.sigs], ...(p.seal ? { seal: p.seal } : {}) });
      continue;
    }
    if (cur.doc.sha256 !== p.doc.sha256) continue;
    for (const s of p.sigs) if (!cur.sigs.some((x) => x.key === s.key)) cur.sigs.push(s);
    if (p.seal && (!cur.seal || p.seal.at < cur.seal.at)) cur.seal = p.seal;
  }
  return [...byId.values()];
};

/** Sign with the identity key (no server). `svgPath` is the card signature or one drawn now. */
export const signAgreement = async (
  wallet: Pick<WalletInterface, 'createSignature'>,
  me: string,
  doc: AgreementDoc,
  svgPath: string,
  svgSha256: string,
  at = Date.now(),
): Promise<AgreementSig> => {
  if (!doc.parties.includes(me)) throw new Error('You are not a party to this agreement.');
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(signRecord(doc, svgSha256, at), 'utf8'),
    protocolID: AGREEMENT_PROTOCOL,
    keyID: doc.id,
    counterparty: 'anyone',
  });
  return { key: me, svgSha256, svgPath, at, sig: Utils.toHex(signature) };
};

/** The seal's OP_RETURN: tag, document hash, and a hash over the sorted signatures. Hashes only, no content. */
export const sealScriptHex = (p: AgreementPart): string => {
  const sigsHash = sha256Hex(
    Utils.toArray(
      [...p.sigs]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((s) => `${s.key}:${s.sig}`)
        .join('|'),
      'utf8',
    ),
  );
  return new Script()
    .writeOpCode(0) // OP_FALSE
    .writeOpCode(0x6a) // OP_RETURN
    .writeBin(Utils.toArray(SEAL_TAG, 'utf8'))
    .writeBin(Utils.toArray(p.doc.id, 'utf8'))
    .writeBin(Utils.toArray(p.doc.sha256, 'hex'))
    .writeBin(Utils.toArray(sigsHash, 'hex'))
    .toHex();
};

/** Put the seal receipt on chain from this wallet (one 0-sat output; the wallet pays the network fee). */
export const sealOnChain = async (
  wallet: Pick<WalletInterface, 'createAction'>,
  me: string,
  p: AgreementPart,
  at = Date.now(),
): Promise<AgreementSeal> => {
  const r = await wallet.createAction({
    description: 'Seal an agreement (hashes only)',
    outputs: [{ satoshis: 0, lockingScript: sealScriptHex(p), outputDescription: 'Agreement seal' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  if (!r.txid) throw new Error('The wallet did not return a transaction, so nothing was sealed.');
  return { txid: r.txid.toLowerCase(), at, by: me };
};

/** An agreement's document as viewer content. */
export const docContent = (d: AgreementDoc): DocContent =>
  d.mime === 'application/pdf'
    ? { kind: 'pdf', bytes: new Uint8Array(Utils.toArray(d.content, 'base64')) }
    : d.mime === 'text/html'
      ? { kind: 'html', html: d.content }
      : { kind: 'text', text: d.content };
