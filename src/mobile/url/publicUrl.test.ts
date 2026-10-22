import { describe, expect, test } from 'bun:test';
import { toPublic, toRouter } from './publicUrl';

describe('toPublic', () => {
  test('spaces and a permanent space', () => {
    expect(toPublic('/m/spaces', '')).toBe('/spaces');
    expect(toPublic('/m/spaces', '?space=bwallet-lounge')).toBe('/spaces/bwallet-lounge');
  });
  test('other tab pages lose the /m prefix, top routes stay', () => {
    expect(toPublic('/m/chat', '')).toBe('/chat');
    expect(toPublic('/m/lock/verify', '?tx=ab')).toBe('/lock/verify?tx=ab');
    expect(toPublic('/bsv-wallet', '')).toBe('/wallet');
    expect(toPublic('/settings', '')).toBe('/settings');
  });
  test('a bad slug is not put in the path', () => {
    expect(toPublic('/m/spaces', '?space=../x')).toBe('/spaces?space=..%2Fx');
  });
});

describe('toRouter', () => {
  test('the Exchange: /exchange, /exchange/swap, /exchange/<token>; old /market links open it', () => {
    const tok = `${'a'.repeat(64)}_0`;
    expect(toPublic('/m/exchange', '')).toBe('/exchange');
    expect(toPublic('/m/exchange/swap', '')).toBe('/exchange/swap');
    expect(toPublic(`/m/exchange/${tok}`, '')).toBe(`/exchange/${tok}`);
    expect(toRouter('/exchange', '')).toBe('/m/exchange');
    expect(toRouter('/exchange/swap', '')).toBe('/m/exchange/swap');
    expect(toRouter(`/exchange/${tok}`, '')).toBe(`/m/exchange/${tok}`);
    expect(toRouter('/market', '')).toBe('/m/exchange');
    expect(toRouter('/m/market', '')).toBe('/m/exchange');
    expect(toRouter('/m/market/swap', '?x=1')).toBe('/m/exchange/swap?x=1');
    expect(toRouter('/m/exchange', '')).toBe('/m/exchange');
    expect(toRouter('/m/nfts', '')).toBe('/m/nfts');
    expect(toRouter('/market/swap', '?x=1')).toBe('/m/exchange/swap?x=1');
  });
  test('round trips', () => {
    expect(toRouter('/spaces', '')).toBe('/m/spaces');
    expect(toRouter('/spaces/bwallet-lounge', '')).toBe('/m/spaces?space=bwallet-lounge');
    expect(toRouter('/chat/', '')).toBe('/m/chat');
    expect(toRouter('/settings', '')).toBe('/settings');
    expect(toRouter('/wallet', '')).toBe('/bsv-wallet');
    expect(toRouter('/bsv-wallet', '')).toBe('/bsv-wallet');
  });
  test('root and files keep the app start', () => {
    expect(toRouter('/', '')).toBeNull();
    expect(toRouter('/desktop.html', '')).toBeNull();
  });
  test('restore and set-up screens never reopen from the URL (reload loop)', () => {
    expect(toRouter('/restore-wallet', '')).toBeNull();
    expect(toRouter('/master-restore', '')).toBeNull();
    expect(toPublic('/restore-wallet', '')).toBe('/');
  });
});

describe('shareable album and artist paths', () => {
  test('album round trip', () => {
    expect(toRouter('/bmusic/artist/vexvoid/album/echoes-in-the-abyss', '')).toBe('/m/media/album/first-12');
    expect(toPublic('/m/media/album/first-12', '')).toBe('/bmusic/artist/vexvoid/album/echoes-in-the-abyss');
  });
  test('the old album path still opens', () => {
    expect(toRouter('/media/album/first-12', '')).toBe('/m/media/album/first-12');
    expect(toPublic('/m/media/album/other', '')).toBe('/bmusic/album/other');
  });
  test('artist page round trip', () => {
    expect(toRouter('/bmusic/artists/vexvoid', '')).toBe('/m/media/artists/vexvoid');
    expect(toPublic('/m/media/artists/vexvoid', '')).toBe('/bmusic/artists/vexvoid');
    expect(toPublic('/m/media/artists', '')).toBe('/bmusic/artists');
    expect(toRouter('/bchatx-feed', '')).toBe('/m/feed');
    expect(toPublic('/m/feed', '')).toBe('/bchatx-feed');
  });
  test('the store is /bmusic; old /media links still open it', () => {
    expect(toPublic('/m/media', '')).toBe('/bmusic');
    expect(toRouter('/bmusic', '')).toBe('/m/media');
    expect(toRouter('/media', '')).toBe('/m/media');
    expect(toRouter('/bmusic/artist/vexvoid', '')).toBe('/m/media/artists/vexvoid');
    expect(toRouter('/bmusic/artists', '')).toBe('/m/media/artists');
    expect(toRouter('/media/artist/vexvoid/album/echoes-in-the-abyss', '')).toBe('/m/media/album/first-12');
  });
  test('unknown album falls back to Media', () => {
    expect(toRouter('/bmusic/artist/vexvoid/album/nope', '')).toBe('/m/media');
  });
});

describe('wallet pages under /wallet', () => {
  const op = `${'a'.repeat(64)}_0`;
  test('NFT library and deep link round trip', () => {
    expect(toPublic('/m/nfts', '')).toBe('/wallet/nfts');
    expect(toRouter('/wallet/nfts', '')).toBe('/m/nfts');
    expect(toPublic(`/m/nfts/${op}`, '')).toBe(`/wallet/nfts/${op}`);
    expect(toRouter(`/wallet/nfts/${op}`, '')).toBe(`/m/nfts/${op}`);
  });
  test('dns-dex deep link /m/mint/domain?d= opens in the router with its query', () => {
    expect(toRouter('/m/mint/domain', '?d=example.com')).toBe('/m/mint/domain?d=example.com');
    expect(toRouter('/mint/domain', '?d=example.com')).toBe('/m/mint/domain?d=example.com');
  });
  test('bMint OpNS names: /bmint/opns round trip, keeps ?mint=', () => {
    expect(toPublic('/m/bmint/opns', '?mint=a,b')).toBe('/bmint/opns?mint=a%2Cb');
    expect(toRouter('/bmint/opns', '?mint=a,b')).toBe('/m/bmint/opns?mint=a,b');
    expect(toRouter('/opns-mint', '?mint=a')).toBe('/m/opns-mint?mint=a');
  });

  test('tickets round trip; old /tickets still opens', () => {
    expect(toPublic('/m/tickets', '')).toBe('/wallet/tickets');
    expect(toRouter('/wallet/tickets', '')).toBe('/m/tickets');
    expect(toRouter('/tickets', '')).toBe('/m/tickets');
  });
  test('credits round trip; old /credits still opens', () => {
    expect(toPublic('/m/credits', '')).toBe('/wallet/credits');
    expect(toRouter('/wallet/credits', '')).toBe('/m/credits');
    expect(toRouter('/credits', '')).toBe('/m/credits');
  });
  test('the wallet itself is unchanged', () => {
    expect(toPublic('/bsv-wallet', '')).toBe('/wallet');
    expect(toRouter('/wallet', '')).toBe('/bsv-wallet');
  });
  test('friends and a friend round trip', () => {
    expect(toPublic('/m/friends', '')).toBe('/wallet/friends');
    expect(toPublic('/m/friends/alice', '')).toBe('/wallet/friends/alice');
    expect(toRouter('/wallet/friends', '')).toBe('/m/friends');
    expect(toRouter('/wallet/friends/alice/', '')).toBe('/m/friends/alice');
  });
});

describe('Pots & Locks tabs', () => {
  test('both ways', () => {
    for (const [router, pub] of [
      ['/m/lock', '/lock'],
      ['/m/lock/locks', '/lock/locks'],
      ['/m/lock/subscriptions', '/lock/subscriptions'],
    ]) {
      expect(toPublic(router, '')).toBe(pub);
      expect(toRouter(pub, '')).toBe(router);
    }
  });
  test('bPhone: /m/calls ↔ /bphone, any case, old /calls', () => {
    expect(toPublic('/m/calls', '')).toBe('/bphone');
    expect(toPublic('/m/calls/x', '?a=1')).toBe('/bphone/x?a=1');
    expect(toRouter('/bphone', '')).toBe('/m/calls');
    expect(toRouter('/bPhone', '')).toBe('/m/calls');
    expect(toRouter('/BPHONE/x', '?a=1')).toBe('/m/calls/x?a=1');
    expect(toRouter('/calls', '')).toBe('/m/calls');
    expect(toRouter('/bphones', '')).toBe('/m/bphones');
  });
});
