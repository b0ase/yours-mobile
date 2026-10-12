import { joinLabel, parsePeople, peopleSections, tokenFor, type PersonToken } from './people';

const ID = 'a'.repeat(64) + '_0';
const row = (handle: string, extra: Record<string, unknown> = {}) => ({
  token_id: ID,
  ticker: handle.toUpperCase(),
  handle,
  display_name: `$${handle} holders`,
  avatar_url: null,
  launched_at: '2026-10-01',
  room_ticker: handle.toUpperCase(),
  room_open: false,
  members: 2,
  pricing: { mode: 'curve', start_usd_cents: 1, step_holders: 1000, max_per_buyer: 100 },
  price_usd_cents: 1,
  ...extra,
});

describe('bWalletX people tokens', () => {
  test('parses rows and drops bad ones', () => {
    const out = parsePeople({ tokens: [row('kim'), { token_id: 'nope', handle: 'x' }, row('')] });
    expect(out.map((t) => t.handle)).toEqual(['kim']);
  });

  test('gmail names stay masked', () => {
    const [t] = parsePeople({ tokens: [row('richardwboase.gmail', { display_name: 'richard@gmail.com' })] });
    expect(t.handle).toBe('r•••.gmail');
    expect(t.displayName).toBe('r•••@gmail.com');
    expect(JSON.stringify(t)).not.toContain('richardwboase');
  });

  test('friends first, then people; my own token left out', () => {
    const list = parsePeople({ tokens: [row('ann'), row('kim'), row('me'), row('bob')] });
    const s = peopleSections(list, ['$Kim', 'bob'], 'me');
    expect(s.friends.map((t) => t.handle)).toEqual(['kim', 'bob']);
    expect(s.people.map((t) => t.handle)).toEqual(['ann']);
  });

  test('tokenFor finds by handle', () => {
    const list = parsePeople({ tokens: [row('kim')] });
    expect(tokenFor(list, '$KIM')?.handle).toBe('kim');
    expect(tokenFor(list, 'zed')).toBeNull();
  });

  test('join wording', () => {
    expect(joinLabel({ handle: 'kim', priceUsdCents: 1 } as PersonToken)).toBe("Join $kim's room — 1¢");
    expect(joinLabel({ handle: 'kim', priceUsdCents: null } as PersonToken)).toBe("Ask to join $kim's room");
    expect(joinLabel({ handle: 'kim', priceUsdCents: 250 } as PersonToken)).toBe("Join $kim's room — $2.50");
  });
});
