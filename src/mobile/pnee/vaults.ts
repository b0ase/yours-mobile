/**
 * PNEE vaults in the wallet (owner, 12 Oct 2026): lock, mint, send, top up and close, through the BRC-100 wallet
 * (createAction → our unlocking scripts → signAction), with the contract scripts from ./script.
 *
 *  - Lock: a new vault output owned by a key derived from this wallet's identity ([2,'pnee vault'], a fresh keyID).
 *  - Mint: up to 10x, with a fresh 3-of-5 price round from the signers (bwallet.space /api/pnee?op=price).
 *  - Send: PNEE tokens are amount-conserving: [to them, the rest back to you].
 *  - Close: burn exactly the PNEEs the vault minted and unlock the BSV (the attester co-signs after checking).
 *  - Top up: add BSV.
 *
 * Every chain action goes through `guard` (services/repeatGuard.ts): an identical request inside the repeat window
 * is refused, so a slow broadcast is never paid twice. The caller shows the confirm first (./confirm.ts).
 */
import {
  Beef,
  Transaction,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk';
import { RepeatGuard, repeatRefusal } from '../../services/repeatGuard';
import {
  KIT,
  PNEE,
  burnReceiptScript,
  preimage,
  serializeOutputs,
  sighashDigest,
  tokenScript,
  tokenState,
  tokenUnlock,
  unlockLength,
  vaultScript,
  vaultState,
  vaultUnlock,
  type PriceProof,
  type VaultConfig,
  type VaultState,
} from './script';
import { mintOk } from './math';
import { verifyRound, type PriceRound } from './oracle';

export const PNEE_API = 'https://www.bwallet.space/api/pnee';
export const VAULT_PROTOCOL: WalletProtocol = [2, 'pnee vault'];
export const PNEE_PROTOCOL: WalletProtocol = [2, 'pnee'];
export const VAULT_BASKET = 'pnee vaults';
export const PNEE_BASKET = 'pnee';
export const PNEE_LABEL = 'pnee';
const ONESAT = 'https://api.1sat.app/1sat';
const SEQ_LOCKTIME = 0xfffffffe; // nLockTime enforced (the contract requires it)

// ── the deployment's public keys (bwallet.space) ──

export type PneeConfig = { issuer: string; oracles: string[]; signers: string; kit: { vault: string; token: string } };

export async function fetchConfig(f: typeof fetch = fetch): Promise<PneeConfig> {
  const r = await f(`${PNEE_API}?op=config`);
  if (!r.ok) throw new Error('The PNEE signers are not reachable right now.');
  const c = (await r.json()) as PneeConfig;
  if (c.kit?.vault !== KIT.vault.md5 || c.kit?.token !== KIT.token.md5)
    throw new Error('The PNEE server runs a different contract version. Update bWalletX.');
  if (!/^0[23][0-9a-f]{64}$/.test(c.issuer) || c.oracles?.length !== 5) throw new Error('Bad PNEE signer config.');
  return c;
}

export async function fetchRound(cfg: PneeConfig, f: typeof fetch = fetch): Promise<PriceRound> {
  const r = await f(`${PNEE_API}?op=price`);
  if (!r.ok) throw new Error('No price round from the signers right now. Try again in a minute.');
  return verifyRound((await r.json()) as PriceRound, cfg.oracles.map(BigInt));
}

// ── what the wallet holds ──

type VaultNote = {
  kind: 'pnee-vault';
  protocolID: WalletProtocol;
  keyID: string;
  openTs: string;
  issuer: string;
  oracles: string[];
};
type TokenNote = { kind: 'pnee'; protocolID: WalletProtocol; keyID: string; counterparty: string };

export type Vault = {
  outpoint: string; // txid.vout
  sats: bigint;
  script: string;
  config: VaultConfig;
  state: VaultState;
  note: VaultNote;
};
export type PneeCoin = { outpoint: string; amount: bigint; holder: string; note: TokenNote; script: string };

const parseNote = <T>(s?: string): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};

async function basket(wallet: WalletInterface, name: string) {
  const r = await wallet.listOutputs({
    basket: name,
    include: 'entire transactions',
    includeCustomInstructions: true,
    limit: 1000,
  });
  const beef = r.BEEF ? Beef.fromBinary(Array.from(r.BEEF)) : new Beef();
  return {
    beef,
    outputs: r.outputs
      .filter((o) => o.spendable !== false)
      .map((o) => {
        const [txid, vout] = o.outpoint.split('.');
        const script = beef.findTxid(txid)?.tx?.outputs[Number(vout)]?.lockingScript.toHex() ?? '';
        return { ...o, script };
      }),
  };
}

export async function listVaults(wallet: WalletInterface): Promise<{ vaults: Vault[]; beef: Beef }> {
  const { beef, outputs } = await basket(wallet, VAULT_BASKET);
  const vaults: Vault[] = [];
  for (const o of outputs) {
    const note = parseNote<VaultNote>(o.customInstructions);
    if (note?.kind !== 'pnee-vault' || !o.script) continue;
    const { publicKey } = await wallet.getPublicKey({
      protocolID: note.protocolID,
      keyID: note.keyID,
      counterparty: 'self',
    });
    const config: VaultConfig = {
      owner: publicKey,
      issuer: note.issuer,
      oracles: note.oracles.map(BigInt),
      openTs: BigInt(note.openTs),
    };
    const { genesis: _g, ...state } = vaultState(o.script, config.openTs);
    vaults.push({ outpoint: o.outpoint, sats: BigInt(o.satoshis), script: o.script, config, state, note });
  }
  return { vaults, beef };
}

export async function listCoins(wallet: WalletInterface): Promise<{ coins: PneeCoin[]; beef: Beef }> {
  const { beef, outputs } = await basket(wallet, PNEE_BASKET);
  const coins: PneeCoin[] = [];
  for (const o of outputs) {
    const note = parseNote<TokenNote>(o.customInstructions);
    const t = o.script ? tokenState(o.script) : null;
    if (note?.kind !== 'pnee' || !t) continue;
    coins.push({ outpoint: o.outpoint, amount: t.amount, holder: t.holder, note, script: o.script });
  }
  return { coins, beef };
}

export const pneeBalance = (coins: PneeCoin[]) => coins.reduce((n, c) => n + c.amount, 0n);

// ── signing helpers ──

async function sigFor(
  wallet: WalletInterface,
  tx: Transaction,
  i: number,
  sats: number,
  script: string,
  key: { protocolID: WalletProtocol; keyID: string; counterparty: string },
): Promise<{ sig: number[]; pre: number[] }> {
  const pre = preimage(tx, i, sats, script);
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: sighashDigest(pre),
    protocolID: key.protocolID,
    keyID: key.keyID,
    counterparty: key.counterparty,
  });
  return { sig: Array.from(signature), pre };
}

const fp = async (parts: string[]) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(['pnee', ...parts].join('|')));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
};

/** Never twice: refuses an identical PNEE action still inside the repeat window. */
const guard = new RepeatGuard();
export const pneeGuard = guard;

async function guarded<T extends { txid?: string }>(g: RepeatGuard, key: string[], run: () => Promise<T>): Promise<T> {
  const f = await fp(key);
  const earlier = g.check(f);
  if (earlier) throw new Error(repeatRefusal(earlier));
  g.record(f, {});
  try {
    const r = await run();
    g.record(f, { txid: r.txid });
    return r;
  } catch (e) {
    // a failed attempt (refused, cancelled, not sent) may be tried again
    g.record(f, { aborted: true });
    throw e;
  }
}

type Signable = NonNullable<Awaited<ReturnType<WalletInterface['createAction']>>['signableTransaction']>;

async function signAndSend(
  wallet: WalletInterface,
  signable: Signable,
  build: (tx: Transaction) => Promise<Record<number, { unlockingScript: string }>>,
): Promise<{ txid: string; tx: Transaction }> {
  const tx = Transaction.fromAtomicBEEF(signable.tx);
  let sent = false;
  try {
    const spends = await build(tx);
    const done = await wallet.signAction({ reference: signable.reference, spends });
    sent = true;
    for (const [i, s] of Object.entries(spends))
      tx.inputs[Number(i)].unlockingScript = UnlockingScript.fromHex(s.unlockingScript);
    return { txid: done.txid ?? tx.id('hex'), tx };
  } finally {
    if (!sent) await wallet.abortAction({ reference: signable.reference }).catch(() => undefined);
  }
}

/** Tell bwallet.space what the tx did (it reads the tx from the chain). Best effort; retried a few times. */
export async function submitTx(txid: string, extra: Record<string, unknown> = {}, f: typeof fetch = fetch) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await f(`${PNEE_API}?op=submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txid, ...extra }),
      });
      if (r.status !== 202) return r.ok;
    } catch {
      /* try again */
    }
    await new Promise((res) => setTimeout(res, 4000 * (i + 1)));
  }
  return false;
}

const randomKeyID = () => Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(12))));

const vaultInputArgs = (v: Vault, desc: string) => ({
  outpoint: v.outpoint,
  unlockingScriptLength: unlockLength(v.script.length / 2),
  inputDescription: desc,
  sequenceNumber: SEQ_LOCKTIME,
});

const vaultOutput = (cfg: VaultConfig, state: VaultState | undefined, sats: bigint, note: VaultNote, what: string) => ({
  lockingScript: vaultScript(cfg, state),
  satoshis: Number(sats),
  outputDescription: what.slice(0, 120),
  basket: VAULT_BASKET,
  customInstructions: JSON.stringify(note),
  tags: ['pnee-vault'],
});

// ── actions ──

/** Lock `sats` in a new vault owned by this wallet. Returns the txid. */
export async function lockVault(
  wallet: WalletInterface,
  cfg: PneeConfig,
  round: PriceRound,
  sats: bigint,
  identityKey: string,
  g: RepeatGuard = guard,
): Promise<{ txid: string; outpoint: string }> {
  if (sats < 10_000n) throw new Error('Lock at least 10,000 sats.');
  return guarded(g, ['lock', identityKey, sats.toString()], async () => {
    const keyID = randomKeyID();
    const { publicKey } = await wallet.getPublicKey({ protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self' });
    // openTs a little before the round, so the first mint can use this round
    const openTs = BigInt(round.ts) - PNEE.maxPriceAge;
    const config: VaultConfig = { owner: publicKey, issuer: cfg.issuer, oracles: cfg.oracles.map(BigInt), openTs };
    const note: VaultNote = {
      kind: 'pnee-vault',
      protocolID: VAULT_PROTOCOL,
      keyID,
      openTs: openTs.toString(),
      issuer: cfg.issuer,
      oracles: cfg.oracles,
    };
    const r = await wallet.createAction({
      description: `Lock ${sats} sats in a PNEE vault`,
      outputs: [vaultOutput(config, undefined, sats, note, `PNEE vault: ${sats} sats`)],
      labels: [PNEE_LABEL, 'pnee-lock'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    } as CreateActionArgs);
    if (!r.txid) throw new Error('The wallet did not return a transaction id.');
    void submitTx(r.txid);
    return { txid: r.txid, outpoint: `${r.txid}.0` };
  });
}

/** Add `addSats` to a vault. */
export async function topUpVault(
  wallet: WalletInterface,
  v: Vault,
  beef: Beef,
  addSats: bigint,
  g: RepeatGuard = guard,
) {
  if (addSats <= 0n) throw new Error('Add some BSV.');
  return guarded(g, ['topup', v.outpoint, addSats.toString()], async () => {
    const created = await wallet.createAction({
      description: `Add ${addSats} sats to a PNEE vault`,
      inputBEEF: beef.toBinary(),
      inputs: [vaultInputArgs(v, 'PNEE vault')],
      outputs: [vaultOutput(v.config, v.state, v.sats + addSats, v.note, `PNEE vault: ${v.sats + addSats} sats`)],
      labels: [PNEE_LABEL, 'pnee-topup'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
    } as CreateActionArgs);
    if (!created.signableTransaction) throw new Error('The wallet did not return a transaction to sign.');
    const done = await signAndSend(wallet, created.signableTransaction, async (tx) => {
      const { sig, pre } = await sigFor(wallet, tx, 0, Number(v.sats), v.script, { ...v.note, counterparty: 'self' });
      const rest = serializeOutputs(tx.outputs.slice(1));
      return { 0: { unlockingScript: vaultUnlock.topUp(sig, addSats, rest, pre).toHex() } };
    });
    void submitTx(done.txid);
    return done;
  });
}

const proofFrom = (round: PriceRound): PriceProof => {
  const q = round.quorum;
  return {
    ts: BigInt(round.ts),
    prices: q.map((s) => BigInt(s.priceCents)) as PriceProof['prices'],
    idx: q.map((s) => BigInt(s.signer)) as PriceProof['idx'],
    sigs: q.map((s) => BigInt(s.s)) as PriceProof['sigs'],
    paddings: q.map((s) => s.padding) as PriceProof['paddings'],
  };
};

/** Mint `amount` PNEEs (cents) against a vault, at the round's median price. */
export async function mintPnee(
  wallet: WalletInterface,
  v: Vault,
  beef: Beef,
  round: PriceRound,
  amount: bigint,
  g: RepeatGuard = guard,
) {
  if (BigInt(round.ts) <= v.state.lastTs)
    throw new Error('Wait for the next block: this vault already used this price round.');
  if (!mintOk(v.sats, BigInt(round.median), v.state.debt, amount))
    throw new Error('That is more than this vault can back at 10x.');
  return guarded(g, ['mint', v.outpoint, amount.toString()], async () => {
    const ts = BigInt(round.ts);
    const next: VaultState = {
      debt: v.state.debt + amount,
      lastTs: ts,
      feeCents: v.state.feeCents,
      feeTs: ts > v.state.feeTs ? ts : v.state.feeTs,
    };
    const tokenNote: TokenNote = {
      kind: 'pnee',
      protocolID: v.note.protocolID,
      keyID: v.note.keyID,
      counterparty: 'self',
    };
    const created = await wallet.createAction({
      description: `Mint ${amount} PNEEs ($${(Number(amount) / 100).toFixed(2)}) against a PNEE vault`,
      inputBEEF: beef.toBinary(),
      inputs: [vaultInputArgs(v, 'PNEE vault')],
      outputs: [
        vaultOutput(v.config, next, v.sats, v.note, `PNEE vault: ${next.debt} PNEEs minted`),
        {
          lockingScript: tokenScript(v.config.owner, amount),
          satoshis: 1,
          outputDescription: `${amount} PNEEs`,
          basket: PNEE_BASKET,
          customInstructions: JSON.stringify(tokenNote),
          tags: ['pnee'],
        },
      ],
      lockTime: Number(ts),
      labels: [PNEE_LABEL, 'pnee-mint'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
    } as CreateActionArgs);
    if (!created.signableTransaction) throw new Error('The wallet did not return a transaction to sign.');
    const done = await signAndSend(wallet, created.signableTransaction, async (tx) => {
      if (tx.lockTime !== Number(ts)) throw new Error('The wallet changed the lock time.');
      const { sig, pre } = await sigFor(wallet, tx, 0, Number(v.sats), v.script, { ...v.note, counterparty: 'self' });
      const rest = serializeOutputs(tx.outputs.slice(2));
      return { 0: { unlockingScript: vaultUnlock.mint(sig, amount, proofFrom(round), rest, pre).toHex() } };
    });
    void submitTx(done.txid);
    return done;
  });
}

/** Coins that add up to exactly `amount`, or null (small sets: exact subset search, largest first). */
export function exactCoins(coins: PneeCoin[], amount: bigint): PneeCoin[] | null {
  const sorted = [...coins].sort((a, b) => (a.amount > b.amount ? -1 : 1)).slice(0, 20);
  const pick: PneeCoin[] = [];
  const go = (i: number, left: bigint): boolean => {
    if (left === 0n) return true;
    if (i >= sorted.length || left < 0n) return false;
    pick.push(sorted[i]);
    if (go(i + 1, left - sorted[i].amount)) return true;
    pick.pop();
    return go(i + 1, left);
  };
  return go(0, amount) ? [...pick] : null;
}

/**
 * Send `amount` PNEEs from one coin. `to` = recipient holder pubkey; `toNote` describes the output for the
 * caller (another identity: their derived key; yourself: your own key, used to make an exact amount).
 */
async function sendFromCoin(
  wallet: WalletInterface,
  coin: PneeCoin,
  beef: Beef,
  to: string,
  amount: bigint,
  toNote: TokenNote | null,
  label: string,
) {
  if (amount <= 0n || amount > coin.amount) throw new Error('Bad amount.');
  const keep = coin.amount - amount;
  const outputs: CreateActionArgs['outputs'] = [
    {
      lockingScript: tokenScript(to, amount),
      satoshis: 1,
      outputDescription: `${amount} PNEEs`,
      ...(toNote ? { basket: PNEE_BASKET, customInstructions: JSON.stringify(toNote), tags: ['pnee'] } : {}),
    },
  ];
  if (keep > 0n)
    outputs.push({
      lockingScript: tokenScript(coin.holder, keep),
      satoshis: 1,
      outputDescription: `${keep} PNEEs back to you`,
      basket: PNEE_BASKET,
      customInstructions: JSON.stringify(coin.note),
      tags: ['pnee'],
    });
  const created = await wallet.createAction({
    description: label,
    inputBEEF: beef.toBinary(),
    inputs: [
      {
        outpoint: coin.outpoint,
        unlockingScriptLength: unlockLength(coin.script.length / 2),
        inputDescription: `${coin.amount} PNEEs`,
      },
    ],
    outputs,
    labels: [PNEE_LABEL, 'pnee-send'],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
  } as CreateActionArgs);
  if (!created.signableTransaction) throw new Error('The wallet did not return a transaction to sign.');
  return signAndSend(wallet, created.signableTransaction, async (tx) => {
    const { sig, pre } = await sigFor(wallet, tx, 0, 1, coin.script, coin.note);
    const rest = serializeOutputs(tx.outputs.slice(keep > 0n ? 2 : 1));
    return { 0: { unlockingScript: tokenUnlock.transfer(sig, to, amount, rest, pre).toHex() } };
  });
}

/** Send PNEEs to another bWalletX identity key (they accept it from their PNEEs inbox). */
export async function sendPnee(
  wallet: WalletInterface,
  coins: PneeCoin[],
  beef: Beef,
  recipientIdentity: string,
  myIdentity: string,
  amount: bigint,
  g: RepeatGuard = guard,
) {
  if (!/^0[23][0-9a-f]{64}$/.test(recipientIdentity)) throw new Error('Send to a bWalletX identity key.');
  const coin = [...coins].sort((a, b) => (a.amount < b.amount ? -1 : 1)).find((c) => c.amount >= amount);
  if (!coin)
    throw new Error(`Send at most ${coins.reduce((m, c) => (c.amount > m ? c.amount : m), 0n)} PNEEs at once.`);
  return guarded(g, ['send', recipientIdentity, amount.toString(), coin.outpoint], async () => {
    const keyID = randomKeyID();
    const { publicKey: to } = await wallet.getPublicKey({
      protocolID: PNEE_PROTOCOL,
      keyID,
      counterparty: recipientIdentity,
    });
    const done = await sendFromCoin(wallet, coin, beef, to, amount, null, `Send ${amount} PNEEs`);
    void submitTx(done.txid, { send: { to: recipientIdentity, from: myIdentity, keyID, vout: 0 } });
    return done;
  });
}

/** Accept PNEEs sent to this identity (bwallet.space inbox → internalizeAction). Returns how many were added. */
export async function acceptInbox(
  wallet: WalletInterface,
  myIdentity: string,
  have: Set<string>,
  f: typeof fetch = fetch,
) {
  const r = await f(`${PNEE_API}?op=inbox&to=${myIdentity}`);
  if (!r.ok) return 0;
  const { sends } = (await r.json()) as {
    sends: { txid: string; vout: number; sender: string; key_id: string; amount: number }[];
  };
  let added = 0;
  for (const s of sends) {
    if (have.has(`${s.txid}.${s.vout}`) || !s.sender) continue;
    const b = await f(`${ONESAT}/beef/${s.txid}`);
    if (!b.ok) continue;
    const tx = Array.from(new Uint8Array(await b.arrayBuffer()));
    // the output must be held by the key we derive for this sender + keyID
    const { publicKey } = await wallet.getPublicKey({
      protocolID: PNEE_PROTOCOL,
      keyID: s.key_id,
      counterparty: s.sender,
      forSelf: true,
    });
    const out = Transaction.fromBEEF(tx, s.txid).outputs[s.vout];
    const t = out && tokenState(out.lockingScript.toHex());
    if (!t || t.holder !== publicKey) continue;
    const note: TokenNote = { kind: 'pnee', protocolID: PNEE_PROTOCOL, keyID: s.key_id, counterparty: s.sender };
    try {
      await wallet.internalizeAction({
        tx,
        description: `Received ${t.amount} PNEEs`,
        labels: [PNEE_LABEL, 'pnee-receive'],
        outputs: [
          {
            outputIndex: s.vout,
            protocol: 'basket insertion',
            insertionRemittance: { basket: PNEE_BASKET, customInstructions: JSON.stringify(note), tags: ['pnee'] },
          },
        ],
      });
      added++;
    } catch {
      /* already in the wallet, or not yet provable: next time */
    }
  }
  return added;
}

/** What a close needs: the coins to burn, and a split first when no coins add up to exactly the vault's PNEEs. */
export function closePlan(v: Vault, coins: PneeCoin[]): { burn: PneeCoin[] } | { split: PneeCoin } | { short: bigint } {
  const debt = v.state.debt;
  if (debt === 0n) return { burn: [] };
  const exact = exactCoins(coins, debt);
  if (exact) return { burn: exact };
  const big = coins.find((c) => c.amount > debt);
  if (big) return { split: big };
  const have = coins.reduce((n, c) => n + c.amount, 0n);
  return { short: debt - have };
}

/** Make a coin of exactly `amount` PNEEs (a send to yourself). */
export async function splitCoin(wallet: WalletInterface, coin: PneeCoin, beef: Beef, amount: bigint) {
  const done = await sendFromCoin(
    wallet,
    coin,
    beef,
    coin.holder,
    amount,
    coin.note,
    `Make a coin of exactly ${amount} PNEEs`,
  );
  void submitTx(done.txid);
  return done;
}

/**
 * Close a vault: burn exactly its PNEEs (the `burn` coins add up to its debt) and unlock the BSV into this wallet.
 * The attester co-signs only after checking the burn (site/api/pnee.js op=attest).
 */
export async function closeVault(
  wallet: WalletInterface,
  v: Vault,
  burn: PneeCoin[],
  beef: Beef,
  g: RepeatGuard = guard,
  f: typeof fetch = fetch,
) {
  const total = burn.reduce((n, c) => n + c.amount, 0n);
  if (total !== v.state.debt) throw new Error(`A close burns exactly the ${v.state.debt} PNEEs this vault minted.`);
  return guarded(g, ['close', v.outpoint], async () => {
    const [txid, vout] = v.outpoint.split('.');
    const created = await wallet.createAction({
      description: `Close a PNEE vault: burn ${total} PNEEs, unlock ${v.sats} sats`,
      inputBEEF: beef.toBinary(),
      inputs: [
        vaultInputArgs(v, 'PNEE vault'),
        ...burn.map((c) => ({
          outpoint: c.outpoint,
          unlockingScriptLength: unlockLength(c.script.length / 2),
          inputDescription: `Burn ${c.amount} PNEEs`,
        })),
      ],
      outputs: [
        {
          lockingScript: burnReceiptScript(txid, Number(vout), total),
          satoshis: 0,
          outputDescription: `Burn receipt: ${total} PNEEs`,
        },
      ],
      lockTime: 0,
      labels: [PNEE_LABEL, 'pnee-close'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
    } as CreateActionArgs);
    if (!created.signableTransaction) throw new Error('The wallet did not return a transaction to sign.');
    const signable = created.signableTransaction;
    const done = await signAndSend(wallet, signable, async (tx) => {
      const a = await f(`${PNEE_API}?op=attest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ beef: Utils.toHex(Array.from(signable.tx)), vaultIndex: 0 }),
      });
      const att = (await a.json().catch(() => ({}))) as { signature?: string; error?: string };
      if (!a.ok || !att.signature) throw new Error(att.error || 'The burn attester did not sign.');
      const owner = await sigFor(wallet, tx, 0, Number(v.sats), v.script, { ...v.note, counterparty: 'self' });
      const rest = serializeOutputs(tx.outputs.slice(1));
      const spends: Record<number, { unlockingScript: string }> = {
        0: {
          unlockingScript: vaultUnlock
            .close(owner.sig, Utils.toArray(att.signature, 'hex'), total, rest, owner.pre)
            .toHex(),
        },
      };
      for (let k = 0; k < burn.length; k++) {
        const c = burn[k];
        const s = await sigFor(wallet, tx, k + 1, 1, c.script, c.note);
        spends[k + 1] = { unlockingScript: tokenUnlock.burn(s.sig, s.pre).toHex() };
      }
      return spends;
    });
    void submitTx(done.txid);
    return done;
  });
}
