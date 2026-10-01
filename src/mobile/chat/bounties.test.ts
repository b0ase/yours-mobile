import { describe, expect, test } from 'bun:test';
import {
  claimCheck,
  formatRaw,
  markSeen,
  parseBounties,
  parseSpec,
  rewardLabel,
  showPay,
  sortBounties,
  transferLabel,
  unseenForMe,
} from './bounties';

const row = (o: Record<string, unknown> = {}) => ({
  bounty_no: 1,
  title: 'Fix export',
  status: 'open',
  created_by: 'admin',
  claimed_by: null,
  payout_kind: 'room_token',
  reward_token_raw: '1500',
  reward_sats: null,
  ...o,
});

describe('bounty list', () => {
  test('parses payout bounties, skips legacy and cancelled', () => {
    const bs = parseBounties({
      bounties: [
        row(),
        row({ bounty_no: 2, payout_kind: null }),
        row({ bounty_no: 3, status: 'cancelled' }),
        row({ bounty_no: 4, payout_kind: 'bsv', reward_sats: '5000' }),
      ],
    });
    expect(bs.map((b) => b.bounty_no)).toEqual([1, 4]);
    expect(bs[1].reward_sats).toBe(5000);
  });
  test('prefers claimed_by_handle', () => {
    expect(parseBounties({ bounties: [row({ claimed_by: 'x', claimed_by_handle: 'human' })] })[0].claimed_by).toBe(
      'human',
    );
  });
  test('garbage is empty', () => {
    expect(parseBounties(null)).toEqual([]);
    expect(parseBounties({ bounties: 'no' })).toEqual([]);
  });
  test('sorts open → claimed → merged → paid', () => {
    const bs = parseBounties({
      bounties: [
        row({ bounty_no: 1, status: 'paid' }),
        row({ bounty_no: 2, status: 'merged' }),
        row({ bounty_no: 3 }),
        row({ bounty_no: 4, status: 'claimed' }),
      ],
    });
    expect(sortBounties(bs).map((b) => b.status)).toEqual(['open', 'claimed', 'merged', 'paid']);
  });
  test('reward label scales by token decimals', () => {
    const [b] = parseBounties({ bounties: [row({ reward_sats: 2000 })] });
    expect(rewardLabel(b, { symbol: 'BWRITER', dec: 2 })).toBe('15 $BWRITER + 2,000 sats');
    expect(formatRaw('150', 2)).toBe('1.5');
  });
});

describe('claim', () => {
  const [b] = parseBounties({ bounties: [row()] });
  test('needs a GitHub PR URL', () => {
    expect(claimCheck(b, 'dev', 'https://github.com/a/b/issues/1')).not.toBeNull();
    expect(claimCheck(b, 'dev', 'https://github.com/bitcoin-apps-suite/bitcoin-writer/pull/48')).toBeNull();
  });
  test('creator cannot claim; claimed cannot be claimed', () => {
    expect(claimCheck(b, 'admin', 'https://github.com/a/b/pull/1')).toBe('You created this bounty');
    expect(claimCheck({ ...b, status: 'claimed' }, 'dev', 'https://github.com/a/b/pull/1')).toBe('Already claimed');
  });
});

describe('pay', () => {
  const [m] = parseBounties({ bounties: [row({ status: 'merged', claimed_by: 'dev' })] });
  test('only merged, unpaid, for admin or creator, never to self', () => {
    expect(showPay(m, 'admin', false)).toBe(true);
    expect(showPay(m, 'owner', true)).toBe(true);
    expect(showPay(m, 'rando', false)).toBe(false);
    expect(showPay(m, 'dev', true)).toBe(false);
    expect(showPay({ ...m, status: 'paid' }, 'admin', true)).toBe(false);
    expect(showPay({ ...m, status: 'claimed' }, 'admin', true)).toBe(false);
  });
  test('spec parses token + BSV transfers', () => {
    const spec = parseSpec({
      spec: {
        ticker: 'BWRITER',
        bountyNo: 3,
        claimant: 'dev',
        transfers: [
          {
            type: 'bsv21',
            tokenId: `${'a'.repeat(64)}_0`,
            symbol: 'BWRITER',
            dec: 0,
            amountRaw: '10000',
            address: '1Addr',
          },
          { type: 'bsv', sats: 500, address: '1Addr' },
        ],
      },
    });
    expect(spec?.transfers.map(transferLabel)).toEqual(['10000 $BWRITER', '500 sats']);
  });
  test('malformed spec refused', () => {
    expect(
      parseSpec({
        spec: {
          bountyNo: 1,
          claimant: 'd',
          transfers: [{ type: 'bsv21', tokenId: 'x', amountRaw: '-1', address: 'a' }],
        },
      }),
    ).toBeNull();
    expect(parseSpec({ spec: { bountyNo: 1, claimant: 'd', transfers: [] } })).toBeNull();
    expect(parseSpec({})).toBeNull();
  });
});

describe('notifications', () => {
  const bs = parseBounties({
    bounties: [
      row({ bounty_no: 1, status: 'merged', claimed_by: 'dev' }),
      row({ bounty_no: 2, status: 'merged', claimed_by: 'other' }),
    ],
  });
  test('badge counts my merged/paid bounties not yet seen at that status', () => {
    expect(unseenForMe('BW', bs, 'dev', {}).length).toBe(1);
    const seen = markSeen('BW', bs, {});
    expect(unseenForMe('BW', bs, 'dev', seen).length).toBe(0);
    const paid = bs.map((b) => (b.bounty_no === 1 ? { ...b, status: 'paid' } : b));
    expect(unseenForMe('BW', paid, 'dev', seen).length).toBe(1);
  });
});
