import { Utils } from '@bsv/sdk';

/**
 * Money Button (moneybutton.com, Yours Inc, 2018 to 2022): the import side of "Sweep from another wallet".
 *
 * Keys: a 12-word BIP39 phrase (optional passphrase), BIP44 account m/44'/0'/0', receive chain only
 * (Money Button docs, "Mnemonics (BIP39)": "Money Button uses the wallet path m/44'/0'/0'" and
 * "Money Button does not use internal addresses"). The HD sweep already walks that account with the
 * BIP44 gap limit, so Money Button needs no new derivation, only a name and the token guard below.
 *
 * Tokens: Money Button "assets" used the Simple Fabriik Protocol for Tokens (SFP). An SFP output is
 * a ~546-sat output whose locking script is
 *   OP_NOP <"sfp@0.x"> <asset paymail> <authoriser/owner/issuer hash160s> ... OP_RETURN <8-byte LE amount + notes>
 * and it can only be spent with the authoriser's signature (Fabriik's server, now gone). So the owner
 * can neither move nor burn these alone; the danger is a sweep that treats the output as plain BSV.
 * We detect SFP outputs, keep them out of every BSV sweep, and list them.
 *
 * Sources: archived docs.moneybutton.com/docs/sfp/protocol-overview.html,
 * .../sfp/wallets-integration-guide.html and .../sfp/paymail-09-sfp-build.html (June 2021).
 */
export const MONEYBUTTON_PATH = "m/44'/0'/0'";

export type SfpOutput = {
  outpoint: string;
  satoshis: number;
  version: string;
  asset: string;
  amount: bigint;
  notes: string;
  /** hash160s (hex) pushed in the configuration section: authoriser, owner, issuer. */
  hashes: string[];
};

type Push = { op: number; data?: number[] };

/** Minimal script splitter: opcodes and pushes, with everything after a top-level OP_RETURN as pushes. */
function chunks(script: number[]): Push[] {
  const out: Push[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let len = -1;
    if (op > 0 && op < 0x4c) len = op;
    else if (op === 0x4c) len = script[i++];
    else if (op === 0x4d) {
      len = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16)) + script[i + 3] * 2 ** 24;
      i += 4;
    }
    if (len >= 0) {
      if (i + len > script.length) throw new Error('truncated push');
      out.push({ op, data: script.slice(i, i + len) });
      i += len;
    } else out.push({ op });
  }
  return out;
}

const text = (d?: number[]) => (d ? Utils.toUTF8(d) : '');

/** Is this locking script a plain P2PKH (the only kind a BSV sweep may spend)? */
export const isP2pkh = (scriptHex: string) => /^76a914[0-9a-f]{40}88ac$/i.test(scriptHex);

/** Parse an SFP token locking script, or null when it isn't one. */
export function parseSfp(scriptHex: string): Omit<SfpOutput, 'outpoint' | 'satoshis'> | null {
  if (!/^61/i.test(scriptHex)) return null;
  let cs: Push[];
  try {
    cs = chunks(Utils.toArray(scriptHex, 'hex'));
  } catch {
    return null;
  }
  // "at least 9 chunks and the second one contains a string that matches sfp@*" (integration guide)
  if (cs.length < 9 || cs[0].op !== 0x61) return null;
  const version = text(cs[1].data);
  if (!/^sfp@/i.test(version)) return null;
  const asset = text(cs[2].data);
  const hashes: string[] = [];
  for (const c of cs.slice(3)) {
    if (c.data?.length === 20) hashes.push(Utils.toHex(c.data));
    else break;
  }
  const ret = cs.findIndex((c) => c.op === 0x6a);
  const data = ret >= 0 ? cs[ret + 1]?.data : undefined;
  let amount = 0n;
  let notes = '';
  if (data && data.length >= 8) {
    for (let b = 7; b >= 0; b--) amount = (amount << 8n) | BigInt(data[b]);
    notes = text(data.slice(8))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]+/g, ' ')
      .trim();
  }
  return { version, asset, amount, notes, hashes };
}

/** hash160 (hex) of a P2PKH address, to match against SFP owner pushes. */
export const addressHash = (address: string) => Utils.toHex(Utils.fromBase58Check(address).data as number[]);

/** SFP outputs in a raw transaction that name one of `hashes` (our addresses' hash160s). */
export function sfpOutputsFor(txHex: string, txid: string, hashes: Set<string>): SfpOutput[] {
  const found: SfpOutput[] = [];
  const outs = txOutputs(txHex);
  outs.forEach((o, vout) => {
    const p = parseSfp(o.script);
    if (p && p.hashes.some((h) => hashes.has(h)))
      found.push({ ...p, outpoint: `${txid}_${vout}`, satoshis: o.satoshis });
  });
  return found;
}

/** Outputs (value + script hex) of a raw transaction. */
export function txOutputs(txHex: string): { satoshis: number; script: string }[] {
  const r = new Utils.Reader(Utils.toArray(txHex, 'hex'));
  r.read(4);
  const nIn = r.readVarIntNum();
  for (let i = 0; i < nIn; i++) {
    r.read(36);
    r.read(r.readVarIntNum());
    r.read(4);
  }
  const nOut = r.readVarIntNum();
  const outs: { satoshis: number; script: string }[] = [];
  for (let i = 0; i < nOut; i++) {
    const satoshis = r.readUInt64LEBn().toNumber();
    outs.push({ satoshis, script: Utils.toHex(r.read(r.readVarIntNum())) });
  }
  return outs;
}

/**
 * Split prepared sweep inputs: plain P2PKH coins may be swept as BSV; anything else (SFP tokens,
 * unknown scripts) is kept back, so a sweep never spends something it doesn't understand.
 */
export function splitSpendable<T extends { outpoint: string; lockingScript: string }>(
  inputs: T[],
  protectedOutpoints: Set<string> = new Set(),
): { spendable: T[]; kept: T[] } {
  const spendable: T[] = [];
  const kept: T[] = [];
  for (const i of inputs) (isP2pkh(i.lockingScript) && !protectedOutpoints.has(i.outpoint) ? spendable : kept).push(i);
  return { spendable, kept };
}
