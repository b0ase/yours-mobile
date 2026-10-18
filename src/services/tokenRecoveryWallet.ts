/**
 * Wires tokenRecovery to the real wallet, 1Sat services and chrome.storage.
 * See tokenRecovery.ts for what it does and why.
 */
import { BSV21_BASKET, P1SAT_PROTOCOL } from '@1sat/types';
import { bsv21FieldsFromOutput, ensurePlaintextCi, internalizeBeef } from '@1sat/actions';
import type { OneSatServices } from '@1sat/wallet-browser';
import { Beef, KeyDeriver, PrivateKey, PublicKey, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { buildKeySearchSetup, invoicePrefixFor, searchMsKeyIDs } from './tokenKeySearch';
import {
  normOutpoint,
  recoverTokenOutputs,
  type KnownTokenOutput,
  type TokenRecoveryOptions,
  type TokenRecoveryResult,
  type TxTokenOutput,
} from './tokenRecovery';
import {
  TOKEN_SEND_JOURNAL_KEY,
  dropSpentTokenOutputs,
  INPUTS_SPENT_ERROR,
  fixStaleToken,
  healTokenSends,
  healUnseenTokenOutputs,
  repairUnsignableTokenOutputs,
  type KeyCheckReport,
  type KeyedTokenOutput,
  openJournalTokens,
  type HealAction,
  type LocalTokenOutput,
  type SpendPassReport,
  type StaleFixResult,
  type TokenSendHealReport,
  type TokenSendJournalEntry,
  type UnseenHealReport,
} from './tokenSendHeal';

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

/** Tokens the user asked Repair Sync to look for; walked on every later run. */
export const WATCH_TOKENS_KEY = 'tokenRecovery:watchTokens';
/** When the wallet's addresses were last asked about tokens (ms). */
const ADDRESS_SEED_AT_KEY = 'tokenRecovery:addressSeedAt';
const ADDRESS_SEED_EVERY_MS = 24 * 3600_000;
const MAX_SEED_ADDRESSES = 30;
const MAX_SEED_TOKENS = 50;

/** `bsv21:<txid>_<vout>` events name the token an output carries. */
export const tokenIdsFromEvents = (events: string[] | undefined): string[] =>
  (events ?? []).filter((e) => /^bsv21:[0-9a-f]{64}_\d+$/i.test(e)).map((e) => e.slice(6));

export interface SeedLookupDeps {
  addresses(): string[];
  /** Token outputs (any state) owned by an address, with their events. */
  ownerTokenOutputs(address: string): Promise<{ outpoint: string; events?: string[] }[]>;
  cacheGet(key: string): Promise<string | null>;
  cacheSet(key: string, value: string): Promise<void>;
  now(): number;
  log?(msg: string): void;
}

/**
 * Starting points for recovery the wallet's own storage may not have: the
 * genesis of each token the user asked about (remembered), and, once a day or
 * on Repair Sync, every token output at the wallet's own addresses plus the
 * genesis of its token. Read-only; bounded so one run asks the indexer at
 * most MAX_SEED_ADDRESSES times.
 */
export const lookupSeedOutpoints = async (
  deps: SeedLookupDeps,
  opts: { thorough: boolean; tokenIds: string[] },
): Promise<string[]> => {
  const log = deps.log ?? (() => {});
  let watched: string[] = [];
  try {
    watched = JSON.parse((await deps.cacheGet(WATCH_TOKENS_KEY)) ?? '[]') as string[];
  } catch {
    watched = [];
  }
  const asked = opts.tokenIds.filter((t) => /^[0-9a-f]{64}[._]\d+$/i.test(t)).map((t) => t.replace('.', '_'));
  if (asked.some((t) => !watched.includes(t))) {
    watched = [...new Set([...watched, ...asked])].slice(-MAX_SEED_TOKENS);
    await deps.cacheSet(WATCH_TOKENS_KEY, JSON.stringify(watched));
  }
  const tokenIds = new Set<string>([...watched, ...asked]);
  const outpoints = new Set<string>();

  const last = Number((await deps.cacheGet(ADDRESS_SEED_AT_KEY)) ?? 0);
  if (opts.thorough || deps.now() - last > ADDRESS_SEED_EVERY_MS) {
    for (const address of deps.addresses().slice(0, MAX_SEED_ADDRESSES)) {
      try {
        for (const o of await deps.ownerTokenOutputs(address)) {
          const ids = tokenIdsFromEvents(o.events);
          if (ids.length === 0) continue;
          outpoints.add(o.outpoint);
          ids.forEach((id) => tokenIds.add(id));
        }
      } catch (err) {
        log(`token lookup for ${address} failed: ${String(err)}`);
      }
    }
    await deps.cacheSet(ADDRESS_SEED_AT_KEY, String(deps.now()));
  }
  for (const id of [...tokenIds].slice(0, MAX_SEED_TOKENS)) outpoints.add(id);
  return [...outpoints].map(normOutpoint);
};

let running: Promise<TokenRecoveryResult> | null = null;

export interface RunTokenRecoveryArgs {
  /** Admin-bound wallet (permissions manager with the admin originator). */
  wallet: WalletInterface;
  services: OneSatServices;
  identityWif: string;
  chain: 'main' | 'test';
  options?: TokenRecoveryOptions;
  /** The wallet's own addresses (deposit addresses + identity), for indexer seeds. */
  addresses?: () => string[];
}

/** Single flight: a second call while one runs gets the running one's result. */
export const runTokenRecovery = (args: RunTokenRecoveryArgs): Promise<TokenRecoveryResult> => {
  if (running) return running;
  running = doRun(args).finally(() => {
    running = null;
  });
  return running;
};

/** Every output (spent or not) an address has held that carries a BSV-21 token. */
const ownerTokenOutputs = async (services: OneSatServices, address: string) => {
  const out: { outpoint: string; events?: string[] }[] = [];
  for await (const ev of services.owner.getTxos(address, { tags: ['bsv21'], events: true, limit: 200 })) {
    if (ev.type === 'txo') out.push({ outpoint: ev.data.outpoint, events: ev.data.events });
    else if (ev.type === 'error') throw ev.error;
    else if (ev.type === 'done') break;
  }
  return out;
};

/** Import one token output the wallet holds the key for (keyID, P1SAT protocol, self). Skips one already listed. */
const importTokenOutput = async (
  env: { wallet: WalletInterface; services: OneSatServices; chain: 'main' | 'test'; identityKey: string },
  { txid, vout, keyID }: { txid: string; vout: number; keyID: string },
) => {
  const { wallet, services, chain, identityKey } = env;
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
};

const doRun = async ({ wallet, services, identityWif, chain, options, addresses }: RunTokenRecoveryArgs) => {
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
      seedOutpoints: (seedOpts) =>
        lookupSeedOutpoints(
          {
            addresses: () => addresses?.() ?? [],
            ownerTokenOutputs: (address) => ownerTokenOutputs(services, address),
            cacheGet: chromeCache.get,
            cacheSet: chromeCache.set,
            now: () => Date.now(),
            log: (m) => console.log(`[tokenRecovery] ${m}`),
          },
          seedOpts,
        ),
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
      importOutput: ({ txid, vout, keyID }) =>
        importTokenOutput({ wallet, services, chain, identityKey }, { txid, vout, keyID }),
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

// --- Unfinished token sends, stale records, the post-merge spend pass (tokenSendHeal.ts) -----------------------

const chainSpends = async (services: OneSatServices, outpoints: string[]) => {
  const map = new Map<string, string | null>();
  for (let i = 0; i < outpoints.length; i += 100) {
    const batch = outpoints.slice(i, i + 100);
    const res = await services.txo.getSpends(batch.map((o) => o.replace('.', '_')));
    batch.forEach((o, j) => map.set(o, res[j] ?? null));
  }
  return map;
};

const overlayStates = async (services: OneSatServices, tokenId: string, outpoints: string[]) => {
  const res = await services.bsv21.getOutputStatus(tokenId, outpoints);
  return new Map(res.map((r) => [normOutpoint(r.outpoint), r.state as string | undefined]));
};

/** Spendable bsv21-basket outputs with their token and amount. */
const localTokenOutputs = async (wallet: WalletInterface): Promise<LocalTokenOutput[]> => {
  const list = await wallet.listOutputs({
    basket: BSV21_BASKET,
    includeTags: true,
    includeCustomInstructions: true,
    limit: 10000,
  });
  return list.outputs.flatMap((o) => {
    const f = bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
    return f.tokenId && f.amt ? [{ outpoint: normOutpoint(o.outpoint), tokenId: f.tokenId, amt: String(f.amt) }] : [];
  });
};

const p2pkhAddress = (hash160: string, chain: 'main' | 'test') =>
  Utils.toBase58Check(Utils.toArray(hash160, 'hex'), chain === 'main' ? [0x00] : [0x6f]);

export interface TokenHealArgs {
  wallet: WalletInterface;
  /** For failed actions (listFailedActions); optional. */
  listFailedActions?: () => Promise<HealAction[]>;
  services: OneSatServices;
  identityWif: string;
  chain: 'main' | 'test';
}

/** Startup and "Fix and send": import the change of token sends storage never finished. */
export const runTokenSendHeal = async (
  args: TokenHealArgs,
  opts: { tokenId?: string } = {},
): Promise<TokenSendHealReport> => {
  const { wallet, services, chain } = args;
  const identityKey = new KeyDeriver(PrivateKey.fromWif(args.identityWif)).identityKey;
  const rawCache = new Map<string, Transaction>();
  const getTx = async (txid: string) => {
    let tx = rawCache.get(txid);
    if (!tx) {
      tx = Transaction.fromBinary(Array.from(await services.beef.getRawTx(txid)));
      rawCache.set(txid, tx);
    }
    return tx;
  };
  return healTokenSends(
    {
      async listActions() {
        const page = await wallet.listActions({
          labels: [],
          includeOutputs: true,
          includeOutputLockingScripts: true,
          limit: 300,
        });
        const failed = args.listFailedActions ? await args.listFailedActions().catch(() => []) : [];
        return [...(page.actions as unknown as HealAction[]), ...failed];
      },
      parse: (lockingScript) => parseTokenOutput(lockingScript, '0'.repeat(64), 0),
      async findValidUnspent(tokenId, hash160) {
        const want = tokenId.replace('.', '_');
        const held = (await ownerTokenOutputs(services, p2pkhAddress(hash160, chain)))
          .filter((o) => tokenIdsFromEvents(o.events).includes(want))
          .map((o) => normOutpoint(o.outpoint));
        if (held.length === 0) return [];
        const spends = await chainSpends(services, held);
        const unspent = held.filter((o) => !spends.get(o));
        if (unspent.length === 0) return [];
        const states = await overlayStates(services, tokenId, unspent);
        const out: { outpoint: string; amt: string }[] = [];
        for (const o of unspent) {
          const st = states.get(o);
          if (st !== 'valid' && st !== 'queued') continue;
          const [txid, vout] = o.split('.');
          const tx = await getTx(txid);
          const t = parseTokenOutput(tx.outputs[Number(vout)].lockingScript.toHex(), txid, Number(vout));
          if (t && t.hash160 === hash160) out.push({ outpoint: o, amt: t.amt });
        }
        return out;
      },
      async haveOutput(outpoint) {
        const have = await wallet.listOutputs({ basket: BSV21_BASKET, limit: 10000 });
        return have.outputs.some((o) => normOutpoint(o.outpoint) === outpoint);
      },
      importOutput: ({ txid, vout, keyID }) =>
        importTokenOutput({ wallet, services, chain, identityKey }, { txid, vout, keyID }),
      journal: {
        async read() {
          try {
            const r = await chrome.storage.local.get(TOKEN_SEND_JOURNAL_KEY);
            return (r?.[TOKEN_SEND_JOURNAL_KEY] as TokenSendJournalEntry[] | undefined) ?? [];
          } catch {
            return [];
          }
        },
        async write(entries) {
          await chrome.storage.local.set({ [TOKEN_SEND_JOURNAL_KEY]: entries });
        },
      },
      now: () => Date.now(),
      log: (m) => console.log(`[tokenSendHeal] ${m}`),
    },
    opts,
  );
};

/** Relinquish token outputs the overlay or the chain reports spent (all tokens, or one). */
export const runSpendPass = (
  args: { wallet: WalletInterface; services: OneSatServices },
  opts: { tokenId?: string } = {},
): Promise<SpendPassReport> =>
  dropSpentTokenOutputs(
    {
      localOutputs: () => localTokenOutputs(args.wallet),
      overlayStatus: (tokenId, outpoints) => overlayStates(args.services, tokenId, outpoints),
      chainSpends: (outpoints) => chainSpends(args.services, outpoints),
      async relinquish(outpoint) {
        await args.wallet.relinquishOutput({ basket: BSV21_BASKET, output: outpoint });
      },
      log: (m) => console.log(`[tokenSpendPass] ${m}`),
    },
    opts,
  );

/** "Fix and send" for one token: drop spent records, import its valid change, report what changed. */
export const runStaleFix = (
  args: TokenHealArgs & { addresses?: () => string[] },
  tokenId: string,
): Promise<StaleFixResult> =>
  fixStaleToken(
    {
      spendPass: (id) => runSpendPass(args, { tokenId: id }),
      healSends: (id) => runTokenSendHeal(args, { tokenId: id }),
      recover: async (id) =>
        (
          await runTokenRecovery({
            wallet: args.wallet,
            services: args.services,
            identityWif: args.identityWif,
            chain: args.chain,
            addresses: args.addresses,
            options: { thorough: true, wide: true, tokenIds: [id] },
          })
        ).imported,
    },
    tokenId,
  );

/** Startup: heal unfinished sends, walk tokens the send view journalled, then close those journal entries. */
export const runStartupTokenHeal = async (args: TokenHealArgs & { addresses?: () => string[] }) => {
  const healed = await runTokenSendHeal(args);
  let journalled: string[] = [];
  try {
    const r = await chrome.storage.local.get(TOKEN_SEND_JOURNAL_KEY);
    const entries = (r?.[TOKEN_SEND_JOURNAL_KEY] as TokenSendJournalEntry[] | undefined) ?? [];
    journalled = openJournalTokens(entries, Date.now());
    if (journalled.length) {
      await runSpendPass(args).catch(() => undefined);
      await runTokenRecovery({ ...args, options: { thorough: true, tokenIds: journalled } }).catch(() => undefined);
      await chrome.storage.local.set({
        [TOKEN_SEND_JOURNAL_KEY]: entries.map((e) => (journalled.includes(e.tokenId) ? { ...e, done: true } : e)),
      });
    }
  } catch (err) {
    healed.errors.push(`journal: ${String(err)}`);
  }
  return { ...healed, journalled };
};

/**
 * Token outputs the overlay reports 'unknown': submit mined ones to the overlay, rebroadcast ones that never reached
 * the chain from the wallet's stored BEEF, relinquish ones whose rebroadcast is refused as a double spend.
 */
export const runUnseenHeal = async (
  args: { wallet: WalletInterface; services: OneSatServices },
  opts: { tokenId?: string; keysOnly?: boolean; verified?: Set<string> } = {},
): Promise<UnseenHealReport> => {
  const { wallet, services } = args;
  let stored: Beef | undefined;
  const walletBeef = async () => {
    if (!stored) {
      const list = await wallet.listOutputs({ basket: BSV21_BASKET, include: 'entire transactions', limit: 10000 });
      stored = list.BEEF?.length ? Beef.fromBinary(Array.from(list.BEEF)) : new Beef();
    }
    return stored;
  };
  const beefOf = async (txid: string): Promise<number[] | null> => {
    try {
      return Array.from(await services.beef.getBeef(txid));
    } catch {
      const beef = await walletBeef();
      return beef.findTxid(txid) ? beef.toBinaryAtomic(txid) : null;
    }
  };
  const keys = await runKeyCheck(args, opts, beefOf).catch(
    (e): KeyCheckReport => ({ checked: 0, repaired: [], dropped: [], errors: [`keys: ${String(e)}`] }),
  );
  stored = undefined; // the key pass may have changed the wallet's outputs
  if (opts.keysOnly) {
    return {
      unseen: [],
      submitted: [],
      rebroadcast: [],
      dropped: [],
      stillUnseen: [],
      keysRepaired: keys.repaired.length,
      keysDropped: keys.dropped.length,
      errors: keys.errors,
    };
  }
  const r = await healUnseenTokenOutputs(
    {
      localOutputs: () => localTokenOutputs(wallet),
      overlayStatus: (tokenId, outpoints) => overlayStates(services, tokenId, outpoints),
      async chainBeef(txid) {
        try {
          return Array.from(await services.beef.getBeef(txid));
        } catch {
          return null;
        }
      },
      async localBeef(txid) {
        const beef = await walletBeef();
        return beef.findTxid(txid) ? beef.toBinaryAtomic(txid) : null;
      },
      async broadcast(beef, txid) {
        const results = await services.postBeef(Beef.fromBinary(beef), [txid]);
        if (results.some((r) => r.status === 'success')) return { ok: true };
        const r = results[0];
        const t = r?.txidResults?.[0] as { doubleSpend?: boolean; data?: { txStatus?: string } } | undefined;
        const error = r?.error?.message ?? 'broadcast failed';
        const inputsSpent = !!t?.doubleSpend || (t?.data?.txStatus === 'REJECTED' && INPUTS_SPENT_ERROR.test(error));
        return { ok: false, inputsSpent, error };
      },
      async submitOverlay(beef, tokenId) {
        await services.overlay.submitBsv21(beef, tokenId.replace('.', '_'));
      },
      async relinquish(outpoint) {
        await wallet.relinquishOutput({ basket: BSV21_BASKET, output: outpoint });
      },
      log: (m) => console.log(`[tokenUnseenHeal] ${m}`),
    },
    opts,
  );
  return {
    ...r,
    keysRepaired: keys.repaired.length,
    keysDropped: keys.dropped.length,
    errors: [...keys.errors, ...r.errors],
  };
};

/** Outputs whose record names a key that doesn't sign them: refile with the right key, or relinquish. */
const runKeyCheck = (
  { wallet }: { wallet: WalletInterface },
  opts: { tokenId?: string; verified?: Set<string> },
  beefOf: (txid: string) => Promise<number[] | null>,
): Promise<KeyCheckReport> =>
  repairUnsignableTokenOutputs(
    {
      async localOutputs() {
        const list = await wallet.listOutputs({
          basket: BSV21_BASKET,
          include: 'locking scripts',
          includeTags: true,
          includeCustomInstructions: true,
          limit: 10000,
        });
        const out: KeyedTokenOutput[] = [];
        for (const o of list.outputs) {
          const f = bsv21FieldsFromOutput({
            tags: o.tags,
            customInstructions: o.customInstructions,
            outpoint: o.outpoint,
          });
          if (!f.tokenId || !f.amt) continue;
          const m = /76a914([0-9a-f]{40})88ac/i.exec(o.lockingScript ?? '');
          let ci: string | undefined;
          try {
            ci = await ensurePlaintextCi(wallet, o.customInstructions);
          } catch {
            ci = undefined;
          }
          out.push({
            outpoint: normOutpoint(o.outpoint),
            tokenId: f.tokenId,
            amt: String(f.amt),
            hash160: m ? m[1] : null,
            customInstructions: ci,
            tags: o.tags,
          });
        }
        return out;
      },
      async derive(key) {
        const { publicKey } = await wallet.getPublicKey({
          protocolID: key.protocolID as [0 | 1 | 2, string],
          keyID: key.keyID,
          counterparty: key.counterparty,
          forSelf: true,
        });
        return PublicKey.fromString(publicKey).toHash('hex') as string;
      },
      async refile(o, customInstructions, tags) {
        const [txid, vout] = o.outpoint.split('.');
        const beef = await beefOf(txid);
        if (!beef) throw new Error('no copy of the transaction to refile from');
        await wallet.relinquishOutput({ basket: BSV21_BASKET, output: o.outpoint });
        await wallet.internalizeAction({
          tx: beef,
          description: 'Token key record fixed',
          outputs: [
            {
              outputIndex: Number(vout),
              protocol: 'basket insertion',
              insertionRemittance: { basket: BSV21_BASKET, tags, customInstructions },
            },
          ],
        });
      },
      async relinquish(outpoint) {
        await wallet.relinquishOutput({ basket: BSV21_BASKET, output: outpoint });
      },
      log: (m) => console.log(`[tokenKeyCheck] ${m}`),
    },
    opts,
  );
