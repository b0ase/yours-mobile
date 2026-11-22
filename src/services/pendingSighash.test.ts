/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles return loosely typed wallet results */
/**
 * A site may get a signature over the sighash of an input it must unlock in its OWN pending action, asked with that
 * input's key, and over nothing else it can't show the wallet (pendingSighash.ts; owner, 15 Nov 2026).
 *
 * The harness: the real LocalWalletPermissionsManager (with the store builds' guardEverySpendAsks), the real
 * guardCrossSiteSigning and guardReservedProtocols in the order initWallet.ts stacks them, over a small base wallet
 * that builds real @bsv/sdk transactions with a real key deriver. The page side is the callers' own code: Bitcoin
 * Writer's signChainInput (lib/writer/wallet-tx.ts) copied below, and tokenSpends, which is TokenBlaster's
 * (src/lib/tokenLoad.ts) line for line.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import {
  Beef,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  PushDrop,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk';
import { ONESAT, bsv21, tokenSpends } from '../mobile/market/launchpad/tokens';
import {
  BLIND_SIGN_REFUSAL,
  COIN_SPEND_DENIED,
  COIN_SPEND_UNASKABLE,
  DATA_HASH_REFUSAL,
  SCOPE_SIGHASH_REFUSAL,
  SCRIPT_SIGHASH_REFUSAL,
  UNGRANTED_SIGHASH_REFUSAL,
  UNPAID_SIGHASH_REFUSAL,
  bareHost,
  guardCrossSiteSigning,
  setProvenPairingCheck,
} from './crossSiteSignGuard';
import { guardEverySpendAsks } from './everySpendAsks';
import {
  MAX_PENDING_ACTIONS,
  MAX_PENDING_PER_SITE,
  PENDING_SIGHASH_TTL_MS,
  PendingSighashes,
  type SigningKeyChecks,
  callerSighashes,
  lockKeyHash,
} from './pendingSighash';
import { PINNED_REFUSAL } from './pinnedProtocols';
import {
  LEVEL0_SIGN_REFUSAL,
  P_MODULE_PROTOCOL_REFUSAL,
  RAW_HASH_REFUSAL,
  RESERVED_REFUSAL,
  guardReservedProtocols,
} from './reservedProtocols';

const ADMIN = 'admin.bwalletx';
const WRITER = 'www.bitcoin-writer.example';
const BLASTER = 'www.tokenblaster.lol';
const EVIL = 'evil.example';
const CHAIN_PROTOCOL: WalletProtocol = [2, 'bitcoin writer chain'];
const AMMO_PROTOCOL: WalletProtocol = [1, 'tokenblaster ammo'];
const TOKEN = `${'ab'.repeat(32)}_0`;
const FUNDING = 100_000;
const FEE = 12;
const ALL_FORKID = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;

type Call = (args: any, originator?: string) => Promise<any>;
type Wallet = Record<string, Call>;
type Sheet = { type: string; originator: string; satoshis?: number };
/** A pay sheet as the user reads it: the amount, the reason line and the line items. */
type PaySheet = {
  originator: string;
  satoshis: number;
  reason?: string;
  lineItems?: { type: string; satoshis: number; description: string }[];
};

const atomic = (tx: Transaction) => {
  const beef = new Beef();
  for (const input of tx.inputs) beef.mergeRawTx(input.sourceTransaction!.toBinary());
  beef.mergeRawTx(tx.toBinary());
  return beef.toBinaryAtomic(tx.id('hex'));
};

/** Does input `index` unlock its source output in `tx`? The interpreter's own answer. */
const unlocks = (tx: Transaction, index: number) => {
  const input = tx.inputs[index];
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex];
  try {
    return new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== index),
      outputs: tx.outputs,
      inputIndex: index,
      unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
  } catch {
    return false;
  }
};

/**
 * One wallet: a base that funds every action with one input of its own (the last one) and signs it at signAction, the
 * real permissions manager on top, then the guards. `restart()` is a new service worker over the same keys: new
 * manager, new guards, nothing remembered.
 */
const setup = (
  opts: { approve?: boolean; now?: () => number; signFails?: boolean; denyPay?: (sheet: PaySheet) => boolean } = {},
) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const fundKey = PrivateKey.fromRandom();
  const sheets: Sheet[] = [];
  const paySheets: PaySheet[] = [];
  const sent: Transaction[] = [];
  // Grants outlive a service worker (IndexedDB in the wallet): one store for every build().
  const store = new InMemoryPermissionStore();
  const build = () => {
    const live = new Map<string, Transaction>();
    let refs = 0;
    const base = {
      getPublicKey: (a: never) => proto.getPublicKey(a),
      createSignature: (a: never) => proto.createSignature(a),
      verifySignature: (a: never) => proto.verifySignature(a),
      createHmac: (a: never) => proto.createHmac(a),
      verifyHmac: (a: never) => proto.verifyHmac(a),
      encrypt: (a: never) => proto.encrypt(a),
      decrypt: (a: never) => proto.decrypt(a),
      listActions: async () => ({ actions: [], totalActions: 0 }),
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
      async createAction(a: {
        inputBEEF?: number[];
        inputs?: { outpoint: string; unlockingScript?: string; sequenceNumber?: number }[];
        outputs?: { lockingScript: string; satoshis: number }[];
        version?: number;
        lockTime?: number;
      }) {
        const beef = a.inputBEEF ? Beef.fromBinary(a.inputBEEF) : new Beef();
        const tx = new Transaction(a.version ?? 1, [], [], a.lockTime ?? 0);
        let fromSite = 0;
        for (const i of a.inputs ?? []) {
          const [txid, vout] = i.outpoint.split('.');
          const source = beef.findTxid(txid)!.tx!;
          fromSite += source.outputs[Number(vout)].satoshis!;
          tx.addInput({
            sourceTransaction: source,
            sourceTXID: txid,
            sourceOutputIndex: Number(vout),
            unlockingScript: i.unlockingScript ? UnlockingScript.fromHex(i.unlockingScript) : new UnlockingScript(),
            sequence: i.sequenceNumber ?? 0xffffffff,
          });
        }
        const funding = new Transaction();
        funding.addOutput({ lockingScript: new P2PKH().lock(fundKey.toAddress()), satoshis: FUNDING + refs });
        tx.addInput({
          sourceTransaction: funding,
          sourceTXID: funding.id('hex'),
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff,
        });
        let out = 0;
        for (const o of a.outputs ?? []) {
          out += o.satoshis;
          tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
        }
        tx.addOutput({
          lockingScript: new P2PKH().lock(fundKey.toAddress()),
          satoshis: FUNDING + refs + fromSite - out - FEE,
        });
        const reference = `ref-${++refs}-${Math.random().toString(36).slice(2)}`;
        live.set(reference, tx);
        return { signableTransaction: { reference, tx: atomic(tx) } };
      },
      async signAction(a: { reference: string; spends?: Record<number, { unlockingScript: string }> }) {
        const tx = live.get(a.reference);
        if (!tx) throw new Error('recovery of out-of-session signAction reference data is not yet implemented.');
        if (opts.signFails) throw new Error('broadcast failed');
        for (const [i, s] of Object.entries(a.spends ?? {}))
          tx.inputs[Number(i)].unlockingScript = UnlockingScript.fromHex(s.unlockingScript);
        const last = tx.inputs.length - 1;
        tx.inputs[last].unlockingScriptTemplate = new P2PKH().unlock(fundKey);
        await tx.sign();
        for (let i = 0; i < tx.inputs.length; i++)
          if (!unlocks(tx, i)) throw new Error(`input ${i} does not unlock its coin`);
        live.delete(a.reference);
        sent.push(tx);
        return { txid: tx.id('hex'), tx: atomic(tx) };
      },
      async abortAction(a: { reference: string }) {
        return { aborted: live.delete(a.reference) };
      },
    };
    const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, {}, { store } as never);
    (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
      type: string;
      originator: string;
      spending?: { satoshis: number; lineItems?: PaySheet['lineItems'] };
      reason?: string;
      protocolID?: [number, string];
      counterparty?: string;
      privileged?: boolean;
    }) => {
      sheets.push({ type: r.type, originator: r.originator, satoshis: r.spending?.satoshis });
      if (opts.approve === false) throw new Error('User denied');
      if (r.type === 'spending' && r.spending) {
        const sheet = {
          originator: r.originator,
          satoshis: r.spending.satoshis,
          reason: r.reason,
          lineItems: r.spending.lineItems,
        };
        paySheets.push(sheet);
        if (opts.denyPay?.(sheet)) throw new Error('User denied');
      }
      // Allow on a protocol sheet stores the grant, as the wallet's own sheet does (grantPermission).
      if (r.type === 'protocol' && r.protocolID)
        await store.putGrant({
          key: {
            type: 'protocol',
            originator: normalizeOriginator(r.originator),
            privileged: !!r.privileged,
            protocolLevel: r.protocolID[0],
            protocolName: r.protocolID[1],
            counterparty: r.protocolID[0] === 1 ? '' : (r.counterparty ?? 'self'),
          },
          expiry: 0,
          grantedAt: Date.now(),
        } as never);
      return true;
    };
    guardEverySpendAsks(mgr, { adminOriginator: ADMIN, normalize: normalizeOriginator });
    // initWallet.ts: guardReservedProtocols(guardCrossSiteSigning(…manager…)).
    return guardReservedProtocols(guardCrossSiteSigning(mgr, ADMIN, opts.now), ADMIN) as unknown as Wallet;
  };
  let live = build();
  /** The wallet as one site's page sees it. */
  const as = (originator: string) =>
    new Proxy({} as WalletInterface, {
      get: (_, method: string) => (a: unknown) => live[method](a, originator),
    });
  /** The public key of an app key, straight from the deriver (what a site's getPublicKey answers). */
  const keyOf = async (protocolID: WalletProtocol, keyID: string, counterparty = 'self') =>
    (await proto.getPublicKey({ protocolID, keyID, counterparty, forSelf: true })).publicKey;
  return {
    get wallet() {
      return live;
    },
    restart: () => void (live = build()),
    proto,
    sheets,
    paySheets,
    sent,
    as,
    keyOf,
    /**
     * A site asks for one of its keys, as a page does before it locks a coin to it (Bitcoin Writer's chainPublicKey,
     * TokenBlaster's freshAddress): the protocol sheet shows, and Allow leaves the site holding the grant.
     */
    siteKey: async (site: string, protocolID: WalletProtocol, keyID: string, counterparty = 'self') =>
      (await live.getPublicKey({ protocolID, keyID, counterparty, forSelf: true }, site)).publicKey as string,
  };
};

/** A confirmed-looking coin locked to `script`, and the BEEF a site would send with it. */
const coin = (script: LockingScript, satoshis = 1) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: script, satoshis });
  const beef = new Beef();
  beef.mergeRawTx(tx.toBinary());
  return { tx, outpoint: `${tx.id('hex')}.0`, beef };
};
const p2pkh = (publicKey: string) => new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
const beefOf = (...coins: { beef: Beef }[]) => {
  const beef = new Beef();
  for (const c of coins) beef.mergeBeef(c.beef);
  return beef.toBinary();
};
const payTo = (satoshis: number) => ({
  lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
  satoshis,
  outputDescription: 'a payment',
});

/** The sighash of input `index`, as a page computes it (TransactionSignature.format + sha256d). */
const sighash = (tx: Transaction, index: number, scope = ALL_FORKID) => {
  const input = tx.inputs[index];
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex];
  return Hash.hash256(
    TransactionSignature.format({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== index),
      inputIndex: index,
      outputs: tx.outputs,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript: source.lockingScript,
      lockTime: tx.lockTime,
      scope,
    }),
  );
};

// ── Bitcoin Writer (lib/writer/wallet-tx.ts), the page's own code ───────────────────────────────────────────────────
const chainKeyID = (keyId: string) => `${keyId}/chain`;
async function signChainInput(wallet: WalletInterface, signableTx: number[], keyId: string, prevOutpoint: string) {
  const tx = Transaction.fromAtomicBEEF(signableTx);
  const [txid, vout] = prevOutpoint.split('.');
  const index = tx.inputs.findIndex(
    (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === Number(vout),
  );
  const input = tx.inputs[index];
  const source = input.sourceTransaction!.outputs[Number(vout)];
  const preimage = TransactionSignature.format({
    sourceTXID: txid,
    sourceOutputIndex: Number(vout),
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== index),
    inputIndex: index,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: ALL_FORKID,
  });
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(preimage),
    protocolID: CHAIN_PROTOCOL,
    keyID: chainKeyID(keyId),
    counterparty: 'self',
  });
  const { publicKey } = await wallet.getPublicKey({
    protocolID: CHAIN_PROTOCOL,
    keyID: chainKeyID(keyId),
    counterparty: 'self',
    forSelf: true,
  });
  const der = Signature.fromDER(Array.from(signature));
  const sig = new TransactionSignature(der.r, der.s, ALL_FORKID).toChecksigFormat();
  const pub = Utils.toArray(publicKey, 'hex');
  return {
    index,
    unlockingScript: new UnlockingScript([
      { op: sig.length, data: sig },
      { op: pub.length, data: pub },
    ]).toHex(),
  };
}

/** A Bitcoin Writer save: spend the previous chain coin, write the next one, pay the service. */
const writerSave = async (w: ReturnType<typeof setup>, site = WRITER, keyId = 'doc-1') => {
  const chainKey = await w.siteKey(site, CHAIN_PROTOCOL, chainKeyID(keyId));
  const prev = coin(p2pkh(chainKey));
  const created = await w.as(site).createAction({
    description: 'Save your document on chain',
    labels: ['bitcoin writer'],
    inputBEEF: beefOf(prev),
    inputs: [{ outpoint: prev.outpoint, unlockingScriptLength: 108, inputDescription: 'Previous save (chain UTXO)' }],
    outputs: [
      { lockingScript: p2pkh(chainKey).toHex(), satoshis: 1, outputDescription: 'This save (chain UTXO)' },
      payTo(500),
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const signable = created.signableTransaction!;
  return { prev, chainKey, signable, tx: Transaction.fromAtomicBEEF(signable.tx), keyId };
};

/** A token coin under a site's own key: BSV-21 inscription + P2PKH, the script TokenBlaster's coins have. */
const tokenCoin = async (w: ReturnType<typeof setup>, keyID: string, protocolID = AMMO_PROTOCOL, site = BLASTER) => {
  // The site asks for the key first (refused for a reserved protocol; the coin is locked to that key all the same).
  await w.siteKey(site, protocolID, keyID).catch(() => undefined);
  const publicKey = await w.keyOf(protocolID, keyID);
  return {
    ...coin(bsv21(TOKEN, 500n, PublicKey.fromString(publicKey).toAddress())),
    protocolID,
    keyID,
    publicKey,
  };
};
/** TokenBlaster's loadTokens (src/lib/tokenLoad.ts): token coins in, tokens to the gun, signAndProcess: false. */
const blasterLoad = async (
  w: ReturnType<typeof setup>,
  coins: Awaited<ReturnType<typeof tokenCoin>>[],
  site = BLASTER,
) => {
  const created = await w.as(site).createAction({
    description: 'Load 1,000 $AMMO into your gun',
    inputBEEF: beefOf(...coins),
    inputs: coins.map((c) => ({ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: '$AMMO' })),
    outputs: [
      {
        lockingScript: bsv21(TOKEN, 500n * BigInt(coins.length), PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 1,
        outputDescription: '1,000 $AMMO into your gun',
      },
    ],
    labels: ['tokenblaster'],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
  });
  const signable = created.signableTransaction!;
  return { signable, tx: Transaction.fromAtomicBEEF(signable.tx) };
};

const blindSign = (w: ReturnType<typeof setup>, site: string, hash: unknown, key: Record<string, unknown>) =>
  w.wallet.createSignature({ hashToDirectlySign: hash, counterparty: 'self', ...key }, site);
const chainKeyArgs = (keyId = 'doc-1') => ({ protocolID: CHAIN_PROTOCOL, keyID: chainKeyID(keyId) });

describe('the callers, end to end', () => {
  test('Bitcoin Writer save: createAction → createSignature(sighash) → signAction', async () => {
    const w = setup();
    const { prev, signable, keyId } = await writerSave(w);
    // The pay sheet came before the page had anything to sign.
    expect(w.sheets.filter((s) => s.type === 'spending')).toEqual([
      { type: 'spending', originator: WRITER, satoshis: 500 + FEE },
    ]);
    const { index, unlockingScript } = await signChainInput(w.as(WRITER), signable.tx, keyId, prev.outpoint);
    const signed = await w.as(WRITER).signAction({
      reference: signable.reference,
      spends: { [index]: { unlockingScript } },
      options: { acceptDelayedBroadcast: false },
    });
    expect(signed.txid).toBe(w.sent[0].id('hex'));
    expect(unlocks(w.sent[0], index)).toBe(true);
    // The key still met the protocol sheet: the hash being readable skips no permission.
    expect(w.sheets.some((s) => s.type === 'protocol' && s.originator === WRITER)).toBe(true);
  });

  test("TokenBlaster's signing loop (tokenSpends) over two token coins under a site key", async () => {
    const w = setup();
    const coins = [await tokenCoin(w, 'ammo-1'), await tokenCoin(w, 'ammo-2')];
    const { signable, tx } = await blasterLoad(w, coins);
    const spends = await tokenSpends(
      w.as(BLASTER),
      tx,
      coins.map((c, index) => ({ index, protocolID: c.protocolID, keyID: c.keyID })),
    );
    const done = await w.as(BLASTER).signAction({ reference: signable.reference, spends });
    expect(done.txid).toBe(w.sent[0].id('hex'));
    expect(unlocks(w.sent[0], 0) && unlocks(w.sent[0], 1)).toBe(true);
  });

  test('NOT covered: TokenBlaster as written signs with [0,"onesat"], which stays reserved at every step', async () => {
    const w = setup();
    // tokenLoad.ts:83 / ammoChain.ts:26 (freshAddress), before any createAction.
    await expect(
      w.wallet.getPublicKey({ protocolID: ONESAT, keyID: `${TOKEN}-1`, counterparty: 'self' }, BLASTER),
    ).rejects.toThrow(RESERVED_REFUSAL);
    // tokenLoad.ts:151 / ammoChain.ts:179,227: even a real pending sighash of an input locked to that very key.
    const coins = [await tokenCoin(w, `${TOKEN}-1`, ONESAT)];
    const { tx } = await blasterLoad(w, coins);
    const asked = w.sheets.length;
    await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID: ONESAT, keyID: `${TOKEN}-1` })).rejects.toThrow(
      RESERVED_REFUSAL,
    );
    expect(w.sheets.length).toBe(asked);
  });
});

describe('only the sighash of the site’s own pending action', () => {
  test('a made-up preimage, or any other hash, is refused as before', async () => {
    const w = setup();
    await writerSave(w);
    await expect(blindSign(w, WRITER, Hash.hash256([1, 2, 3]), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(blindSign(w, WRITER, new Array(32).fill(0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    // With no pending action at all.
    const fresh = setup();
    await expect(blindSign(fresh, WRITER, Hash.hash256([1]), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('another site cannot get a signature for this site’s action', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    // Not even with a pending action of its own, spending a coin under the same key.
    await writerSave(w, EVIL);
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    // A subdomain or a parent is another originator.
    await expect(blindSign(w, `app.${WRITER}`, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(blindSign(w, 'bitcoin-writer.example', sighash(tx, 0), chainKeyArgs())).rejects.toThrow(
      BLIND_SIGN_REFUSAL,
    );
    // The owner still can.
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
  });

  test('another site cannot sign or abort the action away from its owner', async () => {
    const w = setup();
    const { tx, signable } = await writerSave(w);
    await expect(w.wallet.signAction({ reference: signable.reference, spends: {} }, EVIL)).rejects.toThrow(
      /different originator/,
    );
    await expect(w.wallet.abortAction({ reference: signable.reference }, EVIL)).rejects.toThrow(/different originator/);
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
  });

  test('once signed, the same request is refused (replay)', async () => {
    const w = setup();
    const { prev, signable, tx, keyId } = await writerSave(w);
    const { index, unlockingScript } = await signChainInput(w.as(WRITER), signable.tx, keyId, prev.outpoint);
    await w.as(WRITER).signAction({ reference: signable.reference, spends: { [index]: { unlockingScript } } });
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('once aborted, refused', async () => {
    const w = setup();
    const { signable, tx } = await writerSave(w);
    await w.as(WRITER).abortAction({ reference: signable.reference });
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('a signAction that fails ends it too (the manager aborts the action)', async () => {
    const w = setup({ signFails: true });
    const { signable, tx } = await writerSave(w);
    await expect(w.as(WRITER).signAction({ reference: signable.reference, spends: {} })).rejects.toThrow();
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('expired: refused after PENDING_SIGHASH_TTL_MS', async () => {
    let t = 1_000_000;
    const w = setup({ now: () => t });
    const { tx } = await writerSave(w);
    t += PENDING_SIGHASH_TTL_MS - 1;
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
    t += 1;
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('a restarted service worker remembers nothing: refused, and the action cannot be finished either', async () => {
    const w = setup();
    const { signable, tx } = await writerSave(w);
    w.restart();
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(w.as(WRITER).signAction({ reference: signable.reference, spends: {} })).rejects.toThrow();
  });

  test('a denied pay sheet leaves nothing to sign', async () => {
    const w = setup({ approve: false });
    const chainKey = await w.keyOf(CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const prev = coin(p2pkh(chainKey));
    const args = {
      description: 'Save your document on chain',
      inputBEEF: beefOf(prev),
      inputs: [{ outpoint: prev.outpoint, unlockingScriptLength: 108, inputDescription: 'Previous save' }],
      outputs: [payTo(500)],
    };
    await expect(w.as(WRITER).createAction(args)).rejects.toThrow();
    expect(w.sheets.map((s) => s.type)).toEqual(['spending']);
  });
});

describe('only the exact digest of an input the site must unlock', () => {
  test('an input the wallet funds and signs itself is never signed for a site', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    const funding = tx.inputs.length - 1;
    expect(funding).toBe(1);
    await expect(blindSign(w, WRITER, sighash(tx, funding), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      blindSign(w, WRITER, sighash(tx, funding), { protocolID: [2, 'writer other'], keyID: '1' }),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('SIGHASH_NONE, SINGLE, ANYONECANPAY, no FORKID and CHRONICLE digests are refused', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    const S = TransactionSignature;
    const scopes = [
      S.SIGHASH_NONE | S.SIGHASH_FORKID,
      S.SIGHASH_SINGLE | S.SIGHASH_FORKID,
      S.SIGHASH_ALL | S.SIGHASH_FORKID | S.SIGHASH_ANYONECANPAY,
      S.SIGHASH_NONE | S.SIGHASH_FORKID | S.SIGHASH_ANYONECANPAY,
      S.SIGHASH_SINGLE | S.SIGHASH_FORKID | S.SIGHASH_ANYONECANPAY,
      S.SIGHASH_ALL,
      S.SIGHASH_ALL | S.SIGHASH_FORKID | S.SIGHASH_CHRONICLE,
    ];
    const all = Utils.toHex(sighash(tx, 0));
    for (const scope of scopes) {
      const digest = sighash(tx, 0, scope);
      expect(Utils.toHex(digest)).not.toBe(all);
      await expect(blindSign(w, WRITER, digest, chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    }
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
  });

  test('the right transaction with altered outputs, inputs, sequence, version or lock time is refused', async () => {
    const w = setup();
    const { signable } = await writerSave(w);
    const altered: ((t: Transaction) => void)[] = [
      (t) => (t.outputs[1].satoshis = 499),
      (t) => (t.outputs[1].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress())),
      (t) => t.outputs.pop(),
      (t) => t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1 }),
      (t) => t.inputs.pop(),
      (t) => (t.inputs[0].sequence = 0),
      (t) => (t.version = 2),
      (t) => (t.lockTime = 1),
    ];
    for (const change of altered) {
      const t = Transaction.fromAtomicBEEF(signable.tx);
      change(t);
      await expect(blindSign(w, WRITER, sighash(t, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    }
  });

  test('a wrong source amount or locking script (a preimage the page made up) is refused', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    const input = tx.inputs[0];
    const digest = (sourceSatoshis: number, subscript: LockingScript) =>
      Hash.hash256(
        TransactionSignature.format({
          sourceTXID: input.sourceTXID!,
          sourceOutputIndex: 0,
          sourceSatoshis,
          transactionVersion: tx.version,
          otherInputs: tx.inputs.slice(1),
          inputIndex: 0,
          outputs: tx.outputs,
          inputSequence: 0xffffffff,
          subscript,
          lockTime: tx.lockTime,
          scope: ALL_FORKID,
        }),
      );
    const real = input.sourceTransaction!.outputs[0].lockingScript;
    await expect(blindSign(w, WRITER, digest(2, real), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      blindSign(w, WRITER, digest(1, new P2PKH().lock(PrivateKey.fromRandom().toAddress())), chainKeyArgs()),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(blindSign(w, WRITER, digest(1, real), chainKeyArgs())).resolves.toBeDefined();
  });

  test('a hash that is not 32 plain bytes, comes with data, or asks for the privileged key is refused', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    const d = sighash(tx, 0);
    const bad: [unknown, Record<string, unknown>][] = [
      [d.slice(0, 31), {}],
      [[...d, 0], {}],
      [Uint8Array.from(d), {}],
      [Utils.toHex(d), {}],
      [d.map((b, i) => (i === 0 ? b + 0.5 : b)), {}],
      [d, { data: [1, 2, 3] }],
      [d, { privileged: true }],
    ];
    for (const [hash, extra] of bad)
      await expect(blindSign(w, WRITER, hash, { ...chainKeyArgs(), ...extra })).rejects.toThrow();
    // The same bytes as `data` is a different signature (over sha256 of them) and takes the ordinary path.
    await expect(blindSign(w, WRITER, d, chainKeyArgs())).resolves.toBeDefined();
  });

  test('an input the site already unlocked in createAction has no sighash to ask for', async () => {
    const w = setup();
    const chainKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const prev = coin(p2pkh(chainKey));
    const created = await w.as(WRITER).createAction({
      description: 'Save your document on chain',
      inputBEEF: beefOf(prev),
      inputs: [{ outpoint: prev.outpoint, unlockingScript: '0101', inputDescription: 'Previous save' }],
      outputs: [payTo(500)],
      options: { signAndProcess: false },
    });
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });
});

describe('only with the key the input is locked to', () => {
  test('another key of the same protocol, another protocol, another counterparty: refused', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    const d = sighash(tx, 0);
    const asked = w.sheets.length;
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    const wrong: Record<string, unknown>[] = [
      { protocolID: CHAIN_PROTOCOL, keyID: chainKeyID('doc-2') },
      { protocolID: [2, 'bitcoin writer'], keyID: chainKeyID('doc-1') },
      { protocolID: [1, 'bitcoin writer chain'], keyID: chainKeyID('doc-1') },
      { ...chainKeyArgs(), counterparty: 'anyone' },
      { ...chainKeyArgs(), counterparty: other },
      { ...chainKeyArgs(), counterparty: undefined },
      { protocolID: [2, 'auth message signature'], keyID: '1' },
      { protocolID: [2, 'bwallet sign in'], keyID: '1', counterparty: 'anyone' },
    ];
    for (const key of wrong) await expect(blindSign(w, WRITER, d, key)).rejects.toThrow(BLIND_SIGN_REFUSAL);
    // Refused before any sheet.
    expect(w.sheets.length).toBe(asked);
  });

  test('a coin locked to a key derived with no counterparty ("anyone") signs with exactly that request', async () => {
    const w = setup();
    const anyoneKey = await w.siteKey(BLASTER, AMMO_PROTOCOL, 'k', 'anyone');
    const c = coin(p2pkh(anyoneKey), 5);
    const created = await w.as(BLASTER).createAction({
      description: 'Spend an app coin',
      inputBEEF: beefOf(c),
      inputs: [{ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'app coin' }],
      outputs: [payTo(700)],
    });
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    const key = { protocolID: AMMO_PROTOCOL, keyID: 'k' };
    await expect(blindSign(w, BLASTER, sighash(tx, 0), { ...key, counterparty: 'self' })).rejects.toThrow(
      BLIND_SIGN_REFUSAL,
    );
    const { signature } = await w.wallet.createSignature({ hashToDirectlySign: sighash(tx, 0), ...key }, BLASTER);
    const sig = [...signature, ALL_FORKID];
    const pub = Utils.toArray(anyoneKey, 'hex');
    const unlockingScript = new UnlockingScript([
      { op: sig.length, data: sig },
      { op: pub.length, data: pub },
    ]).toHex();
    await w
      .as(BLASTER)
      .signAction({ reference: created.signableTransaction!.reference, spends: { 0: { unlockingScript } } });
    expect(unlocks(w.sent[0], 0)).toBe(true);
  });

  test('reserved, level-0, payment and module protocols keep their own refusals, even for a coin locked to them', async () => {
    const w = setup();
    const cases: [WalletProtocol, string, string][] = [
      [ONESAT, 'k', RESERVED_REFUSAL],
      [[1, 'btrust'], 'owner', RESERVED_REFUSAL],
      [[2, 'bwalletx presign'], 'k', RESERVED_REFUSAL],
      [[0, 'site level zero'], 'k', LEVEL0_SIGN_REFUSAL],
      [[2, '3241645161d8'], 'a b', RAW_HASH_REFUSAL],
      [[1, 'P 1sat'], 'k', P_MODULE_PROTOCOL_REFUSAL],
    ];
    for (const [protocolID, keyID, refusal] of cases) {
      const c = await tokenCoin(w, keyID, protocolID);
      const { tx } = await blasterLoad(w, [c]);
      await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID, keyID })).rejects.toThrow(refusal);
    }
    // A module's own name reaches the cross-site guard, which keeps refusing its hash.
    const c = await tokenCoin(w, 'k', [1, 'p 1sat']);
    const { tx } = await blasterLoad(w, [c]);
    await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID: [1, 'p 1sat'], keyID: 'k' })).rejects.toThrow(
      BLIND_SIGN_REFUSAL,
    );
  });

  test('the posting key ([1,"sigma"]) never signs a sighash, even for a coin a site locked to it', async () => {
    const w = setup();
    for (const protocolID of [
      [1, 'sigma'],
      [1, ' Sigma '],
    ] as WalletProtocol[]) {
      const c = await tokenCoin(w, 'post', protocolID);
      const { tx } = await blasterLoad(w, [c]);
      await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID, keyID: 'post' })).rejects.toThrow(
        BLIND_SIGN_REFUSAL,
      );
    }
  });

  test('a script whose key the wallet cannot read is refused: bare multisig, a P2PKH with a tail, a lock', async () => {
    const w = setup();
    const publicKey = await w.siteKey(BLASTER, AMMO_PROTOCOL, 'k');
    const pub = Utils.toArray(publicKey, 'hex');
    const pkh = Hash.hash160(pub);
    const p2pkhChunks = p2pkh(publicKey).chunks;
    const scripts = [
      // A key and OP_CHECKSIG with anything but PushDrop's own pushes-then-drops around it.
      new LockingScript([{ op: pub.length, data: pub }, { op: OP.OP_CHECKSIG }, { op: OP.OP_DROP }]),
      new LockingScript([{ op: pub.length, data: pub }, { op: OP.OP_CHECKSIG }, { op: 1, data: [7] }]),
      new LockingScript([{ op: pub.length, data: pub }, { op: OP.OP_CHECKSIG }, { op: OP.OP_NOT }]),
      new LockingScript([
        { op: 1, data: [7] },
        { op: OP.OP_2DROP },
        { op: pub.length, data: pub },
        { op: OP.OP_CHECKSIG },
      ]),
      new LockingScript([{ op: pub.length, data: pub }, { op: OP.OP_CHECKSIGVERIFY }]),
      new LockingScript([{ op: 65, data: [4, ...new Array(64).fill(1)] }, { op: OP.OP_CHECKSIG }]),
      new LockingScript([{ op: OP.OP_1 }, { op: pub.length, data: pub }, { op: OP.OP_1 }, { op: OP.OP_CHECKMULTISIG }]),
      new LockingScript([...p2pkhChunks, { op: OP.OP_RETURN }, { op: 3, data: [1, 2, 3] }]),
      new LockingScript([{ op: OP.OP_1 }, { op: OP.OP_DROP }, ...p2pkhChunks]),
      // An "envelope" that runs code is not one.
      new LockingScript([{ op: OP.OP_0 }, { op: OP.OP_IF }, { op: OP.OP_ELSE }, { op: OP.OP_ENDIF }, ...p2pkhChunks]),
      new LockingScript([{ op: OP.OP_1 }, { op: OP.OP_IF }, { op: 1, data: [7] }, { op: OP.OP_ENDIF }, ...p2pkhChunks]),
      // The P2PKH bytes inside a push are data, not a lock.
      new LockingScript([{ op: 25, data: p2pkh(publicKey).toBinary() }]),
      new LockingScript([{ op: OP.OP_HASH160 }, { op: 20, data: pkh }, { op: OP.OP_EQUAL }]),
    ];
    for (const script of scripts) {
      expect(lockKeyHash(script)).toBeNull();
      const c = coin(script, 3);
      const created = await w.as(BLASTER).createAction({
        description: 'Spend an app coin',
        inputBEEF: beefOf(c),
        inputs: [{ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'app coin' }],
        outputs: [payTo(700)],
      });
      const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
      await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID: AMMO_PROTOCOL, keyID: 'k' })).rejects.toThrow(
        BLIND_SIGN_REFUSAL,
      );
    }
  });
});

describe('32 bytes of data is a hash too (the data door, review 15 Nov 2026)', () => {
  const NONE_ACP =
    TransactionSignature.SIGHASH_NONE | TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ANYONECANPAY;
  const dataSign = (w: ReturnType<typeof setup>, site: string, data: unknown, key: Record<string, unknown>) =>
    w.wallet.createSignature({ data, counterparty: 'self', ...key }, site);

  test('R1: data = sha256(preimage) of a transaction the wallet never saw is refused, whatever the flags', async () => {
    const w = setup();
    // Both sites hold the protocol's grant: before the fix that was all it took.
    const key = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    await w.siteKey(EVIL, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const prev = coin(p2pkh(key), 1_000_000);
    // Built by the site alone: no createAction, no pay sheet.
    const tx = new Transaction(1, [], [], 0);
    tx.addInput({
      sourceTransaction: prev.tx,
      sourceTXID: prev.tx.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 999_000 });
    const asked = w.sheets.length;
    for (const scope of [ALL_FORKID, NONE_ACP]) {
      const preimage = TransactionSignature.format({
        sourceTXID: prev.tx.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 1_000_000,
        transactionVersion: 1,
        otherInputs: [],
        inputIndex: 0,
        outputs: tx.outputs,
        inputSequence: 0xffffffff,
        subscript: prev.tx.outputs[0].lockingScript,
        lockTime: 0,
        scope,
      });
      for (const site of [EVIL, WRITER])
        await expect(dataSign(w, site, Hash.sha256(preimage), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    }
    // Refused before any sheet.
    expect(w.sheets.length).toBe(asked);
  });

  test('the sighash of the site’s own pending input signs as data too; nothing else of 32 bytes does', async () => {
    const w = setup();
    const { tx, signable, chainKey } = await writerSave(w);
    const input = tx.inputs[0];
    const preimage = (scope: number, t = tx) =>
      TransactionSignature.format({
        sourceTXID: input.sourceTXID!,
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        transactionVersion: t.version,
        otherInputs: t.inputs.slice(1),
        inputIndex: 0,
        outputs: t.outputs,
        inputSequence: 0xffffffff,
        subscript: input.sourceTransaction!.outputs[0].lockingScript,
        lockTime: t.lockTime,
        scope,
      });
    const refused = [
      Hash.sha256(preimage(NONE_ACP)),
      // The digest itself as data would be signed over its hash: not the sighash.
      sighash(tx, 0),
      Hash.sha256(Hash.sha256([1, 2, 3])),
      new Array(32).fill(0),
    ];
    for (const data of refused)
      await expect(dataSign(w, WRITER, data, chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    const data = Hash.sha256(preimage(ALL_FORKID));
    await expect(dataSign(w, EVIL, data, chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(dataSign(w, WRITER, data, chainKeyArgs('doc-2'))).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      w.wallet.createSignature(
        { data, hashToDirectlySign: sighash(tx, 0), counterparty: 'self', ...chainKeyArgs() },
        WRITER,
      ),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
    const { signature } = await dataSign(w, WRITER, data, chainKeyArgs());
    const sig = [...signature, ALL_FORKID];
    const pub = Utils.toArray(chainKey, 'hex');
    const unlockingScript = new UnlockingScript([
      { op: sig.length, data: sig },
      { op: pub.length, data: pub },
    ]).toHex();
    await w.as(WRITER).signAction({ reference: signable.reference, spends: { 0: { unlockingScript } } });
    expect(unlocks(w.sent[0], 0)).toBe(true);
    await expect(dataSign(w, WRITER, data, chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('@bsv/sdk PushDrop.unlock (data = sha256(preimage)) spends the site’s own token through its pending action', async () => {
    const w = setup();
    const site = w.as(BLASTER);
    for (const lockPosition of ['before', 'after'] as const) {
      const fields = [Utils.toArray('a token of the site', 'utf8'), [1, 2, 3]];
      const lock = await new PushDrop(site).lock(fields, AMMO_PROTOCOL, 'token-1', 'self', true, true, lockPosition);
      expect(lockKeyHash(lock)).toBe(
        Utils.toHex(Hash.hash160(Utils.toArray(await w.keyOf(AMMO_PROTOCOL, 'token-1'), 'hex'))),
      );
      const token = coin(lock, 1);
      const create = () =>
        site.createAction({
          description: 'Update the site token',
          inputBEEF: beefOf(token),
          inputs: [{ outpoint: token.outpoint, unlockingScriptLength: 74, inputDescription: 'the old token' }],
          outputs: [payTo(300)],
        });
      // Any other scope, or another key: refused.
      const a = await create();
      const ta = Transaction.fromAtomicBEEF(a.signableTransaction!.tx);
      await expect(new PushDrop(site).unlock(AMMO_PROTOCOL, 'token-1', 'self', 'none').sign(ta, 0)).rejects.toThrow(
        BLIND_SIGN_REFUSAL,
      );
      await expect(
        new PushDrop(site).unlock(AMMO_PROTOCOL, 'token-1', 'self', 'all', true).sign(ta, 0),
      ).rejects.toThrow(BLIND_SIGN_REFUSAL);
      await expect(new PushDrop(site).unlock(AMMO_PROTOCOL, 'token-2', 'self').sign(ta, 0)).rejects.toThrow(
        BLIND_SIGN_REFUSAL,
      );
      await expect(new PushDrop(w.as(EVIL)).unlock(AMMO_PROTOCOL, 'token-1', 'self').sign(ta, 0)).rejects.toThrow(
        BLIND_SIGN_REFUSAL,
      );
      const unlock = await new PushDrop(site).unlock(AMMO_PROTOCOL, 'token-1', 'self').sign(ta, 0);
      const done = await site.signAction({
        reference: a.signableTransaction!.reference,
        spends: { 0: { unlockingScript: unlock.toHex() } },
      });
      const sent = w.sent[w.sent.length - 1];
      expect(done.txid).toBe(sent.id('hex'));
      expect(unlocks(sent, 0)).toBe(true);
    }
  });

  test('a pinned protocol signs its record hashes from its own site only, and never with a key that holds coins', async () => {
    const w = setup();
    const BJOBSX = [2, 'bjobsx records'];
    const json = Utils.toArray('{"v":1,"app":"bjobsx","type":"profile"}', 'utf8');
    // bjobsx.com mint/records.js: the published profile, and a minted record.
    const profile = { data: Hash.sha256(json), protocolID: BJOBSX, keyID: 'public profile', counterparty: 'anyone' };
    const record = { data: Hash.sha256(json), protocolID: BJOBSX, keyID: 'public 5f3a9c', counterparty: 'self' };
    for (const call of [profile, record]) {
      for (const home of ['bjobsx.com', 'www.bjobsx.com'])
        await expect(w.wallet.createSignature(call, home)).resolves.toBeDefined();
      for (const other of [EVIL, 'jobs.bjobsx.com', 'bjobsx.com.evil.example', 'bvideox.com'])
        await expect(w.wallet.createSignature(call, other)).rejects.toThrow(PINNED_REFUSAL);
      await expect(w.wallet.createSignature(call, `bjobsx.com.c${'0a'.repeat(22)}.paired.invalid`)).rejects.toThrow();
    }
    // Never the privileged keyring.
    await expect(w.wallet.createSignature({ ...record, privileged: true }, 'bjobsx.com')).rejects.toThrow(
      BLIND_SIGN_REFUSAL,
    );
    // The same site, a key that is not a record-signing key (bMintX's pot is 'pot <account>'), or a bare hash.
    for (const keyID of ['pot 123', 'publicprofile', 'k', ' public profile', 'Public profile'])
      await expect(w.wallet.createSignature({ ...record, keyID }, 'bjobsx.com')).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      w.wallet.createSignature({ ...record, data: undefined, hashToDirectlySign: record.data }, 'bjobsx.com'),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      w.wallet.createSignature(
        { data: record.data, protocolID: [2, 'bmintx archive'], keyID: 'pot 123', counterparty: 'self' },
        'bmintx.com',
      ),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      w.wallet.createSignature(
        { data: record.data, protocolID: [2, 'bmintx archive'], keyID: 'seal 9c41', counterparty: 'self' },
        'bmintx.com',
      ),
    ).resolves.toBeDefined();
    // A protocol that is not pinned has no such exception, whatever the key is called.
    await expect(
      dataSign(w, WRITER, record.data, { protocolID: [2, 'writer records'], keyID: 'public 1' }),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('31 and 33 bytes sign as before; so do the wallet’s own 32 bytes and a 32-byte HMAC', async () => {
    const w = setup();
    const key = { protocolID: [1, 'site notes'], keyID: 'k' };
    for (const n of [1, 31, 33, 64])
      await expect(dataSign(w, WRITER, new Array(n).fill(7), key)).resolves.toBeDefined();
    await expect(dataSign(w, WRITER, new Array(32).fill(7), key)).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(dataSign(w, WRITER, Utils.toArray('a'.repeat(32), 'utf8'), key)).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(dataSign(w, ADMIN, new Array(32).fill(7), key)).resolves.toBeDefined();
    await expect(dataSign(w, ADMIN, new Array(32).fill(7), { protocolID: ONESAT, keyID: 'k' })).resolves.toBeDefined();
    await expect(w.wallet.createHmac({ data: new Array(32).fill(7), ...key }, WRITER)).resolves.toBeDefined();
    // Known cost: PushDrop.lock signs its fields, so a site token whose fields come to exactly 32 bytes is refused.
    await expect(
      new PushDrop(w.as(BLASTER)).lock([new Array(32).fill(9)], AMMO_PROTOCOL, 't', 'self', true),
    ).rejects.toThrow(BLIND_SIGN_REFUSAL);
    await expect(
      new PushDrop(w.as(BLASTER)).lock([new Array(31).fill(9)], AMMO_PROTOCOL, 't', 'self', true),
    ).resolves.toBeDefined();
  });
});

describe('only a site that already holds the key’s protocol (review 15 Nov 2026)', () => {
  /** R2: a site names a coin of ANOTHER app as its input and pays 1 sat on top, so the pay sheet says "1 sat". */
  const nameCoin = async (w: ReturnType<typeof setup>, site: string, c: ReturnType<typeof coin>) => {
    const created = await w.as(site).createAction({
      description: 'Claim your free gift',
      inputBEEF: beefOf(c),
      inputs: [{ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'a gift coin' }],
      outputs: [payTo(1_000_000 - FEE + 1)],
      options: { randomizeOutputs: false },
    });
    return Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
  };

  test('R2: no grant, no signature and no sheet: the site is told to ask for the protocol first', async () => {
    const w = setup();
    const writerKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const tx = await nameCoin(w, EVIL, coin(p2pkh(writerKey), 1_000_000));
    // What the user saw: one pay sheet, for the 1 sat over what the named coin brings.
    expect(w.sheets.filter((s) => s.originator === EVIL)).toEqual([
      { type: 'spending', originator: EVIL, satoshis: 1 },
    ]);
    const asked = w.sheets.length;
    for (const hash of [sighash(tx, 0), Hash.hash256([1])])
      await expect(blindSign(w, EVIL, hash, chainKeyArgs())).rejects.toThrow(UNGRANTED_SIGHASH_REFUSAL);
    // Right key or wrong key (R3): the same words, and no sheet either way.
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs('doc-2'))).rejects.toThrow(UNGRANTED_SIGHASH_REFUSAL);
    expect(w.sheets.length).toBe(asked);
    // The grant is per site: Writer holding it gives evil nothing, and evil's action gives Writer nothing.
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('a level-2 grant is for its counterparty only', async () => {
    const w = setup();
    const { tx } = await writerSave(w);
    await expect(blindSign(w, WRITER, sighash(tx, 0), { ...chainKeyArgs(), counterparty: 'anyone' })).rejects.toThrow(
      UNGRANTED_SIGHASH_REFUSAL,
    );
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
  });

  test('a coin under a protocol pinned to another site cannot be had at all, grant or no grant', async () => {
    const w = setup();
    const BJOBSX: WalletProtocol = [2, 'bjobsx records'];
    const tx = await nameCoin(w, EVIL, coin(p2pkh(await w.keyOf(BJOBSX, 'public profile')), 1_000_000));
    await expect(blindSign(w, EVIL, sighash(tx, 0), { protocolID: BJOBSX, keyID: 'public profile' })).rejects.toThrow(
      PINNED_REFUSAL,
    );
    // The same answer from the sighash check alone, without the guard outside it and with a grant it could not hold.
    const p = new PendingSighashes();
    const key = PrivateKey.fromRandom();
    const c = coin(new P2PKH().lock(key.toAddress()), 10);
    const t = new Transaction();
    t.addInput({ sourceTransaction: c.tx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    const funding = coin(new P2PKH().lock(PrivateKey.fromRandom().toAddress()), 1_000);
    t.addInput({ sourceTransaction: funding.tx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 900 });
    const checks = { granted: async () => true, derive: async () => key.toPublicKey().toString() };
    const sign = { hashToDirectlySign: sighash(t, 0), protocolID: BJOBSX, keyID: 'k', counterparty: 'self' };
    const create = { inputs: [{ outpoint: c.outpoint }], outputs: [{ satoshis: 900 }] };
    for (const site of [EVIL, 'bjobsx.com']) p.record(site, create, { reference: `r-${site}`, tx: atomic(t) });
    expect(await p.request(EVIL, sign, checks)).toBeNull();
    expect(await p.request('bjobsx.com', sign, checks)).toMatchObject({ sign: { keyID: 'k' } });
  });

  test('M1: a site holding another app’s unpinned protocol takes that app’s coin only past a sheet for its value', async () => {
    const w = setup();
    const writerKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    // The user says Allow to "evil.example wants to use 'bitcoin writer chain'": BRC-42 keys are not per site.
    await w.siteKey(EVIL, CHAIN_PROTOCOL, 'anything-else');
    const tx = await nameCoin(w, EVIL, coin(p2pkh(writerKey), 1_000_000));
    // The pay sheet at createAction: 1 sat, the coin subtracted (its own line says "a gift coin").
    expect(w.paySheets.map((p) => p.satoshis)).toEqual([1]);
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
    // Before the signature: the coin's whole value, in the wallet's words.
    const line = 'evil.example is spending a coin of yours worth 1000000 sats, held under "bitcoin writer chain"';
    expect(w.paySheets[1]).toEqual({
      originator: EVIL,
      satoshis: 1_000_000,
      reason: line,
      lineItems: [
        {
          type: 'input',
          satoshis: 1_000_000,
          description: 'A coin of yours worth 1000000 sats, held under "bitcoin writer chain"',
        },
      ],
    });
    // Once per action: the same request again shows nothing more.
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).resolves.toBeDefined();
    expect(w.paySheets).toHaveLength(2);
  });

  test('M1: No on that sheet refuses every signature of the action, which can still be aborted', async () => {
    let deny = true;
    const w = setup({ denyPay: (sheet) => deny && sheet.satoshis === 1_000_000 });
    const writerKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    await w.siteKey(EVIL, CHAIN_PROTOCOL, 'anything-else');
    const c = coin(p2pkh(writerKey), 1_000_000);
    const create = () =>
      w.as(EVIL).createAction({
        description: 'Claim your free gift',
        inputBEEF: beefOf(c),
        inputs: [{ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'a gift coin' }],
        outputs: [payTo(1_000_000 - FEE + 1)],
      });
    const action = await create();
    const tx = Transaction.fromAtomicBEEF(action.signableTransaction!.tx);
    const signed: unknown[] = [];
    const base = w.proto.createSignature.bind(w.proto);
    w.proto.createSignature = async (a) => (signed.push(a), base(a));
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).rejects.toThrow('User denied');
    // The No stands for the whole action: no second sheet, even if the user would now say yes.
    deny = false;
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(COIN_SPEND_DENIED);
    expect(signed).toEqual([]);
    expect(w.paySheets.filter((p) => p.satoshis === 1_000_000)).toHaveLength(1);
    await expect(w.as(EVIL).abortAction({ reference: action.signableTransaction!.reference })).resolves.toEqual({
      aborted: true,
    });
    await expect(blindSign(w, EVIL, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    // A new action is a new question.
    const again = await create();
    const tx2 = Transaction.fromAtomicBEEF(again.signableTransaction!.tx);
    await expect(blindSign(w, EVIL, sighash(tx2, 0), chainKeyArgs())).resolves.toBeDefined();
    expect(signed).toHaveLength(1);
  });

  test('one sheet per action: three named coins raise exactly one extra sheet, for their total', async () => {
    const w = setup();
    const coins = [await tokenCoin(w, 'ammo-1'), await tokenCoin(w, 'ammo-2')];
    // The third is under another protocol of the site, and worth more.
    const otherKey = await w.siteKey(BLASTER, [1, 'tokenblaster front'], 'f');
    const front = {
      ...coin(p2pkh(otherKey), 5_000),
      protocolID: [1, 'tokenblaster front'] as WalletProtocol,
      keyID: 'f',
    };
    const created = await w.as(BLASTER).createAction({
      description: 'Load 1,000 $AMMO into your gun',
      inputBEEF: beefOf(...coins, front),
      inputs: [...coins, front].map((c) => ({
        outpoint: c.outpoint,
        unlockingScriptLength: 108,
        inputDescription: 'a coin',
      })),
      outputs: [payTo(6_000)],
      options: { randomizeOutputs: false, signAndProcess: false },
    });
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    const before = w.paySheets.length;
    expect(w.paySheets.map((p) => p.satoshis)).toEqual([6_000 + FEE - 5_002]);
    const spends = await tokenSpends(
      w.as(BLASTER),
      tx,
      [...coins, front].map((c, index) => ({ index, protocolID: c.protocolID, keyID: c.keyID })),
    );
    await w.as(BLASTER).signAction({ reference: created.signableTransaction!.reference, spends });
    expect([0, 1, 2].every((i) => unlocks(w.sent[0], i))).toBe(true);
    // Exactly one more sheet, at the first signature: the three coins' total, a line each. Only the coin being
    // signed for is known by its protocol then.
    expect(w.paySheets.slice(before)).toEqual([
      {
        originator: BLASTER,
        satoshis: 5_002,
        reason: 'www.tokenblaster.lol is spending 3 coins of yours worth 5002 sats in all',
        lineItems: [
          { type: 'input', satoshis: 1, description: 'A coin of yours worth 1 sats, held under "tokenblaster ammo"' },
          { type: 'input', satoshis: 1, description: 'A coin worth 1 sats this site will unlock' },
          { type: 'input', satoshis: 5_000, description: 'A coin worth 5000 sats this site will unlock' },
        ],
      },
    ]);
  });

  test('a protocol pinned to the calling site needs no extra sheet; from another site it is refused as before', async () => {
    const w = setup();
    const BJOBSX: WalletProtocol = [2, 'bjobsx records'];
    const HOME = 'bjobsx.com';
    const key = await w.siteKey(HOME, BJOBSX, 'chain 1');
    const c = coin(p2pkh(key), 50_000);
    const create = (site: string) =>
      w.as(site).createAction({
        description: 'Update your profile record',
        inputBEEF: beefOf(c),
        inputs: [{ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'the record coin' }],
        outputs: [payTo(50_100)],
      });
    const created = await create(HOME);
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    const spends = await tokenSpends(w.as(HOME), tx, [{ index: 0, protocolID: BJOBSX, keyID: 'chain 1' }]);
    await w.as(HOME).signAction({ reference: created.signableTransaction!.reference, spends });
    expect(unlocks(w.sent[0], 0)).toBe(true);
    // The user saw the protocol sheet (once, for the key) and the action's own pay sheet. Nothing else.
    expect(w.sheets.map((s) => [s.type, s.satoshis])).toEqual([
      ['protocol', undefined],
      ['spending', 100 + FEE],
    ]);
    const other = await create(EVIL);
    const otherTx = Transaction.fromAtomicBEEF(other.signableTransaction!.tx);
    await expect(blindSign(w, EVIL, sighash(otherTx, 0), { protocolID: BJOBSX, keyID: 'chain 1' })).rejects.toThrow(
      PINNED_REFUSAL,
    );
  });

  test('pinned and other coins in one action: the sheet covers only the others', async () => {
    const w = setup();
    const BJOBSX: WalletProtocol = [2, 'bjobsx records'];
    const OTHER: WalletProtocol = [1, 'bjobsx tips'];
    const HOME = 'bjobsx.com';
    const pinned = coin(p2pkh(await w.siteKey(HOME, BJOBSX, 'chain 1')), 50_000);
    const tips = coin(p2pkh(await w.siteKey(HOME, OTHER, 'jar')), 700);
    const created = await w.as(HOME).createAction({
      description: 'Update your profile record',
      inputBEEF: beefOf(pinned, tips),
      inputs: [pinned, tips].map((c) => ({
        outpoint: c.outpoint,
        unlockingScriptLength: 108,
        inputDescription: 'a coin',
      })),
      outputs: [payTo(51_000)],
      options: { randomizeOutputs: false },
    });
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    const before = w.paySheets.length;
    await expect(blindSign(w, HOME, sighash(tx, 0), { protocolID: BJOBSX, keyID: 'chain 1' })).resolves.toBeDefined();
    expect(w.paySheets.length).toBe(before);
    await expect(blindSign(w, HOME, sighash(tx, 1), { protocolID: OTHER, keyID: 'jar' })).resolves.toBeDefined();
    expect(w.paySheets.slice(before)).toEqual([
      {
        originator: HOME,
        satoshis: 700,
        reason: 'bjobsx.com is spending a coin of yours worth 700 sats, held under "bjobsx tips"',
        lineItems: [
          { type: 'input', satoshis: 700, description: 'A coin of yours worth 700 sats, held under "bjobsx tips"' },
        ],
      },
    ]);
  });

  test('M1: a manager with no way to ask, or one that answers anything but yes, signs nothing', async () => {
    const key = PrivateKey.fromRandom();
    const c = coin(new P2PKH().lock(key.toAddress()), 10);
    const funding = coin(new P2PKH().lock(PrivateKey.fromRandom().toAddress()), 1_000);
    const t = new Transaction();
    for (const x of [c, funding])
      t.addInput({ sourceTransaction: x.tx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 900 });
    const sign = { hashToDirectlySign: sighash(t, 0), protocolID: [1, 'app'], keyID: 'k' };
    const create = { inputs: [{ outpoint: c.outpoint }], outputs: [{ satoshis: 900 }] };
    for (const [ensure, words] of [
      [undefined, COIN_SPEND_UNASKABLE],
      [async () => false, COIN_SPEND_DENIED],
      [async () => undefined, COIN_SPEND_DENIED],
      [async () => Promise.reject(new Error('sheet closed')), 'sheet closed'],
    ] as const) {
      const signed: unknown[] = [];
      const m = guardCrossSiteSigning(
        {
          getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
          ensureProtocolPermission: async () => true,
          ...(ensure ? { ensureSpendingAuthorization: ensure } : {}),
          createSignature: async (a: unknown) => (signed.push(a), { signature: [1] }),
          createAction: async () => ({ signableTransaction: { reference: 'r', tx: atomic(t) } }),
        },
        ADMIN,
      );
      await m.createAction(create as never, 'a.example');
      await expect(m.createSignature(sign as never, 'a.example')).rejects.toThrow(words);
      expect(signed).toEqual([]);
    }
  });

  test('a Bitcoin Writer save (546-sat chain coin in, 546 out): exactly which sheets the user sees', async () => {
    const w = setup();
    const chainKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const prev = coin(p2pkh(chainKey), 546);
    const created = await w.as(WRITER).createAction({
      description: 'Save your document on chain',
      inputBEEF: beefOf(prev),
      inputs: [{ outpoint: prev.outpoint, unlockingScriptLength: 108, inputDescription: 'Previous save (chain UTXO)' }],
      outputs: [{ lockingScript: p2pkh(chainKey).toHex(), satoshis: 546, outputDescription: 'This save' }, payTo(20)],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    const signable = created.signableTransaction!;
    const { index, unlockingScript } = await signChainInput(w.as(WRITER), signable.tx, 'doc-1', prev.outpoint);
    await w.as(WRITER).signAction({ reference: signable.reference, spends: { [index]: { unlockingScript } } });
    expect(unlocks(w.sent[0], index)).toBe(true);
    // One protocol sheet (the first time only: the grant is kept), the pay sheet, and the sheet for the chain coin.
    expect(w.sheets.map((s) => [s.type, s.satoshis])).toEqual([
      ['protocol', undefined],
      ['spending', 20 + FEE],
      ['spending', 546],
    ]);
    expect(w.paySheets[1].reason).toBe(
      'www.bitcoin-writer.example is spending a coin of yours worth 546 sats, held under "bitcoin writer chain"',
    );
  });
});

describe('the refusal says which rule applied (third-party PushDrop apps, final check 15 Nov 2026)', () => {
  const P: WalletProtocol = [2, 'todo list'];
  const SITE = 'todo.example';

  test('a redeem that takes nothing from the wallet; other sighash flags; a script the wallet cannot read', async () => {
    const w = setup();
    const pd = new PushDrop(w.as(SITE));
    const lock = await pd.lock([Utils.toArray('buy milk', 'utf8')], P, '1', 'self', true, true);
    const token = coin(lock, 1000);
    const create = async (outputs: unknown[]) => {
      const created = await w.as(SITE).createAction({
        description: 'A todo token',
        inputBEEF: beefOf(token),
        inputs: [{ outpoint: token.outpoint, unlockingScriptLength: 74, inputDescription: 'the token' }],
        outputs: outputs as never,
        options: { randomizeOutputs: false },
      });
      return Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    };
    // (a) Redeemed back to the wallet: no pay sheet was shown, and the refusal says so.
    const redeem = await create([]);
    expect(w.paySheets).toEqual([]);
    await expect(pd.unlock(P, '1', 'self').sign(redeem, 0)).rejects.toThrow(UNPAID_SIGHASH_REFUSAL);
    // (c) Flags other than SIGHASH_ALL|FORKID.
    const paid = await create([payTo(2000)]);
    for (const [signOutputs, anyoneCanPay] of [
      ['all', true],
      ['none', false],
      ['none', true],
      ['single', false],
      ['single', true],
    ] as const)
      await expect(pd.unlock(P, '1', 'self', signOutputs, anyoneCanPay).sign(paid, 0)).rejects.toThrow(
        SCOPE_SIGHASH_REFUSAL,
      );
    await expect(pd.unlock(P, '1', 'self').sign(paid, 0)).resolves.toBeDefined();
    // A lock the wallet can't read a key from.
    const odd = coin(new LockingScript([...lock.chunks, { op: OP.OP_NOP }]), 1000);
    const created = await w.as(SITE).createAction({
      description: 'A todo token',
      inputBEEF: beefOf(odd),
      inputs: [{ outpoint: odd.outpoint, unlockingScriptLength: 74, inputDescription: 'the token' }],
      outputs: [payTo(2000)],
    });
    const oddTx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    await expect(blindSign(w, SITE, sighash(oddTx, 0), { protocolID: P, keyID: '1' })).rejects.toThrow(
      SCRIPT_SIGHASH_REFUSAL,
    );
    // Every one of them still starts with the sentence sites already check for.
    for (const words of [UNPAID_SIGHASH_REFUSAL, SCOPE_SIGHASH_REFUSAL, SCRIPT_SIGHASH_REFUSAL, DATA_HASH_REFUSAL])
      expect(words.startsWith(BLIND_SIGN_REFUSAL)).toBe(true);
  });

  test('(b) 32 bytes of data that is no pending sighash: told it is read as a hash', async () => {
    const w = setup();
    await expect(new PushDrop(w.as(SITE)).lock([new Array(32).fill(9)], P, '1', 'self', true)).rejects.toThrow(
      DATA_HASH_REFUSAL,
    );
    // A bare hash that is none keeps the plain sentence, and nothing about pending actions leaks to a site without
    // the grant: right digest or wrong, the same words.
    await expect(blindSign(w, SITE, Hash.hash256([1]), { protocolID: P, keyID: '1' })).rejects.toThrow(
      new RegExp(`^${BLIND_SIGN_REFUSAL}$`),
    );
  });
});

describe('only after the user (or the site’s envelope) approved the payment', () => {
  test('an action that takes nothing from the wallet shows no pay sheet, so its sighash stays refused', async () => {
    const w = setup();
    const key = await w.siteKey(BLASTER, AMMO_PROTOCOL, 'pot');
    const pot = coin(p2pkh(key), 50_000);
    const created = await w.as(BLASTER).createAction({
      description: 'Move the app coin out',
      inputBEEF: beefOf(pot),
      inputs: [{ outpoint: pot.outpoint, unlockingScriptLength: 108, inputDescription: 'app coin' }],
      outputs: [payTo(40_000)],
    });
    expect(w.sheets.filter((s) => s.type === 'spending')).toEqual([]);
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx);
    await expect(blindSign(w, BLASTER, sighash(tx, 0), { protocolID: AMMO_PROTOCOL, keyID: 'pot' })).rejects.toThrow(
      BLIND_SIGN_REFUSAL,
    );
    // One satoshi over what the coin brings and the sheet shows; then it signs.
    const paid = await w.as(BLASTER).createAction({
      description: 'Move the app coin out',
      inputBEEF: beefOf(pot),
      inputs: [{ outpoint: pot.outpoint, unlockingScriptLength: 108, inputDescription: 'app coin' }],
      outputs: [payTo(50_000 - FEE + 1)],
    });
    expect(w.sheets.filter((s) => s.type === 'spending')).toEqual([
      { type: 'spending', originator: BLASTER, satoshis: 1 },
    ]);
    const paidTx = Transaction.fromAtomicBEEF(paid.signableTransaction!.tx);
    await expect(
      blindSign(w, BLASTER, sighash(paidTx, 0), { protocolID: AMMO_PROTOCOL, keyID: 'pot' }),
    ).resolves.toBeDefined();
  });
});

describe('who is asking', () => {
  test('the wallet itself is untouched, and its own actions are not recorded for anyone', async () => {
    const w = setup();
    await expect(
      w.wallet.createSignature({ hashToDirectlySign: Hash.hash256([9]), protocolID: ONESAT, keyID: 'k' }, ADMIN),
    ).resolves.toBeDefined();
    const chainKey = await w.siteKey(WRITER, CHAIN_PROTOCOL, chainKeyID('doc-1'));
    const prev = coin(p2pkh(chainKey));
    const created = await w.wallet.createAction(
      {
        description: 'The wallet’s own action',
        inputBEEF: beefOf(prev),
        inputs: [{ outpoint: prev.outpoint, unlockingScriptLength: 108, inputDescription: 'a coin of the wallet' }],
        outputs: [payTo(500)],
        options: { signAndProcess: false },
      },
      ADMIN,
    );
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction.tx);
    await expect(blindSign(w, WRITER, sighash(tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
  });

  test('a phone pairing that did not prove its site stays refused; one that did is that site', async () => {
    const unproven = `${WRITER}.c${'0a'.repeat(22)}.paired.invalid`;
    const proven = `${WRITER}.c${'be'.repeat(22)}.paired.invalid`;
    setProvenPairingCheck((o) => o === proven);
    try {
      const w = setup();
      const a = await writerSave(w, unproven);
      await expect(blindSign(w, unproven, sighash(a.tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
      const b = await writerSave(w, proven);
      await expect(blindSign(w, proven, sighash(b.tx, 0), chainKeyArgs())).resolves.toBeDefined();
      // The same site in a browser tab, or in another pairing, is another originator.
      await expect(blindSign(w, WRITER, sighash(b.tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
      await expect(blindSign(w, unproven, sighash(b.tx, 0), chainKeyArgs())).rejects.toThrow(BLIND_SIGN_REFUSAL);
    } finally {
      setProvenPairingCheck(() => false);
    }
  });

  test('a blind-hash site and plain data signing are as they were', async () => {
    const w = setup();
    await expect(
      w.wallet.createSignature(
        { hashToDirectlySign: Hash.hash256([1]), protocolID: [1, 'sigma'], keyID: 'k' },
        'bchatx.com',
      ),
    ).resolves.toBeDefined();
    await expect(
      w.wallet.createSignature({ data: [1, 2, 3], protocolID: [1, 'site notes'], keyID: 'k' }, WRITER),
    ).resolves.toBeDefined();
    await expect(
      w.wallet.createHmac({ data: [1, 2, 3], protocolID: [1, 'site notes'], keyID: 'k' }, WRITER),
    ).resolves.toBeDefined();
  });
});

describe('callerSighashes and PendingSighashes', () => {
  const key = PrivateKey.fromRandom();
  const mine = coin(new P2PKH().lock(key.toAddress()), 10);
  const walletCoin = coin(new P2PKH().lock(PrivateKey.fromRandom().toAddress()), 1_000);
  const build = (outSats = 900) => {
    const tx = new Transaction();
    for (const c of [mine, walletCoin])
      tx.addInput({ sourceTransaction: c.tx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: outSats });
    return tx;
  };
  const args = (outSats = 900, outpoint = mine.outpoint) => ({
    inputs: [{ outpoint }],
    outputs: [{ satoshis: outSats }],
  });
  const pkh = Utils.toHex(Hash.hash160(key.toPublicKey().encode(true) as number[]));

  test('one digest per input the site must unlock, mapped to the key hash of its lock', () => {
    const tx = build();
    const d = callerSighashes(args(), atomic(tx))!;
    expect([...d.entries()]).toEqual([[Utils.toHex(sighash(tx, 0)), pkh]]);
    expect(callerSighashes(args(), Uint8Array.from(atomic(tx)))?.size).toBe(1);
    // Either spelling of the outpoint the site used names the same coin.
    expect(callerSighashes(args(900, mine.outpoint.replace('.', '_').toUpperCase()), atomic(tx))?.size).toBe(1);
  });

  test('an inscription envelope before the P2PKH is still that key', () => {
    const script = bsv21(TOKEN, 5n, key.toAddress());
    expect(lockKeyHash(script)).toBe(pkh);
    expect(lockKeyHash(new P2PKH().lock(key.toAddress()))).toBe(pkh);
  });

  test('nothing when it cannot be read or does not add up', () => {
    const tx = build();
    const none: [unknown, unknown][] = [
      [undefined, atomic(tx)],
      [{ outputs: [{ satoshis: 900 }] }, atomic(tx)],
      [{ inputs: [], outputs: [{ satoshis: 900 }] }, atomic(tx)],
      [args(), undefined],
      [args(), [1, 2, 3]],
      [args(), Utils.toHex(atomic(tx))],
      // A coin the transaction does not spend, a coin named twice, an outpoint the wallet cannot read.
      [args(900, `${'00'.repeat(32)}.0`), atomic(tx)],
      [
        { inputs: [{ outpoint: mine.outpoint }, { outpoint: mine.outpoint }], outputs: [{ satoshis: 900 }] },
        atomic(tx),
      ],
      [args(900, `${mine.outpoint}0x`), atomic(tx)],
      // Amounts that are not satoshis (the manager's "all of it" sentinel included).
      [{ inputs: [{ outpoint: mine.outpoint }], outputs: [{ satoshis: -1 }] }, atomic(tx)],
      [{ inputs: [{ outpoint: mine.outpoint }], outputs: [{ satoshis: 1.5 }] }, atomic(tx)],
      [{ inputs: [{ outpoint: mine.outpoint }], outputs: [{ satoshis: 0x775f05a073fff }] }, atomic(tx)],
      [{ inputs: [{ outpoint: mine.outpoint }], outputs: [{ satoshis: '900' }] }, atomic(tx)],
      // More asked for than the transaction pays out.
      [args(5_000), atomic(tx)],
    ];
    for (const [a, t] of none) expect(callerSighashes(a as never, t)).toBeNull();
    // Naming the wallet's coin as well: the site brings 1,010, pays 900 + 110 fee, so nothing is taken.
    expect(
      callerSighashes(
        { inputs: [{ outpoint: mine.outpoint }, { outpoint: walletCoin.outpoint }], outputs: [{ satoshis: 900 }] },
        atomic(tx),
      ),
    ).toBeNull();
  });

  test('a caller whose host cannot be read stays refused, whatever it has pending', async () => {
    // The real manager refuses such an originator's createAction itself; the guard does not lean on that.
    const tx = build();
    const m = guardCrossSiteSigning(
      {
        getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
        ensureProtocolPermission: async () => true,
        ensureSpendingAuthorization: async () => true,
        createSignature: async () => ({ signature: [1] }),
        createAction: async () => ({ signableTransaction: { reference: 'r', tx: atomic(tx) } }),
      },
      ADMIN,
    );
    const sign = { hashToDirectlySign: sighash(tx, 0), protocolID: [1, 'app'], keyID: 'k' };
    for (const who of ['chrome_extension', 'not a host', '[::1]']) {
      expect(bareHost(who)).toBeNull();
      await m.createAction(args() as never, who);
      await expect(m.createSignature(sign as never, who)).rejects.toThrow(BLIND_SIGN_REFUSAL);
    }
    await m.createAction(args() as never, 'a.example');
    await expect(m.createSignature(sign as never, 'a.example')).resolves.toEqual({ signature: [1] });
  });

  test('what is signed is the copy that was checked, not an object the caller can still change', async () => {
    const tx = build();
    const signedWith: unknown[] = [];
    const m = guardCrossSiteSigning(
      {
        getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
        ensureProtocolPermission: async () => true,
        ensureSpendingAuthorization: async () => true,
        createSignature: async (a: unknown) => (signedWith.push(a), { signature: [1] }),
        createAction: async () => ({ signableTransaction: { reference: 'r', tx: atomic(tx) } }),
      },
      ADMIN,
    );
    await m.createAction(args() as never, 'a.example');
    const real = sighash(tx, 0);
    let reads = 0;
    // The first read is the real sighash; every later one another hash.
    const shifty = {
      protocolID: [1, 'app'],
      keyID: 'k',
      get hashToDirectlySign() {
        return reads++ === 0 ? real : Hash.hash256([6, 6, 6]);
      },
    };
    const outcome = await m.createSignature(shifty as never, 'a.example').then(
      () => 'signed',
      (e: Error) => e.message,
    );
    // Either refused, or signed over the real sighash: never over the other hash.
    if (outcome === 'signed')
      expect((signedWith[0] as { hashToDirectlySign: number[] }).hashToDirectlySign).toEqual(real);
    else expect(outcome).toBe(BLIND_SIGN_REFUSAL);
    expect(signedWith.length).toBeLessThanOrEqual(1);
  });

  test('caps: a site’s own oldest goes first, and no site’s loop pushes out another’s (R5)', async () => {
    const p = new PendingSighashes();
    const derive = async () => key.toPublicKey().toString();
    const answer = (site: string, sign: object, checks: Partial<SigningKeyChecks> = {}) =>
      p.request(site, sign, { granted: async () => true, derive, ...checks });
    const signFor = (tx: Transaction) => ({ hashToDirectlySign: sighash(tx, 0), protocolID: [1, 'app'], keyID: 'k' });
    const ask = async (tx: Transaction, site = 'a.example') => {
      const r = await answer(site, signFor(tx));
      return r !== null && 'sign' in r;
    };
    const victim = build(899);
    p.record('victim.example', args(899), { reference: 'victim', tx: atomic(victim) });
    const txs: Transaction[] = [];
    for (let i = 0; i < MAX_PENDING_ACTIONS + 5; i++) {
      const tx = build(800 - i);
      txs.push(tx);
      p.record('a.example', args(800 - i), { reference: `r${i}`, tx: atomic(tx) });
    }
    // One site holds at most its 8 newest; the other site's record is untouched.
    expect(p.size).toBe(MAX_PENDING_PER_SITE + 1);
    expect(await ask(victim, 'victim.example')).toBe(true);
    expect(await ask(txs[txs.length - MAX_PENDING_PER_SITE - 1])).toBe(false);
    expect(await ask(txs[txs.length - MAX_PENDING_PER_SITE])).toBe(true);
    expect(await ask(txs[txs.length - 1])).toBe(true);
    // Many sites together still stop at the overall cap (the oldest of all goes then).
    for (let i = 0; i < MAX_PENDING_ACTIONS; i++)
      p.record(`s${i}.example`, args(700 - i), { reference: `s${i}`, tx: atomic(build(700 - i)) });
    expect(p.size).toBe(MAX_PENDING_ACTIONS);
    // A reference recorded again replaces what it allowed.
    const last = txs[txs.length - 1];
    p.record('a.example', args(), { reference: `r${txs.length - 1}`, tx: atomic(build()) });
    expect(await ask(last)).toBe(false);
  });

  test('the grant comes first: without it nothing is looked up or derived, hit or miss (R3)', async () => {
    const p = new PendingSighashes();
    const tx = build();
    p.record('a.example', args(), { reference: 'r', tx: atomic(tx) });
    let derived = 0;
    const derive = async () => (derived++, key.toPublicKey().toString());
    const hit = { hashToDirectlySign: sighash(tx, 0), protocolID: [1, 'app'], keyID: 'k' };
    const miss = { ...hit, hashToDirectlySign: Hash.hash256([1]) };
    const asked: unknown[] = [];
    const none = { granted: async (k: unknown) => (asked.push(k), false), derive };
    expect(await p.request('a.example', hit, none)).toEqual({ refusal: 'ungranted' });
    expect(await p.request('a.example', miss, none)).toEqual({ refusal: 'ungranted' });
    expect(
      await p.request('a.example', hit, { granted: async () => Promise.reject(new Error('x')), derive }),
    ).toBeNull();
    expect(derived).toBe(0);
    // The grant is asked for exactly the key createSignature would use (no counterparty means 'anyone').
    expect(asked[0]).toEqual({ protocolID: [1, 'app'], keyID: 'k', counterparty: 'anyone' });
    // A site with nothing pending is not told about grants at all.
    expect(await p.request('b.example', hit, none)).toBeNull();
    // With the grant: a miss is the plain refusal and still derives nothing; a hit derives once and signs.
    const yes = { granted: async () => true, derive };
    expect(await p.request('a.example', miss, yes)).toBeNull();
    expect(derived).toBe(0);
    expect(await p.request('a.example', hit, yes)).toMatchObject({ sign: { keyID: 'k' } });
    expect(derived).toBe(1);
    // A key lookup that fails, or answers something that is not a key, allows nothing.
    expect(await p.request('a.example', hit, { ...yes, derive: async () => undefined })).toBeNull();
    expect(await p.request('a.example', hit, { ...yes, derive: async () => 'not a key' })).toBeNull();
    expect(
      await p.request('a.example', hit, { ...yes, derive: async () => Promise.reject(new Error('locked')) }),
    ).toBeNull();
    expect(await p.request('a.example', { ...hit, keyID: { toString: () => 'k' } }, yes)).toBeNull();
    expect(await p.request('a.example', { ...hit, counterparty: { toString: () => 'self' } }, yes)).toBeNull();
    // Signed or aborted while the grant was being checked: nothing to sign any more.
    const slow = { granted: async () => (p.settle('r'), true), derive };
    expect(await p.request('a.example', hit, slow)).toBeNull();
  });
});
