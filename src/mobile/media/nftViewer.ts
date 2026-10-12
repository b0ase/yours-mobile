import { Beef, Script, type WalletInterface, type WalletOutput } from '@bsv/sdk';
import { nftTypeOf, type NftType } from '../nfts/nftLibrary';

/** Which hero viewer an NFT gets (NftHero.tsx). SVG draws as an image: scripts in an <img> never run. */
export const viewerFor = (contentType: string | null | undefined): NftType => nftTypeOf(contentType);

/** Clips under a minute play muted on a loop (iPhone-style); longer ones wait for Play. */
export const SHORT_CLIP_S = 60;
export const isShortClip = (seconds: number) => Number.isFinite(seconds) && seconds > 0 && seconds < SHORT_CLIP_S;

/** "video/mp4" → "MP4", "image/svg+xml" → "SVG". */
export const typeChip = (contentType: string | null | undefined) => {
  const sub = (contentType ?? '').split(';')[0].split('/')[1] ?? '';
  return sub ? sub.split('+')[0].replace(/^x-/, '').toUpperCase().slice(0, 8) : 'NFT';
};

export type Inscription = { contentType: string; data: Uint8Array };

const ORD = [0x6f, 0x72, 0x64]; // "ord"

/**
 * 1Sat inscription envelope in a locking script: OP_FALSE OP_IF "ord" [OP_1 <type>] OP_0 <data…> OP_ENDIF.
 * Data may be split over several pushes. Returns null when the script carries no inscription.
 */
export const extractInscription = (script: Script): Inscription | null => {
  const c = script.chunks;
  for (let i = 0; i + 2 < c.length; i++) {
    if (c[i].op !== 0 || c[i + 1].op !== 0x63) continue; // OP_FALSE OP_IF
    const tag = c[i + 2].data;
    if (!tag || tag.length !== 3 || tag.some((b, k) => b !== ORD[k])) continue;
    let contentType = '';
    const parts: number[][] = [];
    for (let j = i + 3; j < c.length; j++) {
      const ch = c[j];
      if (ch.op === 0x68) break; // OP_ENDIF
      const isField = (n: number) => ch.op === 0x50 + n || (ch.data?.length === 1 && ch.data[0] === n);
      if (ch.op === 0) {
        // OP_0: the body follows until OP_ENDIF.
        for (let k = j + 1; k < c.length && c[k].op !== 0x68; k++) parts.push(c[k].data ?? []);
        break;
      }
      if (isField(1) && c[j + 1]) {
        contentType = new TextDecoder().decode(new Uint8Array(c[j + 1].data ?? []));
        j++;
      } else j++; // any other field: skip its value
    }
    const len = parts.reduce((n, p) => n + p.length, 0);
    const data = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
    }
    return { contentType, data };
  }
  return null;
};

/** The inscription in output `vout` of `txid` inside a BEEF (the wallet's own copy of a signed tx). */
export const inscriptionFromBeef = (beef: number[] | Uint8Array, txid: string, vout: number): Inscription | null => {
  try {
    const tx = Beef.fromBinary(Array.from(beef)).findTxid(txid)?.tx;
    const out = tx?.outputs[vout];
    return out ? extractInscription(out.lockingScript) : null;
  } catch {
    return null;
  }
};

/**
 * Pending NFT: read its content from the signed transaction the wallet holds (listOutputs with entire
 * transactions returns that BEEF; read-only). Narrowed by the output's origin tag when it has one.
 */
export async function localInscription(
  wallet: Pick<WalletInterface, 'listOutputs'>,
  output: Pick<WalletOutput, 'outpoint' | 'tags'>,
): Promise<Inscription | null> {
  const [txid, v] = output.outpoint.split(/[._]/);
  const vout = Number(v) || 0;
  const originTag = (output.tags ?? []).find((t) => t.startsWith('origin:'));
  for (let offset = 0; offset < 200; offset += 25) {
    const r = await wallet.listOutputs({
      basket: '1sat',
      include: 'entire transactions',
      ...(originTag ? { tags: [originTag] } : {}),
      limit: 25,
      offset,
    });
    if (r.outputs.some((o) => o.outpoint.split(/[._]/)[0] === txid) && r.BEEF)
      return inscriptionFromBeef(r.BEEF, txid, vout);
    if (r.outputs.length < 25) break;
  }
  return null;
}
