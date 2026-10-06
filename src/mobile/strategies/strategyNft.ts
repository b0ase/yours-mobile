/**
 * Exchange › Strategies (SMART-WALLET-SPEC.md §7): a strategy sold as an encrypted 1Sat NFT.
 *
 * The inscription (content type STRATEGY_CONTENT_TYPE) is a public envelope: the spec buyers compare,
 * the sale terms (price in dollars, copies, the author's payout address), and the strategy program
 * encrypted with a random content key (AES-256-GCM). `keyHash` = sha256(content key), so the key
 * service (site/api/strategies.js) can prove a key belongs to an envelope without trusting anyone.
 *
 * Every copy is the same envelope inscribed again: the author's copy when publishing, a buyer's copy
 * when buying (the same transaction pays the author). The key service gives the content key to whoever
 * proves they own a copy that was the author's or was paid for, up to `copies`.
 */
import { APP_NAME } from '../storeBuild';
import type { Strategy, StrategySpec } from '../agents/strategy';
import { parseStrategy } from '../agents/strategy';

export const STRATEGY_CONTENT_TYPE = 'application/vnd.bwalletx.strategy+json';
export const ENVELOPE_FORMAT = 'bwalletx.strategy-nft/1';
export const STRATEGY_DISCLAIMER = `Strategies are programs written and sold by users. ${APP_NAME} doesn’t review, rate or recommend them.`;
export const MAX_COPIES = 10_000;

export type SaleTerms = { priceUsd: number; copies: number; payTo: string };

export type Envelope = {
  format: typeof ENVELOPE_FORMAT;
  name: string;
  version: string;
  description: string;
  spec: Required<StrategySpec>;
  author: { name: string; address: string };
  sale: SaleTerms;
  keyHash: string;
  iv: string;
  ciphertext: string;
};

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export const keyHashOf = async (key: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', key));

const SPEC_FIELDS: (keyof StrategySpec)[] = ['trades', 'risk', 'spends', 'often', 'stops', 'needs'];
export const SPEC_LABELS: Record<keyof StrategySpec, string> = {
  trades: 'What it trades',
  risk: 'Seller’s risk rating',
  spends: 'Most it will spend',
  often: 'How often it acts',
  stops: 'When it stops',
  needs: 'Needs',
};

/** The mechanical checks before publishing (§7.2): every spec field filled, sane sale terms. */
export const publishProblems = (s: Strategy, sale: SaleTerms, description: string): string[] => {
  const out: string[] = [];
  for (const f of SPEC_FIELDS) if (!s.spec?.[f]?.toString().trim()) out.push(`Spec: “${SPEC_LABELS[f]}” is empty`);
  if (!description.trim()) out.push('Add a description');
  if (!(sale.priceUsd >= 0.01 && sale.priceUsd <= 10_000)) out.push('Price must be between $0.01 and $10,000');
  if (!(Number.isInteger(sale.copies) && sale.copies >= 1 && sale.copies <= MAX_COPIES))
    out.push(`Copies must be 1–${MAX_COPIES}`);
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(sale.payTo)) out.push('No payout address');
  return out;
};

/** Encrypt a strategy into a publishable envelope. Returns the content key (base64) to register. */
export const sealStrategy = async (
  s: Strategy,
  meta: { description: string; author: { name: string; address: string }; sale: SaleTerms },
): Promise<{ envelope: Envelope; key: string }> => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(s))),
  );
  const spec = Object.fromEntries(
    SPEC_FIELDS.map((f) => [f, String(s.spec?.[f] ?? '').slice(0, 200)]),
  ) as Required<StrategySpec>;
  return {
    key: b64(key),
    envelope: {
      format: ENVELOPE_FORMAT,
      name: s.name,
      version: s.version,
      description: meta.description.trim().slice(0, 1000),
      spec,
      author: { name: meta.author.name.slice(0, 40), address: meta.author.address },
      sale: meta.sale,
      keyHash: await keyHashOf(key),
      iv: b64(iv),
      ciphertext: b64(ct),
    },
  };
};

/** Decrypt with the content key from the key service; the result is re-validated like any strategy file. */
export const openStrategy = async (env: Envelope, keyB64: string): Promise<Strategy> => {
  const key = unb64(keyB64);
  if ((await keyHashOf(key)) !== env.keyHash) throw new Error('That key doesn’t belong to this strategy');
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, k, unb64(env.ciphertext));
  const r = parseStrategy(new TextDecoder().decode(plain));
  if (!r.ok) throw new Error(`The strategy inside is invalid: ${r.errors.join('; ')}`);
  return r.strategy;
};

/** Parse an envelope (from an inscription or the key service). Null if it isn't one. */
export const parseEnvelope = (input: unknown): Envelope | null => {
  try {
    const o = (typeof input === 'string' ? JSON.parse(input) : input) as Envelope;
    if (o?.format !== ENVELOPE_FORMAT || typeof o.keyHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.keyHash))
      return null;
    if (typeof o.ciphertext !== 'string' || typeof o.iv !== 'string' || !o.sale || !o.spec || !o.author) return null;
    return o;
  } catch {
    return null;
  }
};

/** What the owner signs to unlock or publish; the key service checks the action, outpoint and a 5-minute window. */
export const proofMessage = (action: 'publish' | 'unlock', outpoint: string, ts: number) =>
  `bwalletx strategy ${action}: ${outpoint}: ${ts}`;
