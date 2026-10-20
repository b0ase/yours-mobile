import { Beef, Utils } from '@bsv/sdk';
import type { Fetch } from '../../names/names';
import { checkBeef } from './guard';
import {
  headerFromFields,
  parseOutpoint,
  verifyMintEvidence,
  type HeaderAnswer,
  type Options,
  type Verdict,
} from './verify';

/**
 * Fetching for "Check this mint": public sources only, each answer re-checked by verify.ts.
 *
 *   BEEF (tx + BUMP)  WhatsOnChain  /tx/<txid>/beef
 *   headers by height WhatsOnChain  /block/height/<h>   (fields; we rebuild and re-hash the 80 bytes)
 *                     Bitails       /block/height/<h>   (raw 80-byte header)
 *
 * A source being down gives UNREACHABLE, never VERIFIED. A source lying gives REFUSED: the tx bytes
 * must hash to the txid, the path must reach the header's root, and the header's work is checked here.
 */

export const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export const BITAILS = 'https://api.bitails.io';
/** Largest BEEF hex we read (≈ 32 MB of bytes); bMint inscriptions are far smaller. */
const MAX_HEX = 64 << 20;

export interface HeaderSource {
  name: string;
  get(height: number, f: Fetch): Promise<number[]>;
}

const json = async (f: Fetch, url: string) => {
  const r = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as Record<string, unknown>;
};

export const wocHeaders: HeaderSource = {
  name: 'WhatsOnChain',
  async get(height, f) {
    const j = await json(f, `${WOC}/block/height/${height}`);
    if (j.height !== height) throw new Error('wrong height');
    return headerFromFields(j as unknown as Parameters<typeof headerFromFields>[0]);
  },
};

export const bitailsHeaders: HeaderSource = {
  name: 'Bitails',
  async get(height, f) {
    const j = await json(f, `${BITAILS}/block/height/${height}`);
    if (j.height !== height || typeof j.header !== 'string' || !/^[0-9a-f]{160}$/i.test(j.header))
      throw new Error('no header');
    return Utils.toArray(j.header, 'hex');
  },
};

export const DEFAULT_HEADER_SOURCES = [wocHeaders, bitailsHeaders];

export interface CheckDeps {
  fetch?: Fetch;
  headerSources?: HeaderSource[];
  /** BEEF hex for a txid; default WhatsOnChain. */
  getBeef?: (txid: string, f: Fetch) => Promise<string>;
}

export async function wocBeef(txid: string, f: Fetch): Promise<string> {
  const r = await f(`${WOC}/tx/${txid}/beef`, { signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) throw new Error('not found');
  if (!r.ok) throw new Error(`${r.status}`);
  const t = (await r.text()).trim();
  if (t.length > MAX_HEX) throw new Error('too large');
  return t;
}

/** The height of the tx's BUMP, after the bounded walk (verify.ts re-parses and re-checks everything). */
function bumpHeight(beef: number[], txid: string): number | null {
  try {
    checkBeef(beef);
    return Beef.fromBinaryStrict(beef).findBump(txid)?.blockHeight ?? null;
  } catch {
    return null;
  }
}

/** Fetch everything, then let verify.ts decide. File hashing happens before this, on the device. */
export async function checkMint(
  input: string,
  opts: { fileSha256?: string } & Options = {},
  deps: CheckDeps = {},
): Promise<Verdict> {
  const f = deps.fetch ?? fetch;
  const outpoint = parseOutpoint(input);
  if (!outpoint) return { status: 'REFUSED', code: 'malformed', reason: 'That is not a mint link or transaction id.' };
  const txid = outpoint.split('_')[0];
  let beefHex: string;
  try {
    beefHex = await (deps.getBeef ?? wocBeef)(txid, f);
  } catch (e) {
    const m = (e as Error)?.message;
    return {
      status: 'UNREACHABLE',
      reason:
        m === 'not found'
          ? 'No public service has this transaction (not broadcast yet, or the link is wrong).'
          : `Could not fetch the transaction (${m || 'network error'}).`,
      outpoint,
    };
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(beefHex))
    return { status: 'REFUSED', code: 'malformed', reason: 'The proof is not hex.', outpoint };
  const beef = Utils.toArray(beefHex, 'hex');
  const height = bumpHeight(beef, txid);
  const headers: HeaderAnswer[] = [];
  if (height !== null) {
    const got = await Promise.allSettled(
      (deps.headerSources ?? DEFAULT_HEADER_SOURCES).map(async (s) => ({
        source: s.name,
        height,
        raw: await s.get(height, f),
      })),
    );
    for (const g of got) if (g.status === 'fulfilled') headers.push(g.value);
  }
  return verifyMintEvidence(
    { outpoint, beef, headers, fileSha256: opts.fileSha256 },
    { minHeaderSources: opts.minHeaderSources },
  );
}
