/** Wording for the single "Migration tool" row at the bottom of the wallet home. Always shown. */
export const migrationRowText = (legacyLeft: number | undefined): string =>
  legacyLeft && legacyLeft > 0
    ? `${legacyLeft} item${legacyLeft === 1 ? '' : 's'} still at your old address. Bring them in`
    : 'coins, tokens and ordinals from Yours or old addresses';
