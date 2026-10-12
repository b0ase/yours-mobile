// PNEE vaults, server side (owner, 12 Oct 2026). The bwallet.space API (api/pnee.js) runs the five price signers
// and the burn attester, and keeps the public list of vaults that bwalletx.com/backing shows.
//
// Every rule here is mechanical and checked against the chain:
//  - a vault is an output whose script is the PNEE vault template filled with THIS server's issuer and signer keys;
//  - a PNEE token is genuine if it is output 1 of a vault mint, or an output of a token send whose token input
//    was genuine (each step checked on submit);
//  - the attester co-signs a close only when output 0 burns at least the vault's PNEEs, the token inputs are
//    genuine and add up to at least that, and the transaction creates no new token outputs.
//
// Keys come only from the environment (never from code): PNEE_ISSUER_KEY (secp256k1, hex),
// PNEE_ORACLE_1 … PNEE_ORACLE_5 ("<p hex>:<q hex>", Rabin primes). `bwalletx-bond pnpm signers` makes them.
const crypto = require('node:crypto');
const { PrivateKey, Transaction, TransactionSignature, LockingScript, Hash, Utils } = require('@bsv/sdk');
const KIT = require('./pnee-kit.json');

const SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
const P = Object.fromEntries(Object.entries(KIT.params).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));
const hex = (b) => Utils.toHex(b);
const bytes = (h) => Utils.toArray(h, 'hex');

// ── script encoding (mirrors src/mobile/pnee/script.ts; both are tested against the same vectors) ──
function intBytes(n) {
  if (n === 0n) return [];
  const neg = n < 0n;
  let a = neg ? -n : n;
  const out = [];
  while (a > 0n) {
    out.push(Number(a & 0xffn));
    a >>= 8n;
  }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0);
  else if (neg) out[out.length - 1] |= 0x80;
  return out;
}
function pushBytes(b) {
  const n = b.length;
  if (n === 0) return '00';
  if (n < 0x4c) return hex([n, ...b]);
  if (n <= 0xff) return hex([0x4c, n, ...b]);
  if (n <= 0xffff) return hex([0x4d, n & 0xff, n >> 8, ...b]);
  return hex([0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24, ...b]);
}
function pushInt(n) {
  if (n === 0n) return '00';
  if (n === -1n) return '4f';
  if (n >= 1n && n <= 16n) return (0x50 + Number(n)).toString(16);
  return pushBytes(intBytes(n));
}

function vaultCode({ owner, issuer, oracles, openTs }) {
  const values = {
    owner: pushBytes(bytes(owner)),
    issuer: pushBytes(bytes(issuer)),
    bondCode: pushBytes(bytes(KIT.bondCode)),
    minRatioPct: pushInt(P.minRatioPct),
    liqRatioPct: pushInt(P.liqRatioPct),
    liqDiscountPct: pushInt(P.liqDiscountPct),
    feeBps: pushInt(P.feeBps),
    minVaultCents: pushInt(P.minVaultCents),
    maxPriceAge: pushInt(P.maxPriceAge),
    unitCents: pushInt(P.unitCents),
    openTs: pushInt(BigInt(openTs)),
  };
  oracles.forEach((n, i) => (values[`oracles[${i}]`] = pushInt(BigInt(n))));
  return (
    KIT.vault.hex.replace(/<([^>]+)>/g, (_, k) => {
      if (values[k] === undefined) throw new Error(`no value for <${k}>`);
      return values[k];
    }) + '6a'
  );
}

function splitState(scriptHex) {
  const b = bytes(scriptHex);
  if (b.length < 6 || b[b.length - 1] !== 0) return null;
  const n = b[b.length - 5] | (b[b.length - 4] << 8) | (b[b.length - 3] << 16) | (b[b.length - 2] << 24);
  const start = b.length - 5 - n;
  if (start < 1) return null;
  return { code: hex(b.slice(0, start)), state: b.slice(start, b.length - 5) };
}
function reader(b) {
  let i = 0;
  const raw = () => {
    let n = b[i++];
    if (n === 0xfd) ((n = b[i] | (b[i + 1] << 8)), (i += 2));
    const out = b.slice(i, i + n);
    i += n;
    return out;
  };
  return {
    bool: () => b[i++] === 1,
    raw,
    int: () => {
      const x = raw();
      if (!x.length) return 0n;
      let n = 0n;
      for (let k = x.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(k === x.length - 1 ? x[k] & 0x7f : x[k]);
      return x[x.length - 1] & 0x80 ? -n : n;
    },
    done: () => i === b.length,
  };
}

/** Read the n-th push after `i` in a script byte array: [data bytes | small int, next index]. */
function readPush(b, i) {
  const op = b[i];
  if (op === 0) return [[], i + 1];
  if (op === 0x4f) return [-1n, i + 1];
  if (op >= 0x51 && op <= 0x60) return [BigInt(op - 0x50), i + 1];
  let n = op;
  let at = i + 1;
  if (op === 0x4c) ((n = b[at]), (at += 1));
  else if (op === 0x4d) ((n = b[at] | (b[at + 1] << 8)), (at += 2));
  else if (op === 0x4e) ((n = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)), (at += 4));
  else if (op > 0x4b) return [null, i];
  return [b.slice(at, at + n), at + n];
}
const numOf = (x) => {
  if (typeof x === 'bigint') return x;
  if (!x || !x.length) return 0n;
  let n = 0n;
  for (let k = x.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(k === x.length - 1 ? x[k] & 0x7f : x[k]);
  return x[x.length - 1] & 0x80 ? -n : n;
};

/**
 * Owner and openTs of a PNEE vault script of THIS deployment (our issuer and signer keys), or null. The 16
 * constructor values are consecutive pushes right after the template's fixed prefix: read owner (1st) and
 * openTs (16th), rebuild the whole code with our keys and compare.
 */
function vaultParts(scriptHex, cfg) {
  const s = splitState(scriptHex);
  if (!s) return null;
  const pre = KIT.vault.hex.indexOf('<owner>');
  if (s.code.slice(0, pre) !== KIT.vault.hex.slice(0, pre)) return null;
  const b = bytes(s.code.slice(pre));
  const vals = [];
  let i = 0;
  for (let k = 0; k < 16; k++) {
    const [v, next] = readPush(b, i);
    if (v === null) return null;
    vals.push(v);
    i = next;
  }
  if (!Array.isArray(vals[0]) || vals[0].length !== 33) return null;
  const owner = hex(vals[0]);
  const openTs = numOf(vals[15]);
  try {
    if (vaultCode({ owner, issuer: cfg.issuer, oracles: cfg.oracles, openTs }) !== s.code) return null;
  } catch {
    return null;
  }
  return { owner, openTs, state: s.state };
}

function vaultState(scriptHex, openTs) {
  const s = splitState(scriptHex);
  const r = reader(s.state);
  const genesis = r.bool();
  const st = { debt: r.int(), lastTs: r.int(), feeCents: r.int(), feeTs: r.int() };
  return genesis
    ? { genesis, debt: 0n, lastTs: BigInt(openTs), feeCents: 0n, feeTs: BigInt(openTs) }
    : { genesis, ...st };
}

function tokenState(scriptHex) {
  const s = splitState(scriptHex);
  if (!s || s.code !== KIT.bondCode) return null;
  const r = reader(s.state);
  r.bool();
  const holder = hex(r.raw());
  const amount = r.int();
  return r.done() && amount > 0n ? { holder, amount } : null;
}

/** Vault outpoint and amount of a burn receipt script, or null. */
function burnReceipt(scriptHex) {
  const b = bytes(scriptHex);
  if (b[0] !== 0x00 || b[1] !== 0x6a) return null;
  const n = b[2];
  const d = b.slice(3, 3 + n);
  if (n !== 7 + 36 + 8 || Utils.toUTF8(d.slice(0, 7)) !== 'bwxburn') return null;
  const txid = hex(d.slice(7, 39).reverse());
  const vout = d[39] | (d[40] << 8) | (d[41] << 16) | (d[42] << 24);
  let amount = 0n;
  for (let k = 50; k >= 43; k--) amount = (amount << 8n) | BigInt(d[k]);
  return { txid, vout, amount };
}

// ── Rabin price signatures (1024-bit; verify in script is one modular square) ──
function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function egcd(a, b) {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x, y] = egcd(b, a % b);
  return [g, y, x - (a / b) * y];
}
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function rabinHash(buf) {
  const h1 = sha(buf);
  const h2 = sha(h1);
  const h3 = sha(h2);
  const h4 = sha(h3);
  return BigInt('0x' + Buffer.concat([h1, h2, h3, h4]).reverse().toString('hex'));
}
const le8 = (n) => {
  const out = [];
  let a = BigInt(n);
  for (let i = 0; i < 8; i++) (out.push(Number(a & 0xffn)), (a >>= 8n));
  return out;
};
/** Exactly what each signer signs: priceCents (8 LE) ‖ ts (8 LE). */
const priceMsg = (priceCents, ts) => Buffer.from([...le8(priceCents), ...le8(ts)]);
function rabinSign(msg, { p, q }) {
  const n = p * q;
  for (let i = 0; i < 4096; i++) {
    const padding = Buffer.alloc(i === 0 ? 0 : 2);
    if (i > 0) padding.writeUInt16LE(i);
    const h = rabinHash(Buffer.concat([msg, padding])) % n;
    if (modPow(h, (p - 1n) / 2n, p) !== 1n && h % p !== 0n) continue;
    if (modPow(h, (q - 1n) / 2n, q) !== 1n && h % q !== 0n) continue;
    const sp = modPow(h, (p + 1n) / 4n, p);
    const sq = modPow(h, (q + 1n) / 4n, q);
    const [, yp, yq] = egcd(p, q);
    let s = (sp * yq * q + sq * yp * p) % n;
    if (s < 0n) s += n;
    if ((s * s) % n !== h) throw new Error('rabin: sqrt failed');
    return { s, padding: padding.toString('hex') };
  }
  throw new Error('rabin: no padding');
}
const rabinVerify = (msg, { s, padding }, n) =>
  (s * s) % n === rabinHash(Buffer.concat([msg, Buffer.from(padding, 'hex')])) % n;

// ── keys from the environment ──
function signerKeys(env = process.env) {
  const issuerHex = String(env.PNEE_ISSUER_KEY || '').trim();
  const oracles = [1, 2, 3, 4, 5].map((i) => String(env[`PNEE_ORACLE_${i}`] || '').trim());
  if (!/^[0-9a-f]{64}$/i.test(issuerHex) || oracles.some((o) => !/^[0-9a-f]+:[0-9a-f]+$/i.test(o))) return null;
  const rabin = oracles.map((o) => {
    const [p, q] = o.split(':').map((x) => BigInt('0x' + x));
    return { p, q, n: p * q };
  });
  const issuer = PrivateKey.fromHex(issuerHex);
  return { issuer, issuerPub: issuer.toPublicKey().toString(), rabin };
}

/** Public config: what a wallet bakes into a new vault, and who runs the signers. */
function publicConfig(keys) {
  return {
    format: 'bwalletx.pnee-config/1',
    issuer: keys.issuerPub,
    oracles: keys.rabin.map((k) => k.n.toString()),
    params: KIT.params,
    kit: { vault: KIT.vault.md5, token: KIT.token.md5 },
    signers:
      'All five price signer keys and the burn attester key are run by The Bitcoin Corporation Ltd on the bwallet.space server.',
  };
}

/** One price round: every signer signs the median of the public sources, at round time `ts`. */
function signRound(keys, priceCents, ts) {
  return keys.rabin.map((k, signer) => {
    const sig = rabinSign(priceMsg(priceCents, ts), k);
    return { signer, priceCents: Number(priceCents), s: sig.s.toString(), padding: sig.padding };
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ── the close attestation ──
/**
 * Check a close transaction (unsigned is fine: the attester signs the vault input's sighash) and return the
 * issuer signature for input `vaultIndex`, or { error }.
 * `sources`: outpoint → { script, satoshis } for every input; `genuine(outpoint)`: is that token genuine?
 */
async function attestClose({ tx, vaultIndex, sources, keys, cfg, genuine }) {
  const vin = tx.inputs[vaultIndex];
  if (!vin) return { error: 'No vault input' };
  const vOut = `${vin.sourceTXID}_${vin.sourceOutputIndex}`;
  const src = sources[vOut];
  if (!src) return { error: 'Vault input source unknown' };
  const parts = vaultParts(src.script, cfg);
  if (!parts) return { error: 'Not a PNEE vault of this deployment' };
  const st = vaultState(src.script, parts.openTs);
  const r = tx.outputs[0] && burnReceipt(tx.outputs[0].lockingScript.toHex());
  if (!r || r.txid !== vin.sourceTXID || r.vout !== vin.sourceOutputIndex)
    return { error: 'Output 0 is not this vault’s burn receipt' };
  if (r.amount < st.debt) return { error: `The receipt burns ${r.amount}, the vault has ${st.debt} PNEEs` };
  let burned = 0n;
  for (let i = 0; i < tx.inputs.length; i++) {
    if (i === vaultIndex) continue;
    const op = `${tx.inputs[i].sourceTXID}_${tx.inputs[i].sourceOutputIndex}`;
    const s = sources[op];
    const t = s && tokenState(s.script);
    if (!t) continue;
    if (!(await genuine(op))) return { error: `Token input ${op} is not a genuine PNEE` };
    burned += t.amount;
  }
  if (burned < r.amount) return { error: `The token inputs hold ${burned} PNEEs; the receipt says ${r.amount}` };
  if (tx.outputs.some((o) => tokenState(o.lockingScript.toHex()))) return { error: 'A close may not create PNEEs' };
  const pre = TransactionSignature.format({
    sourceTXID: vin.sourceTXID,
    sourceOutputIndex: vin.sourceOutputIndex,
    sourceSatoshis: src.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== vaultIndex),
    inputIndex: vaultIndex,
    outputs: tx.outputs,
    inputSequence: vin.sequence ?? 0xffffffff,
    subscript: LockingScript.fromHex(src.script),
    lockTime: tx.lockTime,
    scope: SIGHASH,
  });
  const sig = keys.issuer.sign(Hash.sha256(pre));
  return { signature: hex(sig.toDER()), burned: r.amount.toString(), debt: st.debt.toString() };
}

/** Collateral value in cents and ratio in percent (Infinity with no PNEEs). */
const valueCents = (sats, priceCents) => (BigInt(sats) * BigInt(priceCents)) / 100000000n;
const ratioPct = (sats, priceCents, debt) =>
  BigInt(debt) === 0n ? null : Number((valueCents(sats, priceCents) * 100n) / (BigInt(debt) * P.unitCents));

module.exports = {
  KIT,
  P,
  SIGHASH,
  attestClose,
  burnReceipt,
  median,
  priceMsg,
  publicConfig,
  rabinSign,
  rabinVerify,
  ratioPct,
  signRound,
  signerKeys,
  splitState,
  tokenState,
  valueCents,
  vaultCode,
  vaultParts,
  vaultState,
  pushInt,
  Transaction,
};

// ── reading a transaction for the public vault list ──
const METHOD = { 0x00: 'topUp', 0x51: 'mint', 0x52: 'close', 0x53: 'liquidate' };
/** Method a vault input was spent through: the last push of its unlocking script is the method index. */
function vaultMethod(unlockingHex) {
  const b = bytes(unlockingHex || '');
  return METHOD[b[b.length - 1]] || null;
}

/**
 * What a transaction did to PNEE vaults: `opened` (new vault outputs), `moved` (a vault input → its next
 * output, after topUp or mint), `ended` (a vault input closed or liquidated). `prevScript(op)` gives the script
 * of a spent output (from the BEEF or the chain).
 */
async function vaultChanges(tx, cfg, prevScript) {
  const txid = tx.id('hex');
  const out = { opened: [], moved: [], ended: [] };
  const spentVault = new Map();
  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    const op = `${inp.sourceTXID}_${inp.sourceOutputIndex}`;
    const script = await prevScript(op, inp);
    const parts = script && vaultParts(script, cfg);
    if (parts)
      spentVault.set(i, { op, parts, method: vaultMethod(inp.unlockingScript && inp.unlockingScript.toHex()) });
  }
  tx.outputs.forEach((o, vout) => {
    const h = o.lockingScript.toHex();
    const parts = vaultParts(h, cfg);
    if (!parts) return;
    const st = vaultState(h, parts.openTs);
    const row = { outpoint: `${txid}_${vout}`, owner: parts.owner, openTs: parts.openTs, sats: o.satoshis, ...st };
    // a vault output at index 0 continuing a vault input 0 is a move (topUp / mint); otherwise a new vault
    const from = vout === 0 ? spentVault.get(0) : null;
    if (from && from.parts.owner === parts.owner && from.parts.openTs === parts.openTs)
      out.moved.push({ from: from.op, method: from.method, ...row });
    else if (st.genesis) out.opened.push(row);
  });
  for (const [i, v] of spentVault) {
    if (i === 0 && out.moved.some((m) => m.from === v.op)) continue;
    out.ended.push({ outpoint: v.op, method: v.method, txid });
  }
  return out;
}

module.exports.vaultChanges = vaultChanges;
module.exports.vaultMethod = vaultMethod;

/**
 * Is the PNEE token at `op` genuine? Output 1 of a vault mint (for exactly the PNEEs the mint added), or output 0/1
 * of a token send whose token input was genuine. Walks back through `getTx` (chain or BEEF), at most `max` steps.
 */
async function tokenGenuine(op, cfg, getTx, memo = new Map(), max = 64) {
  if (memo.has(op)) return memo.get(op);
  memo.set(op, false);
  if (max <= 0) return false;
  const [txid, v] = op.split('_');
  const vout = Number(v);
  const tx = await getTx(txid);
  const out = tx && tx.outputs[vout];
  const t = out && tokenState(out.lockingScript.toHex());
  if (!t) return false;
  const srcScript = async (inp) => {
    const p = await getTx(inp.sourceTXID);
    return p && p.outputs[inp.sourceOutputIndex] ? p.outputs[inp.sourceOutputIndex].lockingScript.toHex() : null;
  };
  let ok = false;
  const inp0 = tx.inputs[0];
  const s0 = inp0 && (await srcScript(inp0));
  const parts = s0 && vaultParts(s0, cfg);
  if (parts && vout === 1 && vaultMethod(inp0.unlockingScript && inp0.unlockingScript.toHex()) === 'mint') {
    const before = vaultState(s0, parts.openTs);
    const after = vaultState(tx.outputs[0].lockingScript.toHex(), parts.openTs);
    ok = after.debt - before.debt === t.amount && t.holder === parts.owner;
  } else if (vout <= 1) {
    const outs = [0, 1].map((k) => tx.outputs[k] && tokenState(tx.outputs[k].lockingScript.toHex()));
    const total = (outs[0] ? outs[0].amount : 0n) + (outs[1] ? outs[1].amount : 0n);
    for (const inp of tx.inputs) {
      if (vaultMethod(inp.unlockingScript && inp.unlockingScript.toHex()) !== 'topUp') continue; // index 0 = transfer
      const s = await srcScript(inp);
      const ti = s && tokenState(s);
      if (!ti || ti.amount !== total) continue;
      if (await tokenGenuine(`${inp.sourceTXID}_${inp.sourceOutputIndex}`, cfg, getTx, memo, max - 1)) {
        ok = true;
        break;
      }
    }
  }
  memo.set(op, ok);
  return ok;
}
module.exports.tokenGenuine = tokenGenuine;
