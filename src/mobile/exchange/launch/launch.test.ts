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
import { defaultVestPlan } from './vesting';

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
    expect(a.txCount).toBe(2);
    expect(b.txCount).toBe(3);
    expect(b.totalSats).toBe(b.networkSats + b.launchFeeSats + b.depositSats);
  });

  it('counts vesting and the deposit together: one sheet, a true total', () => {
    const vest = { ...defaultVestPlan(), keepBps: 1_000 };
    const plain = launchCost(0, 100, ADDR);
    const both = launchCost(0, 100, ADDR, { vest });
    expect(both.txCount).toBe(plain.txCount + 1);
    expect(both.depositSats).toBe(plain.depositSats);
    expect(both.networkSats).toBeGreaterThan(plain.networkSats);
    expect(both.totalSats).toBe(both.networkSats + both.launchFeeSats + both.depositSats);
    const f = { ...emptyLaunchForm(), name: 'Frog', ticker: 'FROG' };
    const labels = approvalLines(f, both, (n) => `${n}`, false, undefined, vest).map((l) => l.label);
    expect(labels).toContain('Keep for yourself, locked');
    expect(labels).toContain('Indexing deposit (paid to the token indexer, GorillaPool)');
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
      'Coin card on-chain',
      "Open holders' room",
      'List on the Launchpad',
      'Indexing deposit (paid to the token indexer, GorillaPool)',
      'Network fee',
      'Our launch fee',
    ]);
    expect(lines[6].value).toBe('10010000 sats');
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
  DEPOSIT_NOTE,
  costSummary,
  depositValue,
  cleanOptions,
  defaultLaunchOptions,
  hasMapExtras,
  LAUNCH_DISCLAIMER,
  launchPrefill,
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
  it('defaults are valid; the coin card (with the disclaimer) is always written', () => {
    expect(validateOptions(defaultLaunchOptions(), CATS)).toBeNull();
    expect(hasMapExtras(defaultLaunchOptions())).toBe(true);
    const f = { ...emptyLaunchForm(), name: 'Frog', ticker: 'FROG' };
    expect(launchMapFields(f, defaultLaunchOptions()).slice(-2)).toEqual(['disclaimer', LAUNCH_DISCLAIMER]);
  });

  it('carries the owner-approved no-promises disclaimer', () => {
    expect(LAUNCH_DISCLAIMER).toBe(
      'No returns, dividends or price rises are promised. There is no promise the money will be spent on the project, that it will succeed, or that it will become a company.',
    );
  });

  it('prefills from a query string (a bApp Tokenise), dropping bad values', () => {
    const p = launchPrefill('?name=bWriter&description=Write%20and%20sell&website=https%3A%2F%2Fx.app&category=apps');
    expect(p.form).toEqual({ name: 'bWriter', description: 'Write and sell' });
    expect(p.options).toEqual({ website: 'https://x.app', category: 'apps' });
    expect(launchPrefill('?website=http%3A%2F%2Fx.app&category=Bad%20Cat').options).toEqual({});
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
      'disclaimer',
      LAUNCH_DISCLAIMER,
    ]);
  });

  it('every launch pays the indexing deposit (never "free")', () => {
    const c = launchCost(0, 100, '');
    expect(c.launchFeeSats).toBe(0);
    expect(c.depositSats).toBe(10_010_000);
    expect(c.totalSats).toBe(c.networkSats + c.depositSats);
    expect(c.totalSats).toBeGreaterThan(10_000_000);
    expect(launchCost(0, 100, '', { depositSats: 250_000 }).depositSats).toBe(250_000);
  });

  it('cost copy names the deposit and the total, no "free" / "Launch fee: none"', () => {
    const fmt = (n: number) => `$${((n / 1e8) * 18).toFixed(2)}`;
    const c = launchCost(0, 100, '');
    const s = costSummary(c, fmt);
    expect(s).toContain('Indexing deposit $1.80 (to GorillaPool)');
    expect(s).toContain('our launch fee: none');
    expect(`${s} ${DEPOSIT_NOTE}`).not.toMatch(/\bfree\b|no fee/i);
    expect(s).not.toContain('Launch fee: none');
    expect(depositValue(10_010_000, fmt)).toBe('$1.80 · 10,010,000 sats');
    expect(depositValue(10_010_000, (n) => `${n.toLocaleString('en-US')} sats`)).toBe('10,010,000 sats');
    expect(costSummary(launchCost(0, 100, ADDR), fmt)).toContain('our launch fee $0.02');
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
  it('keeps an https advert video only', () => {
    const [a, b] = parseLaunchList([
      { token_id: id('a'), ticker: 'A', video: 'https://v.example/ad.mp4' },
      { token_id: id('b'), ticker: 'B', video: 'javascript:alert(1)' },
    ]);
    expect(a.video).toBe('https://v.example/ad.mp4');
    expect(b.video).toBeNull();
  });
});
