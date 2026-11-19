/**
 * Exchange › Contracts (SMART-WALLET-SPEC.md §8): a contract is sold as a PUBLIC 1Sat NFT (content type
 * CONTRACT_CONTENT_TYPE) so buyers can read and audit it before paying. The envelope carries the contract's
 * descriptor (`bwalletx.contract/1`: what it does, its network, parameters, spend paths, oracle, code hash and
 * source) plus sale terms. A buyer's copy is the same envelope inscribed again in the transaction that pays the
 * author; the catalogue (site/api/contracts.js) counts paid copies against the edition size.
 */
import { Hash, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import { APP_NAME } from '../storeBuild';

export const CONTRACT_CONTENT_TYPE = 'application/vnd.bwalletx.contract+json';
export const CONTRACT_ENVELOPE_FORMAT = 'bwalletx.contract-nft/1';
export const CONTRACT_DISCLAIMER = `Contracts are programs. Read what each one does before you use it; ${APP_NAME} doesn’t review, rate or recommend them.`;

export type ContractDescriptor = {
  format: 'bwalletx.contract/1';
  name: string;
  version: string;
  network: 'testnet' | 'mainnet';
  summary: string;
  params?: Record<string, string | number>;
  spendPaths?: { name: string; who: string; requires: string }[];
  oracle?: { quorum: number; signers: string[] };
  source?: string;
  codeHash?: string;
};

export type ContractEnvelope = {
  format: typeof CONTRACT_ENVELOPE_FORMAT;
  contract: ContractDescriptor;
  description: string;
  /**
   * `name` is what the author typed (never shown for a signed listing). `identityKey` and `handle` (the author's
   * bWalletX paymail) are set by the wallet's own publish and covered by `authorSig`.
   */
  author: { name: string; address: string; identityKey?: string; handle?: string };
  sale: { priceUsd: number; copies: number; payTo: string };
  /** The author's identity-key signature over the rest of the envelope (signContractEnvelope). */
  authorSig?: string;
};

/**
 * Author signatures (owner, 14 Nov 2026: "paid contract listing need an author's signature"; b-Aware row 115).
 * BRC-43 [2,'bwallet contract'], keyID '1', counterparty 'anyone', by the author's identity key, over the canonical
 * JSON of the envelope without authorSig: the payee (sale.payTo = author.address), price, copies, text and the
 * author's key and handle are all signed. Reserved (services/reservedProtocolList.ts), so no site can make the
 * wallet produce one; only the wallet's own publish signs. The format string stays bwalletx.contract-nft/1: the
 * catalogue's parser (site/lib/contracts.js) refuses any other format and keeps extra fields, so signed and unsigned
 * envelopes are both /1 and a signature is what tells them apart.
 */
export const CONTRACT_SIGN_PROTOCOL: [2, string] = [2, 'bwallet contract'];
export const CONTRACT_SIGN_KEY_ID = '1';
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

/** Key-order-independent JSON value (objects with sorted keys). */
export const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

/**
 * What makes two listings the same contract (b-Aware row 352, UID 630, and its review). Free text (name, version,
 * summary, the envelope's description) never does: one changed character there must not make a copy a different
 * contract. Mirrored line for line by the catalogue (site/lib/contracts.js contractKeys); a test runs both on the same
 * fixtures.
 * - A listing with code (every paid one must have it; contractCodeProblem) IS its code: `hash:` + its code hash in
 *   lower case, and `src:` + sha256 of its normalised source. Params, spend paths, oracle and network are text the
 *   author types around the code, so a junk param, `5` for "5" or an empty oracle don't make a new contract. Two
 *   listings are the same contract when they share either key (sameContract), so dropping the code hash or the source
 *   of an original that carries both doesn't make a copy new either.
 * - A free listing with no code: `free:` + the canonical JSON of its normalised format, network, params, spend paths,
 *   oracle and NAME (the name, or every unrelated free contract on one network would be "the same").
 * Known limit: a real edit to the code itself (one changed character of a code hash, a new token in the source) is a
 * different contract; the backstop is the signed author handle on the sheet.
 */
export const CODE_HASH_RE = /^[0-9a-f]{64}$/i;
const FREE_IDENTITY_FIELDS = ['format', 'network', 'params', 'spendPaths', 'oracle', 'name'] as const;

/** Source as identity sees it: NFKC, CRLF/CR → LF, trailing whitespace per line and blank lines at the ends dropped. */
export const normaliseSource = (s: unknown): string =>
  typeof s === 'string'
    ? s
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => l.replace(/\s+$/u, ''))
        .join('\n')
        .trim()
    : '';

/** Every string and number as NFKC-trimmed text; null, '', [] and {} dropped (undefined); object keys sorted. */
const tidy = (v: unknown): unknown => {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const a = v.map(tidy).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k.normalize('NFKC').trim(), tidy(x)] as const)
      .filter(([k, x]) => k !== '' && x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  const s = String(v).normalize('NFKC').trim();
  return s === '' ? undefined : s;
};

/** The identity keys of a contract descriptor (see above). Never empty. */
export const contractKeys = (c: Partial<ContractDescriptor> | null | undefined): string[] => {
  const src: Record<string, unknown> = c && typeof c === 'object' ? c : {};
  const keys: string[] = [];
  if (typeof src.codeHash === 'string' && CODE_HASH_RE.test(src.codeHash))
    keys.push(`hash:${src.codeHash.toLowerCase()}`);
  const source = normaliseSource(src.source);
  if (source !== '') keys.push(`src:${Utils.toHex(Hash.sha256(Utils.toArray(source, 'utf8')))}`);
  if (keys.length) return keys;
  const picked: Record<string, unknown> = {};
  for (const k of FREE_IDENTITY_FIELDS) picked[k] = src[k];
  return [`free:${JSON.stringify(tidy(picked) ?? {})}`];
};

/** One string for a contract's identity: its code hash, else its source, else its free fields (contractKeys[0]). */
export const contractIdentity = (c: Partial<ContractDescriptor> | null | undefined): string => contractKeys(c)[0];

/** The same contract: the two share an identity key. */
export const sameContract = (
  a: Partial<ContractDescriptor> | null | undefined,
  b: Partial<ContractDescriptor> | null | undefined,
) => {
  const theirs = contractKeys(b);
  return contractKeys(a).some((k) => theirs.includes(k));
};

/**
 * Why a PAID listing can't be listed, or null: it must carry code, a valid code hash (64 hex characters) or a
 * source that isn't blank once normalised, and a code hash it carries must be valid (buyers are shown it, and it is
 * the identity).
 */
export const contractCodeProblem = (c: Partial<ContractDescriptor> | null | undefined): string | null => {
  const hash = c?.codeHash as unknown;
  const hasHash = hash !== undefined && hash !== null && hash !== '';
  if (hasHash && (typeof hash !== 'string' || !CODE_HASH_RE.test(hash)))
    return 'A paid contract’s code hash must be 64 hex characters';
  if (!hasHash && normaliseSource(c?.source) === '')
    return 'A paid contract must include its source or code hash, so buyers can read what they are paying for';
  return null;
};

/** The bytes the author signs: the canonical envelope with authorSig left out. */
export const contractSigningBytes = (env: ContractEnvelope): number[] => {
  const { authorSig: _sig, ...rest } = env;
  return Utils.toArray(JSON.stringify(canonical(rest)), 'utf8');
};

/** The wallet's own publish: the envelope with the account's identity key, handle and signature. */
export const signContractEnvelope = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  env: ContractEnvelope,
  handle?: string,
): Promise<ContractEnvelope> => {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const { authorSig: _old, ...rest } = env;
  const { handle: _h, identityKey: _k, ...typed } = rest.author;
  const author = { ...typed, identityKey: publicKey.toLowerCase(), ...(handle ? { handle } : {}) };
  const unsigned: ContractEnvelope = { ...rest, author };
  const { signature } = await wallet.createSignature({
    data: contractSigningBytes(unsigned),
    protocolID: CONTRACT_SIGN_PROTOCOL,
    keyID: CONTRACT_SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { ...unsigned, authorSig: Utils.toHex(signature) };
};

/** The author's identity key when authorSig is a valid signature by author.identityKey; null otherwise. */
export const contractAuthorKey = async (env: ContractEnvelope): Promise<string | null> => {
  const key = env.author?.identityKey;
  const sig = env.authorSig;
  if (typeof key !== 'string' || !PUBKEY_RE.test(key) || typeof sig !== 'string' || !/^[0-9a-f]{16,200}$/i.test(sig))
    return null;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: contractSigningBytes(env),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: CONTRACT_SIGN_PROTOCOL,
      keyID: CONTRACT_SIGN_KEY_ID,
      counterparty: key,
    });
    return valid ? key : null;
  } catch {
    return null;
  }
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate a contract descriptor (contract.json). Errors are listed, never defaulted. */
export const parseDescriptor = (
  input: unknown,
): { ok: true; contract: ContractDescriptor } | { ok: false; errors: string[] } => {
  let o: Record<string, unknown>;
  try {
    o = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>;
  } catch {
    return { ok: false, errors: ['Not valid JSON'] };
  }
  const errors: string[] = [];
  if (o?.format !== 'bwalletx.contract/1') errors.push('format must be "bwalletx.contract/1"');
  const name = str(o?.name, 60);
  const version = str(o?.version, 20);
  const summary = str(o?.summary, 1000);
  if (!name) errors.push('name is required');
  if (!version) errors.push('version is required');
  if (!summary) errors.push('summary is required');
  if (o?.network !== 'testnet' && o?.network !== 'mainnet') errors.push('network must be "testnet" or "mainnet"');
  if (errors.length) return { ok: false, errors };
  const paths = Array.isArray(o.spendPaths)
    ? (o.spendPaths as Record<string, unknown>[])
        .slice(0, 20)
        .map((p) => ({ name: str(p?.name, 40), who: str(p?.who, 80), requires: str(p?.requires, 300) }))
    : undefined;
  const params =
    o.params && typeof o.params === 'object'
      ? Object.fromEntries(
          Object.entries(o.params as Record<string, unknown>)
            .slice(0, 30)
            .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
            .map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 120) : v]),
        )
      : undefined;
  const or = o.oracle as { quorum?: unknown; signers?: unknown } | undefined;
  const oracle =
    or && Number.isInteger(or.quorum) && Array.isArray(or.signers)
      ? {
          quorum: or.quorum as number,
          signers: (or.signers as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20),
        }
      : undefined;
  return {
    ok: true,
    contract: {
      format: 'bwalletx.contract/1',
      name,
      version,
      network: o.network as ContractDescriptor['network'],
      summary,
      ...(params && { params: params as Record<string, string | number> }),
      ...(paths?.length && { spendPaths: paths }),
      ...(oracle && { oracle }),
      ...(str(o.source, 300) && { source: str(o.source, 300) }),
      ...(/^[0-9a-f]{64}$/.test(str(o.codeHash, 64)) && { codeHash: str(o.codeHash, 64) }),
    },
  };
};

export const contractEnvelope = (
  contract: ContractDescriptor,
  meta: { description: string; author: { name: string; address: string }; sale: ContractEnvelope['sale'] },
): ContractEnvelope => ({
  format: CONTRACT_ENVELOPE_FORMAT,
  contract,
  description: meta.description.trim().slice(0, 1000),
  author: { name: meta.author.name.slice(0, 40), address: meta.author.address },
  sale: meta.sale,
});

export const contractSaleProblems = (env: ContractEnvelope): string[] => {
  const out: string[] = [];
  if (!env.description.trim()) out.push('Add a description');
  if (!(env.sale.priceUsd >= 0 && env.sale.priceUsd <= 10_000)) out.push('Price must be between $0 and $10,000');
  if (!(Number.isInteger(env.sale.copies) && env.sale.copies >= 1 && env.sale.copies <= 100_000))
    out.push('Copies must be 1–100,000');
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(env.sale.payTo)) out.push('No payout address');
  return out;
};
