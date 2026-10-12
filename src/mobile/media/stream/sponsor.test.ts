import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import { StreamHttpError, type SponsoredKeyResponse } from './api';
import { isSponsoredTrack, pickKeySource, SponsoredKeySource, trackSourceKind, type KeySource } from './keySource';
import { deriveSessionKey, openSponsoredSession } from './session';
import {
  PayToPlay,
  signSponsored,
  SPONSOR_502_TRIES,
  SPONSOR_PACE_MS,
  SponsorEnded,
  SponsoredPayer,
  sponsoredMessage,
} from './sponsor';

const ok = (segment: number): SponsoredKeyResponse => ({
  txid: `tx${segment}`,
  wrappedKey: '',
  protocolID: [2, 'bmusic stream key'],
  keyID: `t.${segment}`,
  serverIdentityKey: '',
  sponsoredBy: 'vexvoid',
  next: { segment: segment + 1 },
});

/** A fake clock: sleep advances time instantly and records each wait. */
const clock = () => {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
  };
};

describe('sponsored listening', () => {
  test('sig is the session key over utf8 "sponsored:<trackId>:<segment>", DER hex', () => {
    const key = PrivateKey.fromRandom();
    expect(sponsoredMessage('first-12-02', 9)).toBe('sponsored:first-12-02:9');
    const sig = signSponsored(key, 'first-12-02', 9);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
    const ok = PublicKey.fromString(key.toPublicKey().toString()).verify(
      Utils.toArray('sponsored:first-12-02:9', 'utf8'),
      Signature.fromDER(sig, 'hex'),
    );
    expect(ok).toBe(true);
  });

  test('posts listener + sig, paced to one request per second', async () => {
    const c = clock();
    const key = PrivateKey.fromRandom();
    const bodies: { trackId: string; segment: number; listener: string; sig: string }[] = [];
    const at: number[] = [];
    const p = new SponsoredPayer({
      key,
      now: c.now,
      sleep: c.sleep,
      post: async (b) => {
        bodies.push(b);
        at.push(c.now());
        return ok(b.segment);
      },
    });
    await p.pay('t', 0);
    await p.pay('t', 1);
    c.advance(300);
    await p.pay('t', 2);
    expect(at).toEqual([0, SPONSOR_PACE_MS, 2 * SPONSOR_PACE_MS]);
    expect(bodies[1]).toEqual({
      trackId: 't',
      segment: 1,
      listener: key.toPublicKey().toString(),
      sig: signSponsored(key, 't', 1),
    });
    expect(p.stats.seconds).toBe(3);
    expect(p.stats.lastTxid).toBe('tx2');
  });

  test('429 backs off and retries the same segment', async () => {
    const c = clock();
    let n = 0;
    const p = new SponsoredPayer({
      key: PrivateKey.fromRandom(),
      now: c.now,
      sleep: c.sleep,
      post: async (b) => {
        if (n++ < 2) throw new StreamHttpError(429, 'slow down');
        return ok(b.segment);
      },
    });
    const r = await p.pay('t', 4);
    expect(r.keyID).toBe('t.4');
    expect(n).toBe(3);
    expect(c.waits.filter((w) => w > SPONSOR_PACE_MS).length).toBeGreaterThan(0);
    expect(p.status).toBe('ready');
  });

  test('502 retries the same segment, then stops after 3 tries with the real message', async () => {
    const c = clock();
    const segs: number[] = [];
    const p = new SponsoredPayer({
      key: PrivateKey.fromRandom(),
      now: c.now,
      sleep: c.sleep,
      post: async (b) => {
        segs.push(b.segment);
        throw new StreamHttpError(502, 'ARC rejected: txn-mempool-conflict');
      },
    });
    await expect(p.pay('t', 5)).rejects.toThrow('502: ARC rejected: txn-mempool-conflict');
    expect(segs).toEqual(Array(SPONSOR_502_TRIES).fill(5));
    expect(p.status).toBe('error');
    expect(p.error).toContain('txn-mempool-conflict');
  });

  test('410 ends sponsorship with SponsorEnded; later calls fail fast without a request', async () => {
    let calls = 0;
    const p = new SponsoredPayer({
      key: PrivateKey.fromRandom(),
      sleep: async () => {},
      post: async () => {
        calls++;
        throw new StreamHttpError(410, 'pot empty');
      },
    });
    await expect(p.pay('t', 7)).rejects.toBeInstanceOf(SponsorEnded);
    await expect(p.pay('t', 8)).rejects.toBeInstanceOf(SponsorEnded);
    expect(calls).toBe(1);
    expect(p.status).toBe('ended');
  });

  test('re-requesting an already sponsored segment gets the key again without counting a new payment', async () => {
    const p = new SponsoredPayer({
      key: PrivateKey.fromRandom(),
      sleep: async () => {},
      post: async (b) => ok(b.segment),
    });
    await p.pay('t', 3);
    const again = await p.pay('t', 3);
    expect(again.keyID).toBe('t.3');
    expect(p.stats.seconds).toBe(1);
    expect(p.stats.payments).toBe(1);
  });

  test('no funding createAction: the sponsored session key is the deterministic session key', async () => {
    const pw = new ProtoWallet(PrivateKey.fromRandom());
    let created = 0;
    const wallet = {
      createHmac: pw.createHmac.bind(pw),
      createAction: async () => {
        created++;
        throw new Error('must not fund');
      },
    };
    const { id, key } = await openSponsoredSession(wallet);
    expect(created).toBe(0);
    expect(key.toHex()).toBe((await deriveSessionKey(wallet, id)).toHex());
  });

  test('410 hands over to the paid flow from the same segment; the engine picks sponsored first', async () => {
    const paid: KeySource = { kind: 'perSecond', segmentKey: async () => new Uint8Array(32) };
    const p = new SponsoredPayer({
      key: PrivateKey.fromRandom(),
      sleep: async () => {},
      post: async (b) => {
        if (b.segment >= 2) throw new StreamHttpError(410, 'capped');
        return ok(b.segment);
      },
    });
    const sponsored = new SponsoredKeySource(p, PrivateKey.fromRandom());
    expect(pickKeySource({ sponsored, perSecond: paid })?.kind).toBe('sponsored');
    expect(pickKeySource({ perSecond: paid })?.kind).toBe('perSecond');
    // Mirrors the engine loop: segments in order, stop at the first failure, resume there with the paid source.
    let seg = 0;
    let failed: unknown = null;
    for (; seg < 4; seg++) {
      try {
        await p.pay('t', seg);
      } catch (e) {
        failed = e;
        break;
      }
    }
    expect(failed).toBeInstanceOf(SponsorEnded);
    expect(seg).toBe(2);
    const resumed: number[] = [];
    const next = pickKeySource({ sponsored: null, perSecond: paid })!;
    for (let n = seg; n < 4; n++) {
      await next.segmentKey('t', n);
      resumed.push(n);
    }
    expect(resumed).toEqual([2, 3]);
  });
});

describe('per-track sponsorship (first-12: 1–6 sponsored, 7–12 pay to play)', () => {
  const status = {
    sponsored: true,
    sponsor: 'vexvoid',
    capSats: 1000,
    spentSats: 0,
    sponsoredTracks: ['first-12-01', 'first-12-02', 'first-12-03', 'first-12-04', 'first-12-05', 'first-12-06'],
    payToPlayTracks: ['first-12-07', 'first-12-08', 'first-12-09', 'first-12-10', 'first-12-11', 'first-12-12'],
  };
  test('source is chosen per track', () => {
    expect(trackSourceKind(status, 'first-12-03')).toBe('sponsored');
    expect(trackSourceKind(status, 'first-12-07')).toBe('perSecond');
    expect(trackSourceKind({ ...status, sponsored: false }, 'first-12-03')).toBe('perSecond');
    // An older server without the lists: the pot covers every track.
    expect(trackSourceKind({ sponsored: true, sponsor: 'v', capSats: 1, spentSats: 0 }, 'first-12-09')).toBe(
      'sponsored',
    );
    expect(trackSourceKind(null, 'first-12-01')).toBe('perSecond');
  });
  test('410 payToPlay switches only that track to paid; the pot is not ended', async () => {
    const key = PrivateKey.fromRandom();
    const p = new SponsoredPayer({
      key,
      sleep: async () => {},
      post: async (b) => {
        if (b.trackId === 'first-12-07')
          throw new StreamHttpError(410, 'this track is pay to play', { error: 'x', payToPlay: true });
        return ok(b.segment);
      },
    });
    await expect(p.pay('first-12-07', 0)).rejects.toBeInstanceOf(PayToPlay);
    expect(p.status).toBe('ready');
    await expect(p.pay('first-12-06', 0)).resolves.toBeDefined();
  });
  test('the sponsored key source refuses an uncovered track without a request', async () => {
    let calls = 0;
    const key = PrivateKey.fromRandom();
    const p = new SponsoredPayer({ key, sleep: async () => {}, post: async (b) => (calls++, ok(b.segment)) });
    const src = new SponsoredKeySource(p, key, (t) => isSponsoredTrack(status, t));
    await expect(src.segmentKey('first-12-08', 0)).rejects.toBeInstanceOf(PayToPlay);
    expect(calls).toBe(0);
  });
});
