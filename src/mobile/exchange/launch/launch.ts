import { mintFeeAddress, txFeeSats } from '../../mint/mint';
import { TOKEN_DEPLOY_BYTES, validateToken, type TokenForm } from '../../tokens/token';
import { safety, type SafetyFilter } from '../../market/safety';
import { hasReturnsWording, RETURNS_BLOCK } from '../../tokens/returnsWording';

/**
 * Exchange › Launchpad › Launch your own coin (phase 1 of the launchpad of launchpads): a BSV-21 token
 * deployed from this wallet on our own flow, no tokenblaster.lol. Pure helpers; nothing here signs.
 *
 * Fee (owner, 11 Oct 2026: "small flat BSV fee, never a share of the token"): one flat output of
 * LAUNCH_FEE_SATS to the build's bCorp fee address (BWALLET_MINT_FEE_ADDRESS, address only). A build
 * without that address, and every store build (bcorpFeeAddress), charges no launch fee.
 */

/** Flat launch fee: 0.001 BSV. Owner decision pending on the exact figure. */
export const LAUNCH_FEE_SATS = 100_000;
/** Launchpad default: 1 billion whole tokens (house convention, CLAUDE.md). */
export const LAUNCH_DEFAULT_SUPPLY = '1000000000';

export const emptyLaunchForm = (): TokenForm => ({
  name: '',
  ticker: '',
  supply: LAUNCH_DEFAULT_SUPPLY,
  decimals: '0',
  description: '',
});

/** The flat fee, or 0 when the build carries no fee address. */
export const launchFeeFor = (feeAddress?: string): number => (mintFeeAddress(feeAddress) ? LAUNCH_FEE_SATS : 0);

export interface LaunchCost {
  networkSats: number;
  launchFeeSats: number;
  totalSats: number;
  txCount: number;
}

/** Network fee for the optional icon inscription plus the deploy, and the flat launch fee. */
export function launchCost(iconBytes: number, satsPerKb: number, feeAddress?: string): LaunchCost {
  const icon = iconBytes > 0 ? txFeeSats(iconBytes, satsPerKb) : 0;
  const networkSats = icon + txFeeSats(TOKEN_DEPLOY_BYTES, satsPerKb);
  const launchFeeSats = launchFeeFor(feeAddress);
  return { networkSats, launchFeeSats, totalSats: networkSats + launchFeeSats, txCount: iconBytes > 0 ? 2 : 1 };
}

/** Form check before the approval sheet: token rules plus the returns-wording block. */
export function validateLaunch(f: TokenForm, s: SafetyFilter = safety()): string | null {
  return validateToken(f, s) ?? (hasReturnsWording(`${f.name} ${f.description}`) ? RETURNS_BLOCK : null);
}

/** The one approval sheet's lines: everything the launch does, all in one Allow. */
export function approvalLines(
  f: TokenForm,
  cost: LaunchCost,
  fmt: (sats: number) => string,
  hasIcon: boolean,
): { label: string; value: string }[] {
  const ticker = f.ticker.trim().replace(/^\$/, '');
  const supply = BigInt((f.supply || '0').replace(/[,_\s]/g, '') || '0').toLocaleString('en-US');
  return [
    { label: 'Create token', value: `$${ticker}` },
    { label: 'Supply to your wallet', value: supply },
    ...(hasIcon ? [{ label: 'Inscribe icon', value: 'On-chain image' }] : []),
    { label: 'Network fee', value: fmt(cost.networkSats) },
    { label: 'Launch fee (flat)', value: cost.launchFeeSats > 0 ? fmt(cost.launchFeeSats) : 'None' },
  ];
}
