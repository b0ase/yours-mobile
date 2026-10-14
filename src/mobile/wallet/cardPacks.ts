import type { PackId } from './cardDesign';

/**
 * Holder art packs (Design your card › Collections, owner 14 Oct 2026): our own art, unlocked by what the wallet
 * already holds. Pure rules here (tested in cardPacks.test.ts); the pictures live in cardArt.ts.
 *  - VexVoid: the wallet has no album-purchase record yet (bMusic's owner key source is still NotYet), so it
 *    unlocks on holding the $VEXVOID token or any NFT whose name mentions VexVoid / V3XV0ID / Echoes in the Abyss.
 *  - NPG: holding the $NPG token (or $NPGRED), or an NFT named Ninja Punk Girls / NPG.
 *  - NPGX: holding the $NPGX token, or an NFT named NPGX.
 */
export type Holdings = { tokens: readonly string[]; nftNames: readonly string[] };

const RULES: Record<PackId, { tokens: string[]; nft: RegExp }> = {
  vexvoid: { tokens: ['VEXVOID', 'V3X', 'MISSVOID'], nft: /vex\s*void|v3xv0id|echoes in the abyss/i },
  npg: { tokens: ['NPG', 'NPGRED'], nft: /ninja\s*punk\s*girls|\bnpg\b(?!x)/i },
  npgx: { tokens: ['NPGX'], nft: /\bnpgx\b/i },
};

export function ownsPack(pack: PackId, h: Holdings): boolean {
  const r = RULES[pack];
  const syms = h.tokens.map((t) => t.replace(/^\$/, '').toUpperCase());
  return r.tokens.some((t) => syms.includes(t)) || h.nftNames.some((n) => r.nft.test(n));
}
