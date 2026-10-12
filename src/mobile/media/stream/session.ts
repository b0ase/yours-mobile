import { P2PKH, PrivateKey, PublicKey, Random, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { buildSweepTx, coinSats, type Coin } from './tx';

/**
 * Ephemeral session key for per-second streaming. The private key is never stored: it is derived from the
 * wallet (an HMAC under a BRC-42 'self' key, protocol [2,'bmusic session'], keyID = session id), so a session
 * that dies with the page can be recovered and swept on the next start from its id alone. Storage keeps only
 * { id, identityKey, fundingTxid, createdAt }.
 */
export const SESSION_PROTOCOL: [2, string] = [2, 'bmusic session'];
export const STORE_KEY = 'bwx.bmusic.sessions';
const BRC29_PROTOCOL = '3241645161d8';

type Wallet = Pick<WalletInterface, 'createHmac' | 'getPublicKey' | 'createAction' | 'internalizeAction'>;

export type SessionRecord = { id: string; identityKey: string; fundingTxid: string | null; createdAt: number };

export async function deriveSessionKey(wallet: Pick<WalletInterface, 'createHmac'>, id: string): Promise<PrivateKey> {
  const { hmac } = await wallet.createHmac({
    data: Utils.toArray(`bmusic session:${id}`, 'utf8'),
    protocolID: SESSION_PROTOCOL,
    keyID: id,
    counterparty: 'self',
  });
  return new PrivateKey(Utils.toHex(hmac), 16);
}

// ── records (localStorage; only ids and txids) ───────────────────────────────
type KV = Pick<Storage, 'getItem' | 'setItem'>;
const kv = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
export const listSessions = (s: KV | null = kv()): SessionRecord[] => {
  try {
    const v = JSON.parse(s?.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
};
const save = (rs: SessionRecord[], s: KV | null) => {
  try {
    s?.setItem(STORE_KEY, JSON.stringify(rs));
  } catch {
    // storage blocked: recovery falls back to sweeping in-session only
  }
};
export const recordSession = (r: SessionRecord, s: KV | null = kv()) =>
  save([...listSessions(s).filter((x) => x.id !== r.id), r], s);
export const forgetSession = (id: string, s: KV | null = kv()) => {
  ACTIVE_SESSIONS.delete(id);
  save(
    listSessions(s).filter((x) => x.id !== id),
    s,
  );
};

/** Sessions live in this page; recovery never sweeps these. */
export const ACTIVE_SESSIONS = new Set<string>();

export const newSessionId = () => Utils.toHex(Random(16));

/**
 * A sponsored session: the same deterministic session key (signer and BRC-2 recipient), no funding and no
 * record, since there is nothing to sweep.
 */
export async function openSponsoredSession(
  wallet: Pick<WalletInterface, 'createHmac'>,
): Promise<{ id: string; key: PrivateKey }> {
  const id = newSessionId();
  return { id, key: await deriveSessionKey(wallet, id) };
}

/** Fund a new session with ONE wallet createAction (the budget sheet's approval). */
export async function openSession(
  wallet: Wallet,
  budgetSats: number,
  s: KV | null = kv(),
): Promise<{ id: string; key: PrivateKey; coin: Coin }> {
  const id = newSessionId();
  ACTIVE_SESSIONS.add(id);
  const key = await deriveSessionKey(wallet, id);
  const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey;
  // Recorded before funding: if the page dies mid-approval, the next start still finds the address.
  recordSession({ id, identityKey, fundingTxid: null, createdAt: Date.now() }, s);
  const r = await wallet
    .createAction({
      description: 'bMusic listening budget',
      outputs: [
        {
          lockingScript: new P2PKH().lock(key.toAddress()).toHex(),
          satoshis: budgetSats,
          outputDescription: 'Stream budget (session key)',
        },
      ],
      labels: ['bmusic-stream'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    })
    .catch((e) => {
      // Refused or failed: nothing funded for sure? Keep the record (recovery drops it once empty).
      ACTIVE_SESSIONS.delete(id);
      throw e;
    });
  if (!r.tx || !r.txid) {
    forgetSession(id, s);
    ACTIVE_SESSIONS.delete(id);
    throw new Error('The wallet did not fund the session');
  }
  recordSession({ id, identityKey, fundingTxid: r.txid, createdAt: Date.now() }, s);
  const tx = Transaction.fromAtomicBEEF(r.tx);
  return { id, key, coin: { tx, vout: 0 } };
}

/**
 * Return a session coin to the wallet: a BRC-29 'wallet payment' from the session key to the wallet's identity,
 * then internalizeAction (the wallet takes the BEEF and broadcasts it). Returns the sats returned, 0 for dust.
 */
export async function sweepCoin(wallet: Wallet, key: PrivateKey, coin: Coin): Promise<number> {
  if (coinSats(coin) < 1) return 0;
  const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey;
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Utils.toArray('sweep', 'utf8'));
  const to = PublicKey.fromString(identityKey).deriveChild(
    key,
    `2-${BRC29_PROTOCOL}-${derivationPrefix} ${derivationSuffix}`,
  );
  const tx = await buildSweepTx(key, coin, new P2PKH().lock(to.toAddress()).toHex());
  if (!tx) return 0;
  await wallet.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: key.toPublicKey().toString() },
      },
    ],
    description: 'bMusic budget returned',
    labels: ['bmusic-stream'],
  });
  return tx.outputs[0].satoshis ?? 0;
}

/** Try each candidate coin (newest first) until one sweeps; the others are spent or never broadcast. */
export async function sweepFirst(wallet: Wallet, key: PrivateKey, coins: Coin[]): Promise<number> {
  let last: unknown = null;
  for (const c of coins) {
    try {
      return await sweepCoin(wallet, key, c);
    } catch (e) {
      last = e;
    }
  }
  if (last) throw last;
  return 0;
}

/** Find a session address's unspent coins with their ancestry (indexer + BEEF service). */
export type FindCoins = (address: string) => Promise<Coin[]>;

export const defaultFindCoins: FindCoins = async (address) => {
  const { OneSatServices } = await import('@1sat/wallet-browser');
  const svc = new OneSatServices('main');
  for await (const ev of svc.owner.getTxos(address, { refresh: true, limit: 1 })) {
    if (ev.type === 'done' || ev.type === 'error') break;
  }
  const utxos = (await svc.txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
  const coins: Coin[] = [];
  for (const u of utxos) {
    const [txid, vout] = u.outpoint.split(/[._]/);
    if (!txid || !(u.satoshis && u.satoshis > 0)) continue;
    const beef = await svc.beef.getBeef(txid);
    coins.push({ tx: Transaction.fromBEEF(Array.from(beef), txid), vout: parseInt(vout, 10) });
  }
  return coins;
};

/** A record with no coins is dropped only after this long (indexer lag on a fresh funding tx). */
export const EMPTY_GRACE_MS = 10 * 60 * 1000;

/**
 * App start: sweep every recorded session of this wallet that isn't active. Records of other accounts are
 * left alone (their key derives from their own wallet).
 */
export async function recoverSessions(
  wallet: Wallet,
  opts: { findCoins?: FindCoins; active?: ReadonlySet<string>; now?: number; store?: KV | null } = {},
): Promise<{ swept: number; sats: number }> {
  const s = opts.store === undefined ? kv() : opts.store;
  const findCoins = opts.findCoins ?? defaultFindCoins;
  const now = opts.now ?? Date.now();
  const me = (await wallet.getPublicKey({ identityKey: true })).publicKey;
  let swept = 0;
  let sats = 0;
  for (const r of listSessions(s)) {
    if (r.identityKey !== me || (opts.active ?? ACTIVE_SESSIONS).has(r.id)) continue;
    try {
      const key = await deriveSessionKey(wallet, r.id);
      const coins = await findCoins(key.toAddress());
      if (!coins.length) {
        if (now - r.createdAt > EMPTY_GRACE_MS) forgetSession(r.id, s);
        continue;
      }
      for (const c of coins) sats += await sweepCoin(wallet, key, c);
      swept++;
      forgetSession(r.id, s);
    } catch (e) {
      console.warn('[bmusic] session sweep failed; will retry next start', r.id, e);
    }
  }
  return { swept, sats };
}
