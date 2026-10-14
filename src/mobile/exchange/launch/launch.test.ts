import { describe, expect, it } from 'bun:test';
import {
  LAUNCH_DEFAULT_SUPPLY,
  LAUNCH_FEE_SATS,
  approvalLines,
  emptyLaunchForm,
  launchCost,
  launchFeeFor,
  validateLaunch,
} from './launch';
import { exchangeView, LAUNCH_ROUTE } from '../exchangeData';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ok = { check: () => ({ blocked: false }) } as never;

describe('launch', () => {
  it('defaults to a 1B supply, whole tokens', () => {
    expect(emptyLaunchForm().supply).toBe(LAUNCH_DEFAULT_SUPPLY);
    expect(LAUNCH_DEFAULT_SUPPLY).toBe('1000000000');
    expect(emptyLaunchForm().decimals).toBe('0');
  });

  it('charges the flat fee only when a fee address is built in', () => {
    expect(launchFeeFor(ADDR)).toBe(LAUNCH_FEE_SATS);
    expect(launchFeeFor('')).toBe(0);
    expect(launchFeeFor('not-an-address')).toBe(0);
  });

  it('flat fee does not scale with icon size', () => {
    const a = launchCost(0, 100, ADDR);
    const b = launchCost(400_000, 100, ADDR);
    expect(a.launchFeeSats).toBe(b.launchFeeSats);
    expect(b.networkSats).toBeGreaterThan(a.networkSats);
    expect(a.txCount).toBe(1);
    expect(b.txCount).toBe(2);
    expect(b.totalSats).toBe(b.networkSats + b.launchFeeSats);
  });

  it('validates the form', () => {
    expect(validateLaunch(emptyLaunchForm(), ok)).toBe('Name the token.');
    expect(validateLaunch({ ...emptyLaunchForm(), name: 'Frog', ticker: 'FROG' }, ok)).toBeNull();
    expect(validateLaunch({ ...emptyLaunchForm(), name: 'Frog', ticker: 'frog!' }, ok)).toMatch(/Ticker/);
  });

  it('lists every step on one sheet', () => {
    const f = { ...emptyLaunchForm(), name: 'Frog', ticker: '$FROG' };
    const lines = approvalLines(f, launchCost(10, 100, ADDR), (n) => `${n} sats`, true);
    expect(lines.map((l) => l.label)).toEqual([
      'Create token',
      'Supply to your wallet',
      'Inscribe icon',
      'Network fee',
      'Launch fee (flat)',
    ]);
    expect(lines[0].value).toBe('$FROG');
    expect(lines[1].value).toBe('1,000,000,000');
    expect(approvalLines(f, launchCost(0, 100, ''), String, false).at(-1)?.value).toBe('None');
  });

  it('routes /launchpad/new to the launch screen', () => {
    expect(LAUNCH_ROUTE).toBe('/m/exchange/launchpad/new');
    expect(exchangeView('/launchpad/new')).toEqual({ tab: 'launch' });
    expect(exchangeView('/launchpad')).toEqual({ tab: 'launchpad' });
  });
});
