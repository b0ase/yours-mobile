import {
  Hash,
  OP,
  P2PKH,
  PrivateKey,
  Script,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
} from '@bsv/sdk';
import { RUN_JIG_SATS } from './runGuard';
import { MAX_MOVES, outpoint, readRun, type GetTx } from './runIdentify';

/**
 * NFTs that were listed for sale on RelayX when it closed (owner promise on bwalletx.com/recover-relayx).
 *
 * How a RelayX listing works on chain (decoded from real txs, e.g. listing 7a679860… and its cancel 4a3aaac8…):
 *  - The listing is a Run tx whose one op is CALL jig.send(OrderLock(payTo, price)). The jig's new Run owner is an
 *    OrderLock object (class d6170025…_o1); its lock script is an sCrypt contract (OrderLock.scriptTemplate)
 *    with one field, hashOutput = sha256d(price LE8 + 0x19 + P2PKH(payTo)).
 *  - Output 0 is a 546-sat P2PKH "cancel baton" to one of the seller's addresses, output 1 the Run OP_RETURN,
 *    output 2 the order (the jig, now locked by the contract).
 *  - A buy spends the order with SIGHASH_SINGLE|ANYONECANPAY: output 0 must pay hashOutput. A cancel spends the
 *    order with isCancel = true and SIGHASH_NONE: the contract checks hashPrevouts = order + baton (listing tx,
 *    vout 0) and nothing else, so whoever can sign for the baton can cancel. There is no other seller key.
 *  - The cancel is itself a Run tx: CALL jig.send(address), with the jig's new Run state hash in "out". That hash
 *    is rebuilt here from the listing's state, which is only accepted when it hashes to the listing's own "out".
 *
 * Found from the user's keys: the baton sits at their address, so it is one of the dust outputs the scan already
 * reads. A listing whose baton was spent can't be cancelled by anyone and isn't found here.
 */

export const ORDER_LOCK = 'd6170025a62248d8df6dc14e3806e68b8df3d804c800c7bfb23b0b4232862505_o1';
export const RELAY_NFT = 'cdea2c203af755cd9477ca310c61021abaafc135a21d8f93b8ebfc6ca5f95712_o1';
/** OrderLock's deps (Base58, Hex, asm, sha256), referenced by every listing and cancel. */
export const ORDER_LOCK_DEPS = [
  '727e7b423b7ee40c0b5be87fba7fa5673ea2d20a74259040a7295d9c32a90011_o1',
  '81bcef29b0e4ed745f3422c0b764a33c76d0368af2d2e7dd139db8e00ee3d8a6_o1',
  '49145693676af7567ebe20671c5cb01369ac788c20f3b1c804f624a1eda18f3f_o1',
  '3b7ef411185bbe3d01caeadbe6f115b0103a546c4ef0ac7474aa6fbb71aff208_o1',
] as const;

/** OrderLock.scriptTemplate after its 33-byte hashOutput push (from the class's DEPLOY, tx d6170025…). */
const ORDER_LOCK_REST =
  '01c35279630142517a75547901687f7501447f77007901207f7504000000007e517951797e56797eaa577901247f75547f77' +
  '876975756754795579827758947f75557982770128947f77527987696861547921cdb285cc49e5ff3eed6536e7b426e8a528' +
  'b05bf9276bd05431a671743e651ceb002102dca1e194dd541a47f4c85fea6a4d45bb50f16ed2fddc391bf80b525454f8b409' +
  '20f941a26b1c1802eaa09109701e4e632e1ef730b0b68c9517e7c19be2ba4c7d37202f282d163597a82d72c263b004695297' +
  'aecb4d758dccd1dbf61e82a3360bde2c202cde0b36a3821ef6dbd1cc8d754dcbae97526904b063c2722da89735162d282f56' +
  '795679aa616100790079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f' +
  '517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e' +
  '7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679' +
  '5679537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00615179' +
  '51795179517997527a75517a5179009f635179517993527a75517a685179517a75517a7561527a75517a517951795296a063' +
  '0079527994527a75517a68537982775279827754527993517993013051797e527e53797e57797e527e52797e5579517f517f' +
  '517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f' +
  '517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e' +
  '7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7e56797e0079517a75517a75517a75517a75517a75517a75517a75517a75' +
  '517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a756177777777' +
  '77';

/** The order's lock script for a listing that pays `price` sats to `payTo`. */
export function orderLockHex(payTo: string, price: number): string {
  const w = new Utils.Writer();
  w.writeUInt64LE(price);
  const pay = new P2PKH().lock(payTo).toBinary();
  w.writeVarIntNum(pay.length);
  w.write(pay);
  return '20' + Utils.toHex(Hash.hash256(w.toArray())) + ORDER_LOCK_REST;
}

/** Run's state JSON: keys sorted the Run way (integer keys first, numerically), no spaces. */
const cmpKeys = (a: string, b: string) => {
  const ai = String(parseInt(a, 10)) === a;
  const bi = String(parseInt(b, 10)) === b;
  if (ai && !bi) return -1;
  if (bi && !ai) return 1;
  if (ai && bi) return parseInt(a, 10) - parseInt(b, 10);
  return a < b ? -1 : b < a ? 1 : 0;
};
export function runStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : runStringify(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort(cmpKeys)
    .map((k) => `${JSON.stringify(k)}:${runStringify(o[k])}`)
    .join(',')}}`;
}
export const runStateHash = (state: unknown) => Utils.toHex(Hash.sha256(Utils.toArray(runStringify(state), 'utf8')));

export type RunState = { cls: { $jig: string }; kind: 'jig'; props: Record<string, unknown>; version: '04' };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const p2pkhAddress = (s: Script): string | null => {
  const b = s.toBinary();
  if (b.length !== 25 || b[0] !== OP.OP_DUP || b[1] !== OP.OP_HASH160 || b[2] !== 20 || b[23] !== OP.OP_EQUALVERIFY)
    return null;
  return b[24] === OP.OP_CHECKSIG ? Utils.toBase58Check(b.slice(3, 23), [0]) : null;
};

/** A RelayX listing tx, as read from chain. `problem`: why it can't be cancelled here (shown, never guessed past). */
export type ListingTx = {
  txid: string;
  orderVout: number;
  orderSats: number;
  orderScript: string;
  price: number;
  payTo: string;
  batonSats: number;
  batonAddress: string;
  /** The jig's Run state hash after the listing (the listing's "out"). */
  stateHash: string;
  refs: string[];
  /** Where the jig was before the listing. */
  jigFrom: { txid: string; vout: number };
  problem?: string;
};

/** Is this tx a RelayX listing (one jig sent to an OrderLock)? null when it isn't one at all. */
export function readListingTx(tx: Transaction): ListingTx | null {
  const r = readRun(tx);
  if (!r) return null;
  const { run } = r;
  const op = run.exec?.length === 1 ? run.exec[0] : null;
  const data = op?.op === 'CALL' && Array.isArray(op.data) ? (op.data as unknown[]) : null;
  if (!data || data[1] !== 'send' || !Array.isArray(data[2]) || data[2].length !== 1) return null;
  const arg = data[2][0];
  const arb = isObj(arg) && isObj(arg.$arb) ? arg.$arb : null;
  const t = isObj(arg) && isObj(arg.T) ? arg.T.$jig : null;
  const refs = run.ref ?? [];
  if (!arb || typeof t !== 'number' || refs[t - run.in] !== ORDER_LOCK) return null;
  const payTo = arb.address;
  const price = arb.satoshis;
  if (typeof payTo !== 'string' || typeof price !== 'number' || !Number.isSafeInteger(price)) return null;
  const txid = tx.id('hex');
  const orderVout = r.firstJig;
  const order = tx.outputs[orderVout];
  const baton = tx.outputs[0];
  const input = tx.inputs[0];
  const base: ListingTx = {
    txid,
    orderVout,
    orderSats: order?.satoshis ?? 0,
    orderScript: order?.lockingScript.toHex() ?? '',
    price,
    payTo,
    batonSats: baton?.satoshis ?? 0,
    batonAddress: (baton && p2pkhAddress(baton.lockingScript)) ?? '',
    stateHash: run.out?.[0] ?? '',
    refs,
    jigFrom: { txid: input?.sourceTXID ?? '', vout: input?.sourceOutputIndex ?? -1 },
  };
  const odd = (why: string): ListingTx => ({ ...base, problem: why });
  if (run.in !== 1 || !isObj(data[0]) || data[0].$jig !== 0) return odd('It moves more than one NFT.');
  if ((run.out?.length ?? 0) !== 1 || (run.cre?.length ?? 0) !== 0 || ((run as { del?: unknown[] }).del?.length ?? 0))
    return odd("Its Run record isn't the usual RelayX listing.");
  if (r.firstJig !== 2 || !base.batonAddress) return odd("It has no RelayX cancel output where we'd expect one.");
  if (base.orderScript !== orderLockHex(payTo, price)) return odd("Its lock script isn't RelayX's OrderLock.");
  if (!base.jigFrom.txid) return odd("Couldn't read where it came from.");
  return base;
}

/** The highest RelayX card number tried when rebuilding a numbered NFT's state. */
export const MAX_NO = 20_000;

/** The jig's Run state at the listing, rebuilt from its history and checked against the listing's hash. */
export async function listingState(
  l: ListingTx,
  getTx: GetTx,
  maxMoves = MAX_MOVES,
): Promise<{ state: RunState; origin: string } | { problem: string }> {
  let { txid, vout } = l.jigFrom;
  const owners = new Set<string>();
  for (let hops = 1; hops <= maxMoves; hops++) {
    const tx = await getTx(txid);
    const r = readRun(tx);
    if (!r) return { problem: 'Its history has a non-Run transaction.' };
    const k = vout - r.firstJig;
    if (k < 0) return { problem: "Its history doesn't add up." };
    const ops = r.run.exec ?? [];
    if (hops === 1) {
      // Who owned it just before the listing: RelayNFT.send stores that as `sender`.
      for (const o of ops) {
        const d = Array.isArray(o.data) ? (o.data as unknown[]) : [];
        if (o.op === 'CALL' && Array.isArray(d[2]) && typeof d[2][0] === 'string' && d[2][0]) owners.add(d[2][0]);
      }
      for (const c of r.run.cre ?? []) if (typeof c === 'string') owners.add(c);
      const a = tx.outputs[vout] && p2pkhAddress(tx.outputs[vout].lockingScript);
      if (a) owners.add(a);
    }
    if (k < (r.run.in ?? 0)) {
      const input = tx.inputs[k];
      if (!input?.sourceTXID) return { problem: "Couldn't follow its history." };
      txid = input.sourceTXID;
      vout = input.sourceOutputIndex;
      continue;
    }
    // The mint: RelayNFT.mint(owner, metadata) on its class, one NFT out.
    const d = ops.length === 1 && ops[0].op === 'CALL' && Array.isArray(ops[0].data) ? (ops[0].data as unknown[]) : [];
    const c = isObj(d[0]) ? d[0].$jig : undefined;
    const args = Array.isArray(d[2]) ? (d[2] as unknown[]) : [];
    if (
      d[1] !== 'mint' ||
      typeof c !== 'number' ||
      c >= r.run.in ||
      k !== r.run.in ||
      (r.run.out?.length ?? 0) !== r.run.in + 1
    )
      return { problem: "It wasn't minted the usual RelayX way." };
    if (typeof args[0] === 'string' && args[0]) owners.add(args[0]);
    const meta = args[1] === undefined ? {} : args[1];
    if (!isObj(meta)) return { problem: 'Its details are in a form we can’t rebuild.' };
    const origin = outpoint(txid, vout);
    const cls = { $jig: outpoint(txid, r.firstJig + c) };
    const owner = { $arb: { address: l.payTo, satoshis: l.price }, T: { $jig: ORDER_LOCK } };
    const tries = typeof meta.no === 'number' ? [meta.no] : [];
    for (let n = 0; n <= MAX_NO; n++) tries.push(n);
    for (const sender of owners)
      for (const no of tries) {
        const metadata = no ? { ...meta, no } : { ...meta };
        const props: Record<string, unknown> = {
          location: '_o2',
          nonce: hops + 1,
          origin,
          owner,
          satoshis: 0,
          sender,
          metadata,
        };
        if (no) props.no = no;
        const state: RunState = { cls, kind: 'jig', props, version: '04' };
        if (runStateHash(state) === l.stateHash) return { state, origin };
      }
    return { problem: "Couldn't rebuild its Run state exactly, so a cancel can't be checked." };
  }
  return { problem: `It has moved more than ${maxMoves} times.` };
}

export const CANCEL_FEE_PER_KB = 100;
/** Hard ceiling on the cancel's fee: anything above this fails closed rather than being shown. */
export const MAX_CANCEL_FEE = 2_000;
/** The Run app name written in the cancel's OP_RETURN (any string is valid Run). */
export const CANCEL_APP = 'bwalletx';

export type CancelPlan = {
  tx: Transaction;
  /** Where the NFT goes: the address that holds the listing's cancel output (the user's). */
  to: string;
  fee: number;
  /** BSV back to `to` after the fee (the order's sats + the baton, less the NFT's 273 and the fee). */
  change: number;
};

const SCOPE_NONE = TransactionSignature.SIGHASH_NONE | TransactionSignature.SIGHASH_FORKID;

/** Does input i run true against its source output? */
export function inputValid(tx: Transaction, i: number): boolean {
  const input = tx.inputs[i];
  const src = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  if (!src || !input.unlockingScript) return false;
  try {
    return new Spend({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: src.satoshis ?? 0,
      lockingScript: src.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      outputs: tx.outputs,
      inputIndex: i,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
  } catch {
    return false;
  }
}

/** The Run cancel payload: jig.send(to), with the new state's hash. */
export function cancelPayload(l: ListingTx, state: RunState, to: string) {
  const next: RunState = {
    ...state,
    props: {
      ...state.props,
      location: '_o1',
      nonce: (state.props.nonce as number) + 1,
      owner: to,
      sender: state.props.owner,
    },
  };
  const ref = [state.cls.$jig, RELAY_NFT, ORDER_LOCK, ...ORDER_LOCK_DEPS];
  if ([...ref].sort().join() !== [...l.refs].sort().join())
    throw new Error("Its Run references aren't the usual RelayX set.");
  return {
    in: 1,
    ref,
    out: [runStateHash(next)],
    del: [],
    cre: [],
    exec: [{ op: 'CALL', data: [{ $jig: 0 }, 'send', [to]] }],
  };
}

export function cancelScript(payload: unknown, app = CANCEL_APP): Script {
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('run', 'utf8'))
    .writeBin([5])
    .writeBin(Utils.toArray(app, 'utf8'))
    .writeBin(Utils.toArray(JSON.stringify(payload), 'utf8'));
}

/**
 * Build and sign the cancel, never broadcast here. Inputs: the order (OrderLock, isCancel) and the baton (P2PKH,
 * signed with `wif`). Outputs: the Run payload, the NFT (273 sats) and the change, all to the baton's address.
 * The order and baton pay the fee; nothing else of the wallet's is spent. Both inputs are run through the script
 * interpreter before it is returned; anything that doesn't check out throws.
 */
export async function buildCancel(
  l: ListingTx,
  listing: Transaction,
  state: RunState,
  wif: string,
  opts: { feePerKb?: number; app?: string } = {},
): Promise<CancelPlan> {
  if (l.problem) throw new Error(l.problem);
  if (listing.id('hex') !== l.txid) throw new Error('Wrong listing transaction.');
  const key = PrivateKey.fromWif(wif);
  const to = key.toAddress();
  if (to !== l.batonAddress) throw new Error("This key doesn't hold the listing's cancel output.");
  const opReturn = cancelScript(cancelPayload(l, state, to), opts.app);
  const feePerKb = opts.feePerKb ?? CANCEL_FEE_PER_KB;
  const total = l.orderSats + l.batonSats;

  const make = (change: number, lockTime: number) => {
    const tx = new Transaction(1, [], [], lockTime);
    tx.addInput({
      sourceTransaction: listing,
      sourceOutputIndex: l.orderVout,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    });
    tx.addInput({
      sourceTransaction: listing,
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    tx.addOutput({ lockingScript: opReturn, satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: RUN_JIG_SATS });
    if (change > 0) tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: change });
    return tx;
  };
  const unlockOrder = (tx: Transaction) => {
    const preimage = TransactionSignature.format({
      sourceTXID: l.txid,
      sourceOutputIndex: l.orderVout,
      sourceSatoshis: l.orderSats,
      transactionVersion: tx.version,
      otherInputs: [tx.inputs[1]],
      outputs: tx.outputs,
      inputIndex: 0,
      subscript: Script.fromHex(l.orderScript),
      inputSequence: 0xffffffff,
      lockTime: tx.lockTime,
      scope: SCOPE_NONE,
    });
    // unlock(preimage, trailingPrevouts = "", isCancel = true)
    tx.inputs[0].unlockingScript = new UnlockingScript().writeBin(preimage).writeOpCode(OP.OP_0).writeOpCode(OP.OP_1);
  };

  // Size with the change output (the order's unlock is ~950 bytes, the baton's ~107).
  const probe = make(1, 0);
  unlockOrder(probe);
  await probe.sign();
  const fee = Math.max(1, Math.ceil((probe.toBinary().length * feePerKb) / 1000));
  if (fee > MAX_CANCEL_FEE) throw new Error(`The cancel's fee (${fee} sats) is higher than expected, so it wasn't made.`);
  const change = total - RUN_JIG_SATS - fee;
  if (change < 0) throw new Error(`The listing holds ${total} sats, not enough for the NFT and the ${fee}-sat fee.`);
  // OP_PUSH_TX in the contract can refuse a few preimages: a different lock time gives a different one.
  for (let lockTime = 0; lockTime < 16; lockTime++) {
    const tx = make(change, lockTime);
    unlockOrder(tx);
    await tx.sign();
    const toUser = tx.outputs.slice(1).every((o) => p2pkhAddress(o.lockingScript) === to);
    const spent = total - tx.outputs.reduce((n, o) => n + (o.satoshis ?? 0), 0);
    if (!toUser || spent !== fee || tx.outputs[0].satoshis !== 0) throw new Error("The cancel's outputs didn't check out.");
    if (inputValid(tx, 0) && inputValid(tx, 1)) return { tx, to, fee, change };
  }
  throw new Error("The cancel didn't check out against the order's script, so it wasn't made.");
}
