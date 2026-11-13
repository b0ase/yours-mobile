/**
 * The world outside the devices, for the two-device simulation (src/incident/twoDeviceSim.test.ts): one fake BSV
 * chain with a mempool and blocks, a spent index, and every network source the wallet asks, each of which can be
 * made to answer 404 / 429 / 500 or time out for its next N calls.
 *
 * Sources (what each fault queue covers):
 *  - 'woc'       WhatsOnChain over fetch: /tx/hash/<txid>, /tx/<txid>/hex, /tx/<txid>/<vout>/spent, /chain/info
 *  - 'arc'       GorillaPool ARC over fetch: /v1/tx/<txid>
 *  - 'oneSat'    1Sat's BEEF store over fetch: /1sat/beef/<txid>, and services.beef.getRawTx (the overlay's raw tx)
 *  - 'txo'       the 1Sat spend index (services.txo.getSpends / getSpend / get): the overlay
 *  - 'broadcast' services.postBeef (the wallet's broadcaster)
 *  - 'backup'    wallet.1sat.app (World wires it onto the backup store's sync calls)
 * A '404' fault answers "not found" whatever the truth (a lagging indexer). Everything else is the truth.
 *
 * Ownership is decided here, never read back from a device: an output is the wallet's when the harness paid it to the
 * wallet, or when a device broadcast it and its script is not one the harness marked external (recipients, the Store).
 * Test support only: no network, no keys of any real account.
 */
import { Beef, MerklePath, Transaction, Utils } from '@bsv/sdk';
import { fixUtxoStatus } from '../../services/utxoStatus';

export type Source = 'woc' | 'arc' | 'oneSat' | 'txo' | 'broadcast' | 'backup';
export type FaultKind = '404' | '429' | '500' | 'timeout';
export const SOURCES: Source[] = ['woc', 'arc', 'oneSat', 'txo', 'broadcast', 'backup'];

export type ChainTx = { tx: Transaction; raw: number[]; block?: number };
export type Owned = { sats: number; token?: string };

/** A small deterministic PRNG (mulberry32) for seeded sequences. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    bytes: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 256)),
  };
}
export type Rng = ReturnType<typeof rng>;

const TXID = /^[0-9a-f]{64}$/;
export const op = (txid: string, vout: number) => `${txid}.${vout}`;
const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => op((i.sourceTXID ?? i.sourceTransaction!.id('hex')).toLowerCase(), i.sourceOutputIndex));

export class FaultError extends Error {
  constructor(
    readonly source: Source,
    readonly kind: FaultKind,
  ) {
    super(
      kind === 'timeout'
        ? `network: ${source} did not answer in time`
        : `${kind} ${kind === '429' ? 'Too Many Requests' : kind === '404' ? 'Not Found' : 'Internal Server Error'} (${source})`,
    );
  }
  get status() {
    return this.kind === 'timeout' ? undefined : Number(this.kind);
  }
}

export class FakeChain {
  height: number;
  readonly txs = new Map<string, ChainTx>();
  /** "txid.vout" → the transaction that spent it (mempool or mined). */
  readonly spentBy = new Map<string, string>();
  /** The wallet's outputs ("txid.vout"), decided by the harness (see file header). */
  readonly owned = new Map<string, Owned>();
  /** Locking scripts (hex) that are NOT the wallet's: recipients of sends, the Store. */
  readonly external = new Set<string>();
  readonly faults: Record<Source, FaultKind[]> = { woc: [], arc: [], oneSat: [], txo: [], broadcast: [], backup: [] };
  readonly calls: Record<Source, number> = { woc: 0, arc: 0, oneSat: 0, txo: 0, broadcast: 0, backup: 0 };
  readonly faultsHit: Record<Source, number> = { woc: 0, arc: 0, oneSat: 0, txo: 0, broadcast: 0, backup: 0 };
  /** URLs nobody mocked (a code path the harness doesn't cover yet). */
  readonly unmocked: string[] = [];
  /** How long a 'timeout' fault waits before failing (a real deadline would be seconds). */
  timeoutMs = 20;
  /** Ids the harness made up for parents of incoming payments (they need no history). */
  constructor(height = 974_000) {
    this.height = height;
  }

  // ── faults ──

  /** Queue `n` faults of `kind` for `source`'s next calls. */
  fault(source: Source, kind: FaultKind, n = 1) {
    for (let i = 0; i < n; i++) this.faults[source].push(kind);
  }
  clearFaults() {
    for (const s of SOURCES) this.faults[s].length = 0;
  }
  /** Count a call to `source`, and take its next fault if one is queued. */
  take(source: Source): FaultKind | undefined {
    this.calls[source]++;
    const f = this.faults[source].shift();
    if (f) this.faultsHit[source]++;
    return f;
  }
  /** Throw the next fault for `source`, if any ('404' included: a thrown not-found). */
  async gate(source: Source) {
    const f = this.take(source);
    if (!f) return;
    if (f === 'timeout') await new Promise((r) => setTimeout(r, this.timeoutMs));
    throw new FaultError(source, f);
  }

  // ── the ledger ──

  has = (txid: string) => this.txs.has(txid);
  mined = (txid: string) => this.txs.get(txid)?.block !== undefined;

  /**
   * Put a transaction on the network (mempool). Refuses a double spend of an outpoint already spent by another tx
   * (returns the clash). `walletBroadcast`: a device sent it, so its non-external outputs are the wallet's.
   */
  accept(
    tx: Transaction,
    o: { walletBroadcast?: boolean } = {},
  ): { ok: true } | { ok: false; clash: string; by: string } {
    const txid = tx.id('hex');
    if (this.txs.has(txid)) return { ok: true };
    for (const i of inputsOf(tx)) {
      const by = this.spentBy.get(i);
      if (by && by !== txid) return { ok: false, clash: i, by };
    }
    for (const i of inputsOf(tx)) this.spentBy.set(i, txid);
    this.txs.set(txid, { tx: Transaction.fromBinary(tx.toBinary()), raw: tx.toBinary() });
    if (o.walletBroadcast)
      tx.outputs.forEach((out, vout) => {
        const sats = out.satoshis ?? 0;
        if (sats > 0 && !this.external.has(out.lockingScript.toHex())) this.owned.set(op(txid, vout), { sats });
      });
    return { ok: true };
  }

  /** Mine everything in the mempool into the next block (one block per call). */
  mine() {
    this.height++;
    for (const t of this.txs.values()) if (t.block === undefined) t.block = this.height;
  }

  /** A merkle path for a mined tx (single-tx block: the root is the txid; the chain tracker accepts every root). */
  merklePath(txid: string): MerklePath | undefined {
    const t = this.txs.get(txid);
    if (t?.block === undefined) return undefined;
    return new MerklePath(t.block, [[{ offset: 0, hash: txid, txid: true }]]);
  }

  /** The wallet's unspent outputs on chain, mempool included: "txid.vout" → satoshis (BSV only, or tokens only). */
  unspent(kind: 'bsv' | 'token' = 'bsv'): Map<string, number> {
    const m = new Map<string, number>();
    for (const [o, w] of this.owned) {
      const [txid] = o.split('.');
      if (!this.txs.has(txid) || this.spentBy.has(o)) continue;
      if ((kind === 'token') !== !!w.token) continue;
      m.set(o, w.sats);
    }
    return m;
  }

  // ── WhatsOnChain, ARC, 1Sat's BEEF store over fetch ──

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const source: Source | undefined = url.includes('whatsonchain.com')
      ? 'woc'
      : url.includes('arc.gorillapool.io')
        ? 'arc'
        : url.includes('api.1sat.app/1sat/beef')
          ? 'oneSat'
          : undefined;
    if (!source) {
      this.unmocked.push(url);
      return new Response('', { status: 404 });
    }
    const f = this.take(source);
    if (f === 'timeout') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.timeoutMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      throw Object.assign(new Error(`network: ${source} timed out`), { name: 'TimeoutError' });
    }
    if (f) return new Response('', { status: Number(f) });
    return this.answer(source, url);
  }) as typeof fetch;

  private answer(source: Source, url: string): Response {
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    const notFound = () => new Response('', { status: 404 });
    if (source === 'woc') {
      let m = /\/tx\/hash\/([0-9a-f]{64})$/.exec(url);
      if (m) return this.has(m[1]) ? json({ txid: m[1], hash: m[1] }) : notFound();
      m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(url);
      if (m) return this.has(m[1]) ? new Response(Utils.toHex(this.txs.get(m[1])!.raw)) : notFound();
      m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
      if (m) {
        const by = this.spentBy.get(op(m[1], Number(m[2])));
        if (!by) return notFound();
        return json({ txid: by, vin: 0, status: this.mined(by) ? 'confirmed' : 'unconfirmed' });
      }
      if (/\/chain\/info$/.test(url)) return json({ blocks: this.height });
      this.unmocked.push(url);
      return notFound();
    }
    if (source === 'arc') {
      const m = /\/v1\/tx\/([0-9a-f]{64})$/.exec(url);
      if (!m || !this.has(m[1])) return notFound();
      return json({ txid: m[1], txStatus: this.mined(m[1]) ? 'MINED' : 'SEEN_ON_NETWORK' });
    }
    const m = /\/1sat\/beef\/([0-9a-f]{64})$/.exec(url);
    if (!m || !this.has(m[1])) return notFound();
    const beef = new Beef();
    beef.mergeTransaction(this.txs.get(m[1])!.tx);
    return new Response(new Uint8Array(beef.toBinary()), { status: 200 });
  }

  // ── the wallet's services (the shape initWallet's OneSatServices has, as far as the toolbox and our code ask) ──

  /** Services for one device. `posted` collects what that device broadcast. */
  services(posted: string[] = []) {
    const spendOf = (o: string) => this.spentBy.get(o.replace('_', '.')) ?? null;
    const tracker = { isValidRootForHeight: async () => true, currentHeight: async () => this.height };
    const svc: Record<string, unknown> = {
      chain: 'main',
      txo: {
        getSpends: async (ops: string[]) => {
          await this.gate('txo');
          return ops.map(spendOf);
        },
        getSpend: async (o: string) => {
          await this.gate('txo');
          return spendOf(o);
        },
        get: async (o: string) => {
          await this.gate('txo');
          const [txid, vout] = o.replace('_', '.').split('.');
          const t = this.txs.get(txid);
          if (!t) throw Object.assign(new Error('404 Not Found'), { status: 404 });
          return {
            outpoint: `${txid}.${vout}`,
            satoshis: t.tx.outputs[Number(vout)]?.satoshis,
            spend: spendOf(o) ?? undefined,
            height: t.block,
          };
        },
      },
      beef: {
        getRawTx: async (txid: string) => {
          await this.gate('oneSat');
          const t = this.txs.get(txid);
          if (!t) throw Object.assign(new Error('404 Not Found'), { status: 404 });
          return t.raw;
        },
      },
      getChainTracker: async () => tracker,
      getHeight: async () => this.height,
      getHeaderForHeight: async () => new Array(80).fill(0),
      nLockTimeIsFinal: async () => true,
      hashOutputScript: (s: string) => s,
      getBsvExchangeRate: async () => 17,
      getFiatExchangeRate: async () => 1,
      getStatusForTxids: async (txids: string[]) => ({
        status: 'success',
        results: txids.map((txid) => ({
          txid,
          status: this.mined(txid) ? 'mined' : this.has(txid) ? 'known' : 'unknown',
          depth: this.mined(txid) ? this.height - this.txs.get(txid)!.block! + 1 : 0,
        })),
      }),
      getRawTx: async (txid: string) => ({ txid, name: 'fake-chain', rawTx: this.txs.get(txid)?.raw }),
      getMerklePath: async (txid: string) => {
        const merklePath = this.merklePath(txid);
        return merklePath
          ? {
              name: 'fake-chain',
              merklePath,
              header: {
                height: merklePath.blockHeight,
                merkleRoot: txid,
                hash: txid,
                version: 1,
                previousHash: '00'.repeat(32),
                time: 0,
                bits: 0,
                nonce: 0,
              },
              notes: [],
            }
          : { name: 'fake-chain', notes: [] };
      },
      // 1sat-stack's arcade: REJECTED "UTXO_SPENT" when an input is already spent by another transaction.
      postBeef: async (beef: Beef, txids: string[]) => {
        const f = this.take('broadcast');
        if (f)
          return [
            {
              name: 'fake-arcade',
              status: 'error',
              error: new FaultError('broadcast', f),
              txidResults: txids.map((txid) => ({ txid, status: 'error', serviceError: true })),
            },
          ];
        const refused: { txid: string; reason: string }[] = [];
        for (const t of txids) {
          const tx = beef.findTxid(t)?.tx;
          if (!tx) continue;
          // Unmined ancestors in the BEEF reach the network with it.
          const r = this.accept(tx, { walletBroadcast: true });
          if (!r.ok) refused.push({ txid: t, reason: `UTXO_SPENT (70): utxo already spent by tx ${r.by}` });
          else posted.push(t);
        }
        if (refused.length)
          return [
            {
              name: 'fake-arcade',
              status: 'error',
              error: new Error(refused[0].reason),
              txidResults: refused.map((r) => ({
                txid: r.txid,
                status: 'error',
                data: { txStatus: 'REJECTED', extraInfo: r.reason },
              })),
            },
          ];
        return [
          { name: 'fake-arcade', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
        ];
      },
    };
    fixUtxoStatus(svc);
    const unmocked = this.unmocked;
    return new Proxy(svc, {
      get(t, p) {
        if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
        return async () => {
          unmocked.push(`services.${String(p)}`);
          throw new Error(`fake chain services: ${String(p)} not implemented`);
        };
      },
    });
  }
}

export const isTxid = (s: string) => TXID.test(s);
