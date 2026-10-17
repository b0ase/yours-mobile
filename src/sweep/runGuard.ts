/**
 * Run NFTs (jigs) must never be spent as plain sats: a Run jig is an ordinary P2PKH output whose Run state lives
 * in an OP_RETURN of the tx that made it, so a value-only sweep or fee spend destroys the NFT for good (owner,
 * 17 Oct 2026: RelayX collections). Run jigs sit at 273 sats (Run's default dust), so any 273-sat output, or one
 * the indexer tags as Run, is held back from every sweep and shown as a Run NFT instead.
 */
export const RUN_JIG_SATS = 273;

export const isRunJig = (o: { satoshis?: number; events?: readonly string[] }): boolean =>
  o.satoshis === RUN_JIG_SATS ||
  (o.events ?? []).some((e) => /^(type|app|proto|protocol):run\b/i.test(e) || e === 'run');
