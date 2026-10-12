import { describe, expect, test } from 'bun:test';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
(globalThis as Record<string, unknown>).__MARKET_BLOCKLIST_URL__ = '';
(globalThis as Record<string, unknown>).__MARKET_REPORT_URL__ = '';
const b = await import('./bpics');
const { RepeatGuard } = await import('../../services/repeatGuard');

const tx = (n: number) => n.toString(16).padStart(64, '0');
const row = (n: number, o: { type?: string; app?: string; ptype?: string; height?: number; owner?: string } = {}) => ({
  outpoint: `${tx(n)}_0`,
  owner: o.owner ?? `1Owner${n}`,
  height: o.height ?? 900_000 + n,
  idx: n,
  origin: {
    outpoint: `${tx(n)}_0`,
    data: {
      map: { app: o.app ?? 'bpics', type: o.ptype ?? 'pic', name: `Pic ${n}` },
      insc: { file: { type: o.type ?? 'image/jpeg' } },
    },
  },
});

describe('bPics tag', () => {
  test('sharing is opt-in: unticked by default', () => {
    expect(b.SHARE_DEFAULT).toBe(false);
  });
  test('unshared mint keeps the plain bWallet MAP (no bPics tag)', () => {
    const m = b.buildPicMap({ title: ' Sunset ', description: '', share: false });
    expect(m).toEqual({ app: 'bWallet', type: 'ord', name: 'Sunset' });
  });
  test('shared mint carries app=bpics, type=pic', () => {
    const m = b.buildPicMap({ title: 'Sunset', description: 'Brighton', share: true });
    expect(m).toEqual({ app: 'bpics', type: 'pic', name: 'Sunset', description: 'Brighton', client: 'bWallet' });
  });
  test('feed URL searches the MAP tag, newest first', () => {
    const u = new URL(b.feedUrl(30));
    expect(u.pathname).toBe('/api/inscriptions/search');
    expect(JSON.parse(atob(u.searchParams.get('q')!))).toEqual({ map: { app: 'bpics', type: 'pic' } });
    expect(u.searchParams.get('dir')).toBe('desc');
    expect(u.searchParams.get('offset')).toBe('30');
  });
});

describe('bPics feed', () => {
  test('images only: SVG, HTML and others are dropped', () => {
    const pics = b.parseFeed([
      row(1),
      row(2, { type: 'image/svg+xml' }),
      row(3, { type: 'text/html' }),
      row(4, { type: 'image/png' }),
      row(5, { type: 'video/mp4' }),
    ]);
    expect(pics.map((p) => p.idx)).toEqual([1, 4]);
  });
  test('untagged rows and junk are dropped', () => {
    expect(b.parseFeed([row(1, { app: 'bWallet' }), row(2, { ptype: 'ord' }), null, 7, {}])).toEqual([]);
    expect(b.parseFeed({ not: 'an array' })).toEqual([]);
  });
  test('newest first, unconfirmed on top, duplicates removed', () => {
    const pics = b.parseFeed([row(1), row(3), row(2, { height: 0 }), row(3)]);
    expect(b.visibleFeed(pics, { pics: [], minters: [] }).map((p) => p.idx)).toEqual([2, 3, 1]);
  });
  test('hidden pictures and hidden or blocked minters drop out', () => {
    const pics = b.parseFeed([row(1), row(2, { owner: '1Spam' }), row(3), row(4)]);
    let h = b.hidePic({ pics: [], minters: [] }, pics[0].origin);
    h = b.hideMinter(h, ['1SPAM']);
    const handles: Record<number, string> = { 3: 'troll' };
    const shown = b.visibleFeed(
      pics,
      h,
      (p) => ({ keys: [p.owner], handle: handles[p.idx] ?? null }),
      (x) => x === 'troll',
    );
    expect(shown.map((p) => p.idx)).toEqual([4]);
  });
});

describe('bPics repeat guard', () => {
  test('an identical inscription is refused the second time', async () => {
    const script = '0063036f7264' + 'ab'.repeat(40);
    let calls = 0;
    const ctx = {
      wallet: {
        createAction: async () => {
          calls++;
          return { txid: 'f'.repeat(64) };
        },
      },
    } as never;
    const g = new RepeatGuard();
    const guarded = b.withRepeatGuard(ctx, g) as unknown as {
      wallet: { createAction: (a: unknown) => Promise<unknown> };
    };
    const args = { description: 'x', outputs: [{ lockingScript: script, satoshis: 1, outputDescription: 'o' }] };
    await guarded.wallet.createAction(args);
    await expect(guarded.wallet.createAction(args)).rejects.toThrow(/already on its way/);
    expect(calls).toBe(1);
  });
});

describe('data URI', () => {
  test('splits and sizes', () => {
    const r = b.splitDataUri('data:image/jpeg;base64,QUJD');
    expect(r).toEqual({ contentType: 'image/jpeg', base64: 'QUJD' });
    expect(b.base64Bytes('QUJD')).toBe(3);
    expect(b.base64Bytes('QQ==')).toBe(1);
  });
});

describe('bPics is free (owner, 12 Oct 2026)', () => {
  test('no bWallet mint fee with an empty fee address', async () => {
    const { estimateCost } = await import('../mint/mint');
    const c = estimateCost(200_000, 100, 50, { feeAddress: '' });
    expect(c.feeSats).toBe(0);
    expect(c.totalSats).toBe(c.networkSats);
  });
});
