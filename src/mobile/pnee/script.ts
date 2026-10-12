/**
 * PNEE vault scripts without sCrypt (owner, 12 Oct 2026).
 *
 * bwalletx-bond compiles BondVault and BondToken and exports the templates (`pnpm kit` → kit/pnee-kit.json,
 * pinned here by sha256 in script.test.ts). This file fills a template the way sCrypt does, reads and writes the
 * contract state, and builds the unlocking scripts for each spend path. Every function is checked byte for byte
 * against the golden transactions in kit/pnee-vectors.json, and those transactions are run through the
 * @bsv/sdk interpreter.
 *
 * Nothing here signs or sends anything: signatures come in as arguments.
 */
import { Hash, LockingScript, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk';
import KIT from './kit/pnee-kit.json';

export const SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID; // 0x41
export { KIT };

/** The PNEE deployment parameters, as compiled into every vault this wallet opens. */
export const PNEE = {
  unitCents: BigInt(KIT.params.unitCents), // 1 PNEE = 1¢
  minRatioPct: BigInt(KIT.params.minRatioPct), // 1000 = mint up to 10x
  liqRatioPct: BigInt(KIT.params.liqRatioPct), // 150
  liqDiscountPct: BigInt(KIT.params.liqDiscountPct), // 10
  feeBps: BigInt(KIT.params.feeBps), // 0: no fee
  minVaultCents: BigInt(KIT.params.minVaultCents),
  maxPriceAge: BigInt(KIT.params.maxPriceAge),
} as const;

const hex = (b: number[]) => Utils.toHex(b);
const bytes = (h: string) => Utils.toArray(h, 'hex');

/** Minimal little-endian sign-magnitude bytes of a script number (0 → []). */
export function intBytes(n: bigint): number[] {
  if (n === 0n) return [];
  const neg = n < 0n;
  let a = neg ? -n : n;
  const out: number[] = [];
  while (a > 0n) {
    out.push(Number(a & 0xffn));
    a >>= 8n;
  }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0);
  else if (neg) out[out.length - 1] |= 0x80;
  return out;
}

/** Push of raw bytes, smallest form. */
export function pushBytes(b: number[]): string {
  const n = b.length;
  if (n === 0) return '00';
  if (n < 0x4c) return hex([n, ...b]);
  if (n <= 0xff) return hex([0x4c, n, ...b]);
  if (n <= 0xffff) return hex([0x4d, n & 0xff, n >> 8, ...b]);
  return hex([0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24, ...b]);
}

/** Push of an int the way sCrypt writes one: OP_0, OP_1NEGATE, OP_1..OP_16, else the minimal bytes. */
export function pushInt(n: bigint): string {
  if (n === 0n) return '00';
  if (n === -1n) return '4f';
  if (n >= 1n && n <= 16n) return (0x50 + Number(n)).toString(16);
  return pushBytes(intBytes(n));
}

function varint(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8];
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
}
const writeBytes = (b: number[]) => [...varint(b.length), ...b];
const writeInt = (n: bigint) => writeBytes(n === 0n ? [0] : intBytes(n));
const writeBool = (v: boolean) => [v ? 1 : 0];

/** sCrypt state section: data ‖ len (4 LE) ‖ version 0. */
function serializeState(data: number[]): string {
  const n = data.length;
  return hex([...data, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24, 0]);
}

/** Split a stateful locking script into its code (ending OP_RETURN) and its state bytes. */
export function splitState(scriptHex: string): { code: string; state: number[] } {
  const b = bytes(scriptHex);
  if (b.length < 6 || b[b.length - 1] !== 0) throw new Error('Not a stateful script');
  const n = b[b.length - 5] | (b[b.length - 4] << 8) | (b[b.length - 3] << 16) | (b[b.length - 2] << 24);
  const start = b.length - 5 - n;
  if (start < 1) throw new Error('Bad state length');
  return { code: hex(b.slice(0, start)), state: b.slice(start, b.length - 5) };
}

class Reader {
  i = 0;
  constructor(private b: number[]) {}
  bool() {
    return this.b[this.i++] === 1;
  }
  raw() {
    let n = this.b[this.i++];
    if (n === 0xfd) {
      n = this.b[this.i] | (this.b[this.i + 1] << 8);
      this.i += 2;
    } else if (n === 0xfe) {
      n = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24);
      this.i += 4;
    }
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  int() {
    const b = this.raw();
    if (b.length === 0) return 0n;
    let n = 0n;
    for (let k = b.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(k === b.length - 1 ? b[k] & 0x7f : b[k]);
    return b[b.length - 1] & 0x80 ? -n : n;
  }
  done() {
    return this.i === this.b.length;
  }
}

// ── Vault ───────────────────────────────────────────────────────────────────────────────────────────────

export type VaultConfig = {
  owner: string; // compressed pubkey hex
  issuer: string;
  oracles: bigint[]; // 5 Rabin moduli
  openTs: bigint;
};

export type VaultState = { debt: bigint; lastTs: bigint; feeCents: bigint; feeTs: bigint };

function fillTemplate(tpl: string, values: Record<string, string>): string {
  const out = tpl.replace(/<([^>]+)>/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`No value for <${name}>`);
    return v;
  });
  return out;
}

/** Code part of a PNEE vault (everything up to and including OP_RETURN) for this owner. */
export function vaultCode(c: VaultConfig): string {
  if (c.oracles.length !== 5) throw new Error('A vault needs 5 price signer keys');
  const P = PNEE;
  const values: Record<string, string> = {
    owner: pushBytes(bytes(c.owner)),
    issuer: pushBytes(bytes(c.issuer)),
    bondCode: pushBytes(bytes(KIT.bondCode)),
    minRatioPct: pushInt(P.minRatioPct),
    liqRatioPct: pushInt(P.liqRatioPct),
    liqDiscountPct: pushInt(P.liqDiscountPct),
    feeBps: pushInt(P.feeBps),
    minVaultCents: pushInt(P.minVaultCents),
    maxPriceAge: pushInt(P.maxPriceAge),
    unitCents: pushInt(P.unitCents),
    openTs: pushInt(c.openTs),
  };
  c.oracles.forEach((n, i) => (values[`oracles[${i}]`] = pushInt(n)));
  return fillTemplate(KIT.vault.hex, values) + '6a';
}

/** A vault's locking script. `state` undefined = the genesis script a new vault is deployed with. */
export function vaultScript(c: VaultConfig, state?: VaultState): string {
  const data = state
    ? [
        ...writeBool(false),
        ...writeInt(state.debt),
        ...writeInt(state.lastTs),
        ...writeInt(state.feeCents),
        ...writeInt(state.feeTs),
      ]
    : [...writeBool(true), ...writeInt(0n), ...writeInt(0n), ...writeInt(0n), ...writeInt(0n)];
  return vaultCode(c) + serializeState(data);
}

/**
 * State of a vault script. A genesis script holds zeros: the contract sets lastTs and feeTs to openTs on its
 * first spend, so that is what the state means.
 */
export function vaultState(scriptHex: string, openTs: bigint): VaultState & { genesis: boolean } {
  const r = new Reader(splitState(scriptHex).state);
  const genesis = r.bool();
  const s = { debt: r.int(), lastTs: r.int(), feeCents: r.int(), feeTs: r.int() };
  if (!r.done()) throw new Error('Unexpected vault state');
  return genesis ? { genesis, debt: 0n, lastTs: openTs, feeCents: 0n, feeTs: openTs } : { genesis, ...s };
}

/** True when the script is a PNEE vault for this config (any state). */
export const isVaultScript = (scriptHex: string, c: VaultConfig) => {
  try {
    return splitState(scriptHex).code === vaultCode(c);
  } catch {
    return false;
  }
};

// ── BondToken (PNEEs) ──────────────────────────────────────────────────────────────────────────────────

/** A PNEE token output: `amount` PNEEs (cents) held by `holder` (pubkey hex). */
export function tokenScript(holder: string, amount: bigint): string {
  return KIT.bondCode + serializeState([...writeBool(false), ...writeBytes(bytes(holder)), ...writeInt(amount)]);
}

/** Holder and amount of a PNEE token script, or null when it isn't one. */
export function tokenState(scriptHex: string): { holder: string; amount: bigint } | null {
  try {
    const { code, state } = splitState(scriptHex);
    if (code !== KIT.bondCode) return null;
    const r = new Reader(state);
    r.bool();
    const holder = hex(r.raw());
    const amount = r.int();
    return r.done() && amount > 0n ? { holder, amount } : null;
  } catch {
    return null;
  }
}

/** The close / liquidate burn receipt (output 0): OP_FALSE OP_RETURN 'bwxburn' ‖ vault outpoint ‖ amount. */
export function burnReceiptScript(vaultTxid: string, vout: number, amount: bigint): string {
  const outpoint = [...bytes(vaultTxid).reverse(), vout & 0xff, (vout >> 8) & 0xff, (vout >> 16) & 0xff, vout >>> 24];
  const amt: number[] = [];
  let a = amount;
  for (let i = 0; i < 8; i++) {
    amt.push(Number(a & 0xffn));
    a >>= 8n;
  }
  return '006a' + pushBytes([...Utils.toArray('bwxburn', 'utf8'), ...outpoint, ...amt]);
}

// ── Spends ─────────────────────────────────────────────────────────────────────────────────────────────

/** Outputs after the contract's fixed ones (the funding wallet's change), serialized for `restOutputs`. */
export function serializeOutputs(outs: { satoshis?: number; lockingScript: LockingScript }[]): string {
  const out: number[] = [];
  for (const o of outs) {
    let v = BigInt(o.satoshis ?? 0);
    for (let i = 0; i < 8; i++) {
      out.push(Number(v & 0xffn));
      v >>= 8n;
    }
    const s = o.lockingScript.toBinary();
    out.push(...varint(s.length), ...s);
  }
  return hex(out);
}

/** The BIP143-style preimage the contract checks (OP_PUSH_TX), for input `i` of `tx`. */
export function preimage(tx: Transaction, i: number, sourceSatoshis: number, sourceScript: string): number[] {
  const input = tx.inputs[i];
  return TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    inputIndex: i,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: LockingScript.fromHex(sourceScript),
    lockTime: tx.lockTime,
    scope: SIGHASH,
  });
}

/** The digest a signer signs for that preimage (hashToDirectlySign). */
export const sighashDigest = (pre: number[]) => Hash.sha256(Hash.sha256(pre));

/** DER signature + sighash byte, as a script push. */
const pushSig = (der: number[]) => pushBytes([...der, SIGHASH]);

export type PriceProof = {
  ts: bigint;
  prices: [bigint, bigint, bigint];
  idx: [bigint, bigint, bigint];
  sigs: [bigint, bigint, bigint];
  paddings: [string, string, string];
};

const pushProof = (p: PriceProof) =>
  pushInt(p.ts) +
  p.prices.map(pushInt).join('') +
  p.idx.map(pushInt).join('') +
  p.sigs.map(pushInt).join('') +
  p.paddings.map((x) => pushBytes(bytes(x))).join('');

const unlock = (h: string) => UnlockingScript.fromHex(h);

export const vaultUnlock = {
  topUp: (sig: number[], addSats: bigint, rest: string, pre: number[]) =>
    unlock(pushSig(sig) + pushInt(addSats) + pushBytes(bytes(rest)) + pushBytes(pre) + pushInt(0n)),
  mint: (sig: number[], amount: bigint, price: PriceProof, rest: string, pre: number[]) =>
    unlock(pushSig(sig) + pushInt(amount) + pushProof(price) + pushBytes(bytes(rest)) + pushBytes(pre) + pushInt(1n)),
  close: (ownerSig: number[], issuerSig: number[], burned: bigint, rest: string, pre: number[]) =>
    unlock(
      pushSig(ownerSig) + pushSig(issuerSig) + pushInt(burned) + pushBytes(bytes(rest)) + pushBytes(pre) + pushInt(2n),
    ),
};

export const tokenUnlock = {
  transfer: (sig: number[], to: string, amount: bigint, rest: string, pre: number[]) =>
    unlock(
      pushSig(sig) + pushBytes(bytes(to)) + pushInt(amount) + pushBytes(bytes(rest)) + pushBytes(pre) + pushInt(0n),
    ),
  burn: (sig: number[], pre: number[]) => unlock(pushSig(sig) + pushBytes(pre) + pushInt(1n)),
};

/** Upper bounds for createAction's unlockingScriptLength (preimage ≈ the locking script + 200 bytes). */
export const unlockLength = (lockingScriptBytes: number, restBytes = 400) => lockingScriptBytes + restBytes + 2_500;
