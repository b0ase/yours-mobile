/**
 * Wires tokenRecovery to the real wallet, 1Sat services and chrome.storage.
 * See tokenRecovery.ts for what it does and why.
 */
import { BSV21_BASKET, P1SAT_PROTOCOL } from '@1sat/types';
import { internalizeBeef } from '@1sat/actions';
import type { OneSatServices } from '@1sat/wallet-browser';
import { KeyDeriver, PrivateKey, PublicKey, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { buildKeySearchSetup, invoicePrefixFor, searchMsKeyIDs } from './tokenKeySearch';
import {
  normOutpoint,
  recoverTokenOutputs,
  type KnownTokenOutput,
  type TokenRecoveryOptions,
  type TokenRecoveryResult,
  type TxTokenOutput,
} from './tokenRecovery';

/** Pull the BSV-21 transfer/mint data and the P2PKH owner out of one output script. */
export const parseTokenOutput = (lockingScriptHex: string, txid: string, vout: number): TxTokenOutput | null => {
  let script: Script;
  try {
    script = Script.fromHex(lockingScriptHex);
  } catch {
    return null;
  }
  let token: { id?: string; amt?: string; op?: string } | null = null;
  for (const chunk of script.chunks) {
    if (!chunk.data || chunk.data.length < 10) continue;
    const text = Utils.toUTF8(chunk.data);
    if (!text.includes('"bsv-20"')) continue;
    try {
      const j = JSON.parse(text) as { p?: string; op?: string; id?: string; amt?: string };
      if (j.p === 'bsv-20') token = j;
    } catch {
      // not JSON
    }
  }
  if (!token?.amt) return null;
  const op = token.op;
  // A deploy+mint names no id; the token id is its own outpoint.
  const tokenId = op === 'deploy+mint' ? `${txid}_${vout}` : token.id;
  if (!tokenId || (op !== 'transfer' && op !== 'deploy+mint')) return null;
  const hex = lockingScriptHex.toLowerCase();
  const m = /76a914([0-9a-f]{40})88ac$/.exec(hex);
  return { vout, tokenId, amt: String(token.amt), hash160: m ? m[1] : null };
};

const chromeCache = {
  async get(key: string): Promise<string | null> {
    try {
      const r = await chrome.storage.local.get(key);
      return (r?.[key] as string | undefined) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
      // cache only
    }
  },
};

/** Every bsv21-basket output the wallet's actions created or received, spent or not. */
const listKnownTokenOutputs = async (wallet: WalletInterface): Promise<KnownTokenOutput[]> => {
  const out: KnownTokenOutput[] = [];
  const pageSize = 500;
  try {
    for (let offset = 0; ; offset += pageSize) {
      const page = await wallet.listActions({ labels: [], includeOutputs: true, limit: pageSize, offset });
      for (const a of page.actions) {
        for (const o of a.outputs ?? []) {
          // 1-sat outputs too: a spent token output may no longer carry its basket.
          // The indexer decides what is a token; non-tokens drop out cheaply.
          if (o.basket === BSV21_BASKET || o.satoshis === 1) {
            out.push({ outpoint: `${a.txid}.${o.outputIndex}`, spendable: o.spendable });
          }
        }
      }
      if (page.actions.length < pageSize) break;
    }
  } catch (err) {
    console.warn('[tokenRecovery] listActions failed; using spendable outputs only:', err);
  }
  // listActions only reports outputs the wallet still files under the basket;
  // listOutputs is the authority for what is spendable now.
  const now = await wallet.listOutputs({ basket: BSV21_BASKET, limit: 10000 });
  const spendable = new Set(now.outputs.map((o) => normOutpoint(o.outpoint)));
  const seen = new Set(out.map((o) => o.outpoint));
  for (const o of out) o.spendable = spendable.has(o.outpoint);
  for (const s of spendable) if (!seen.has(s)) out.push({ outpoint: s, spendable: true });
  return out;
};

let running: Promise<TokenRecoveryResult> | null = null;

export interface RunTokenRecoveryArgs {
  /** Admin-bound wallet (permissions manager with the admin originator). */
  wallet: WalletInterface;
  services: OneSatServices;
  identityWif: string;
  chain: 'main' | 'test';
  options?: TokenRecoveryOptions;
}

/** Single flight: a second call while one runs gets the running one's result. */
export const runTokenRecovery = (args: RunTokenRecoveryArgs): Promise<TokenRecoveryResult> => {
  if (running) return running;
  running = doRun(args).finally(() => {
    running = null;
  });
  return running;
};

const doRun = async ({ wallet, services, identityWif, chain, options }: RunTokenRecoveryArgs) => {
  const deriver = new KeyDeriver(PrivateKey.fromWif(identityWif));
  const invoicePrefix = invoicePrefixFor(P1SAT_PROTOCOL);
  const setup = buildKeySearchSetup(identityWif, invoicePrefix);
  const identityKey = deriver.identityKey;
  const txCache = new Map<string, Transaction>();
  const getTx = async (txid: string) => {
    let tx = txCache.get(txid);
    if (!tx) {
      tx = Transaction.fromBinary(Array.from(await services.beef.getRawTx(txid)));
      txCache.set(txid, tx);
    }
    return tx;
  };

  const result = await recoverTokenOutputs(
    {
      knownTokenOutputs: () => listKnownTokenOutputs(wallet),
      async getSpends(outpoints) {
        const map = new Map<string, string | null>();
        for (let i = 0; i < outpoints.length; i += 100) {
          const batch = outpoints.slice(i, i + 100);
          const res = await services.txo.getSpends(batch.map((o) => o.replace('.', '_')));
          batch.forEach((o, j) => map.set(o, res[j] ?? null));
        }
        return map;
      },
      async getTxTokenOutputs(txid) {
        const tx = await getTx(txid);
        const outs: TxTokenOutput[] = [];
        tx.outputs.forEach((o, vout) => {
          if (o.satoshis !== 1) return;
          const t = parseTokenOutput(o.lockingScript.toHex(), txid, vout);
          if (t) outs.push(t);
        });
        return outs;
      },
      async getTxTiming(txid) {
        try {
          const mp = await services.getMerklePath(txid);
          const height = mp.merklePath?.blockHeight;
          if (!height) return {};
          const [cur, prev] = await Promise.all([
            services.chaintracks.findHeaderForHeight(height),
            services.chaintracks.findHeaderForHeight(height - 1),
          ]);
          return { blockTime: cur?.time, prevBlockTime: prev?.time };
        } catch {
          return {};
        }
      },
      async overlayStatus(tokenId, outpoints) {
        const res = await services.bsv21.getOutputStatus(tokenId, outpoints);
        return new Map(res.map((r) => [normOutpoint(r.outpoint), r.state as string | undefined]));
      },
      searchKeys: (prefix, targets, fromMs, toMs) =>
        searchMsKeyIDs({ setup, keyIDPrefix: prefix, targets, fromMs, toMs }),
      async importOutput({ txid, vout, keyID }) {
        // Never twice: skip if the wallet lists it by now.
        const have = await wallet.listOutputs({ basket: BSV21_BASKET, limit: 10000 });
        if (have.outputs.some((o) => normOutpoint(o.outpoint) === `${txid}.${vout}`)) return;
        const { publicKey } = await wallet.getPublicKey({
          protocolID: P1SAT_PROTOCOL,
          keyID,
          counterparty: 'self',
          forSelf: true,
        });
        const address = PublicKey.fromString(publicKey).toAddress();
        const beef = await services.beef.getBeef(txid);
        await internalizeBeef({
          beef: beef instanceof Uint8Array ? beef : new Uint8Array(beef),
          wallet,
          services,
          chain,
          addressDerivations: new Map([
            [
              address,
              {
                outputIndex: vout,
                keyID,
                protocolID: P1SAT_PROTOCOL,
                counterparty: 'self',
                senderIdentityKey: identityKey,
              },
            ],
          ]),
        });
      },
      async dropStale(outpoint) {
        await wallet.relinquishOutput({ basket: BSV21_BASKET, output: outpoint });
      },
      cacheGet: chromeCache.get,
      cacheSet: chromeCache.set,
      now: () => Date.now(),
      log: (m) => console.log(`[tokenRecovery] ${m}`),
    },
    options,
  );
  if (result.imported.length || result.stale.length || result.pending.length) {
    console.log('[tokenRecovery] done:', JSON.stringify(result));
  }
  return result;
};
