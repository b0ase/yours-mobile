/**
 * Feed-author binding (authorBinding.ts): the wallet's half of bit-sign's /api/bitsign/feed/author-binding.
 *
 * The checks below marked "server" are copied from bit-sign (feed-author-binding-selftest.mts, lib/feed/
 * author-binding.ts parseFeedAuthorClaim, lib/bpics.ts bsmRecoversTo, and the route's verifySignature call), so a
 * claim that passes here is one the live route accepts, byte for byte.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BigNumber, BSM, KeyDeriver, PrivateKey, ProtoWallet, PublicKey, Script, Signature, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { guardReservedProtocols, isReservedProtocol, reservedProtocolRefusal } from '../../services/reservedProtocols';
import {
  aipAddressOf,
  bindingOutcome,
  ensureFeedAuthorBinding,
  FAILED_RETRY_MS,
  FEED_AUTHOR_BINDING_API,
  FEED_AUTHOR_KEY_ID,
  FEED_AUTHOR_PROTOCOL,
  feedAuthorAlias,
  feedAuthorMessage,
  NEEDS_NAME_RETRY_MS,
  resetAuthorBindingSession,
  RETRY_DELAYS_MS,
  signFeedAuthorClaim,
  type AuthorBindingDeps,
  type FeedAuthorBody,
} from './authorBinding';
import {
  authorNameSigned,
  readAuthorBinding,
  writeAuthorBinding,
  type AuthorBindingRecord,
} from './authorBindingState';
import { publish } from './feedApi';

// ── the server's checks (bit-sign), copied ───────────────────────────────────

/** server: lib/bpics.ts bsmRecoversTo. */
const bsmRecoversTo = (message: string, signatureB64: string, address: string): boolean => {
  try {
    const msg = Utils.toArray(message, 'utf8');
    const hash = new BigNumber(BSM.magicHash(msg));
    for (let r = 0; r < 4; r++) {
      try {
        const sig = Signature.fromCompact(signatureB64, 'base64');
        const pub: PublicKey = sig.RecoverPublicKey(r, hash);
        if (pub.toAddress() === address && BSM.verify(msg, sig, pub)) return true;
      } catch {
        /* try the next recovery id */
      }
    }
  } catch {
    /* malformed */
  }
  return false;
};

/** server: the route's identity check (ProtoWallet('anyone').verifySignature with the claimed key as counterparty). */
const identityVerifies = async (text: string, sigHex: string, key: string) => {
  try {
    return (
      await new ProtoWallet('anyone').verifySignature({
        protocolID: [2, 'bwallet feed author'],
        keyID: '1',
        counterparty: key,
        data: Array.from(Buffer.from(text, 'utf8')),
        signature: Array.from(Buffer.from(sigHex, 'hex')),
      })
    ).valid;
  } catch {
    return false;
  }
};

/** server: parseFeedAuthorClaim's shape rules (it refuses, never normalises). */
const WINDOW_MS = 10 * 60_000;
const serverShapeError = (b: FeedAuthorBody, now: number): string | null => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(b.alias)) return 'alias';
  if (!/^0[23][0-9a-f]{64}$/.test(b.identityKey)) return 'identityKey';
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,64}$/.test(b.bapId)) return 'bapId';
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(b.postingAddress)) return 'postingAddress';
  if (!Number.isSafeInteger(b.timestamp) || b.timestamp <= 0) return 'timestamp';
  if (Math.abs(now - b.timestamp) > WINDOW_MS) return 'stale';
  if (!/^([0-9a-f]{2}){8,80}$/i.test(b.identitySignature)) return 'identitySignature';
  if (!/^[A-Za-z0-9+/]{86,88}={0,2}$/.test(b.postingSignature)) return 'postingSignature';
  return null;
};

// ── a wallet with a published posting profile ────────────────────────────────

const BAP: [1, string] = [1, 'sigma'];

type Counts = { listOutputs: number; createSignature: number; getPublicKey: number };
/** An account: a root key, a BRC-100 wallet over it, and a "bap" basket holding its ID records up to `seq`. */
const account = (seq = 1) => {
  const root = PrivateKey.fromRandom();
  const proto = new ProtoWallet(root);
  const counts: Counts = { listOutputs: 0, createSignature: 0, getPublicKey: 0 };
  const state = { seq, actions: 0 };
  const wallet = {
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => (counts.getPublicKey++, proto.getPublicKey(a)),
    createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => (
      counts.createSignature++,
      proto.createSignature(a)
    ),
    listOutputs: async () => {
      counts.listOutputs++;
      const outputs = Array.from({ length: state.seq }, (_, i) => ({ tags: ['type:id', `seq:${i + 1}`] }));
      return { totalOutputs: outputs.length, outputs };
    },
    createAction: async () => (state.actions++, { txid: 'ab'.repeat(32) }),
  };
  const identityKey = root.toPublicKey().toString();
  /** The posting key as the chain knows it: [1,'sigma'] identity-N, derived here without the wallet. */
  const postingKey = (n = state.seq) => new KeyDeriver(root).derivePrivateKey(BAP, `identity-${n}`, 'self');
  return {
    ctx: { wallet } as unknown as OneSatContext,
    wallet,
    counts,
    state,
    identityKey,
    identityAddress: root.toPublicKey().toAddress(),
    postingKey,
    postingAddress: (n?: number) => postingKey(n).toPublicKey().toAddress(),
  };
};

/** Deps with their own storage, clock, network and timers. */
const harness = (paymail = 'peytonmoon69@bwalletx.com') => {
  const store = new Map<string, AuthorBindingRecord>();
  const sent: FeedAuthorBody[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const h = {
    now: 1_763_200_000_000,
    paymail,
    /** The next answers, in order; the last one repeats. */
    answers: [{ status: 200, body: { ok: true } as Record<string, unknown> }],
    store,
    sent,
    timers,
    urls: [] as string[],
    deps: {} as Partial<AuthorBindingDeps>,
  };
  h.deps = {
    now: () => h.now,
    paymailFor: () => h.paymail,
    // Outside a build the paymail domain is unset (names/config.ts), so say what "ours" is here.
    bare: (p) => p.replace(/@bwalletx\.com$/i, ''),
    read: (id) => store.get(id) ?? null,
    write: (id, r) => void (r ? store.set(id, r) : store.delete(id)),
    schedule: (fn, ms) => timers.push({ fn, ms }),
    fetch: (async (url: string, init: RequestInit) => {
      h.urls.push(url);
      sent.push(JSON.parse(String(init.body)));
      const a = h.answers.length > 1 ? h.answers.shift()! : h.answers[0];
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
  };
  return h;
};
const answer = (status: number, code: string) => ({ status, body: { code, error: 'x' } as Record<string, unknown> });
/** Let a scheduled retry (fire-and-forget) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(resetAuthorBindingSession);

describe('the canonical text', () => {
  const claim = {
    alias: 'peytonmoon69',
    identityKey: '02' + 'ab'.repeat(32),
    bapId: 's3JdX57uoLS6MQmYKf98BUMiSNf',
    postingAddress: '13XXTWWsTgwHZknqVMJ59Fcop49hxKToae',
    timestamp: 1_763_200_000_000,
  };

  test('is exactly the agreed bytes: UTF-8, fields in order, no trailing newline', () => {
    const text = feedAuthorMessage(claim);
    expect(text).toBe(
      'bwallet-feed-author|v1|alias=peytonmoon69|identityKey=02abababababababababababababababababababababababababababababababab|bapId=s3JdX57uoLS6MQmYKf98BUMiSNf|postingAddress=13XXTWWsTgwHZknqVMJ59Fcop49hxKToae|timestamp=1763200000000',
    );
    const bytes = Utils.toArray(text, 'utf8');
    expect(bytes).toEqual(Array.from(Buffer.from(text, 'utf8')));
    expect(bytes.length).toBe(text.length); // ASCII only
    expect(bytes[bytes.length - 1]).toBe('0'.charCodeAt(0));
    expect(bytes.slice(0, 23)).toEqual(Array.from(Buffer.from('bwallet-feed-author|v1|', 'ascii')));
  });

  test('every field is in the text: changing any one changes it', () => {
    const text = feedAuthorMessage(claim);
    for (const patch of [
      { alias: 'someoneelse' },
      { identityKey: '03' + 'ab'.repeat(32) },
      { bapId: 'other' },
      { postingAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
      { timestamp: claim.timestamp + 1 },
    ])
      expect(feedAuthorMessage({ ...claim, ...patch })).not.toBe(text);
  });

  test('protocol, key ID and route are the agreed ones', () => {
    expect(FEED_AUTHOR_PROTOCOL).toEqual([2, 'bwallet feed author']);
    expect(FEED_AUTHOR_KEY_ID).toBe('1');
    expect(FEED_AUTHOR_BINDING_API).toBe('https://www.bchatx.com/api/bitsign/feed/author-binding');
  });

  test('the alias is our own name, lowercase, with no $ or @domain; anything else is no alias', () => {
    const ours = (p: string) => p.replace(/@bwalletx\.com$/i, '');
    expect(feedAuthorAlias('PeytonMoon69@bwalletx.com', ours)).toBe('peytonmoon69');
    expect(feedAuthorAlias('', ours)).toBeNull();
    expect(feedAuthorAlias('someone@handcash.io', ours)).toBeNull();
    expect(feedAuthorAlias('$peyton@bwalletx.com', ours)).toBeNull();
    expect(feedAuthorAlias('pey ton@bwalletx.com', ours)).toBeNull();
  });
});

describe('both signatures, checked as the server checks them', () => {
  const sign = async (a = account()) => {
    const claim = {
      alias: 'peytonmoon69',
      identityKey: a.identityKey,
      bapId: 's3JdX57uoLS6MQmYKf98BUMiSNf',
      postingAddress: a.postingAddress(),
      timestamp: 1_763_200_000_000,
    };
    return { a, claim, body: await signFeedAuthorClaim(a.ctx, claim), text: feedAuthorMessage(claim) };
  };

  test('the body passes the server shape rules', async () => {
    const { body } = await sign();
    expect(serverShapeError(body, body.timestamp)).toBeNull();
    expect(Object.keys(body).sort()).toEqual(
      ['alias', 'bapId', 'identityKey', 'identitySignature', 'postingAddress', 'postingSignature', 'timestamp'].sort(),
    );
    expect(body.identitySignature).toMatch(/^30[0-9a-f]+$/); // DER, lowercase hex
  });

  test('identity signature verifies for the identity key, and only for this text and key', async () => {
    const { body, text, claim } = await sign();
    expect(await identityVerifies(text, body.identitySignature, body.identityKey)).toBe(true);
    expect(
      await identityVerifies(
        feedAuthorMessage({ ...claim, alias: 'someoneelse' }),
        body.identitySignature,
        body.identityKey,
      ),
    ).toBe(false);
    expect(await identityVerifies(text, body.identitySignature, PrivateKey.fromRandom().toPublicKey().toString())).toBe(
      false,
    );
  });

  test('posting signature recovers to the posting address, and only for this text', async () => {
    const { a, body, text, claim } = await sign();
    expect(bsmRecoversTo(text, body.postingSignature, body.postingAddress)).toBe(true);
    expect(
      bsmRecoversTo(
        feedAuthorMessage({ ...claim, postingAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }),
        body.postingSignature,
        body.postingAddress,
      ),
    ).toBe(false);
    // It is a plain Bitcoin Signed Message by the BAP posting key: the selftest's BSM.sign verifies the same way.
    const sig = Signature.fromCompact(body.postingSignature, 'base64');
    expect(BSM.verify(Utils.toArray(text, 'utf8'), sig, a.postingKey().toPublicKey())).toBe(true);
    expect(Utils.toArray(body.postingSignature, 'base64').length).toBe(65);
    // The identity key is not the posting key: its address must not be what the signature recovers to.
    expect(bsmRecoversTo(text, body.postingSignature, a.identityAddress)).toBe(false);
  });

  test('the posting key is the one that signs posts (AIP address on a signed post)', async () => {
    const { applyBapAip } = await import('@1sat/actions');
    const a = account();
    const script = new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
    const signed = await applyBapAip(a.ctx, script);
    expect(aipAddressOf(signed)).toBe(a.postingAddress());
    expect(aipAddressOf(script)).toBeNull();
  });

  test('a claim naming another posting address is not signed', async () => {
    const a = account();
    const claim = {
      alias: 'peytonmoon69',
      identityKey: a.identityKey,
      bapId: 'x',
      postingAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      timestamp: 1,
    };
    await expect(signFeedAuthorClaim(a.ctx, claim)).rejects.toThrow(/posting key/);
  });
});

describe('reserved: no site can make the wallet produce the identity signature', () => {
  const args = { protocolID: FEED_AUTHOR_PROTOCOL, keyID: '1', counterparty: 'anyone', data: [1, 2, 3] };

  test('refused for an outside caller on every signing path, in any case or spacing', () => {
    expect(isReservedProtocol(FEED_AUTHOR_PROTOCOL)).toBe(true);
    for (const method of ['createSignature', 'getPublicKey', 'createHmac', 'encrypt', 'revealSpecificKeyLinkage'])
      expect(reservedProtocolRefusal(method, args)).toMatch(/reserved/);
    expect(reservedProtocolRefusal('createSignature', { ...args, protocolID: [2, ' Bwallet Feed Author '] })).toMatch(
      /reserved/,
    );
    expect(reservedProtocolRefusal('createSignature', { ...args, hashToDirectlySign: [1], data: undefined })).toMatch(
      /reserved/,
    );
  });

  test('through the permissions manager: a site is refused before any prompt; the wallet itself signs', async () => {
    const calls: string[] = [];
    const manager = guardReservedProtocols(
      {
        createSignature: async (_a: unknown, originator?: string) => (calls.push(`sign:${originator}`), { ok: true }),
        ensureProtocolPermission: async () => (calls.push('prompt'), true),
        grantGroupedPermission: async (p: unknown) => void calls.push(`grouped:${JSON.stringify(p)}`),
      },
      'wallet-admin',
    ) as unknown as {
      createSignature: (a: unknown, o?: string) => Promise<unknown>;
      ensureProtocolPermission: (a: unknown) => Promise<boolean>;
      grantGroupedPermission: (p: unknown) => Promise<void>;
    };
    await expect(manager.createSignature(args, 'evil.example')).rejects.toThrow(/reserved/);
    await expect(manager.createSignature(args, undefined)).rejects.toThrow(/reserved/);
    await expect(
      manager.ensureProtocolPermission({ originator: 'bchatx.com', protocolID: FEED_AUTHOR_PROTOCOL }),
    ).rejects.toThrow(/reserved/);
    expect(calls).toEqual([]);
    // A grouped (BRC-73) grant can't smuggle it in either.
    await manager.grantGroupedPermission({ granted: { protocolPermissions: [{ protocolID: FEED_AUTHOR_PROTOCOL }] } });
    expect(calls).toEqual(['grouped:{"granted":{"protocolPermissions":[]}}']);
    await manager.createSignature(args, 'wallet-admin');
    expect(calls[1]).toBe('sign:wallet-admin');
  });
});

describe('server answers', () => {
  test('map to ok / retry-later / needs-name / failed', () => {
    expect(bindingOutcome(200, { ok: true })).toBe('ok');
    expect(bindingOutcome(200, {})).toBe('failed');
    expect(bindingOutcome(401, { code: 'name_binding_not_verified' })).toBe('needs-name');
    expect(bindingOutcome(503, { code: 'pki_unavailable' })).toBe('retry-later');
    expect(bindingOutcome(503, { code: 'sigma_unavailable' })).toBe('retry-later');
    expect(bindingOutcome(500, null)).toBe('retry-later');
    expect(bindingOutcome(429, null)).toBe('retry-later');
    // Sigma's index trails the chain: a profile published a minute ago isn't there yet.
    expect(bindingOutcome(401, { code: 'bap_id_mismatch' })).toBe('retry-later');
    expect(bindingOutcome(401, { code: 'identity_signature_failed' })).toBe('failed');
    expect(bindingOutcome(401, { code: 'posting_signature_failed' })).toBe('failed');
    expect(bindingOutcome(400, { code: 'bad_request' })).toBe('failed');
  });
});

describe('when it is sent', () => {
  test('first time: one POST of a claim the server would accept, for this account and its posting key', async () => {
    const a = account();
    const h = harness();
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.urls).toEqual([FEED_AUTHOR_BINDING_API]);
    const body = h.sent[0];
    expect(serverShapeError(body, h.now)).toBeNull();
    expect(body.alias).toBe('peytonmoon69');
    expect(body.identityKey).toBe(a.identityKey);
    expect(body.postingAddress).toBe(a.postingAddress());
    expect(body.timestamp).toBe(h.now);
    // BAP ID = base58(ripemd160(sha256(root address))), the root being identity-0 (BAP spec; what Sigma indexes).
    const { Hash } = await import('@bsv/sdk');
    const rootAddress = a.postingAddress(0);
    expect(body.bapId).toBe(Utils.toBase58(Hash.ripemd160(Hash.sha256(rootAddress, 'utf8'))));
    const text = feedAuthorMessage(body);
    expect(await identityVerifies(text, body.identitySignature, body.identityKey)).toBe(true);
    expect(bsmRecoversTo(text, body.postingSignature, body.postingAddress)).toBe(true);
    expect(h.store.get(a.identityAddress)).toMatchObject({
      status: 'ok',
      alias: 'peytonmoon69',
      address: a.postingAddress(),
    });
  });

  test('once per account: later Feed opens and posts send nothing', async () => {
    const a = account();
    const h = harness();
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('already');
    // After a post the caller knows the address it signed with: recognised with one identity-key lookup, no signing.
    const before = { ...a.counts };
    expect(await ensureFeedAuthorBinding(a.ctx, { postingAddress: a.postingAddress() }, h.deps)).toBe('already');
    expect(a.counts).toEqual({ ...before, getPublicKey: before.getPublicKey + 1 });
    expect(h.sent.length).toBe(1);
  });

  test('two calls at once (Feed open + a post) send one request', async () => {
    const a = account();
    const h = harness();
    const both = await Promise.all([
      ensureFeedAuthorBinding(a.ctx, {}, h.deps),
      ensureFeedAuthorBinding(a.ctx, {}, h.deps),
    ]);
    expect(both).toEqual(['ok', 'ok']);
    expect(h.sent.length).toBe(1);
  });

  test('per account: a second account on the same device sends its own', async () => {
    const [a, b] = [account(), account()];
    const h = harness();
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    expect(await ensureFeedAuthorBinding(b.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent.map((s) => s.identityKey)).toEqual([a.identityKey, b.identityKey]);
  });

  test('the posting address changed (key rotation): sent again for the new address, then remembered', async () => {
    const a = account();
    const h = harness();
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    a.state.seq = 2;
    // A post signed by the new key reports its address: not the one on record, so the claim is made again.
    expect(await ensureFeedAuthorBinding(a.ctx, { postingAddress: a.postingAddress(2) }, h.deps)).toBe('ok');
    expect(h.sent.map((s) => s.postingAddress)).toEqual([a.postingAddress(1), a.postingAddress(2)]);
    expect(a.postingAddress(1)).not.toBe(a.postingAddress(2));
    expect(bsmRecoversTo(feedAuthorMessage(h.sent[1]), h.sent[1].postingSignature, a.postingAddress(2))).toBe(true);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('already');
    expect(h.sent.length).toBe(2);
  });

  test('the name changed: sent again for the new name', async () => {
    const a = account();
    const h = harness();
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    h.paymail = 'peyton@bwalletx.com';
    expect(await ensureFeedAuthorBinding(a.ctx, { postingAddress: a.postingAddress() }, h.deps)).toBe('ok');
    expect(h.sent.map((s) => s.alias)).toEqual(['peytonmoon69', 'peyton']);
  });

  test('no bWalletX paymail: nothing is signed or sent', async () => {
    const a = account();
    const h = harness('');
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('no-name');
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
  });

  test('no posting profile yet: nothing is signed or sent, and it is sent once one is published', async () => {
    const a = account(0);
    const h = harness();
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('no-identity');
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
    a.state.seq = 1;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent.length).toBe(1);
  });
});

describe('503: retried later, quietly', () => {
  test('nothing is recorded, posts in between do not re-send, and the scheduled retry links the account', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(503, 'sigma_unavailable'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(h.store.size).toBe(0);
    expect(h.timers.map((t) => t.ms)).toEqual([RETRY_DELAYS_MS[0]]);
    // A like and a post a few seconds later: no second request while the retry is pending.
    h.now += 5_000;
    expect(await ensureFeedAuthorBinding(a.ctx, { postingAddress: a.postingAddress() }, h.deps)).toBe('waiting');
    expect(h.sent.length).toBe(1);
    // The retry fires: a fresh claim (new timestamp, inside the server's window), accepted and remembered.
    h.now += RETRY_DELAYS_MS[0];
    h.timers[0].fn();
    await settle();
    expect(h.sent.length).toBe(2);
    expect(h.sent[1].timestamp).toBe(h.now);
    expect(serverShapeError(h.sent[1], h.now)).toBeNull();
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('already');
  });

  test('a server that stays down: three spaced retries, then only a later Feed open or post asks again', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(503, 'pki_unavailable')];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      h.now += h.timers[i].ms;
      h.timers[i].fn();
      await settle();
    }
    expect(h.timers.map((t) => t.ms)).toEqual(RETRY_DELAYS_MS);
    expect(h.sent.length).toBe(1 + RETRY_DELAYS_MS.length);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('waiting');
    h.now += RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(h.store.size).toBe(0);
  });

  test('no network is the same as a 503', async () => {
    const a = account();
    const h = harness();
    h.deps.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(h.timers.length).toBe(1);
  });

  test('a lock drops pending retries', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(503, 'sigma_unavailable')];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    resetAuthorBindingSession();
    h.timers[0].fn();
    await settle();
    expect(h.sent.length).toBe(1);
  });
});

describe('name not signed yet: no nagging', () => {
  test('noted; not asked again on every post; asked again once the name is signed', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(401, 'name_binding_not_verified'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('needs-name');
    expect(h.store.get(a.identityAddress)).toMatchObject({ status: 'needs-name', code: 'name_binding_not_verified' });
    expect(h.timers.length).toBe(0);
    h.now += 60 * 60_000;
    expect(await ensureFeedAuthorBinding(a.ctx, { postingAddress: a.postingAddress() }, h.deps)).toBe('waiting');
    expect(h.sent.length).toBe(1);
    // The name sync signs the binding and clears the note (authorBindingState.authorNameSigned).
    h.deps.write!(a.identityAddress, null);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent.length).toBe(2);
  });

  test('signed on another device: asked again after a day', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(401, 'name_binding_not_verified')];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    h.now += NEEDS_NAME_RETRY_MS - 1;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('waiting');
    h.now += 2;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('needs-name');
    expect(h.sent.length).toBe(2);
  });

  test('a refused claim is not re-sent on every post either', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(401, 'posting_signature_failed')];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('failed');
    h.now += FAILED_RETRY_MS - 1;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('waiting');
    h.now += 2;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('failed');
    expect(h.sent.length).toBe(2);
  });

  describe('the note on this device', () => {
    const real = globalThis.localStorage;
    beforeEach(() => {
      const m = new Map<string, string>();
      globalThis.localStorage = {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      } as unknown as Storage;
    });
    afterEach(() => {
      globalThis.localStorage = real;
    });

    test('authorNameSigned clears a needs-name note and nothing else', () => {
      const rec = (status: AuthorBindingRecord['status']): AuthorBindingRecord => ({
        status,
        alias: 'a',
        address: '1x',
        at: 1,
      });
      writeAuthorBinding('1Me', rec('needs-name'));
      writeAuthorBinding('1Other', rec('ok'));
      authorNameSigned('1Me');
      authorNameSigned('1Other');
      authorNameSigned(null);
      expect(readAuthorBinding('1Me')).toBeNull();
      expect(readAuthorBinding('1Other')).toEqual(rec('ok'));
    });
  });
});

describe('a post is never stopped by the binding', () => {
  const script = () => new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('ensureFeedAuthorBinding never rejects: refusals, no network, a wallet that throws', async () => {
    const a = account();
    for (const ans of [answer(401, 'identity_signature_failed'), answer(400, 'bad_request'), answer(500, 'x')]) {
      resetAuthorBindingSession();
      const h = harness();
      h.answers = [ans];
      expect(typeof (await ensureFeedAuthorBinding(a.ctx, {}, h.deps))).toBe('string');
    }
    const h = harness();
    const broken = account();
    broken.wallet.createSignature = () => Promise.reject(new Error('Wallet is locked'));
    expect(await ensureFeedAuthorBinding(broken.ctx, {}, h.deps)).toBe('unavailable');
    const none = { wallet: { getPublicKey: () => Promise.reject(new Error('Wallet not available')) } };
    expect(await ensureFeedAuthorBinding(none as unknown as OneSatContext, {}, h.deps)).toBe('unavailable');
    expect(h.sent.length).toBe(0);
  });

  test('publish returns the txid while the binding is still hanging', async () => {
    const a = account();
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
    let asked = 0;
    const get = a.wallet.getPublicKey;
    // The binding starts by asking for the identity key (a post never does): it never answers.
    a.wallet.getPublicKey = (args) => (args.identityKey ? (asked++, new Promise(() => undefined)) : get(args));
    const txid = await publish(a.ctx, script(), 'Feed post', ['app:bWallet']);
    expect(txid).toBe('ab'.repeat(32));
    expect(a.state.actions).toBe(1);
    await settle();
    expect(asked).toBe(1); // the binding did start, after the post
  });

  test('publish returns the txid when the binding blows up', async () => {
    const a = account();
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
    const get = a.wallet.getPublicKey;
    a.wallet.getPublicKey = (args) => {
      if (args.identityKey) throw new Error('boom');
      return get(args);
    };
    expect(await publish(a.ctx, script(), 'Feed post', ['app:bWallet'])).toBe('ab'.repeat(32));
    await settle();
  });

  test('the binding is not started when the post itself fails', async () => {
    const a = account();
    let asked = 0;
    const get = a.wallet.getPublicKey;
    a.wallet.getPublicKey = (args) => (args.identityKey && asked++, get(args));
    a.wallet.createAction = () => Promise.reject(new Error('Insufficient funds'));
    await expect(publish(a.ctx, script(), 'Feed post', ['app:bWallet'])).rejects.toThrow('Insufficient funds');
    await settle();
    expect(asked).toBe(0);
  });
});
