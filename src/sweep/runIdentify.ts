import { Script, Transaction } from '@bsv/sdk';

/**
 * RelayX (Run) NFT importer, phase a: read-only (owner, 17 Oct 2026; docs/RELAYX-RECOVERY.md).
 *
 * A jig the user holds is an ordinary P2PKH output; what it IS lives in the Run payload of the tx that made it.
 * To name it we walk its location back to its ORIGIN (the output of the tx that created it):
 *
 *   1. Read the tx at the location and its Run payload: an output `OP_FALSE OP_RETURN "run" <ver> <app> <JSON>`.
 *      JSON `{in, ref, out, del, cre, exec}`; `in` = how many of the tx's first inputs are jigs.
 *   2. Jig outputs start right after the last OP_RETURN (S2 mints: image o0, Run o1, class o2, new NFT o3).
 *      Updated input jigs come first, in input order, then created jigs.
 *   3. Output k (counted from the first jig output) with k < `in` is input jig k moved on: follow input k's
 *      previous output and repeat. Otherwise the jig was created here, and this outpoint is its origin.
 *
 * The origin is then looked up in the NPG maps the NPG site publishes (origin = mint output, txid_o3). Other
 * NPG classes (KAZUYO, AIKA, NPG 00001…) are unencrypted, one girl per class: those are named from the class's
 * own DEPLOY metadata, found by walking the mint's class input back the same way.
 */

const BLOB = 'https://qw1nh74cmgrgawoh.public.blob.vercel-storage.com';
/** Published by the NPG site (tokenblaster session), immutable: {class, collection, jigs: {origin: {i, n, name?}}}. */
export const NPG_JIG_MAPS = [`${BLOB}/s2/v2/jig-to-card.json`, `${BLOB}/s1/v1/jig-to-card.json`] as const;
/** S2 cut-out art (961x1441 WebP with alpha) and the bounding box of each girl in it. */
export const npgCutoutUrl = (n: number) => `${BLOB}/s2/v2/${String(n).padStart(4, '0')}-cutout.webp`;
export const NPG_CUTOUT_INDEX = `${BLOB}/s2/v2/cutouts-index.json`;

/** OP_FALSE OP_RETURN PUSH3 "run". */
const RUN_PREFIX = [0x00, 0x6a, 0x03, 0x72, 0x75, 0x6e];
const OP_RETURN = 0x6a;

export type RunPayload = { in: number; ref?: string[]; out?: string[]; cre?: unknown[]; exec?: RunOp[] };
type RunOp = { op: string; data: unknown };

export const outpoint = (txid: string, vout: number) => `${txid}_o${vout}`;
export const splitOutpoint = (o: string) => {
  // Run writes txid_oN; the 1Sat indexer writes txid_N.
  const m = /^([0-9a-f]{64})_o?(\d+)$/i.exec(o);
  if (!m) throw new Error(`not an outpoint: ${o}`);
  return { txid: m[1].toLowerCase(), vout: Number(m[2]) };
};

/** The Run payload of a tx and the index of its first jig output, or null when the tx isn't a Run tx. */
export function readRun(tx: Transaction): { run: RunPayload; firstJig: number } | null {
  let run: RunPayload | null = null;
  let lastReturn = -1;
  tx.outputs.forEach((o, i) => {
    const b = o.lockingScript.toBinary();
    if (b[0] === OP_RETURN || (b[0] === 0x00 && b[1] === OP_RETURN)) lastReturn = i;
    if (run || b.length < RUN_PREFIX.length || !RUN_PREFIX.every((x, k) => b[k] === x)) return;
    // The SDK keeps everything after OP_RETURN as one chunk; its bytes are the pushes "run", version, app, JSON.
    // (A script built in code may hold them as separate chunks instead.)
    const cs = o.lockingScript.chunks;
    const at = cs.findIndex((c) => c.op === OP_RETURN);
    const pushes = cs[at]?.data?.length
      ? Script.fromBinary([...cs[at].data!])
          .chunks.filter((c) => c.data)
          .map((c) => c.data!)
      : cs
          .slice(at + 1)
          .filter((c) => c.data)
          .map((c) => c.data!);
    const json = pushes[pushes.length - 1] ?? [];
    try {
      run = JSON.parse(new TextDecoder().decode(new Uint8Array(json))) as RunPayload;
    } catch {
      run = null;
    }
  });
  return run ? { run, firstJig: lastReturn + 1 } : null;
}

export type GetTx = (txid: string) => Promise<Transaction>;

/** Walk a jig's current location back to the output that created it. */
export async function jigOrigin(
  location: string,
  getTx: GetTx,
  maxHops = 80,
  /** Origins already known (the NPG maps): stop there without downloading the mint, which carries the image. */
  isKnown: (outpoint: string) => boolean = () => false,
): Promise<{ origin: string; mint?: Transaction }> {
  let { txid, vout } = splitOutpoint(location);
  for (let hop = 0; hop < maxHops; hop++) {
    if (isKnown(outpoint(txid, vout))) return { origin: outpoint(txid, vout) };
    const tx = await getTx(txid);
    const r = readRun(tx);
    if (!r) throw new Error(`${txid.slice(0, 8)}… is not a Run transaction`);
    const k = vout - r.firstJig;
    if (k < 0) throw new Error(`output ${vout} of ${txid.slice(0, 8)}… is not a jig`);
    if (k >= (r.run.in ?? 0)) return { origin: outpoint(txid, vout), mint: tx };
    const input = tx.inputs[k];
    if (!input?.sourceTXID) throw new Error(`input ${k} of ${txid.slice(0, 8)}… has no source`);
    txid = input.sourceTXID;
    vout = input.sourceOutputIndex;
  }
  throw new Error(`gave up after ${maxHops} moves`);
}

/** Name in a mint's own call args (`mint("", {name})`) or a DEPLOY's class metadata, when there is one. */
export function runName(run: RunPayload): string {
  for (const e of run.exec ?? []) {
    const s = JSON.stringify(e.data ?? '');
    const m = /"metadata":\{[^}]*?"name":"([^"]+)"/.exec(s) ?? /"name":"([^"]+)"/.exec(s);
    if (m) return m[1];
  }
  return '';
}

export type NpgMap = {
  class: string;
  collection: string;
  jigs: Record<string, { i: number; n: number; name?: string }>;
};

export type IdentifiedJig = {
  location: string;
  origin: string;
  /** e.g. "NPG #0417", "Nao (NPG #0001)", "KAZUYO", or "RelayX NFT". */
  title: string;
  collection: string;
  /** S2 card number, when known: art at npgCutoutUrl(n). */
  n?: number;
  art?: string;
};

export const npgTitle = (n: number, name?: string) =>
  name ? `${name} (NPG #${String(n).padStart(4, '0')})` : `NPG #${String(n).padStart(4, '0')}`;

/** Name one held jig: map lookup first, then the class's own metadata. Never throws; unknowns say so. */
export async function identifyJig(location: string, getTx: GetTx, maps: readonly NpgMap[]): Promise<IdentifiedJig> {
  try {
    const { origin, mint: minted } = await jigOrigin(location, getTx, 80, (o) => maps.some((m) => !!m.jigs[o]));
    for (const m of maps) {
      const hit = m.jigs[origin];
      if (!hit) continue;
      const s2 = m.class.startsWith('393b1c2a');
      return {
        location,
        origin,
        title: npgTitle(hit.n, hit.name),
        collection: m.collection,
        n: hit.n,
        art: s2 ? npgCutoutUrl(hit.n) : undefined,
      };
    }
    // Not in the NPG maps: name it from the mint, else from its class (input 0 of the mint is the class).
    const mint = minted ?? (await getTx(splitOutpoint(origin).txid));
    const own = readRun(mint);
    let title = own ? runName(own.run) : '';
    let collection = 'RelayX NFT';
    if (own?.run.in && mint.inputs[0]?.sourceTXID) {
      try {
        const cls = await jigOrigin(outpoint(mint.inputs[0].sourceTXID, mint.inputs[0].sourceOutputIndex), getTx);
        const deploy = cls.mint ? readRun(cls.mint) : null;
        const name = deploy ? runName(deploy.run) : '';
        if (name) collection = name;
      } catch {
        /* class unreadable: keep the generic label */
      }
    }
    if (!title) title = collection;
    return { location, origin, title, collection };
  } catch (e) {
    return { location, origin: '', title: 'RelayX NFT', collection: `Couldn't read it (${(e as Error).message})` };
  }
}

/** Load the published NPG maps; a map that can't be fetched is skipped (its jigs show as "number pending"). */
export async function loadNpgMaps(f: typeof fetch = fetch): Promise<NpgMap[]> {
  const got = await Promise.all(
    NPG_JIG_MAPS.map(async (u) => {
      try {
        const r = await f(u);
        return r.ok ? ((await r.json()) as NpgMap) : null;
      } catch {
        return null;
      }
    }),
  );
  return got.filter((m): m is NpgMap => !!m && typeof m.jigs === 'object');
}
