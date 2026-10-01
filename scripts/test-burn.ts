/**
 * One-off mainnet test of a BSV-21 ticket burn (docs/TICKETS-BURN-PHASE0.md).
 *
 * Chained 0-conf path, no confirmations in between:
 *   tx1 deploy+mint BURNTEST (100, dec 0) to creator A
 *   tx2 creator funds the 1sat-stack overlay fee address (derived from the token id,
 *       so it can only be paid AFTER the deploy txid is known)
 *   tx3 transfer 10 tickets A -> buyer B (+ sats for B's fees, + overlay fee per token output)
 *   tx4 B burns 1 ticket (method A `burn` op + MAP room-entry), spending tx3's unconfirmed outputs
 * Each tx goes to api.1sat.app /1sat/tx (the broadcaster bWallet uses) and then to the BSV-21
 * overlay submit endpoint, exactly like @1sat/actions. Indexers are polled in the background
 * while the chain continues.
 *
 * Keys are throwaway and live ONLY in the scratchpad dir (never the repo). Usage:
 *   bun scripts/test-burn.ts address|balance|run [--dir <keydir>]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSV21 } from '@1sat/templates';
import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  SatoshisPerKilobyte,
  Transaction,
} from '@bsv/sdk';
import { buildTicketBurnOutputs } from '../src/mobile/tickets/burn';

const DEFAULT_DIR =
  '/private/tmp/claude-501/-Volumes-2026-Projects-yours-mobile/b5049913-df1e-4fa1-abce-48c873142917/scratchpad/burntest';
const API = 'https://api.1sat.app';
const GP = 'https://ordinals.gorillapool.io/api';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const FEE_RATE = 150; // sat/kB; ARC policy is 100
const MINT_OVERLAY_FUND = 3000; // creator pre-funds the overlay at mint
const OVERLAY_FEE_FALLBACK = 1000; // 1sat-stack default fee_per_output
const BUYER_SATS = 3000; // sats sent with the tickets so B can pay its burn fees
const SUPPLY = 100n;
const SEND = 10n;
const MIN_BALANCE = 10_000;
const MAX_SPEND = 20_000;
const POLL_MS = 500;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 180_000);

const args = process.argv.slice(2);
const cmd = args[0];
const dirIdx = args.indexOf('--dir');
const dir = dirIdx >= 0 ? args[dirIdx + 1] : DEFAULT_DIR;

function loadKey(name: string): PrivateKey {
  const path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, PrivateKey.fromRandom().toWif(), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return PrivateKey.fromWif(readFileSync(path, 'utf8').trim());
}

const keyA = loadKey('key.wif'); // creator / funding address
const keyB = loadKey('key2.wif'); // buyer
const addrA = keyA.toAddress().toString();
const addrB = keyB.toAddress().toString();
const lockA = new P2PKH().lock(addrA);
const lockB = new P2PKH().lock(addrB);

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

async function wocUtxos(addr: string): Promise<{ tx_hash: string; tx_pos: number; value: number }[]> {
  const r = await getJson(`${WOC}/address/${addr}/unspent/all`);
  if (r.status !== 200) throw new Error(`WoC unspent ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body.result ?? r.body).map((u: any) => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos, value: u.value }));
}

async function balance(addr: string): Promise<number> {
  return (await wocUtxos(addr)).reduce((s, u) => s + u.value, 0);
}

/** Funding tx with proof chain, from 1sat-stack's BEEF service. */
async function sourceTx(txid: string): Promise<Transaction> {
  const r = await fetch(`${API}/1sat/beef/${txid}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    throw new Error(
      `No BEEF for funding tx ${txid} (${r.status}). Wait for 1 confirmation of the funding tx and retry.`,
    );
  }
  const beef = Beef.fromBinary(Array.from(new Uint8Array(await r.arrayBuffer())));
  const tx = beef.findAtomicTransaction(txid);
  if (!tx) throw new Error(`BEEF for ${txid} did not contain the tx`);
  return tx;
}

interface Step {
  name: string;
  txid: string;
  bytes: number;
  minerFee: number;
  broadcastMs: number;
  broadcast: any;
  overlaySubmitMs?: number;
  overlaySubmit?: any;
}

async function broadcast(name: string, tx: Transaction, overlayTopic: 'discovery' | string): Promise<Step> {
  const txid = tx.id('hex');
  const beef = tx.toAtomicBEEF();
  const start = Date.now();
  const b = await getJson(`${API}/1sat/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(beef),
  });
  const broadcastMs = Date.now() - start;
  const fee = tx.getFee();
  log(`${name} broadcast ${txid} -> ${b.status} ${JSON.stringify(b.body)} (${broadcastMs} ms)`);
  const ok = ['SEEN_ON_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED', 'STORED', 'ANNOUNCED_TO_NETWORK', 'RECEIVED', 'QUEUED', 'SENT_TO_NETWORK'];
  if (!ok.includes(b.body?.txStatus)) {
    throw new Error(`${name} not accepted by broadcaster: ${JSON.stringify(b.body)}`);
  }
  const step: Step = { name, txid, bytes: tx.toBinary().length, minerFee: fee, broadcastMs, broadcast: b.body };
  const topic = overlayTopic === 'discovery' ? 'tm_bsv21' : `tm_${overlayTopic}`;
  const os = Date.now();
  const o = await getJson(`${API}/1sat/bsv21/overlay/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': topic },
    body: new Uint8Array(beef),
  });
  step.overlaySubmitMs = Date.now() - os;
  step.overlaySubmit = { status: o.status, body: o.body };
  log(`${name} overlay submit (${topic}) -> ${o.status} ${JSON.stringify(o.body)} (${step.overlaySubmitMs} ms)`);
  return step;
}

/** Poll `check` every 500ms from `since` until it returns truthy or timeout. */
async function poll(label: string, since: number, check: () => Promise<any>): Promise<any> {
  let last: any;
  while (Date.now() - since < POLL_TIMEOUT_MS) {
    try {
      const v = await check();
      if (v?.ok) {
        const ms = Date.now() - since;
        log(`${label}: OK after ${ms} ms`);
        return { label, ms, response: v.response };
      }
      last = v?.response;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  log(`${label}: TIMEOUT after ${POLL_TIMEOUT_MS} ms; last=${JSON.stringify(last)?.slice(0, 300)}`);
  return { label, ms: null, response: last };
}

function stackTxPoll(tokenId: string, txid: string, wantOp: string) {
  return async () => {
    const r = await getJson(`${API}/1sat/bsv21/${tokenId}/tx/${txid}`);
    const outs = r.body?.outputs ?? [];
    const ok = r.status === 200 && outs.some((o: any) => o?.data?.bsv21?.op === wantOp);
    return { ok, response: { status: r.status, body: r.body } };
  };
}

function gpOutpointPoll(outpoint: string) {
  return async () => {
    const r = await getJson(`${GP}/bsv20/outpoint/${outpoint}`);
    return { ok: r.status === 200 && r.body?.status === 1, response: { status: r.status, body: r.body } };
  };
}

async function signAndCheck(tx: Transaction): Promise<void> {
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE));
  await tx.sign();
}

async function run() {
  const utxos = await wocUtxos(addrA);
  const total = utxos.reduce((s, u) => s + u.value, 0);
  log(`creator ${addrA} balance ${total} sats in ${utxos.length} utxo(s); buyer ${addrB}`);
  if (total < MIN_BALANCE) {
    throw new Error(`Insufficient balance: ${total} < ${MIN_BALANCE} sats. Fund ${addrA} and retry.`);
  }
  const startBal = total;
  const results: any = { creator: addrA, buyer: addrB, steps: [] as Step[], polls: [] as any[] };
  const pollers: Promise<any>[] = [];

  // tx1: deploy+mint
  const tx1 = new Transaction();
  for (const u of utxos) {
    tx1.addInput({
      sourceTransaction: await sourceTx(u.tx_hash),
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(keyA),
    });
  }
  tx1.addOutput({ lockingScript: BSV21.deployMint('BURNTEST', SUPPLY, 0).lock(lockA), satoshis: 1 });
  tx1.addOutput({ lockingScript: lockA, change: true });
  await signAndCheck(tx1);
  const s1 = await broadcast('tx1 deploy', tx1, 'discovery');
  results.steps.push(s1);
  const tokenId = `${s1.txid}_0`;
  results.tokenId = tokenId;
  const t1 = Date.now();
  pollers.push(
    poll('tx1 1sat-stack token known', t1, async () => {
      const r = await getJson(`${API}/1sat/bsv21/${tokenId}`);
      return { ok: r.status === 200 && !!r.body?.token, response: { status: r.status, body: r.body } };
    }),
    poll('tx1 GorillaPool token known', t1, async () => {
      const r = await getJson(`${GP}/bsv20/id/${tokenId}`);
      return { ok: r.status === 200 && !!r.body?.id, response: { status: r.status, body: r.body } };
    }),
  );

  // Fee address: from the indexer if it already knows the token, else not derivable here
  // without the HD xpub logic — poll briefly for it.
  let feeAddress: string | undefined;
  let feePerOutput = OVERLAY_FEE_FALLBACK;
  const fa0 = Date.now();
  while (!feeAddress && Date.now() - fa0 < 60_000) {
    const r = await getJson(`${API}/1sat/bsv21/${tokenId}`);
    if (r.body?.status?.fee_address) {
      feeAddress = r.body.status.fee_address;
      if (typeof r.body.status.fee_per_output === 'number' && r.body.status.fee_per_output > 0) {
        feePerOutput = r.body.status.fee_per_output;
      }
      results.statusAfterDeploy = r.body.status;
    } else await new Promise((res) => setTimeout(res, POLL_MS));
  }
  if (!feeAddress) throw new Error('1sat-stack never returned status.fee_address for the new token (60 s)');
  log(`fee_address ${feeAddress}, fee_per_output ${feePerOutput} (after ${Date.now() - fa0} ms)`);
  results.feeAddress = feeAddress;
  results.feePerOutput = feePerOutput;

  // tx2: creator funds the overlay (spends tx1 change, unconfirmed)
  const tx2 = new Transaction();
  tx2.addInput({ sourceTransaction: tx1, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(keyA) });
  tx2.addOutput({ lockingScript: new P2PKH().lock(feeAddress), satoshis: MINT_OVERLAY_FUND });
  tx2.addOutput({ lockingScript: lockA, change: true });
  await signAndCheck(tx2);
  const s2 = await broadcast('tx2 overlay fund', tx2, tokenId);
  results.steps.push(s2);
  const t2 = Date.now();
  pollers.push(
    poll('tx2 1sat-stack token is_active', t2, async () => {
      const r = await getJson(`${API}/1sat/bsv21/${tokenId}`);
      return { ok: r.body?.status?.is_active === true, response: { status: r.status, body: r.body } };
    }),
  );

  // tx3: transfer SEND tickets to buyer, token change to A, sats for buyer, overlay fee (2 token outputs)
  const tx3 = new Transaction();
  tx3.addInput({ sourceTransaction: tx1, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(keyA) });
  tx3.addInput({ sourceTransaction: tx2, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(keyA) });
  tx3.addOutput({ lockingScript: BSV21.transfer(tokenId, SEND).lock(lockB), satoshis: 1 });
  tx3.addOutput({ lockingScript: BSV21.transfer(tokenId, SUPPLY - SEND).lock(lockA), satoshis: 1 });
  tx3.addOutput({ lockingScript: lockB, satoshis: BUYER_SATS });
  tx3.addOutput({ lockingScript: new P2PKH().lock(feeAddress), satoshis: feePerOutput * 2 });
  tx3.addOutput({ lockingScript: lockA, change: true });
  await signAndCheck(tx3);
  const s3 = await broadcast('tx3 transfer to buyer', tx3, tokenId);
  results.steps.push(s3);
  const t3 = Date.now();
  pollers.push(
    poll('tx3 1sat-stack transfer indexed', t3, stackTxPoll(tokenId, s3.txid, 'transfer')),
    poll('tx3 GorillaPool transfer valid', t3, gpOutpointPoll(`${s3.txid}_0`)),
  );

  // tx4: buyer burns 1 (spends tx3 outputs 0 and 2, both unconfirmed)
  const outs = buildTicketBurnOutputs({
    tokenId,
    burnRaw: 1n,
    inputRaw: SEND,
    changeLockingScript: lockB,
    method: 'op-burn',
    overlayFee: { address: feeAddress, perOutput: feePerOutput },
    entry: { channel: 'burntest', handle: 'burntest' },
  });
  const tx4 = new Transaction();
  tx4.addInput({ sourceTransaction: tx3, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(keyB) });
  tx4.addInput({ sourceTransaction: tx3, sourceOutputIndex: 2, unlockingScriptTemplate: new P2PKH().unlock(keyB) });
  for (const o of outs) {
    tx4.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
  }
  tx4.addOutput({ lockingScript: lockB, change: true });
  await signAndCheck(tx4);
  const s4 = await broadcast('tx4 burn', tx4, tokenId);
  results.steps.push(s4);
  results.burnVout = 0;
  const t4 = Date.now();
  pollers.push(
    poll('tx4 1sat-stack burn indexed', t4, stackTxPoll(tokenId, s4.txid, 'burn')),
    poll('tx4 GorillaPool burn valid', t4, gpOutpointPoll(`${s4.txid}_0`)),
  );

  results.polls = await Promise.all(pollers);

  // Supply / balances afterwards
  results.after = {
    stackToken: (await getJson(`${API}/1sat/bsv21/${tokenId}`)).body,
    stackBurnTx: (await getJson(`${API}/1sat/bsv21/${tokenId}/tx/${s4.txid}`)).body,
    stackBuyerBalance: (await getJson(`${API}/1sat/bsv21/${tokenId}/p2pkh/${addrB}/balance`)).body,
    gpToken: (await getJson(`${GP}/bsv20/id/${tokenId}`)).body,
    gpBurnOutpoint: (await getJson(`${GP}/bsv20/outpoint/${s4.txid}_0`)).body,
  };
  const spent = startBal - (await balance(addrA)) - (await balance(addrB));
  results.remainder = { creator: await balance(addrA), buyer: await balance(addrB) };
  results.totalSpentSats = spent;
  if (spent > MAX_SPEND) log(`WARNING: spent ${spent} > ${MAX_SPEND}`);
  const out = join(dir, `result-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));
  log(`results written to ${out}`);
  console.log(JSON.stringify(results, null, 2));
}

async function main() {
  if (cmd === 'address') {
    console.log(`creator (fund this): ${addrA}`);
    console.log(`buyer: ${addrB}`);
  } else if (cmd === 'balance') {
    console.log(`creator ${addrA}: ${await balance(addrA)} sats`);
    console.log(`buyer   ${addrB}: ${await balance(addrB)} sats`);
  } else if (cmd === 'run') {
    await run();
  } else {
    console.log('usage: bun scripts/test-burn.ts address|balance|run [--dir <keydir>]');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[${ts()}] ABORT:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
