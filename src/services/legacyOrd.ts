/**
 * The account's legacy ordinals address (addresses.ordAddress, the Yours-style m/44'/236'/1'/0/0 key), watched by
 * the wallet's ongoing sync (owner, 24 Oct 2026: "watch the old ord address").
 *
 * Our paymail server hands that address to senders (pay.bwallet.space /api/paymail/ord/<paymail>), so an NFT sent
 * to $name lands there. The BRC-100 wallet only scans its own BRC-42 deposit keys, so those NFTs never reached
 * Wallet › NFTs. Here:
 *
 *  - installLegacyOrdSigner: the base wallet answers getPublicKey / createSignature for one wallet-only protocol
 *    (LEGACY_ORD_PROTOCOL, keyID 'ord') with the legacy ord key itself. Outside apps can never reach it
 *    (services/reservedProtocols.ts refuses the protocol before any prompt).
 *  - syncLegacyOrd: each unspent 1-sat ordinal at the address (with an origin; never Run jigs) is internalized into
 *    the ordinals basket with customInstructions naming that protocol (tokens, names, BSV: see below). @1sat/actions
 *    then signs sends, listings and avatar moves through signOrdinalInput → the signer above, like any other NFT.
 *
 * Nothing is moved or broadcast here: the outputs stay where they are. Accounts without a key for the address
 * (passkey / seedless, an address that does not match the stored key) are skipped.
 *
 * Scan and spend (owner, 29 Oct 2026, "go fix 1"): the sync now takes in EVERYTHING spendable at both legacy
 * addresses, so nothing sent there is stranded: 1-sat ordinals (as before), OpNS names, BSV-21 tokens and plain
 * BSV. The legacy pay key (addresses.bsvAddress, walletWif) gets its own wallet-only protocol (LEGACY_PAY_PROTOCOL).
 * Plain BSV goes to the deposit basket (counted in the balance, services/depositBalance.ts, and moved into funding
 * by sweepDeposit, which signs through the same signer). Run jigs and locks are never taken in.
 */
import { BigNumber, ECDSA, Hash, PrivateKey } from '@bsv/sdk';
import type { WalletInterface } from '@bsv/sdk';
import type { OneSatServices } from '@1sat/client';
import { internalizeBeef } from '@1sat/actions';
import { BSV21_BASKET, DEPOSIT_BASKET, FUNDING_BASKET, OPNS_BASKET, ORDINALS_BASKET } from '@1sat/types';
import { scanAddress } from '../sweep/scanner';

/** Wallet-only protocol whose single key ('ord') is the legacy ord key. Listed in reservedProtocolList.ts. */
export const LEGACY_ORD_PROTOCOL: [2, string] = [2, 'bwalletx legacy ord'];
export const LEGACY_ORD_KEY_ID = 'ord';
/** Wallet-only protocol for the legacy pay key (addresses.bsvAddress). Listed in reservedProtocolList.ts. */
export const LEGACY_PAY_PROTOCOL: [2, string] = [2, 'bwalletx legacy pay'];
/**
 * Plain BSV, tokens and names are filed with derivationPrefix 'legacy' + suffix 'ord' / 'pay' (keyID 'legacy ord' /
 * 'legacy pay'): @1sat/actions builds a deposit output's keyID from prefix + suffix only.
 */
const LEGACY_PREFIX = 'legacy';
export type LegacyKind = 'ord' | 'pay';
const SPEC: Record<LegacyKind, { protocol: [2, string]; keyIDs: string[] }> = {
  ord: { protocol: LEGACY_ORD_PROTOCOL, keyIDs: [LEGACY_ORD_KEY_ID, `${LEGACY_PREFIX} ord`] },
  pay: { protocol: LEGACY_PAY_PROTOCOL, keyIDs: [`${LEGACY_PREFIX} pay`] },
};
export const LEGACY_PAY_KEY_ID = SPEC.pay.keyIDs[0];

type CallArgs = { protocolID?: unknown; keyID?: unknown; counterparty?: unknown };
const legacyKindOf = (args: CallArgs): LegacyKind | undefined => {
  if (!Array.isArray(args.protocolID) || typeof args.protocolID[1] !== 'string') return undefined;
  if (!(args.counterparty === undefined || args.counterparty === 'self')) return undefined;
  const name = args.protocolID[1].trim().toLowerCase();
  for (const kind of ['ord', 'pay'] as const) {
    const { protocol, keyIDs } = SPEC[kind];
    if (args.protocolID[0] === protocol[0] && name === protocol[1] && keyIDs.includes(args.keyID as string))
      return kind;
  }
  return undefined;
};

/**
 * The legacy ord key, only when it really is the key for the account's ordAddress. undefined: nothing to watch
 * (no ordWif stored, e.g. a passkey or seedless account, or a mismatch).
 */
export const legacyOrdKey = (ordWif: string | undefined, ordAddress: string | undefined): PrivateKey | undefined => {
  if (!ordWif || !ordAddress) return undefined;
  try {
    const key = PrivateKey.fromWif(ordWif);
    return key.toPublicKey().toAddress() === ordAddress ? key : undefined;
  } catch {
    return undefined;
  }
};

/** The legacy pay key (walletWif), only when it is the key for addresses.bsvAddress. Same rules as legacyOrdKey. */
export const legacyPayKey = legacyOrdKey;

type SignerWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

const watching: Partial<Record<LegacyKind, string>> = {};
/** The legacy ord address this context's wallet can sign for ('' / undefined: none, so nothing to take in). */
export const watchedLegacyOrdAddress = () => watching.ord;
/** The legacy pay address this context's wallet can sign for (undefined: none). */
export const watchedLegacyPayAddress = () => watching.pay;

/**
 * Patch the base wallet in place (like guardSpending) so each legacy protocol signs with its key. Every other call
 * goes through unchanged. Returns an undo function (tests).
 */
export const installLegacySigner = (
  wallet: SignerWallet,
  keys: Partial<Record<LegacyKind, PrivateKey>>,
): (() => void) => {
  const getPublicKey = wallet.getPublicKey.bind(wallet);
  const createSignature = wallet.createSignature.bind(wallet);
  const kinds = (['ord', 'pay'] as const).filter((k) => keys[k]);
  for (const k of kinds) watching[k] = keys[k]!.toPublicKey().toAddress();
  const keyFor = (args: CallArgs) => {
    const kind = legacyKindOf(args);
    return kind ? keys[kind] : undefined;
  };
  wallet.getPublicKey = (async (args, originator) => {
    const key = args.identityKey ? undefined : keyFor(args);
    if (key) return { publicKey: key.toPublicKey().toString() };
    return getPublicKey(args, originator);
  }) as WalletInterface['getPublicKey'];
  wallet.createSignature = (async (args, originator) => {
    const key = keyFor(args);
    if (!key) return createSignature(args, originator);
    const hash = args.hashToDirectlySign ?? (args.data ? Hash.sha256(args.data) : undefined);
    if (!hash) throw new Error('args.data or args.hashToDirectlySign must be valid');
    return { signature: ECDSA.sign(new BigNumber(hash), key, true).toDER() as number[] };
  }) as WalletInterface['createSignature'];
  return () => {
    for (const k of kinds) delete watching[k];
    wallet.getPublicKey = getPublicKey;
    wallet.createSignature = createSignature;
  };
};

/** The legacy ord key only (kept for callers and tests). */
export const installLegacyOrdSigner = (wallet: SignerWallet, key: PrivateKey) =>
  installLegacySigner(wallet, { ord: key });

/** "txid_vout" / "txid.vout" → "txid_vout", lower case. */
export const normOutpoint = (o: string) => o.toLowerCase().replace('.', '_');

const TAKEN_KEY = 'bwx.legacyOrd.takenIn';
/** Outpoints (normalised) this device took in from the legacy ord address. Shown only once kept (legacyOrdVisible). */
export const takenInLegacy = (): Set<string> => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(TAKEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const rememberTakenIn = (ops: string[]) => {
  if (!ops.length) return;
  try {
    globalThis.localStorage?.setItem(TAKEN_KEY, JSON.stringify([...new Set([...takenInLegacy(), ...ops])]));
  } catch {
    // no storage here: the list then hides nothing extra, the inbox's Quarantine still applies on screen
  }
};

const TAKEN_OTHER_KEY = 'bwx.legacy.takenInOther';
/**
 * Outpoints of BSV-21 tokens and plain BSV this device took in from a legacy address. Taking in gives the tx an
 * action record, which would make the airdrops inbox treat the tx as our own (no Quarantine for the token) and show
 * nothing for a BSV drop. airdrops/load.ts reads these so tokens stay quarantined until kept, and a taken-in BSV
 * drop shows as already in the balance (needsMove false), never as needing a move.
 */
export const takenInLegacyOther = (): Set<string> => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(TAKEN_OTHER_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const rememberTakenInOther = (ops: string[]) => {
  if (!ops.length) return;
  try {
    globalThis.localStorage?.setItem(TAKEN_OTHER_KEY, JSON.stringify([...new Set([...takenInLegacyOther(), ...ops])]));
  } catch {
    // no storage: the inbox then treats the tx as our own (the token is shown, the BSV is in the balance)
  }
};

/**
 * Quarantine wins (owner review, 24 Oct 2026): an NFT taken in from the legacy ord address shows in Wallet › NFTs
 * only once it is kept (or its sender trusted) in bMail. `kept`: the inbox's kept NFTs (airdrops/inbox keptNfts).
 */
export const legacyOrdVisible = (
  outpoint: string,
  legacy: Set<string>,
  kept: { txid: string; outpoint?: string }[],
  /** Kept NFT origins (airdrops/inbox keptOriginSet): a keep survives the item leaving the History list. */
  keptOrigins: Set<string> = new Set(),
  /** The output's inscription origin, when known. */
  origin?: string,
): boolean => {
  const op = normOutpoint(outpoint);
  if (!legacy.has(op)) return true;
  if (keptOrigins.has(op) || (origin && keptOrigins.has(normOutpoint(origin)))) return true;
  return kept.some((k) => (k.outpoint ? normOutpoint(k.outpoint) === op : op.split('_')[0] === k.txid.toLowerCase()));
};

type ListWallet = Pick<WalletInterface, 'listOutputs' | 'internalizeAction'>;

/** Outpoints already in the given baskets (normalised). Default: the ordinals basket. */
export const heldOrdinals = async (
  wallet: Pick<WalletInterface, 'listOutputs'>,
  baskets: string[] = [ORDINALS_BASKET],
): Promise<Set<string>> => {
  const held = new Set<string>();
  const limit = 1000;
  for (const basket of baskets) {
    for (let offset = 0; offset < 20_000; offset += limit) {
      const r = await wallet.listOutputs({ basket, limit, offset });
      for (const o of r.outputs) held.add(normOutpoint(o.outpoint));
      if (r.outputs.length < limit) break;
    }
  }
  return held;
};

/** Every basket a legacy output can land in: never take in an outpoint the wallet already holds anywhere. */
const LEGACY_BASKETS = [ORDINALS_BASKET, BSV21_BASKET, OPNS_BASKET, DEPOSIT_BASKET, FUNDING_BASKET, 'mnee'];

/**
 * internalizeBeef's explicit-output mode files BSV-21 rows without the `bsv21:<id>` tag (the indexer only tags owned
 * outputs). Balances and sends read the id from customInstructions, but tag filters (bsv21FilterTags) need it too.
 */
const withBsv21Tags = <W extends Pick<WalletInterface, 'internalizeAction'>>(wallet: W): W =>
  new Proxy(wallet, {
    get(t, p, r) {
      if (p !== 'internalizeAction') {
        const v = Reflect.get(t, p, r) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      }
      return (args: Parameters<WalletInterface['internalizeAction']>[0], originator?: string) =>
        t.internalizeAction(
          {
            ...args,
            outputs: args.outputs.map((o) => {
              const ins = o.insertionRemittance;
              if (o.protocol !== 'basket insertion' || !ins || ins.basket !== BSV21_BASKET) return o;
              let id: unknown;
              try {
                id = (JSON.parse(ins.customInstructions ?? '{}') as { id?: unknown }).id;
              } catch {
                return o;
              }
              const tag = typeof id === 'string' && id ? `bsv21:${id}` : '';
              if (!tag || ins.tags?.includes(tag)) return o;
              return { ...o, insertionRemittance: { ...ins, tags: [...(ins.tags ?? []), tag] } };
            }),
          },
          originator,
        );
    },
  });

export type LegacyOrdDeps = {
  wallet: ListWallet;
  services: OneSatServices;
  chain: 'main' | 'test';
  address: string;
  /** Which legacy key owns `address` (default 'ord'). */
  kind?: LegacyKind;
  /** Test seams. */
  scan?: typeof scanAddress;
  internalize?: typeof internalizeBeef;
};

type Derivation = {
  outputIndex: number;
  protocolID: [2, string];
  keyID?: string;
  derivationPrefix?: string;
  derivationSuffix?: string;
  counterparty: 'self';
};
type Pick1 = { txid: string; vout: number; what: 'nft' | 'other' };

const parseOp = (outpoint: string): { txid: string; vout: number } | undefined => {
  const [txid, vout] = normOutpoint(outpoint).split('_');
  const n = Number(vout);
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(n) || n < 0) return undefined;
  return { txid, vout: n };
};

/**
 * Take the address's unspent assets into the wallet: 1-sat ordinals with an origin and OpNS names (ordinals / opns
 * baskets), BSV-21 tokens (bsv21 basket) and plain BSV (deposit basket). Returns how many outputs were added and
 * how many txs failed. Run jigs, locks and BSV-20 are never taken in (the scanner keeps them apart).
 */
export const syncLegacyOrd = async (deps: LegacyOrdDeps): Promise<{ added: number; failed: number }> => {
  const scan = deps.scan ?? scanAddress;
  const internalize = deps.internalize ?? internalizeBeef;
  const kind = deps.kind ?? 'ord';
  const { protocol } = SPEC[kind];
  const assets = await scan(deps.services, deps.address);
  const held = await heldOrdinals(deps.wallet, LEGACY_BASKETS);
  const picks: Pick1[] = [];
  const add = (outpoint: string, what: Pick1['what']) => {
    const p = parseOp(outpoint);
    if (p && !held.has(`${p.txid}_${p.vout}`)) picks.push({ ...p, what });
  };
  // Only real ordinals (an origin the indexer knows).
  for (const o of assets.ordinals ?? []) if ((o.satoshis ?? 0) === 1 && o.origin) add(o.outpoint, 'nft');
  for (const o of assets.opnsNames ?? []) if ((o.satoshis ?? 0) === 1) add(o.outpoint, 'nft');
  for (const t of assets.bsv21Tokens ?? []) for (const o of t.outputs) add(o.outpoint, 'other');
  for (const o of assets.funding ?? []) if ((o.satoshis ?? 0) > 1) add(o.outpoint, 'other');
  // Grouped per tx so one internalize takes all its vouts.
  const byTxid = new Map<string, Pick1[]>();
  for (const p of picks) byTxid.set(p.txid, [...(byTxid.get(p.txid) ?? []).filter((x) => x.vout !== p.vout), p]);
  // An ordinal at the ord address keeps its original keyID 'ord' (NFTs taken in before stay signable as they were).
  const derivation = (p: Pick1): Derivation =>
    kind === 'ord' && p.what === 'nft'
      ? { outputIndex: p.vout, protocolID: protocol, keyID: LEGACY_ORD_KEY_ID, counterparty: 'self' }
      : {
          outputIndex: p.vout,
          protocolID: protocol,
          derivationPrefix: LEGACY_PREFIX,
          derivationSuffix: kind,
          counterparty: 'self',
        };
  const wallet = withBsv21Tags(deps.wallet);
  let added = 0;
  let failed = 0;
  for (const [txid, list] of byTxid) {
    try {
      const beef = await deps.services.beef.getBeef(txid);
      if (!beef) throw new Error(`no BEEF for ${txid}`);
      const r = await internalize({
        beef,
        wallet: wallet as WalletInterface,
        services: deps.services,
        chain: deps.chain,
        outputs: list.map(derivation),
      } as Parameters<typeof internalizeBeef>[0]);
      added += r.internalized;
      rememberTakenIn(list.filter((p) => p.what === 'nft').map((p) => `${txid}_${p.vout}`));
      rememberTakenInOther(list.filter((p) => p.what === 'other').map((p) => `${txid}_${p.vout}`));
    } catch (err) {
      failed++;
      console.warn('[legacyOrd] could not take in', txid, err);
    }
  }
  return { added, failed };
};

/** Both legacy addresses this wallet can sign for, ord first. */
export const watchedLegacyAddresses = (): { kind: LegacyKind; address: string }[] =>
  (['ord', 'pay'] as const).flatMap((kind) => (watching[kind] ? [{ kind, address: watching[kind]! }] : []));

/** For screens (Refresh NFTs, bMail Keep): take in both watched addresses' assets with the screen's wallet context. */
export const takeInLegacyOrd = async (ctx: {
  wallet: unknown;
  services?: OneSatServices;
  chain?: 'main' | 'test';
}): Promise<{ added: number; failed: number }> => {
  const total = { added: 0, failed: 0 };
  if (!ctx.services) return total;
  for (const { kind, address } of watchedLegacyAddresses()) {
    const r = await syncLegacyOrd({
      wallet: ctx.wallet as ListWallet,
      services: ctx.services,
      chain: ctx.chain ?? 'main',
      address,
      kind,
    });
    total.added += r.added;
    total.failed += r.failed;
  }
  return total;
};
