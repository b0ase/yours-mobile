/** Copy and small helpers shared by the PNEE screens (kept out of the component files for fast refresh). */

/** BSV typed with up to 8 decimals → exact sats. */
export const bsvToSats = (bsv: number) => BigInt(Math.round(bsv * 1e8));

/** What a PNEE vault is, in mechanics only. */
export const PNEE_CARD = {
  intro:
    'Every PNEE is one cent, backed by BSV locked in a public vault. You lock BSV in your own vault and mint PNEEs against it.',
  how: 'Mint up to a tenth of the vault’s value: $10 of BSV backs up to $1 of PNEEs (1000%). The ratio is in the vault’s script on-chain. The BSV stays in your vault; to unlock it, burn the PNEEs it minted and close it.',
  floor:
    'If BSV falls until the vault is below 150% of its PNEEs, anyone may close it by burning its PNEEs. They take BSV worth those PNEEs plus 10%, and the rest goes back to you. There is no fee.',
  signers:
    'The BSV price comes from 3 of 5 price signers. All five are run by The Bitcoin Corporation Ltd today. Details at bwalletx.com/pnee.',
};
