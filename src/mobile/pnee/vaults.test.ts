import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Beef, type WalletInterface } from '@bsv/sdk';
import { RepeatGuard } from '../../services/repeatGuard';
import {
  backsUpToLine,
  belowFloor,
  closerSats,
  floorPriceCents,
  fmtCents,
  health,
  maxPnee,
  mintOk,
  mintable,
  ratioPct,
} from './math';
import { closeConfirm, lockConfirm, mintConfirm, sendConfirm, topUpConfirm } from './confirm';
import { closePlan, closeVault, exactCoins, lockVault, mintPnee, type PneeCoin, type Vault } from './vaults';
import { verifyRound, type PriceRound } from './oracle';
import { PNEE, vaultScript, type VaultConfig } from './script';

const V = JSON.parse(readFileSync(join(import.meta.dir, 'kit', 'pnee-vectors.json'), 'utf8'));
const $50 = 5000n; // BSV at $50.00, in cents

describe('10x mint limits', () => {
  test('1 BSV at $50 backs up to $5.00 of PNEEs (500 PNEEs)', () => {
    expect(maxPnee(100_000_000n, $50)).toBe(500n);
    expect(mintable(100_000_000n, $50, 0n)).toBe(500n);
    expect(mintOk(100_000_000n, $50, 0n, 500n)).toBe(true);
    expect(mintOk(100_000_000n, $50, 0n, 501n)).toBe(false);
  });

  test('what is already minted counts: 300 minted leaves 200', () => {
    expect(mintable(100_000_000n, $50, 300n)).toBe(200n);
    expect(mintOk(100_000_000n, $50, 300n, 201n)).toBe(false);
  });

  test('the same as the contract’s on-chain check for the vector vault (11,000,000 sats at $50 → 55)', () => {
    expect(maxPnee(11_000_000n, $50)).toBe(55n);
  });

  test('below the minimum vault size nothing is mintable', () => {
    expect(mintable(900_000n, $50, 0n)).toBe(0n); // $0.45 < $0.50
  });

  test('the live line on the lock sheet', () => {
    expect(backsUpToLine(100_000_000n, $50)).toBe('Your $50.00 of BSV can back up to $5.00 of PNEEs');
  });

  test('ratio, floor and the 10% discount', () => {
    expect(ratioPct(100_000_000n, $50, 500n)).toBe(1000);
    expect(belowFloor(100_000_000n, 749n, 500n)).toBe(true); // $7.49 → 149%
    expect(belowFloor(100_000_000n, 750n, 500n)).toBe(false); // exactly 150%
    expect(floorPriceCents(100_000_000n, 500n)).toBe(750n);
    expect(closerSats(500n, 700n)).toBe(78_571_428n); // $5.50 of BSV at $7.00
    expect(health(100_000_000n, $50, 0n)).toBe('empty');
    expect(health(100_000_000n, 900n, 500n)).toBe('near');
    expect(health(100_000_000n, 700n, 500n)).toBe('below');
    expect(fmtCents(123456n)).toBe('$1,234.56');
  });
});

describe('confirm sheets show exact amounts', () => {
  test('lock', () => {
    const c = lockConfirm(100_000_000n, $50);
    expect(c.lines).toEqual([
      { label: 'You lock', value: '100,000,000 sats (1.00000000 BSV)' },
      { label: 'Worth now', value: '$50.00' },
      { label: 'Can back up to', value: '500 PNEEs ($5.00)' },
      { label: 'Owner', value: 'a key of this wallet' },
    ]);
  });

  test('mint', () => {
    const c = mintConfirm(100_000_000n, 100n, 250n, $50);
    expect(c.lines.map((l) => l.value)).toEqual([
      '250 PNEEs ($2.50)',
      '100,000,000 sats ($50.00)',
      '350 PNEEs ($3.50)',
      '1,428%',
      '150 PNEEs ($1.50)',
      '$50.00 per BSV (3 of 5 signers)',
    ]);
  });

  test('top up, close, send', () => {
    expect(topUpConfirm(100_000_000n, 500n, 50_000_000n, $50).lines[2].value).toBe('1,500%');
    expect(closeConfirm(100_000_000n, 500n).lines).toEqual([
      { label: 'You burn', value: '500 PNEEs ($5.00)' },
      { label: 'You unlock', value: '100,000,000 sats (1.00000000 BSV), less the network fee' },
    ]);
    expect(sendConfirm(1n, '02' + 'ab'.repeat(32)).lines[0].value).toBe('1 PNEE ($0.01)');
  });

  test('no offer or promise words in any confirm', () => {
    const all = JSON.stringify([
      lockConfirm(1n, 1n),
      mintConfirm(1n, 0n, 1n, 1n),
      topUpConfirm(1n, 1n, 1n, 1n),
      closeConfirm(1n, 1n),
      sendConfirm(1n, '02' + '00'.repeat(32)),
    ]);
    expect(all).not.toMatch(/invest|yield|return|interest|profit|apy|coupon|bank|earn|gain/i);
  });
});

const coin = (amount: bigint, n = 0): PneeCoin => ({
  outpoint: `${'c'.repeat(63)}${n}.0`,
  amount,
  holder: V.ownerPub,
  script: '',
  note: { kind: 'pnee', protocolID: [2, 'pnee vault'], keyID: 'k', counterparty: 'self' },
});
const cfg: VaultConfig = {
  owner: V.ownerPub,
  issuer: V.issuerPub,
  oracles: V.oracles.map(BigInt),
  openTs: BigInt(V.openTs),
};
const vault = (debt: bigint): Vault => ({
  outpoint: `${'a'.repeat(64)}.0`,
  sats: 100_000_000n,
  script: vaultScript(cfg, { debt, lastTs: cfg.openTs, feeCents: 0n, feeTs: cfg.openTs }),
  config: cfg,
  state: { debt, lastTs: cfg.openTs, feeCents: 0n, feeTs: cfg.openTs },
  note: {
    kind: 'pnee-vault',
    protocolID: [2, 'pnee vault'],
    keyID: 'k',
    openTs: String(V.openTs),
    issuer: V.issuerPub,
    oracles: V.oracles,
  },
});

describe('close burns exactly the minted amount', () => {
  test('exact coins are found; otherwise a split first, or the shortfall', () => {
    expect(exactCoins([coin(30n, 1), coin(20n, 2), coin(5n, 3)], 50n)!.map((c) => c.amount)).toEqual([30n, 20n]);
    expect(closePlan(vault(50n), [coin(30n, 1), coin(20n, 2)])).toEqual({ burn: [coin(30n, 1), coin(20n, 2)] });
    expect(closePlan(vault(50n), [coin(70n, 1)])).toEqual({ split: coin(70n, 1) });
    expect(closePlan(vault(50n), [coin(10n, 1)])).toEqual({ short: 40n });
  });

  test('closeVault refuses coins that do not add up to the vault’s PNEEs', async () => {
    const w = {} as WalletInterface;
    await expect(closeVault(w, vault(50n), [coin(49n)], new Beef())).rejects.toThrow(/exactly the 50 PNEEs/);
    await expect(closeVault(w, vault(50n), [coin(51n)], new Beef())).rejects.toThrow(/exactly the 50 PNEEs/);
  });
});

/** A wallet whose createAction never finishes: the first action is "still going out". */
function slowWallet() {
  const calls: string[] = [];
  const w = {
    getPublicKey: async () => ({ publicKey: V.ownerPub }),
    createAction: (a: { description: string }) => {
      calls.push(a.description);
      return new Promise(() => undefined);
    },
  } as unknown as WalletInterface;
  return { w, calls };
}
const round: PriceRound = { ts: V.openTs + 1000, priceCents: 5000, signed: [], quorum: [], median: 5000 };
const pcfg = { issuer: V.issuerPub, oracles: V.oracles, signers: '', kit: { vault: '', token: '' } };

describe('RepeatGuard on every PNEE chain action', () => {
  test('lock: an identical second lock is refused while the first is going out', async () => {
    const g = new RepeatGuard();
    const { w, calls } = slowWallet();
    void lockVault(w, pcfg, round, 1_000_000n, V.ownerPub, g);
    await new Promise((r) => setTimeout(r, 10));
    await expect(lockVault(w, pcfg, round, 1_000_000n, V.ownerPub, g)).rejects.toThrow(/already on its way/);
    expect(calls.length).toBe(1);
  });

  test('mint: refused the second time', async () => {
    const g = new RepeatGuard();
    const { w, calls } = slowWallet();
    void mintPnee(w, vault(0n), new Beef(), round, 100n, g);
    await new Promise((r) => setTimeout(r, 10));
    await expect(mintPnee(w, vault(0n), new Beef(), round, 100n, g)).rejects.toThrow(/already on its way/);
    expect(calls.length).toBe(1);
  });

  test('close: refused the second time', async () => {
    const g = new RepeatGuard();
    const { w, calls } = slowWallet();
    void closeVault(w, vault(50n), [coin(50n)], new Beef(), g);
    await new Promise((r) => setTimeout(r, 10));
    await expect(closeVault(w, vault(50n), [coin(50n)], new Beef(), g)).rejects.toThrow(/already on its way/);
    expect(calls.length).toBe(1);
  });

  test('a failed attempt may be tried again', async () => {
    const g = new RepeatGuard();
    let n = 0;
    const w = {
      getPublicKey: async () => ({ publicKey: V.ownerPub }),
      createAction: async () => {
        n++;
        throw new Error('user said no');
      },
    } as unknown as WalletInterface;
    await expect(lockVault(w, pcfg, round, 1_000_000n, V.ownerPub, g)).rejects.toThrow(/user said no/);
    await expect(lockVault(w, pcfg, round, 1_000_000n, V.ownerPub, g)).rejects.toThrow(/user said no/);
    expect(n).toBe(2);
  });

  test('mint refuses more than 10x before asking the wallet', async () => {
    const { w, calls } = slowWallet();
    await expect(mintPnee(w, vault(0n), new Beef(), round, 501n, new RepeatGuard())).rejects.toThrow(
      /more than this vault can back/,
    );
    expect(calls.length).toBe(0);
  });
});

describe('price rounds', () => {
  test('the vector round verifies and its median is $50.00', () => {
    const r = verifyRound(
      { ts: V.mint.price.ts, priceCents: 5000, signed: V.mint.price.signed },
      V.oracles.map(BigInt),
    );
    expect(r.quorum.map((s) => s.signer)).toEqual([0, 2, 4]);
    expect(r.median).toBe(5000);
  });

  test('a forged signature drops the round below three', () => {
    const signed = V.mint.price.signed.map((s: { s: string }, i: number) => (i === 1 ? { ...s, s: '12345' } : s));
    expect(() => verifyRound({ ts: V.mint.price.ts, priceCents: 5000, signed }, V.oracles.map(BigInt))).toThrow(
      /Fewer than three/,
    );
  });

  test('the deployment is 10x / 150% / 10% / no fee', () => {
    expect([PNEE.minRatioPct, PNEE.liqRatioPct, PNEE.liqDiscountPct, PNEE.feeBps]).toEqual([1000n, 150n, 10n, 0n]);
  });
});
