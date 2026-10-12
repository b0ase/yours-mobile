import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  badgeLabel,
  boardState,
  CLAIM_PROTOCOL,
  claimMessage,
  claimSession,
  claimSigArgs,
  displayName,
  myLine,
  optOut,
  optOutSigArgs,
} from './board';

const fakeFetch = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('listener board claim', () => {
  test('claim message and createSignature params', () => {
    expect(claimMessage('02ab', 1700)).toBe('claim:02ab:1700');
    const a = claimSigArgs('02ab', 1700);
    expect(a.protocolID).toEqual([2, 'bmusic listen claim']);
    expect(a.keyID).toBe('02ab');
    expect(a.counterparty).toBe('anyone');
    expect(Utils.toUTF8(a.data)).toBe('claim:02ab:1700');
    const o = optOutSigArgs('03cd', 9);
    expect(o.keyID).toBe('optout');
    expect(Utils.toUTF8(o.data)).toBe('optout:03cd:9');
  });

  test('claim posts a hex sig the server can verify for "anyone"', async () => {
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const identityKey = (await w.getPublicKey({ identityKey: true })).publicKey;
    const { f, calls } = fakeFetch();
    await claimSession(w, '02ab', '$fan', { f, base: 'https://x', now: () => 42 });
    expect(calls[0].url).toBe('https://x/api/bmusic/listen/claim');
    const b = calls[0].body;
    expect(b).toMatchObject({ sessionPubKey: '02ab', identityKey, handle: '$fan', ts: 42 });
    expect(/^[0-9a-f]+$/.test(String(b.sig))).toBe(true);
    const anyone = new ProtoWallet('anyone');
    const v = await anyone.verifySignature({
      ...claimSigArgs('02ab', 42),
      protocolID: CLAIM_PROTOCOL,
      signature: Utils.toArray(String(b.sig), 'hex'),
      counterparty: identityKey,
    });
    expect(v.valid).toBe(true);
  });

  test('opt-out posts identityKey, ts, sig and optOut:true', async () => {
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const { f, calls } = fakeFetch();
    await optOut(w, { f, base: 'https://x', now: () => 7 });
    expect(calls[0].body).toMatchObject({ ts: 7, optOut: true });
    expect(calls[0].body.sessionPubKey).toBeUndefined();
  });

  test('409 surfaces as a status the page can explain', async () => {
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const f = (async () =>
      new Response(JSON.stringify({ error: 'claimed' }), { status: 409 })) as unknown as typeof fetch;
    await expect(claimSession(w, '02ab', undefined, { f })).rejects.toMatchObject({ status: 409 });
  });
});

describe('board rendering states', () => {
  const l = {
    rank: 1,
    identityKey: '02abcdef0123456789',
    handle: null,
    fanScore: 1,
    secondsTotal: 60,
    secondsSelfPaid: 20,
    secondsSponsored: 40,
    completedTracks: 0,
    distinctTracks: 1,
    badges: ['superfan'],
  };
  test('loading, error, empty, list', () => {
    expect(boardState(null, null)).toBe('loading');
    expect(boardState(null, 'down')).toBe('error');
    expect(boardState({ listeners: [], anonCount: 3, anonSeconds: 9 }, null)).toBe('empty');
    expect(boardState({ listeners: [l], anonCount: 0, anonSeconds: 0 }, null)).toBe('list');
  });
  test('names, badges and the You line', () => {
    expect(displayName(l)).toBe('02abcd…6789');
    expect(displayName({ ...l, handle: '$fan' })).toBe('$fan');
    expect(badgeLabel('superfan')).toBe('Superfan');
    expect(badgeLabel('first100')).toBe('First 100');
    expect(myLine({ rank: 4, badges: ['top'] })).toBe('You: #4 · Top listener');
    expect(myLine({ rank: null })).toBe('Not on the board');
    expect(myLine(null)).toBe('Not on the board');
  });
});
