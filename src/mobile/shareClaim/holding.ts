import { ProtoWallet, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { canonicalBytes } from './canonical';
import { companyConfigured, COMPANIES, type CompanyPin } from './companies';

/**
 * The read-only "Your shareholding" card's data (all builds). Shown ONLY when the company server returns this
 * wallet's own register entry, signed by the PINNED company identity key. No prices, values or offers exist here.
 *
 * PROPOSED contract addition (relay to the NPG side):
 *   GET <host>/api/shareholders/holding/<identityKey>
 *     x-bwx-timestamp: <ms>   x-bwx-signature: hex DER
 *     request sig: createSignature(canonicalJson({identityKey, timestamp}), [1,'npg share holding'], keyID=timestamp, 'anyone')
 *   200 → { v:1, company:{name,number,ticker}, holder:{identityKey,registerEntry,nameOnRegister,shares},
 *           tokens:[{id,tranche,amount,outpoint?}], activity:[{at,text}], sig }
 *     sig: company createSignature(canonicalJson(body without sig), [1,'npg share holding'], keyID '1', 'anyone')
 *   404 → not a member OR a bad request signature: either way the card shows nothing, never an error.
 * The timestamp is sent in milliseconds.
 */
export const HOLDING_PROTOCOL: WalletProtocol = [1, 'npg share holding'];

export type Holding = {
  company: { name: string; number: string; ticker: string };
  holder: { identityKey: string; registerEntry: string; nameOnRegister: string; shares: number };
  /** id null = a planned tranche whose token is not on chain yet. */
  tokens: { id: string | null; tranche: string; amount: number; outpoint?: string }[];
  activity: { at: string; text: string }[];
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Verifies a holding response for `identityKey`; null when anything is off (the card then shows nothing). */
export async function checkHolding(raw: unknown, pin: CompanyPin, identityKey: string): Promise<Holding | null> {
  if (!companyConfigured(pin) || !isObj(raw) || typeof raw.sig !== 'string') return null;
  const rest = { ...raw };
  delete rest.sig;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: canonicalBytes(rest),
      signature: Utils.toArray(raw.sig, 'hex'),
      protocolID: HOLDING_PROTOCOL,
      keyID: '1',
      counterparty: pin.identityKey,
    });
    if (!valid) return null;
  } catch {
    return null;
  }
  const h = raw.holder,
    c = raw.company;
  if (raw.v !== 1 || !isObj(c) || c.number !== pin.number || !isObj(h)) return null;
  if (String(h.identityKey).toLowerCase() !== identityKey.toLowerCase()) return null; // own entry only
  if (typeof h.registerEntry !== 'string' || typeof h.nameOnRegister !== 'string' || !isCount(h.shares)) return null;
  if (!Array.isArray(raw.tokens)) return null;
  let sum = 0;
  const tokens: Holding['tokens'] = [];
  for (const t of raw.tokens) {
    if (!isObj(t) || !isCount(t.amount) || typeof t.tranche !== 'string') return null;
    if (t.id === null) {
      // Only a tranche pinned as planned may be off chain, and never larger than its allotment.
      const plan = Object.prototype.hasOwnProperty.call(pin.planned, t.tranche) ? pin.planned[t.tranche] : null;
      if (!plan || t.amount > plan.shares) return null;
      sum += t.amount;
      tokens.push({ id: null, tranche: t.tranche, amount: t.amount });
      continue;
    }
    if (typeof t.id !== 'string' || !pin.tokens[t.id] || t.tranche !== pin.tokens[t.id].tranche) return null;
    sum += t.amount;
    tokens.push({
      id: t.id,
      tranche: t.tranche,
      amount: t.amount,
      outpoint: typeof t.outpoint === 'string' ? t.outpoint : undefined,
    });
  }
  if (sum !== h.shares) return null;
  const activity = Array.isArray(raw.activity)
    ? raw.activity
        .filter(
          (a): a is { at: string; text: string } => isObj(a) && typeof a.at === 'string' && typeof a.text === 'string',
        )
        .slice(0, 20)
    : [];
  return {
    company: { name: String(c.name), number: pin.number, ticker: pin.ticker },
    holder: {
      identityKey: identityKey.toLowerCase(),
      registerEntry: h.registerEntry,
      nameOnRegister: h.nameOnRegister,
      shares: h.shares,
    },
    tokens,
    activity,
  };
}

export async function fetchHoldings(
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  f: typeof fetch = fetch,
  now = Date.now(),
): Promise<Holding[]> {
  const configured = Object.values(COMPANIES).filter(companyConfigured);
  if (!configured.length) return [];
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const identityKey = publicKey.toLowerCase();
  const timestamp = String(now);
  const { signature } = await wallet.createSignature({
    data: canonicalBytes({ identityKey, timestamp }),
    protocolID: HOLDING_PROTOCOL,
    keyID: timestamp,
    counterparty: 'anyone',
  });
  const out: Holding[] = [];
  for (const pin of configured) {
    try {
      const r = await f(`${pin.host}/api/shareholders/holding/${identityKey}`, {
        headers: {
          accept: 'application/json',
          'x-bwx-timestamp': timestamp,
          'x-bwx-signature': Utils.toHex(signature),
        },
      });
      if (!r.ok) continue; // 404 = not a member / bad signature: show nothing
      const h = await checkHolding(await r.json(), pin, identityKey);
      if (h) out.push(h);
    } catch {
      /* one company down never hides another */
    }
  }
  return out;
}
