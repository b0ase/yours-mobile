import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  addSignatures,
  feeFor,
  finalize,
  keysetFor,
  parsePartnerLock,
  partnerLockScript,
  propose,
  proposalTx,
  sighash,
  toChecksig,
  type Keyset,
} from './partnerLock';
import {
  admitPartner,
  agreementProblem,
  agreementText,
  apportion,
  bpsToPct,
  holdingsFor,
  pctToBps,
  sha256Hex,
  signMessage,
  splitCharges,
  splitPayment,
  splitProblem,
  type Partner,
} from './partnership';

const ICE: Partner[] = [
  { handle: 'fred', name: 'Fred Smith', shareBps: 3000 },
  { handle: 'joe', name: 'Joe Bloggs', shareBps: 3000 },
  { handle: 'you', name: 'You Person', shareBps: 4000 },
];

describe('split maths', () => {
  test('percent → basis points', () => {
    expect(pctToBps('30')).toBe(3000);
    expect(pctToBps('27.5%')).toBe(2750);
    expect(pctToBps('0.01')).toBe(1);
    expect(pctToBps('0')).toBeNull();
    expect(pctToBps('101')).toBeNull();
    expect(pctToBps('1.234')).toBeNull();
    expect(bpsToPct(2750)).toBe('27.5%');
  });
  test('apportion is exact and deterministic', () => {
    expect(apportion(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(apportion(7n, [3000n, 3000n, 4000n]).reduce((a, b) => a + b, 0n)).toBe(7n);
    expect(apportion(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(() => apportion(5n, [0n, 0n])).toThrow();
  });
  test('the split must be valid before it is proposed', () => {
    expect(splitProblem(ICE, { kind: 'majority', m: 2 })).toBeNull();
    expect(splitProblem(ICE.slice(0, 2), { kind: 'unanimous' })).toContain('100%');
    expect(splitProblem([ICE[0], ICE[0], ICE[2]], { kind: 'unanimous' })).toContain('twice');
    expect(splitProblem(ICE, { kind: 'majority', m: 1 })).toContain('at least 2 of 3');
    expect(splitProblem([ICE[0]], { kind: 'unanimous' })).toContain('two partners');
  });
});

describe('admit a partner (rebalance pro rata)', () => {
  test('30/30/40 + Max for 10% → 27/27/36/10', () => {
    const next = admitPartner(ICE, { handle: '$Max', name: 'Max Power' }, 1000);
    expect(next.map((p) => [p.handle, p.shareBps])).toEqual([
      ['fred', 2700],
      ['joe', 2700],
      ['you', 3600],
      ['max', 1000],
    ]);
    expect(splitProblem(next, { kind: 'majority', m: 3 })).toBeNull();
  });
  test('awkward shares still sum to exactly 100%', () => {
    const odd = [
      { handle: 'a', name: 'A', shareBps: 3333 },
      { handle: 'b', name: 'B', shareBps: 3333 },
      { handle: 'c', name: 'C', shareBps: 3334 },
    ];
    const next = admitPartner(odd, { handle: 'd', name: 'D' }, 777);
    expect(next.reduce((t, p) => t + p.shareBps, 0)).toBe(10_000);
  });
  test('refuses an existing partner or a silly share', () => {
    expect(() => admitPartner(ICE, { handle: 'fred', name: 'F' }, 1000)).toThrow('already');
    expect(() => admitPartner(ICE, { handle: 'max', name: 'M' }, 10_000)).toThrow();
    expect(() => admitPartner(ICE, { handle: 'max', name: 'M' }, 0)).toThrow();
  });
  test('locked holdings follow the new split', () => {
    const next = admitPartner(ICE, { handle: 'max', name: 'Max' }, 1000);
    expect(holdingsFor(1_000_000_000n, next).map((h) => h.amt)).toEqual([
      270_000_000n,
      270_000_000n,
      360_000_000n,
      100_000_000n,
    ]);
  });
});

describe('every sale splits itself', () => {
  test('one payment, one output per partner, by share, exact', () => {
    expect(splitPayment(10_000, ICE)).toEqual([
      { handle: 'fred', sats: 3000 },
      { handle: 'joe', sats: 3000 },
      { handle: 'you', sats: 4000 },
    ]);
    const odd = splitPayment(1001, ICE);
    expect(odd.reduce((t, p) => t + p.sats, 0)).toBe(1001);
    expect(splitPayment(1, ICE)).toEqual([{ handle: 'you', sats: 1 }]); // zero-sat slices get no output
    expect(() => splitPayment(0, ICE)).toThrow();
  });
  test('as Paid Spaces-style charges to each partner address', () => {
    const addr = { fred: '1Fred', joe: '1Joe', you: '1You' };
    expect(splitCharges(500, ICE, addr)).toEqual([
      { unit: 'sats', amount: '150', to: '1Fred' },
      { unit: 'sats', amount: '150', to: '1Joe' },
      { unit: 'sats', amount: '200', to: '1You' },
    ]);
    expect(() => splitCharges(500, ICE, { fred: '1Fred' })).toThrow('$joe');
  });
});

describe('agreement', () => {
  const input = {
    roomName: 'Ice Cream Van',
    ticker: 'ICE',
    version: 1,
    date: '2026-10-18',
    partners: ICE,
    rule: { kind: 'majority', m: 2 } as const,
  };
  const text = agreementText(input);
  const draft = { version: 1, partners: ICE, rule: input.rule, agreementText: text, agreementSha256: sha256Hex(text) };

  test('plain English, every point the owner asked for', () => {
    expect(text).toContain('PARTNERSHIP AGREEMENT — Ice Cream Van ($ICE)');
    expect(text).toContain('Fred Smith ($fred) — 30% of the partnership shares');
    expect(text).toContain('You Person ($you) — 40% of the partnership shares');
    expect(text).toContain('at least 2 of the 3 partners must agree');
    expect(text).toContain('personally liable');
    expect(text).toContain('taxed on our own share');
    expect(text).toContain('Admitting or removing a partner');
    expect(text).toContain('in proportion to our partnership shares');
    expect(text).toContain('not offered to the public');
    expect(text).toContain('Drafted by b');
    expect(text).toContain('one-for-one');
  });
  test('an admission names the version it replaces', () => {
    const v2 = agreementText({
      ...input,
      version: 2,
      supersedes: 1,
      partners: admitPartner(ICE, { handle: 'max', name: 'Max' }, 1000),
    });
    expect(v2).toContain('Version 2, replacing version 1 · 2026-10-18');
    expect(v2).toContain('Max ($max) — 10%');
    expect(v2).toContain('Fred Smith ($fred) — 27%');
  });
  test('the wallet signs only the exact standard text', () => {
    expect(agreementProblem(draft)).toBeNull();
    expect(agreementProblem(draft, input.ticker)).toBeNull();
    expect(agreementProblem(draft, 'OTHER')).toContain('different token');
    expect(agreementProblem({ ...draft, agreementText: text.replace('40%', '45%') })).toContain('differs');
    expect(agreementProblem({ ...draft, partners: admitPartner(ICE, { handle: 'max', name: 'M' }, 1000) })).toContain(
      'differs',
    );
    expect(agreementProblem({ ...draft, agreementSha256: '0'.repeat(64) })).toContain('fingerprint');
    expect(agreementProblem({ ...draft, version: 2 })).toContain('version');
    expect(agreementProblem({ ...draft, agreementText: 'Sign here' })).toContain('standard form');
  });
  test('sign message binds room, version, hash, signer and time (bit-sign format)', () => {
    expect(signMessage({ roomId: 'r1', version: 2, sha256: 'ab', handle: 'fred', at: 'T' })).toBe(
      'Partnership shares · room r1 · version 2\nI, $fred, sign the partnership agreement sha256 ab.\nT',
    );
  });
});

describe('admission lock move (script interpreter)', () => {
  const TOKEN = 'b'.repeat(64) + '_0';
  const [fred, joe, you, max, feeKey] = [0, 1, 2, 3, 4].map(() => PrivateKey.fromRandom());
  const pub = (k: PrivateKey) => k.toPublicKey().toString();
  const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
  const sign = (k: PrivateKey, tx: Transaction, i: number) =>
    hex(toChecksig(ECDSA.sign(new BigNumber(sighash(tx, i)), k, true).toDER() as number[]));
  let n = 0;
  const utxo = (lockingScript: ReturnType<typeof partnerLockScript> | ReturnType<P2PKH['lock']>, satoshis: number) => {
    const src = new Transaction();
    src.addInput({
      sourceTXID: (n++).toString(16).padStart(64, '0'),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(fred.toAddress()),
      sequence: 0xffffffff,
    });
    src.addOutput({ lockingScript, satoshis });
    return { sourceTx: src, vout: 0 };
  };

  test('30/30/40 holdings → 27/27/36/10 under the new 3-of-4 lock, signed by 2 of the old 3', async () => {
    const old: Keyset = keysetFor({ kind: 'majority', m: 2 }, [pub(fred), pub(joe), pub(you)]);
    const next: Keyset = keysetFor({ kind: 'majority', m: 3 }, [pub(fred), pub(joe), pub(you), pub(max)]);
    const keyOf: Record<string, PrivateKey> = { fred, joe, you, max };
    const inputs = holdingsFor(10_000n, ICE).map((h) =>
      utxo(partnerLockScript({ tokenId: TOKEN, amt: h.amt, holder: pub(keyOf[h.handle]) }, old), 1),
    );
    const outputs = holdingsFor(10_000n, admitPartner(ICE, { handle: 'max', name: 'Max' }, 1000)).map((h) => ({
      tokenId: TOKEN,
      amt: h.amt,
      holder: pub(keyOf[h.handle]),
    }));
    const plan = {
      partnershipId: 'room-ice',
      agreementVersion: 1,
      proposalId: 'admit-max',
      kind: 'admit' as const,
      summary: 'Admit $max for 10%',
      inputs,
      outputs,
      keyset: next,
    };
    const fee = { ...utxo(new P2PKH().lock(feeKey.toAddress()), feeFor(plan)), pubKey: pub(feeKey) };
    let p = await propose(plan, fee, async (d) =>
      toChecksig(ECDSA.sign(new BigNumber(d), feeKey, true).toDER() as number[]),
    );
    const tx = proposalTx(p);
    expect(() => finalize(p)).toThrow('Not enough partner signatures');
    for (const k of [fred, you])
      p = addSignatures(p, pub(k), { 0: sign(k, tx, 0), 1: sign(k, tx, 1), 2: sign(k, tx, 2) });
    const out = Transaction.fromHex(finalize(p).rawTx).outputs.map((o) => parsePartnerLock(o.lockingScript));
    expect(out.map((o) => o?.amt)).toEqual([2700n, 2700n, 3600n, 1000n]);
    expect(out.every((o) => o?.m === 3 && o.pubKeys.length === 4)).toBe(true);
  });
});
