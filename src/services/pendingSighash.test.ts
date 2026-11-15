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
import { BLIND_SIGN_REFUSAL, bareHost, guardCrossSiteSigning, setProvenPairingCheck } from './crossSiteSignGuard';
import { guardEverySpendAsks } from './everySpendAsks';
import {
  MAX_PENDING_ACTIONS,
  PENDING_SIGHASH_TTL_MS,
  PendingSighashes,
  callerSighashes,
  lockKeyHash,
} from './pendingSighash';
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
const setup = (opts: { approve?: boolean; now?: () => number; signFails?: boolean } = {}) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const fundKey = PrivateKey.fromRandom();
  const sheets: Sheet[] = [];
  const sent: Transaction[] = [];
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
    const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, {}, {
      store: new InMemoryPermissionStore(),
    } as never);
    (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
      type: string;
      originator: string;
      spending?: { satoshis: number };
    }) => {
      sheets.push({ type: r.type, originator: r.originator, satoshis: r.spending?.satoshis });
      if (opts.approve === false) throw new Error('User denied');
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
    sent,
    as,
    keyOf,
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
  const chainKey = await w.keyOf(CHAIN_PROTOCOL, chainKeyID(keyId));
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
const tokenCoin = async (w: ReturnType<typeof setup>, keyID: string, protocolID = AMMO_PROTOCOL) => {
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
    const chainKey = await w.keyOf(CHAIN_PROTOCOL, chainKeyID('doc-1'));
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
    const anyoneKey = await w.keyOf(AMMO_PROTOCOL, 'k', 'anyone');
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

  test('a script whose key the wallet cannot read is refused: P2PK, bare multisig, a P2PKH with a tail, a lock', async () => {
    const w = setup();
    const publicKey = await w.keyOf(AMMO_PROTOCOL, 'k');
    const pub = Utils.toArray(publicKey, 'hex');
    const pkh = Hash.hash160(pub);
    const p2pkhChunks = p2pkh(publicKey).chunks;
    const scripts = [
      new LockingScript([{ op: pub.length, data: pub }, { op: OP.OP_CHECKSIG }]),
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

describe('only after the user (or the site’s envelope) approved the payment', () => {
  test('an action that takes nothing from the wallet shows no pay sheet, so its sighash stays refused', async () => {
    const w = setup();
    const key = await w.keyOf(AMMO_PROTOCOL, 'pot');
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
    const chainKey = await w.keyOf(CHAIN_PROTOCOL, chainKeyID('doc-1'));
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

  test('the oldest pending action goes when there are too many', async () => {
    const p = new PendingSighashes();
    const derive = async () => key.toPublicKey().toString();
    const txs: Transaction[] = [];
    for (let i = 0; i <= MAX_PENDING_ACTIONS; i++) {
      const tx = build(900 - i);
      txs.push(tx);
      p.record('a.example', args(900 - i), { reference: `r${i}`, tx: atomic(tx) });
    }
    expect(p.size).toBe(MAX_PENDING_ACTIONS);
    const allows = async (sign: object, d: () => Promise<string | undefined> = derive) =>
      (await p.request('a.example', sign, d)) !== null;
    const ask = (tx: Transaction) => allows({ hashToDirectlySign: sighash(tx, 0), protocolID: [1, 'app'], keyID: 'k' });
    expect(await ask(txs[0])).toBe(false);
    expect(await ask(txs[1])).toBe(true);
    // A reference recorded again replaces what it allowed.
    p.record('a.example', args(), { reference: 'r1', tx: atomic(build()) });
    expect(await ask(txs[1])).toBe(false);
    // A key lookup that fails, or answers something that is not a key, allows nothing.
    const sign = { hashToDirectlySign: sighash(txs[2], 0), protocolID: [1, 'app'], keyID: 'k' };
    expect(await allows(sign, async () => undefined)).toBe(false);
    expect(await allows(sign, async () => 'not a key')).toBe(false);
    expect(await allows(sign, async () => Promise.reject(new Error('locked')))).toBe(false);
    expect(await allows({ ...sign, keyID: { toString: () => 'k' } })).toBe(false);
    expect(await allows({ ...sign, counterparty: { toString: () => 'self' } })).toBe(false);
    expect(await allows(sign)).toBe(true);
  });
});
