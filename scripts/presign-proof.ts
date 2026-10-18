/**
 * Pre-signed payments — §8 mainnet proof (docs/PRESIGNED-PAYMENTS.md §8). NOT shipped.
 *
 * Spends at most 3 SCAM (1 ends at the recipient, 2 come back) and about 5,000 sats,
 * from a throwaway test key that is never used anywhere else.
 *
 * Keys are read at runtime from files outside the repo; nothing is ever printed or committed:
 *   PRESIGN_PAYER_WIF_FILE    default ~/.bwalletx/presign-test/payer.wif     (funded: 3 SCAM in one UTXO + 5,000 sats)
 *   PRESIGN_SERVICE_WIF_FILE  default ~/.bwalletx/presign-test/service.wif   (created on first run if missing)
 *   PRESIGN_RECIPIENT         P2PKH address of a test bWalletX identity (BRC-29 destination)
 *   PRESIGN_TOKEN_UTXO        optional `txid:vout` of the 3-SCAM UTXO (else looked up on GorillaPool)
 *   PRESIGN_STATE             default ~/.bwalletx/presign-test/state.json
 *
 *   bun scripts/presign-proof.ts address        print the payer funding address (no network)
 *   bun scripts/presign-proof.ts all --dry-run  build + verify every tx locally, broadcast nothing
 *   bun scripts/presign-proof.ts all            TX0 → TX1 → TX2 (before T) → wait for T → TX3 → TX4 → status
 *   bun scripts/presign-proof.ts <step>         create | claim | early-refund | refund | race | status
 *
 * The service key here stands in for the Hetzner signer worker. Claim fees come from the
 * payer's TX0 change (the proof has one funded address); in production they come from the
 * service fee pool (§5.1). Refund TX3 uses only the payer WIF, i.e. "seed alone, no server".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  SCAM_TOKEN_ID,
  SIGHASH,
  buildCreation,
  buildRefund,
  checkClaim,
  checkTokenBalance,
  finishClaim,
  payerSlotKeys,
  presignSlot,
  serviceSlotKeys,
  tokenOf,
  verifyInput,
  verifyTx,
  withTransfer,
} from '../src/mobile/presign';

const DIR = join(homedir(), '.bwalletx', 'presign-test');
const PAYER_FILE = process.env.PRESIGN_PAYER_WIF_FILE ?? join(DIR, 'payer.wif');
const SERVICE_FILE = process.env.PRESIGN_SERVICE_WIF_FILE ?? join(DIR, 'service.wif');
const STATE_FILE = process.env.PRESIGN_STATE ?? join(DIR, 'state.json');
const ARC = process.env.PRESIGN_ARC ?? 'https://arc.gorillapool.io';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const ORD = 'https://ordinals.gorillapool.io/api';
const SET_ID = 'proof';
const FEE_SAT_PER_KB = 100;
const DRY = process.argv.includes('--dry-run');
const step = process.argv[2] ?? 'help';

interface State {
  height?: number;
  untilA?: number;
  untilB?: number;
  tx0?: string;
  tx1?: string;
  tx2?: string;
  tx3?: string;
  tx2Responses?: Record<string, unknown>;
  tx2AfterT?: Record<string, unknown>;
  tx4Response?: unknown;
  log: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadState = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { log: [] });
const saveState = (s: State) => {
  if (DRY) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
};
const note = (s: State, msg: string) => {
  console.log(msg);
  s.log.push(`${new Date().toISOString()} ${msg}`);
};

function readWif(file: string, create = false): PrivateKey {
  if (!existsSync(file)) {
    if (!create) throw new Error(`missing key file ${file}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, PrivateKey.fromRandom().toWif(), { mode: 0o600 });
    console.log(`created a throwaway service key at ${file}`);
  }
  return PrivateKey.fromWif(readFileSync(file, 'utf8').trim());
}

async function http(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.text() };
}
async function json<T>(url: string): Promise<T> {
  const r = await http(url);
  if (r.status >= 400) throw new Error(`${url} → ${r.status} ${r.body}`);
  return JSON.parse(r.body) as T;
}
const tipHeight = async () => (await json<{ blocks: number }>(`${WOC}/chain/info`)).blocks;
const rawTx = async (txid: string) => {
  const r = await http(`${WOC}/tx/${txid}/hex`);
  if (r.status >= 400) throw new Error(`tx ${txid} not found (${r.status})`);
  return Transaction.fromHex(r.body.trim());
};

async function arc(tx: Transaction) {
  const r = await http(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: tx.toHexEF() }),
  });
  return r;
}
async function woc(tx: Transaction) {
  return http(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
  });
}

async function broadcast(s: State, label: string, tx: Transaction) {
  const local = verifyTx(tx);
  if (!local.ok) throw new Error(`${label} fails locally: ${local.error}`);
  if (DRY) {
    note(s, `[dry-run] ${label} ${tx.id('hex')} ok locally, fee ${tx.getFee()} sats, ${tx.toBinary().length} bytes`);
    return;
  }
  const r = await arc(tx);
  note(s, `${label} ${tx.id('hex')} → ARC ${r.status} ${r.body}`);
  if (r.status >= 400) throw new Error(`${label} rejected by ARC`);
}

function keys() {
  const payer = readWif(PAYER_FILE);
  const service = readWif(SERVICE_FILE, !DRY);
  const recipient = process.env.PRESIGN_RECIPIENT;
  if (!recipient) throw new Error('set PRESIGN_RECIPIENT to the test recipient P2PKH address');
  const slot = (i: number) => {
    const p = payerSlotKeys(payer, service.toPublicKey(), SET_ID, i);
    const sv = serviceSlotKeys(service, payer.toPublicKey(), SET_ID, i);
    return { ...p, Spriv: sv.S };
  };
  return { payer, service, recipient, slot, addr: payer.toAddress() };
}

/** In a dry run, earlier txs only exist in memory. */
const mem = new Map<string, Transaction>();
const getTx = async (txid: string) => mem.get(txid) ?? rawTx(txid);
const keep = (tx: Transaction) => {
  mem.set(tx.id('hex'), tx);
  return tx.id('hex');
};

async function findTokenUtxo(addr: string): Promise<{ txid: string; vout: number }> {
  const env = process.env.PRESIGN_TOKEN_UTXO;
  if (env) {
    const [txid, vout] = env.split(':');
    return { txid, vout: Number(vout) };
  }
  const list = await json<{ txid: string; vout: number; amt: string }[]>(`${ORD}/bsv20/${addr}/id/${SCAM_TOKEN_ID}`);
  const u = list.find((x) => BigInt(x.amt) >= 3n);
  if (!u) throw new Error('no UTXO with 3 SCAM found; set PRESIGN_TOKEN_UTXO=txid:vout');
  return u;
}

async function create(s: State) {
  const k = keys();
  const h = await tipHeight();
  s.height = h;
  s.untilA = h + 1000;
  s.untilB = h + 3;
  const tok = await findTokenUtxo(k.addr);
  const tokSrc = await rawTx(tok.txid);
  const t = tokenOf(tokSrc.outputs[tok.vout].lockingScript);
  if (!t || t.id !== SCAM_TOKEN_ID || t.amt !== 3n)
    throw new Error(`token UTXO must hold exactly 3 SCAM, found ${t?.amt}`);
  const sats = await json<{ tx_hash: string; tx_pos: number; value: number }[]>(`${WOC}/address/${k.addr}/unspent`);
  const fund = sats.find((u) => u.value >= 4000 && !(u.tx_hash === tok.txid && u.tx_pos === tok.vout));
  if (!fund) throw new Error('no plain UTXO of ≥ 4,000 sats at the payer address');
  const satSrc = await rawTx(fund.tx_hash);
  const unlock = new P2PKH().unlock(k.payer);
  const slot = (i: number, until: number) => {
    const sk = k.slot(i);
    return {
      S: sk.S,
      P: sk.P.toPublicKey(),
      R: sk.R.toPublicKey(),
      until,
      token: { id: SCAM_TOKEN_ID, amt: 1n },
      satoshis: 1,
    };
  };
  const { tx } = await buildCreation({
    inputs: [
      { sourceTransaction: tokSrc, sourceOutputIndex: tok.vout, unlock, token: { id: SCAM_TOKEN_ID, amt: 3n } },
      { sourceTransaction: satSrc, sourceOutputIndex: fund.tx_pos, unlock },
    ],
    slots: [slot(0, s.untilA), slot(1, s.untilB)],
    changeAddress: k.addr,
    feeSatPerKb: FEE_SAT_PER_KB,
  });
  const bal = checkTokenBalance(tx);
  if (!bal.ok) throw new Error(`TX0 would burn: ${bal.error}`);
  await broadcast(s, 'TX0 create', tx);
  s.tx0 = keep(tx);
  note(s, `slot A ${s.tx0}.0 (T=${s.untilA}), slot B ${s.tx0}.1 (T=${s.untilB}), token change ${s.tx0}.2`);
}

async function claim(s: State) {
  const k = keys();
  if (!s.tx0) throw new Error('run create first');
  const tx0 = await getTx(s.tx0);
  const sk = k.slot(0);
  const slot = { sourceTransaction: tx0, sourceOutputIndex: 0 };
  const out = (a: string) => [
    { lockingScript: withTransfer(new P2PKH().lock(a), { id: SCAM_TOKEN_ID, amt: 1n }), satoshis: 1 },
  ];
  // sigP is made over a DIFFERENT out0 (back to the payer), then reused unchanged.
  const sigP = presignSlot(sk.P, { slot, outputs: out(k.addr) }, SIGHASH.NONE_ACP);
  const feeVout = tx0.outputs.length - 1;
  const tx = await finishClaim({
    slot,
    outputs: out(k.recipient),
    sigP,
    S: sk.Spriv,
    feeInputs: [{ sourceTransaction: tx0, sourceOutputIndex: feeVout, unlock: new P2PKH().unlock(k.payer) }],
    changeAddress: k.addr,
    feeSatPerKb: FEE_SAT_PER_KB,
  });
  const chk = checkClaim(tx, k.recipient);
  if (!chk.ok) throw new Error(`TX1 pre-broadcast check: ${chk.error}`);

  // TX1-neg (local only): SINGLE bound to another out0 must fail.
  const sigSingle = presignSlot(sk.P, { slot, outputs: out(k.addr) }, SIGHASH.SINGLE_ACP);
  const neg = await finishClaim({
    slot,
    outputs: out(k.recipient),
    sigP: sigSingle,
    S: sk.Spriv,
    feeInputs: [{ sourceTransaction: tx0, sourceOutputIndex: feeVout, unlock: new P2PKH().unlock(k.payer) }],
    changeAddress: k.addr,
    feeSatPerKb: FEE_SAT_PER_KB,
  });
  const negOk = verifyInput(neg, 0).ok;
  note(s, `TX1-neg (SINGLE, other payee) interpreter: ${negOk ? 'ACCEPTED — FAIL' : 'rejected — pass'}`);
  if (negOk) throw new Error('SINGLE did not pin the output');

  await broadcast(s, 'TX1 claim', tx);
  s.tx1 = keep(tx);
}

async function refundTx(s: State, until: number) {
  const k = keys();
  if (!s.tx0 || !s.tx1) throw new Error('run create and claim first');
  const tx0 = await getTx(s.tx0);
  const tx1 = await getTx(s.tx1);
  return buildRefund({
    slot: { sourceTransaction: tx0, sourceOutputIndex: 1 },
    R: k.slot(1).R,
    until,
    toAddress: k.addr,
    token: { id: SCAM_TOKEN_ID, amt: 1n },
    feeInputs: [
      { sourceTransaction: tx1, sourceOutputIndex: tx1.outputs.length - 1, unlock: new P2PKH().unlock(k.payer) },
    ],
    changeAddress: k.addr,
    feeSatPerKb: FEE_SAT_PER_KB,
  });
}

async function earlyRefund(s: State) {
  if (!s.untilB) throw new Error('run create first');
  const tx = await refundTx(s, s.untilB);
  const b = await refundTx(s, s.untilB - 1);
  const bOk = verifyInput(b, 0).ok;
  note(s, `TX2b (nLockTime T−1) interpreter: ${bOk ? 'ACCEPTED — FAIL' : 'rejected — pass'}`);
  if (bOk) throw new Error('covenant accepted T−1');
  if (!verifyTx(tx).ok) throw new Error('TX2 should be valid at T in the interpreter');
  s.tx2 = tx.id('hex');
  if (DRY) {
    note(s, `[dry-run] TX2 ${s.tx2} built (nLockTime ${tx.lockTime}); would be sent to ARC and WhatsOnChain before T`);
    return;
  }
  const h = await tipHeight();
  if (h >= s.untilB) {
    note(s, `tip ${h} already ≥ T ${s.untilB}: too late to test early broadcast; skipping TX2`);
    return;
  }
  const a = await arc(tx);
  const w = await woc(tx);
  s.tx2Responses = { tip: h, T: s.untilB, arc: a, woc: w };
  note(s, `TX2 early @${h} → ARC ${a.status} ${a.body}`);
  note(s, `TX2 early @${h} → WoC ${w.status} ${w.body}`);
}

async function refund(s: State) {
  if (!s.untilB) throw new Error('run create first');
  let h = await tipHeight();
  while (!DRY && h < s.untilB) {
    console.log(`tip ${h}, waiting for T=${s.untilB}…`);
    await sleep(60_000);
    h = await tipHeight();
  }
  if (s.tx2 && !DRY) {
    const a = await http(`${ARC}/v1/tx/${s.tx2}`);
    const w = await http(`${WOC}/tx/hash/${s.tx2}`);
    s.tx2AfterT = { tip: h, arc: a, woc: w };
    note(s, `TX2 after T: ARC ${a.status} ${a.body} | WoC ${w.status}`);
  }
  // Rebuilt from the payer WIF alone; the service key is not loaded for this tx.
  const tx = await refundTx(s, s.untilB);
  await broadcast(s, 'TX3 refund', tx);
  s.tx3 = keep(tx);
}

async function race(s: State) {
  const k = keys();
  if (!s.tx0) throw new Error('run create first');
  const tx0 = await getTx(s.tx0);
  const sk = k.slot(1);
  const slot = { sourceTransaction: tx0, sourceOutputIndex: 1 };
  const outputs = [
    { lockingScript: withTransfer(new P2PKH().lock(k.recipient), { id: SCAM_TOKEN_ID, amt: 1n }), satoshis: 1 },
  ];
  const sigP = presignSlot(sk.P, { slot, outputs }, SIGHASH.NONE_ACP);
  const sats = DRY
    ? []
    : await json<{ tx_hash: string; tx_pos: number; value: number }[]>(`${WOC}/address/${k.addr}/unspent`);
  const fee = sats.find((u) => u.value >= 300);
  if (!fee) {
    note(s, 'TX4 skipped: no spare fee UTXO');
    return;
  }
  const tx = await finishClaim({
    slot,
    outputs,
    sigP,
    S: sk.Spriv,
    feeInputs: [
      {
        sourceTransaction: await rawTx(fee.tx_hash),
        sourceOutputIndex: fee.tx_pos,
        unlock: new P2PKH().unlock(k.payer),
      },
    ],
    changeAddress: k.addr,
    feeSatPerKb: FEE_SAT_PER_KB,
  });
  const r = await arc(tx);
  s.tx4Response = r;
  note(s, `TX4 claim after refund → ARC ${r.status} ${r.body} (expected: rejected, double spend)`);
}

async function status(s: State) {
  for (const [label, op] of [
    ['slot A', `${s.tx0}_0`],
    ['slot B', `${s.tx0}_1`],
    ['token change', `${s.tx0}_2`],
    ['recipient (TX1)', `${s.tx1}_0`],
    ['refund (TX3)', `${s.tx3}_0`],
  ] as const) {
    if (op.startsWith('undefined')) continue;
    if (DRY) {
      console.log(`${label}: ${op}`);
      continue;
    }
    const r = await http(`${ORD}/txos/${op}?script=false`);
    console.log(`${label} ${op} → ${r.status} ${r.body.slice(0, 400)}`);
  }
  console.log(`state: ${STATE_FILE}`);
}

async function main() {
  const s = loadState();
  switch (step) {
    case 'address':
      console.log(readWif(PAYER_FILE).toAddress());
      return;
    case 'create':
      await create(s);
      break;
    case 'claim':
      await claim(s);
      break;
    case 'early-refund':
      await earlyRefund(s);
      break;
    case 'refund':
      await refund(s);
      break;
    case 'race':
      await race(s);
      break;
    case 'status':
      await status(s);
      return;
    case 'all':
      await create(s);
      saveState(s);
      await claim(s);
      saveState(s);
      await earlyRefund(s);
      saveState(s);
      await refund(s);
      saveState(s);
      if (!DRY) {
        await sleep(15_000);
        await race(s);
      }
      saveState(s);
      await status(s);
      break;
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      return;
  }
  saveState(s);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
