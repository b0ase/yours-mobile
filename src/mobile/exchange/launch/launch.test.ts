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
      "Open holders' room",
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

import {
  cleanOptions,
  defaultLaunchOptions,
  hasMapExtras,
  launchMapFields,
  mergeLaunches,
  parseLaunchList,
  roomMinRaw,
  validateOptions,
  withOptions,
} from './launch';

const CATS = ['games', 'memes'];
const opts = (o: Partial<ReturnType<typeof defaultLaunchOptions>>) => ({ ...defaultLaunchOptions(), ...o });

describe('advanced options', () => {
  it('defaults are valid and add nothing on-chain', () => {
    expect(validateOptions(defaultLaunchOptions(), CATS)).toBeNull();
    expect(hasMapExtras(defaultLaunchOptions())).toBe(false);
  });

  it('validates links, handles, category and room entry', () => {
    expect(validateOptions(opts({ website: 'http://x.com' }), CATS)).toMatch(/https/);
    expect(validateOptions(opts({ website: 'https://frog.coin' }), CATS)).toBeNull();
    expect(validateOptions(opts({ x: 'bad handle!' }), CATS)).toMatch(/X/);
    expect(validateOptions(opts({ x: '@frog', telegram: 'https://t.me/frogs' }), CATS)).toBeNull();
    expect(validateOptions(opts({ category: 'nope' }), CATS)).toMatch(/category/);
    expect(validateOptions(opts({ roomMin: '0' }), CATS)).toMatch(/Room/);
  });

  it('cleans handles and folds decimals into the room minimum', () => {
    expect(cleanOptions(opts({ x: 'https://x.com/frog' })).x).toBe('frog');
    expect(roomMinRaw(opts({ roomMin: '5', decimals: '2' }))).toBe('500');
    expect(withOptions(emptyLaunchForm(), opts({ decimals: '8' })).decimals).toBe('8');
  });

  it('writes the coin card MAP fields', () => {
    const f = { ...emptyLaunchForm(), name: 'Frog', ticker: 'FROG', description: 'ribbit' };
    expect(launchMapFields(f, opts({ website: 'https://frog.coin', x: '@frog', category: 'memes' }))).toEqual([
      'app',
      'bWallet',
      'type',
      'coin',
      'name',
      'Frog',
      'description',
      'ribbit',
      'website',
      'https://frog.coin',
      'x',
      'frog',
      'category',
      'memes',
    ]);
  });

  it('adds the indexing fund to the cost when asked', () => {
    const c = launchCost(0, 100, '', { indexNow: true });
    expect(c.indexSats).toBeGreaterThan(10_000_000 - 1);
    expect(c.totalSats).toBe(c.networkSats + c.indexSats);
    expect(c.txCount).toBe(2);
  });
});

describe('launch list', () => {
  const id = (n: string) => `${n.repeat(64)}_1`;
  it('parses registry rows and skips bad ones', () => {
    const rows = parseLaunchList({
      launches: [
        { token_id: id('a'), ticker: 'A', created_at: '2026-10-14T00:00:00Z' },
        { token_id: 'x', ticker: 'B' },
      ],
    });
    expect(rows.map((r) => r.ticker)).toEqual(['A']);
    expect(rows[0].name).toBe('A');
  });
  it('merges local and registry, registry wins, newest first', () => {
    const local = parseLaunchList([
      { tokenId: id('a'), ticker: 'A', name: 'local', createdAt: 1 },
      { tokenId: id('b'), ticker: 'B', createdAt: 5 },
    ]);
    const reg = parseLaunchList([{ token_id: id('a'), ticker: 'A', name: 'reg', created_at: 2 }]);
    const m = mergeLaunches(reg, local);
    expect(m.map((l) => l.ticker)).toEqual(['B', 'A']);
    expect(m[1].name).toBe('reg');
  });
});
