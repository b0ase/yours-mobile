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
  BLOCKED_RETRY_MS,
  isAuthoredPost,
  ACCOUNT_CHANGED_MESSAGE,
  AccountChangedError,
  assertNameToPost,
  isNameChecked,
  linkAuthorAtUnlock,
  NAME_NEEDED_MESSAGE,
  NameNeededError,
  needsNameToPost,
  postNameGate,
  UNLOCK_RECHECK_MS,
  NEEDS_NAME_RETRY_MS,
  postFeedAuthorBinding,
  resetAuthorBindingSession,
  RETRY_DELAYS_MS,
  signFeedAuthorClaim,
  type AuthorBindingDeps,
  type FeedAuthorBody,
} from './authorBinding';
import {
  authorNameSigned,
  hasPostedFlag,
  readAuthorBinding,
  writeAuthorBinding,
  type AuthorBindingRecord,
} from './authorBindingState';
import { lookupPaymailStateAt } from '../names/paymail';
import { revealMany, revealMedia, RevealStoppedError, revealStoppedMessage } from '../private/privateMint';
import { replyByName, tipDestinations } from './tipMessage';
import { oneAtATime, postAfterPaidSteps, publish } from './feedApi';

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
  const state = { seq, actions: 0, posts: 1, likes: 0 };
  const wallet = {
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => (counts.getPublicKey++, proto.getPublicKey(a)),
    createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => (
      counts.createSignature++,
      proto.createSignature(a)
    ),
    listOutputs: async (a: { basket: string; tags?: string[] }) => {
      counts.listOutputs++;
      // The bSocial basket holds what the account published: posts and replies ('type:post'), and likes, follows,
      // branches, hides. The bap basket holds its ID records.
      if (a.basket === 'bsocial')
        return { totalOutputs: a.tags?.includes('type:post') ? state.posts : state.posts + state.likes, outputs: [] };
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
    /** Identity addresses marked as agent accounts or pots. */
    agents: new Set<string>(),
    /** Identity addresses flagged "has posted" on this device. */
    posted: new Set<string>(),
    headers: {} as Record<string, string>,
    deps: {} as Partial<AuthorBindingDeps>,
  };
  h.deps = {
    now: () => h.now,
    paymailFor: () => h.paymail,
    // Outside a build the paymail domain is unset (names/config.ts), so say what "ours" is here.
    bare: (p) => p.replace(/@bwalletx\.com$/i, ''),
    isAgentOrPot: (id) => h.agents.has(id),
    markPosted: (id) => void h.posted.add(id),
    hasPosted: async (ctx, id) =>
      h.posted.has(id) ||
      ((await ctx.wallet.listOutputs({ basket: 'bsocial', tags: ['type:post'], limit: 1 })).totalOutputs ?? 0) > 0,
    post: (body, f) => postFeedAuthorBinding(body, f, 'direct'),
    read: (id) => store.get(id) ?? null,
    write: (id, r) => void (r ? store.set(id, r) : store.delete(id)),
    schedule: (fn, ms) => timers.push({ fn, ms }),
    fetch: (async (url: string, init: RequestInit) => {
      h.urls.push(url);
      sent.push(JSON.parse(String(init.body)));
      const a = h.answers.length > 1 ? h.answers.shift()! : h.answers[0];
      return new Response(JSON.stringify(a.body), { status: a.status, headers: h.headers });
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
    // 409 means two different things: read the code, never the status.
    expect(bindingOutcome(409, { code: 'bap_not_indexed' })).toBe('retry-later');
    expect(bindingOutcome(409, { code: 'address_linked_to_another_name' })).toBe('blocked');
    expect(bindingOutcome(409, { code: 'something_new' })).toBe('failed');
    expect(bindingOutcome(409, null)).toBe('failed');
    expect(bindingOutcome(0, null)).toBe('retry-later');
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

// ── round 2 (independent review, 15 Nov 2026) ───────────────────────────────

describe('only accounts that post are bound', () => {
  test('Feed open on an account that never posted: nothing is signed or sent', async () => {
    const a = account();
    a.state.posts = 0;
    const h = harness();
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('not-posted');
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
    expect(h.store.size).toBe(0);
  });

  test('Feed open on an account whose wallet holds Feed posts: bound', async () => {
    const a = account();
    a.state.posts = 3;
    const h = harness();
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent.length).toBe(1);
  });

  test('right after a first post: bound, and the account is remembered as one that posts', async () => {
    const a = account();
    a.state.posts = 0;
    const h = harness();
    h.answers = [answer(503, 'sigma_unavailable'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
      'retry-later',
    );
    expect(h.posted.has(a.identityAddress)).toBe(true);
    // Next session's Feed open: the flag alone qualifies it (the basket here is still empty).
    resetAuthorBindingSession();
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent.length).toBe(2);
  });

  test('an agent account or a pot is never bound, on Feed open or after a post', async () => {
    const a = account();
    const h = harness();
    h.agents.add(a.identityAddress);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('excluded');
    expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
      'excluded',
    );
    expect(await ensureFeedAuthorBinding(a.ctx, { retryFor: a.identityAddress }, h.deps)).toBe('excluded');
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
    expect(h.posted.size).toBe(0);
  });

  describe('with this device’s own records', () => {
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
    /** The harness, but with the real agent/pot check and the real "has posted" signal. */
    const realSignals = () => {
      const h = harness();
      delete h.deps.isAgentOrPot;
      delete h.deps.hasPosted;
      delete h.deps.markPosted;
      return h;
    };

    test('kind agent and kind pot (agents/agentAccounts.ts) are both excluded', async () => {
      const [agent, pot, person] = [account(), account(), account()];
      localStorage.setItem(
        'bwallet.agentAccounts',
        JSON.stringify({
          [agent.identityAddress]: { identityAddress: agent.identityAddress, labels: [] },
          [pot.identityAddress]: { identityAddress: pot.identityAddress, labels: [], kind: 'pot' },
        }),
      );
      const h = realSignals();
      expect(await ensureFeedAuthorBinding(agent.ctx, { posted: true }, h.deps)).toBe('excluded');
      expect(await ensureFeedAuthorBinding(pot.ctx, { posted: true }, h.deps)).toBe('excluded');
      expect(await ensureFeedAuthorBinding(person.ctx, {}, h.deps)).toBe('ok');
      expect(h.sent.map((s) => s.identityKey)).toEqual([person.identityKey]);
    });

    test('has posted = the flag set at post time, else the wallet’s bSocial basket', async () => {
      const h = realSignals();
      const never = account();
      never.state.posts = 0;
      expect(await ensureFeedAuthorBinding(never.ctx, {}, h.deps)).toBe('not-posted');
      expect(hasPostedFlag(never.identityAddress)).toBe(false);
      // An older poster (no flag yet): the basket says so.
      const older = account();
      older.state.posts = 2;
      expect(await ensureFeedAuthorBinding(older.ctx, {}, h.deps)).toBe('ok');
      // A post sets the flag; from then on the basket isn't needed.
      await ensureFeedAuthorBinding(never.ctx, { posted: true }, h.deps);
      expect(hasPostedFlag(never.identityAddress)).toBe(true);
      expect(hasPostedFlag(older.identityAddress)).toBe(false);
    });

    test('a basket holding only likes and follows is not "has posted"', async () => {
      const h = realSignals();
      const a = account();
      a.state.posts = 0;
      a.state.likes = 9;
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('not-posted');
      expect(await ensureFeedAuthorBinding(a.ctx, { posted: false, postingAddress: a.postingAddress() }, h.deps)).toBe(
        'not-posted',
      );
      expect(h.sent.length).toBe(0);
      a.state.posts = 1;
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    });

    test('a basket the wallet can’t list counts as "not posted"', async () => {
      const h = realSignals();
      const a = account();
      const list = a.wallet.listOutputs;
      a.wallet.listOutputs = (args) => (args.basket === 'bsocial' ? Promise.reject(new Error('busy')) : list(args));
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('not-posted');
      expect(h.sent.length).toBe(0);
    });
  });
});

describe('a retry belongs to its own account', () => {
  /** One app-wide wallet context that follows the account in use, as the app's does. */
  const switching = (first: ReturnType<typeof account>) => {
    const s = { current: first };
    const wallet = {
      getPublicKey: (a: never) => s.current.wallet.getPublicKey(a),
      createSignature: (a: never) => s.current.wallet.createSignature(a),
      listOutputs: (a: never) => s.current.wallet.listOutputs(a),
    };
    return { s, ctx: { wallet } as unknown as OneSatContext };
  };

  test('A gets a 503, the wallet switches to B, A’s timer fires: nothing is signed or sent for B', async () => {
    const [a, b] = [account(), account()];
    const app = switching(a);
    const h = harness();
    h.answers = [answer(503, 'sigma_unavailable'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(app.ctx, {}, h.deps)).toBe('retry-later');
    app.s.current = b;
    h.now += RETRY_DELAYS_MS[0];
    h.timers[0].fn();
    await settle();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].identityKey).toBe(a.identityKey);
    expect(b.counts.createSignature).toBe(0);
    expect(h.store.size).toBe(0);
    expect(h.timers.length).toBe(1); // and A's retry did not reschedule itself onto B
  });

  test('the wallet is still on A when the timer fires: A is linked', async () => {
    const [a, b] = [account(), account()];
    const app = switching(a);
    const h = harness();
    h.answers = [answer(503, 'sigma_unavailable'), { status: 200, body: { ok: true } }];
    await ensureFeedAuthorBinding(app.ctx, {}, h.deps);
    app.s.current = b;
    app.s.current = a;
    h.now += RETRY_DELAYS_MS[0];
    h.timers[0].fn();
    await settle();
    expect(h.sent.map((s) => s.identityKey)).toEqual([a.identityKey, a.identityKey]);
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
  });
});

describe('server codes from bit-sign #719 / #720', () => {
  test('409 bap_not_indexed: retried, and Retry-After is a minimum (never a way to retry sooner)', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'bap_not_indexed')];
    h.headers = { 'retry-after': '600' };
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(h.store.size).toBe(0);
    expect(h.timers.map((t) => t.ms)).toEqual([600_000]);
    h.now += 5 * 60_000;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('waiting');
    // A short Retry-After does not shorten the wallet's own spacing.
    resetAuthorBindingSession();
    const h2 = harness();
    h2.answers = [answer(409, 'bap_not_indexed')];
    h2.headers = { 'retry-after': '5' };
    await ensureFeedAuthorBinding(a.ctx, {}, h2.deps);
    expect(h2.timers.map((t) => t.ms)).toEqual([RETRY_DELAYS_MS[0]]);
  });

  test('401 bap_id_mismatch (the not-indexed answer until #719 is live): each retry reads the BAP ID again and signs a fresh claim', async () => {
    const a = account();
    const h = harness();
    let rootKeyReads = 0;
    const get = a.wallet.getPublicKey;
    a.wallet.getPublicKey = (args) => (args.keyID === 'identity-0' && rootKeyReads++, get(args));
    h.answers = [answer(401, 'bap_id_mismatch'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(rootKeyReads).toBe(1);
    expect(h.store.size).toBe(0);
    h.now += RETRY_DELAYS_MS[0];
    h.timers[0].fn();
    await settle();
    expect(rootKeyReads).toBe(2);
    const [first, second] = h.sent;
    expect(second.timestamp).toBe(first.timestamp + RETRY_DELAYS_MS[0]);
    expect(second.identitySignature).not.toBe(first.identitySignature);
    expect(second.postingSignature).not.toBe(first.postingSignature);
    expect(serverShapeError(second, h.now)).toBeNull();
    expect(bsmRecoversTo(feedAuthorMessage(second), second.postingSignature, second.postingAddress)).toBe(true);
    expect(await identityVerifies(feedAuthorMessage(second), second.identitySignature, second.identityKey)).toBe(true);
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
  });

  test('a mismatch that never clears: about one send per 30 minutes, no more', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(401, 'bap_id_mismatch')];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      h.now += h.timers[i].ms;
      h.timers[i].fn();
      await settle();
    }
    const sentSoFar = h.sent.length;
    // Posts and Feed opens over the next 29 minutes send nothing.
    for (let m = 1; m < 30; m += 4) {
      h.now += 4 * 60_000;
      if (h.now - h.sent[sentSoFar - 1].timestamp >= RETRY_DELAYS_MS[2]) break;
      expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
        'waiting',
      );
    }
    expect(h.sent.length).toBe(sentSoFar);
    expect(h.timers.length).toBe(RETRY_DELAYS_MS.length);
  });

  test('409 address_linked_to_another_name: no timers, no re-send on Feed open or after posts', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'address_linked_to_another_name')];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
    expect(h.timers.length).toBe(0);
    expect(h.store.get(a.identityAddress)).toEqual({
      status: 'blocked',
      alias: 'peytonmoon69',
      address: a.postingAddress(),
      at: h.now,
      code: 'address_linked_to_another_name',
    });
    // Weeks of Feed opens, posts and a stray retry: nothing more is signed or sent.
    const signed = a.counts.createSignature;
    for (const gap of [1_000, FAILED_RETRY_MS, NEEDS_NAME_RETRY_MS, 27 * 24 * 3600_000]) {
      h.now += gap;
      resetAuthorBindingSession();
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
      expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
        'blocked',
      );
      expect(await ensureFeedAuthorBinding(a.ctx, { retryFor: a.identityAddress }, h.deps)).toBe('blocked');
    }
    expect(h.sent.length).toBe(1);
    expect(a.counts.createSignature).toBe(signed);
    // The name sync signing the name does not lift it (that is for needs-name only).
    expect(h.store.get(a.identityAddress)?.status).toBe('blocked');
  });

  test('the same status, the other code: 409 bap_not_indexed still retries', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'bap_not_indexed'), { status: 200, body: { ok: true } }];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('retry-later');
    expect(h.timers.length).toBe(1);
    h.now += h.timers[0].ms;
    h.timers[0].fn();
    await settle();
    expect(h.sent.length).toBe(2);
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
  });

  test('blocked is for that address and name: a new posting key is a new claim', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'address_linked_to_another_name'), { status: 200, body: { ok: true } }];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    a.state.seq = 2;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
    expect(h.sent[1].postingAddress).toBe(a.postingAddress(2));
  });

  test('a blocked account still posts', async () => {
    const a = account();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'address_linked_to_another_name' }), {
        status: 409,
      })) as unknown as typeof fetch;
    try {
      const script = new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
      expect(await publish(a.ctx, script, 'Feed post', ['app:bWallet'])).toBe('ab'.repeat(32));
      await settle();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the forged claim (review finding A)', () => {
  // A site holding the user's standing posting grant asks for a signature over 32 bytes of `data` under [1,'sigma'].
  // The wallet signs sha256(data); with data = sha256(BSM prefix ‖ text) that is BSM.magicHash(text): a posting-key
  // signature over a feed-author claim naming the ATTACKER's name and key for the VICTIM's posting address.
  const forge = async () => {
    const [victim, attacker] = [account(), account()];
    const claim = {
      alias: 'attacker',
      identityKey: attacker.identityKey,
      bapId: 's3JdX57uoLS6MQmYKf98BUMiSNf',
      postingAddress: victim.postingAddress(),
      timestamp: 1_763_200_000_000,
    };
    const text = feedAuthorMessage(claim);
    const msg = Utils.toArray(text, 'utf8');
    const w = new Utils.Writer();
    const prefix = Utils.toArray('Bitcoin Signed Message:\n', 'utf8');
    w.writeVarIntNum(prefix.length);
    w.write(prefix);
    w.writeVarIntNum(msg.length);
    w.write(msg);
    const { Hash } = await import('@bsv/sdk');
    const inner = Hash.sha256(w.toArray());
    expect(Utils.toHex(Hash.sha256(inner))).toBe(Utils.toHex(BSM.magicHash(msg)));
    const siteArgs = { protocolID: [1, 'sigma'], keyID: 'identity-1', counterparty: 'self', data: inner };
    /** What the server would be sent if the wallet signed `siteArgs`. */
    const finish = (der: number[]) => {
      const sig = Signature.fromDER(der);
      const rec = sig.CalculateRecoveryFactor(victim.postingKey().toPublicKey(), new BigNumber(BSM.magicHash(msg)));
      return Utils.toBase64(sig.toCompact(rec, true) as number[]);
    };
    return { victim, text, siteArgs, finish };
  };
  /** The victim's wallet behind the same guard the app installs (initWallet.ts guardCrossSiteSigning). */
  const guarded = async (victim: ReturnType<typeof account>) => {
    const { guardCrossSiteSigning } = await import('../../services/crossSiteSignGuard');
    return guardCrossSiteSigning(
      { createSignature: (args: never) => victim.wallet.createSignature(args) },
      'wallet-admin',
    ) as { createSignature: (a: unknown, o?: string) => Promise<{ signature: number[] }> };
  };

  test('the route is real: signed without the guard, the forged claim passes the server’s posting check', async () => {
    const { victim, text, siteArgs, finish } = await forge();
    const { signature } = await victim.wallet.createSignature(siteArgs as never);
    expect(bsmRecoversTo(text, finish(Array.from(signature)), victim.postingAddress())).toBe(true);
  });

  test('through the wallet’s guard a site gets no such signature', async () => {
    const { victim, siteArgs } = await forge();
    const wallet = await guarded(victim);
    for (const site of ['https://evil.example', 'evil.example', 'https://bwalletx.com', 'localhost:3000'])
      await expect(wallet.createSignature(siteArgs, site)).rejects.toThrow(/hash the wallet cannot read/);
    expect(victim.counts.createSignature).toBe(0);
  });

  test('the wallet’s own signing is untouched: the real binding still signs and verifies behind the guard', async () => {
    const a = account();
    const wallet = await guarded(a);
    const ctx = {
      wallet: {
        ...a.wallet,
        createSignature: (args: unknown) => wallet.createSignature(args, 'wallet-admin'),
      },
    } as unknown as OneSatContext;
    const h = harness();
    expect(await ensureFeedAuthorBinding(ctx, {}, h.deps)).toBe('ok');
    const body = h.sent[0];
    expect(bsmRecoversTo(feedAuthorMessage(body), body.postingSignature, a.postingAddress())).toBe(true);
    expect(await identityVerifies(feedAuthorMessage(body), body.identitySignature, body.identityKey)).toBe(true);
  });
});

describe('where the request is sent from', () => {
  const body = {
    alias: 'peytonmoon69',
    identityKey: '02' + 'ab'.repeat(32),
    bapId: 's3JdX57uoLS6MQmYKf98BUMiSNf',
    postingAddress: '13XXTWWsTgwHZknqVMJ59Fcop49hxKToae',
    timestamp: 1_763_200_000_000,
    identitySignature: '30' + 'ab'.repeat(20),
    postingSignature: 'A'.repeat(88),
  };
  const g = globalThis as { chrome?: unknown };
  const realChrome = g.chrome;
  afterEach(() => {
    g.chrome = realChrome;
  });

  test('extension: handed to the service worker, never fetched from the panel', async () => {
    const messages: unknown[] = [];
    g.chrome = {
      runtime: {
        sendMessage: async (m: unknown) => (messages.push(m), { status: 200, body: { ok: true }, retryAfter: null }),
      },
    };
    let fetched = 0;
    const f = (async () => (fetched++, new Response('{}'))) as unknown as typeof fetch;
    const r = await postFeedAuthorBinding(body, f, 'worker');
    expect(r.outcome).toBe('ok');
    expect(fetched).toBe(0);
    expect(messages).toEqual([{ action: 'bwxFeedAuthorBinding', body }]);
  });

  test('web, iOS, Android: fetched directly, no message to a worker', async () => {
    const messages: unknown[] = [];
    g.chrome = { runtime: { sendMessage: async (m: unknown) => (messages.push(m), null) } };
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(u), new Response('{"ok":true}'))) as unknown as typeof fetch;
    expect((await postFeedAuthorBinding(body, f, 'direct')).outcome).toBe('ok');
    expect(urls).toEqual([FEED_AUTHOR_BINDING_API]);
    expect(messages).toEqual([]);
  });

  test('the build decides: the extension flag picks the worker', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./authorBinding.ts', import.meta.url), 'utf8');
    expect(src).toContain("transport: 'worker' | 'direct' = feedAuthorTransport(IS_EXTENSION)");
    expect(src).toContain("import { IS_EXTENSION } from '../extension';");
  });

  test('a worker that does not answer is a quiet retry, not an error', async () => {
    g.chrome = { runtime: { sendMessage: () => Promise.reject(new Error('Receiving end does not exist')) } };
    const r = await postFeedAuthorBinding(body, fetch, 'worker');
    expect(r.outcome).toBe('retry-later');
  });

  test('publish hands the signed script to linkAuthor: nothing after the broadcast runs outside its try', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./feedApi.ts', import.meta.url), 'utf8');
    expect(src).toContain('void linkAuthor(ctx, signed, isAuthoredPost(tags));');
    const link = src.slice(src.indexOf('const linkAuthor = async'));
    expect(link.indexOf('try {')).toBeLessThan(link.indexOf('aipAddressOf(signed)'));
    expect(src.split('aipAddressOf(').length - 1).toBe(1);
  });
});

// ── round 3 (final check, 15 Nov 2026) ──────────────────────────────────────

describe('only posts and replies make an account one that posts', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('which publishes are authored: the composer’s post and a reply; nothing else', () => {
    expect(isAuthoredPost(['app:bWallet', 'type:post'])).toBe(true);
    expect(isAuthoredPost(['app:bWallet', 'type:post', 'context:tx', 'contextValue:ab'])).toBe(true);
    for (const type of ['like', 'follow', 'repost', 'hide', 'tip', 'lock'])
      expect(isAuthoredPost(['app:bWallet', `type:${type}`, 'tx:ab'])).toBe(false);
    expect(isAuthoredPost([])).toBe(false);
  });

  test('a like-only account: nothing is sent after the like, and nothing on Feed open', async () => {
    const a = account();
    a.state.posts = 0;
    a.state.likes = 4;
    const h = harness();
    // What publish() does after a like: the post's address, but not `posted`.
    expect(await ensureFeedAuthorBinding(a.ctx, { posted: false, postingAddress: a.postingAddress() }, h.deps)).toBe(
      'not-posted',
    );
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('not-posted');
    expect(h.posted.size).toBe(0);
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
  });

  test('through publish(): a like, follow, branch or hide binds nothing and sets no flag; a post does', async () => {
    const m = new Map<string, string>();
    const realStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
    let requests = 0;
    globalThis.fetch = (async () => (requests++, new Response('{"ok":true}'))) as unknown as typeof fetch;
    // This is about the flag, not the name rule (round 4): keep the rule out of it, whatever other test files
    // have switched names to in this process.
    const gateWas = postNameGate.enabled;
    postNameGate.enabled = () => false;
    try {
      const a = account();
      a.state.posts = 0;
      const script = () => new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('x'));
      let identityAsks = 0;
      const get = a.wallet.getPublicKey;
      a.wallet.getPublicKey = (args) => (args.identityKey && identityAsks++, get(args));
      for (const tags of [
        ['app:bWallet', 'type:like', 'tx:ab'],
        ['app:bWallet', 'type:follow'],
        ['app:bWallet', 'type:repost', 'tx:ab'],
        ['app:bWallet', 'type:hide', 'tx:ab'],
      ]) {
        await publish(a.ctx, script(), 'Feed action', tags);
        await settle();
      }
      expect(identityAsks).toBe(4); // the check ran each time...
      expect(hasPostedFlag(a.identityAddress)).toBe(false); // ...and left no mark
      await publish(a.ctx, script(), 'Feed post', ['app:bWallet', 'type:post']);
      await settle();
      expect(hasPostedFlag(a.identityAddress)).toBe(true);
      // No paymail outside a build, so nothing is sent in either case: the flag is what this pins.
      expect(requests).toBe(0);
    } finally {
      postNameGate.enabled = gateWas;
      globalThis.localStorage = realStorage;
    }
  });

  test('a post that arrives while a Feed-open check is deciding "never posted" is still bound', async () => {
    // The final check's repro: Feed open's "has posted?" is still waiting when the first post lands.
    const a = account();
    a.state.posts = 0;
    const h = harness();
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => (release = r));
    h.deps.hasPosted = () => gate;
    const open = ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    const post = ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps);
    const second = ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps);
    release(false);
    expect(await open).toBe('not-posted');
    expect(await post).toBe('ok');
    expect(await second).toBe('ok');
    expect(h.posted.has(a.identityAddress)).toBe(true);
    expect(h.sent.length).toBe(1); // two posts joining the same check still make one request
    h.deps.hasPosted = async (_ctx, id) => h.posted.has(id);
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('already');
  });

  test('a like that joins such a check does inherit "never posted"', async () => {
    const a = account();
    a.state.posts = 0;
    const h = harness();
    let release!: (v: boolean) => void;
    h.deps.hasPosted = () => new Promise<boolean>((r) => (release = r));
    const open = ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    const like = ensureFeedAuthorBinding(a.ctx, { posted: false, postingAddress: a.postingAddress() }, h.deps);
    release(false);
    expect([await open, await like]).toEqual(['not-posted', 'not-posted']);
    expect(h.sent.length).toBe(0);
  });
});

describe('"linked to another name" has a way out', () => {
  test('after 30 days: one fresh attempt on the next Feed open or post, and not before', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'address_linked_to_another_name')];
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
    h.now += BLOCKED_RETRY_MS - 1;
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
    expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
      'blocked',
    );
    expect(h.sent.length).toBe(1);
    h.now += 2;
    // Still linked elsewhere: one request, a fresh claim, and blocked again for another 30 days.
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
    expect(h.sent.length).toBe(2);
    expect(h.sent[1].timestamp).toBe(h.now);
    expect(h.store.get(a.identityAddress)).toMatchObject({ status: 'blocked', at: h.now });
    expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
    expect(h.sent.length).toBe(2);
    expect(h.timers.length).toBe(0);
  });

  test('after 30 days, released meanwhile: linked', async () => {
    const a = account();
    const h = harness();
    h.answers = [answer(409, 'address_linked_to_another_name'), { status: 200, body: { ok: true } }];
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    h.now += BLOCKED_RETRY_MS;
    expect(await ensureFeedAuthorBinding(a.ctx, { posted: true, postingAddress: a.postingAddress() }, h.deps)).toBe(
      'ok',
    );
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
  });

  test('the name is re-signed: the note is cleared and the next trigger tries again', async () => {
    const m = new Map<string, string>();
    const realStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
    try {
      const a = account();
      const h = harness();
      // This device's own record, as the app keeps it.
      h.deps.read = readAuthorBinding;
      h.deps.write = writeAuthorBinding;
      h.answers = [answer(409, 'address_linked_to_another_name'), { status: 200, body: { ok: true } }];
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
      expect(readAuthorBinding(a.identityAddress)?.status).toBe('blocked');
      h.now += 60_000;
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('blocked');
      // names/accountName.ts calls this when the name sync signs the name's binding.
      authorNameSigned(a.identityAddress);
      expect(readAuthorBinding(a.identityAddress)).toBeNull();
      expect(await ensureFeedAuthorBinding(a.ctx, {}, h.deps)).toBe('ok');
      expect(h.sent.length).toBe(2);
      // A link that worked is not cleared by a later re-sign.
      authorNameSigned(a.identityAddress);
      expect(readAuthorBinding(a.identityAddress)?.status).toBe('ok');
    } finally {
      globalThis.localStorage = realStorage;
    }
  });
});

// ── round 4 (owner, 15 Nov 2026: link at unlock; a post needs a $name) ──────

describe('linked at unlock and on account switch', () => {
  /** One app-wide wallet context that follows the account in use. */
  const app = (first: ReturnType<typeof account>) => {
    const s = { current: first };
    const wallet = {
      getPublicKey: (a: never) => s.current.wallet.getPublicKey(a),
      createSignature: (a: never) => s.current.wallet.createSignature(a),
      listOutputs: (a: never) => s.current.wallet.listOutputs(a),
    };
    return { s, ctx: { wallet } as unknown as OneSatContext };
  };

  test('unlock with an account that has posted: one claim', async () => {
    const a = account();
    const h = harness();
    expect(linkAuthorAtUnlock(a.ctx, a.identityAddress, h.deps)).toBeUndefined(); // returns at once
    await settle();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].identityKey).toBe(a.identityKey);
    expect(h.store.get(a.identityAddress)?.status).toBe('ok');
    expect(h.timers.length).toBe(0);
  });

  test('unlock with an account that never posted: nothing', async () => {
    const a = account();
    a.state.posts = 0;
    a.state.likes = 3;
    const h = harness();
    linkAuthorAtUnlock(a.ctx, a.identityAddress, h.deps);
    await settle();
    expect(a.counts.createSignature).toBe(0);
    expect(h.sent.length).toBe(0);
    expect(h.timers.length).toBe(0);
  });

  test('unlock with an account already linked, an agent account, or one with no name: nothing', async () => {
    const a = account();
    const h = harness();
    await ensureFeedAuthorBinding(a.ctx, {}, h.deps);
    linkAuthorAtUnlock(a.ctx, a.identityAddress, h.deps);
    linkAuthorAtUnlock(a.ctx, a.identityAddress, h.deps);
    await settle();
    expect(h.sent.length).toBe(1);
    const agent = account();
    h.agents.add(agent.identityAddress);
    linkAuthorAtUnlock(agent.ctx, agent.identityAddress, h.deps);
    const nameless = account();
    const h2 = harness('');
    linkAuthorAtUnlock(nameless.ctx, nameless.identityAddress, h2.deps);
    await settle();
    expect(h.sent.length).toBe(1);
    expect(h2.sent.length).toBe(0);
    expect(agent.counts.createSignature + nameless.counts.createSignature).toBe(0);
  });

  test('a switch checks the new account only, even while the wallet is still the old account’s', async () => {
    const [a, b] = [account(), account()];
    const w = app(a);
    const h = harness();
    linkAuthorAtUnlock(w.ctx, a.identityAddress, h.deps);
    await settle();
    expect(h.sent.map((s) => s.identityKey)).toEqual([a.identityKey]);
    // The account in use is now B, but the wallet context has not followed yet.
    const aSigned = a.counts.createSignature;
    linkAuthorAtUnlock(w.ctx, b.identityAddress, h.deps);
    await settle();
    expect(h.sent.length).toBe(1);
    expect(a.counts.createSignature).toBe(aSigned); // nothing more signed as A
    expect(h.timers.map((t) => t.ms)).toEqual([UNLOCK_RECHECK_MS[0]]);
    // The context catches up; the recheck links B, and only B.
    w.s.current = b;
    h.timers[0].fn();
    await settle();
    expect(h.sent.map((s) => s.identityKey)).toEqual([a.identityKey, b.identityKey]);
    expect(h.store.get(b.identityAddress)?.status).toBe('ok');
    expect(h.timers.length).toBe(1);
  });

  test('a context that never follows: a few rechecks, then it stops; a lock drops them', async () => {
    const [a, b] = [account(), account()];
    const h = harness();
    linkAuthorAtUnlock(a.ctx, b.identityAddress, h.deps);
    await settle();
    for (let i = 0; i < UNLOCK_RECHECK_MS.length; i++) {
      h.timers[i].fn();
      await settle();
    }
    expect(h.timers.map((t) => t.ms)).toEqual(UNLOCK_RECHECK_MS);
    expect(h.sent.length).toBe(0);
    const h2 = harness();
    linkAuthorAtUnlock(a.ctx, b.identityAddress, h2.deps);
    await settle();
    resetAuthorBindingSession(); // what a lock does
    h2.timers[0].fn();
    await settle();
    expect(h2.timers.length).toBe(1);
  });

  test('never throws into unlock: a wallet that fails, a scheduler that fails', async () => {
    const h = harness();
    const dead = { wallet: { getPublicKey: () => Promise.reject(new Error('locked')) } } as unknown as OneSatContext;
    expect(() => linkAuthorAtUnlock(dead, '1x', h.deps)).not.toThrow();
    const sync = {
      wallet: {
        getPublicKey: () => {
          throw new Error('boom');
        },
      },
    } as unknown as OneSatContext;
    expect(() => linkAuthorAtUnlock(sync, '1x', h.deps)).not.toThrow();
    await settle();
    expect(h.sent.length).toBe(0);
  });

  test('NotifyEngine (mounted on every platform) runs it once unlocked and on account change, never while locked', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../notify/NotifyEngine.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain(
      'useEffect(() => { if (isLocked || !apiContext?.wallet || !identityAddress) return; linkAuthorAtUnlock(apiContext, identityAddress); }, [apiContext, isLocked, identityAddress]);',
    );
    // The extension, web, iOS and Android builds all mount NotifyEngine through the same App patch.
    const mobile = readFileSync(new URL('../../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(mobile).toContain('<Suspense fallback={null}><NotifyEngine /></Suspense>');
    expect(readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')).toContain(
      "import { MOBILE_DEFINES, MOBILE_SWAPS, mobileText } from './vite.config.mobile';",
    );
    // The Feed-open hook stays.
    const feed = readFileSync(new URL('./FeedPage.tsx', import.meta.url), 'utf8');
    expect(feed).toContain('if (!identity.loading) void ensureFeedAuthorBinding(apiContext);');
  });
});

describe('a post or a reply needs a $name', () => {
  const real = { ...postNameGate };
  const realFetch = globalThis.fetch;
  let paymail = '';
  beforeEach(() => {
    paymail = '';
    postNameGate.enabled = () => true;
    postNameGate.paymailFor = () => paymail;
    postNameGate.bare = (p) => p.replace(/@(bwalletx\.com|bmailx\.com|bwallet\.space)$/i, '');
    // The server's definite "no name" unless a test says otherwise (round 5: an empty cache asks the server once).
    postNameGate.lookup = async () => ({ state: 'none' });
    postNameGate.remember = (_id, p) => void (paymail = p);
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
  });
  afterEach(() => {
    Object.assign(postNameGate, real);
    globalThis.fetch = realFetch;
  });
  const script = () => new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
  const POST = ['app:bWallet', 'type:post'];
  const REPLY = ['app:bWallet', 'type:post', 'context:tx', `contextValue:${'ab'.repeat(32)}`];

  test('the test is the binding’s own: a paymail on one of our domains', () => {
    expect(needsNameToPost('')).toBe(true);
    expect(needsNameToPost('someone@handcash.io')).toBe(true);
    expect(needsNameToPost('peytonmoon69@bwalletx.com')).toBe(false);
    expect(needsNameToPost('peytonmoon69@bmailx.com')).toBe(false);
    expect(needsNameToPost('john.gmail@bwallet.space')).toBe(false);
    // A build with names switched off has nowhere to claim one, so it gates nothing.
    postNameGate.enabled = () => false;
    expect(needsNameToPost('')).toBe(false);
  });

  test('no name: a post and a reply are refused before anything is signed or built', async () => {
    const a = account();
    for (const tags of [POST, REPLY]) {
      const err = await publish(a.ctx, script(), 'Feed post', tags).catch((e) => e);
      expect(err).toBeInstanceOf(NameNeededError);
      expect(err.message).toBe(NAME_NEEDED_MESSAGE);
    }
    expect(NAME_NEEDED_MESSAGE).toMatch(/\$name/);
    expect(NAME_NEEDED_MESSAGE).toMatch(/Nothing was posted or paid/);
    expect(a.state.actions).toBe(0); // no transaction
    expect(a.counts.createSignature).toBe(0); // not even the post's signature
    expect(a.counts.listOutputs).toBe(0);
  });

  test('no name: a like, follow, branch, hide and tip still go out', async () => {
    const a = account();
    for (const type of ['like', 'follow', 'repost', 'hide', 'tip'])
      expect(await publish(a.ctx, script(), 'Feed action', ['app:bWallet', `type:${type}`, 'tx:ab'])).toBe(
        'ab'.repeat(32),
      );
    expect(a.state.actions).toBe(5);
    await settle();
  });

  test('with a name: posting works as before, whatever state the link is in', async () => {
    const a = account();
    paymail = 'peytonmoon69@bwalletx.com';
    // Whatever the link's server would say (down, refused, another name's), the gate lets a named account post.
    // (That the link itself can't stop a post is pinned above, in 'a post is never stopped by the binding'.)
    for (const answer of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      async () => new Response('{"code":"identity_signature_failed"}', { status: 401 }),
      async () => new Response('{"code":"address_linked_to_another_name"}', { status: 409 }),
    ]) {
      globalThis.fetch = answer as unknown as typeof fetch;
      resetAuthorBindingSession();
      expect(await publish(a.ctx, script(), 'Feed post', POST)).toBe('ab'.repeat(32));
      await settle();
    }
    expect(a.state.actions).toBe(3);
  });

  test('publish checks the name first, before the signature and the transaction', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./feedApi.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function publish('));
    const gate = body.indexOf('await assertNameForPost(ctx, tags, nameChecked);');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf('signWithIdentity('));
    expect(gate).toBeLessThan(body.indexOf('executeTrackedAction('));
  });

  test('the composer shows a line and a way to the name flow in place of Post; the tip sheet drops its reply', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./FeedPage.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('const needsName = needsNameToPost(paymail);');
    // In place of the Post button, not beside it.
    expect(src).toMatch(
      /\) : noName \? \( <div data-post-needs-name> .*?Get your \$name <\/button> <\/div> \) : \( <button onClick=\{\(\) => void send\(\)\}/,
    );
    expect(src).toContain(
      "{replyTo ? 'Choose your $name to reply.' : 'Choose your $name to post.'} It’s how people find you.",
    );
    // The existing claim flow, and the same theme tokens as the Post button it replaces.
    expect(src).toContain('{naming && <HandleFlow onClose={() => setNaming(false)} />}');
    expect(src).toMatch(
      /<button onClick=\{\(\) => setNaming\(true\)\} className="mt-2 w-full rounded-2xl py-3 text-sm font-bold" style=\{\{ background: GOLD, color: '#1a1300' \}\}/,
    );
    // send() can't be reached round the button (Enter, a stale handler).
    expect(src).toContain("setError(''); if (noName) return;");
    // A reply sent with a tip is a post of the tipper's own: not offered without a name; the tip is.
    expect(src).toContain('const tipNeedsName = needsNameToPost(myPaymail);');
    // No crypto talk in the new copy.
    expect(src.match(/data-post-needs-name>.*?<\/div>/)?.[0] ?? '').not.toMatch(/chain|BSV|BAP|key|sign/i);
  });
});

// ── round 5 (review of the name rule, 15 Nov 2026) ──────────────────────────

describe('the name rule stops unnamed accounts, never named ones', () => {
  const real = { ...postNameGate };
  const realFetch = globalThis.fetch;
  let cached = '';
  /** What the paymail server answers to the lookup. */
  let server: () => Response | Promise<Response> = () => new Response('{"error":"not-found"}', { status: 404 });
  let lookups = 0;
  beforeEach(() => {
    cached = '';
    lookups = 0;
    server = () => new Response('{"error":"not-found"}', { status: 404 });
    postNameGate.enabled = () => true;
    postNameGate.paymailFor = () => cached;
    postNameGate.bare = (p) => p.replace(/@(bwalletx\.com|bmailx\.com|bwallet\.space)$/i, '');
    // The real lookup reader (names/paymail.ts), over a stubbed network.
    postNameGate.lookup = (key) =>
      lookupPaymailStateAt(async () => (lookups++, server()), `https://pay.test/api/paymail/lookup?key=${key}`);
    postNameGate.remember = (_id, p) => void (cached = p);
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
  });
  afterEach(() => {
    Object.assign(postNameGate, real);
    globalThis.fetch = realFetch;
  });
  const script = () => new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
  const POST = ['app:bWallet', 'type:post'];
  const named = () => new Response('{"paymail":"peytonmoon69@bwalletx.com","alias":"peytonmoon69"}', { status: 200 });

  test('a cached name: no lookup, the post goes out', async () => {
    const a = account();
    cached = 'peytonmoon69@bwalletx.com';
    expect(await publish(a.ctx, script(), 'Feed post', POST)).toBe('ab'.repeat(32));
    expect(lookups).toBe(0);
    await settle();
  });

  test('empty cache, the server has the name: the post is allowed and the cache is restored', async () => {
    const a = account();
    server = named;
    expect(await publish(a.ctx, script(), 'Feed post', POST)).toBe('ab'.repeat(32));
    expect(lookups).toBe(1);
    expect(cached).toBe('peytonmoon69@bwalletx.com');
    await settle();
  });

  test('empty cache, the server’s definite no-name (404 not-found): refused, nothing signed or built', async () => {
    const a = account();
    await expect(publish(a.ctx, script(), 'Feed post', POST)).rejects.toBeInstanceOf(NameNeededError);
    expect(lookups).toBe(1);
    expect(a.state.actions).toBe(0);
    expect(a.counts.createSignature).toBe(0);
  });

  test('empty cache, the server can’t say (503, 429, 500, a stray 404, bad JSON, no network): the post is allowed', async () => {
    const a = account();
    const cannotSay: (() => Response | Promise<Response>)[] = [
      () => new Response('{"error":"paymail-not-configured"}', { status: 503 }),
      () => new Response('{"error":"rate-limited"}', { status: 429 }),
      () => new Response('{"error":"server-error"}', { status: 500 }),
      () => new Response('<html>Not Found</html>', { status: 404 }),
      () => new Response('not json', { status: 200 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    for (const answer of cannotSay) {
      server = answer;
      expect(await publish(a.ctx, script(), 'Feed post', POST)).toBe('ab'.repeat(32));
      expect(cached).toBe(''); // nothing invented
    }
    expect(a.state.actions).toBe(cannotSay.length);
    await settle();
  });

  describe('paid media before the post (the composer’s flow)', () => {
    /** The composer's inscribe step, recording what it was asked to pay for. */
    const inscriber = () => {
      const paid: string[] = [];
      return { paid, run: async () => (paid.push('video'), [{ outpoint: `${'cd'.repeat(32)}_0`, mime: 'video/mp4' }]) };
    };

    test('an unnamed account: the media is never inscribed and nothing is posted', async () => {
      const a = account();
      const ins = inscriber();
      let posted = 0;
      const err = await postAfterPaidSteps(a.ctx, ins.run, async () => (posted++, 'x')).catch((e) => e);
      expect(err).toBeInstanceOf(NameNeededError);
      expect(ins.paid).toEqual([]);
      expect(posted).toBe(0);
      expect(a.state.actions).toBe(0);
    });

    test('the name goes missing after the media is paid for: the post still goes out', async () => {
      const a = account();
      cached = 'peytonmoon69@bwalletx.com';
      const ins = inscriber();
      const txid = await postAfterPaidSteps(
        a.ctx,
        async () => {
          const refs = await ins.run();
          cached = ''; // a failed sync, a switch, a release: by now the cache says "no name"...
          server = () => new Response('{"error":"not-found"}', { status: 404 }); // ...and so does the server
          return refs;
        },
        (_refs, pass) => publish(a.ctx, script(), 'Feed post', POST, undefined, undefined, pass),
      );
      expect(txid).toBe('ab'.repeat(32));
      expect(ins.paid).toEqual(['video']);
      expect(a.state.actions).toBe(1);
      expect(lookups).toBe(0); // checked once, before paying; not again
      await settle();
    });

    test('the check uses the wallet that will sign: a context on an unnamed account is refused before paying', async () => {
      const b = account();
      const ins = inscriber();
      await expect(postAfterPaidSteps(b.ctx, ins.run, async () => 'x')).rejects.toBeInstanceOf(NameNeededError);
      expect(ins.paid).toEqual([]);
    });

    test('only a real pass skips publish’s own check', async () => {
      const a = account();
      const fake = { nameChecked: true } as never;
      expect(isNameChecked(fake)).toBe(false);
      await expect(publish(a.ctx, script(), 'Feed post', POST, undefined, undefined, fake)).rejects.toBeInstanceOf(
        NameNeededError,
      );
      cached = 'peytonmoon69@bwalletx.com';
      expect(isNameChecked(await assertNameToPost(a.ctx))).toBe(true);
    });
  });

  describe('a private-mint reveal is a public post', () => {
    const item = () => ({
      outpoint: `${'ef'.repeat(32)}:0`,
      kid: 'k',
      header: { mime: 'audio/mpeg', name: 'a.mp3', bytes: 3 },
      file: new Uint8Array([1, 2, 3]),
    });

    test('an unnamed account: refused before the inscription is paid for', async () => {
      const a = account();
      const err = await revealMedia(a.ctx, item() as never).catch((e) => e);
      expect(err).toBeInstanceOf(NameNeededError);
      expect(a.state.actions).toBe(0); // no inscription, no post
      expect(a.counts.createSignature).toBe(0);
    });

    test('a named account gets past the name check to the inscription', async () => {
      const a = account();
      cached = 'peytonmoon69@bwalletx.com';
      const err = await revealMedia(a.ctx, item() as never).catch((e) => e);
      expect(err).not.toBeInstanceOf(NameNeededError);
      expect(lookups).toBe(0);
    });

    test('reveals still don’t count as "posted" for linking', () => {
      expect(isAuthoredPost([`reveal:${'ef'.repeat(32)}:0`])).toBe(false);
    });
  });
});

describe('tip sheet: "Under their post" follows the name', () => {
  const post = { txid: 'ab'.repeat(32), author: { paymail: 'someone@bwalletx.com' } };
  const base = tipDestinations(post, () => true);

  test('off without a name, back once the name is known, other choices kept', () => {
    expect(base.reply).toEqual({ available: true, on: true });
    const unnamed = replyByName(base, base, true);
    expect(unnamed.reply).toEqual({ available: false, on: false });
    expect(unnamed.bmail).toEqual(base.bmail);
    const chosen = { ...unnamed, bmail: { available: true, on: false } };
    const namedNow = replyByName(chosen, base, false);
    expect(namedNow.reply).toEqual({ available: true, on: true });
    expect(namedNow.bmail).toEqual({ available: true, on: false });
    const off = { ...base, reply: { available: true, on: false } };
    expect(replyByName(off, base, false).reply).toEqual({ available: true, on: false });
    const none = { ...base, reply: { available: false, on: false } };
    expect(replyByName(none, none, false).reply).toEqual({ available: false, on: false });
  });

  test('the sheet recomputes it when the name state changes; an unnamed agent or pot gets a plain line, no button', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./FeedPage.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain(
      'useEffect(() => { setDests((d) => replyByName(d, tipDestinations(post), tipNeedsName)); }, [tipNeedsName, post]);',
    );
    const line = src.match(/\{noName && agentOrPot \? \((.*?)\) : noName \? \(/)?.[1] ?? '';
    expect(line).toContain('Agent accounts and pots without a $name can’t post to the Feed.');
    expect(line).not.toContain('<button');
    expect(src).toContain('const agentOrPot = isAgentAccount(composerIdentity);');
  });
});

// ── round 6 (final check, 15 Nov 2026) ──────────────────────────────────────

describe('one post per tap, one account per pass', () => {
  const real = { ...postNameGate };
  const realFetch = globalThis.fetch;
  let cached = new Map<string, string>();
  let answer: () => Promise<{ state: 'none' } | { state: 'unknown' } | { state: 'name'; paymail: string }>;
  beforeEach(() => {
    cached = new Map();
    answer = async () => ({ state: 'none' });
    postNameGate.enabled = () => true;
    postNameGate.paymailFor = (id) => cached.get(id) ?? '';
    postNameGate.bare = (p) => p.replace(/@bwalletx\.com$/i, '');
    postNameGate.lookup = () => answer();
    postNameGate.remember = (id, p) => void cached.set(id, p);
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
  });
  afterEach(() => {
    Object.assign(postNameGate, real);
    globalThis.fetch = realFetch;
  });
  const script = () => new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray('hello'));
  const POST = ['app:bWallet', 'type:post'];
  const name = (a: ReturnType<typeof account>) => cached.set(a.identityAddress, 'peytonmoon69@bwalletx.com');
  /** The composer's send(): the guard, the name check, the paid media, the post. */
  const composer = (a: ReturnType<typeof account>) => {
    const gate = { running: false };
    const calls = { inscribe: 0, publish: 0 };
    const send = () =>
      oneAtATime(gate, () =>
        postAfterPaidSteps(
          a.ctx,
          async () => (calls.inscribe++, [{ outpoint: `${'cd'.repeat(32)}_0`, mime: 'video/mp4' }]),
          (_refs, pass) => (calls.publish++, publish(a.ctx, script(), 'Feed post', POST, undefined, undefined, pass)),
        ),
      );
    return { gate, calls, send };
  };

  test('a double tap: the media is inscribed once and the post goes out once', async () => {
    const a = account();
    name(a);
    const c = composer(a);
    const [first, second] = [c.send(), c.send()]; // the same tick, before anything has been awaited
    expect(await second).toBeUndefined();
    expect(await first).toBe('ab'.repeat(32));
    expect(c.calls).toEqual({ inscribe: 1, publish: 1 });
    expect(a.state.actions).toBe(1);
    // The next tap, after it finished, is a new post.
    expect(await c.send()).toBe('ab'.repeat(32));
    expect(c.calls).toEqual({ inscribe: 2, publish: 2 });
    await settle();
  });

  test('a tap while the name is still being looked up is ignored too; a failed send frees the button', async () => {
    const a = account();
    let release!: (v: { state: 'unknown' }) => void;
    answer = () => new Promise((r) => (release = r));
    const c = composer(a);
    const first = c.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(await c.send()).toBeUndefined();
    release({ state: 'unknown' });
    expect(await first).toBe('ab'.repeat(32));
    expect(c.calls).toEqual({ inscribe: 1, publish: 1 });
    answer = async () => ({ state: 'none' });
    await expect(c.send()).rejects.toBeInstanceOf(NameNeededError);
    expect(c.gate.running).toBe(false);
    await settle();
  });

  test('a lookup that never answers: the post goes out after the timeout', async () => {
    const a = account();
    answer = () => new Promise(() => undefined);
    postNameGate.lookupTimeoutMs = 30;
    const started = Date.now();
    expect(await publish(a.ctx, script(), 'Feed post', POST)).toBe('ab'.repeat(32));
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(a.state.actions).toBe(1);
    await settle();
  });

  test('the live lookup itself is given 5 seconds, and its request is aborted then', async () => {
    expect(real.lookupTimeoutMs).toBe(5000);
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./authorBinding.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('fetch(u, { ...i, signal: AbortSignal.timeout(postNameGate.lookupTimeoutMs) })');
  });

  test('a pass is used up by its post: a second post with it is checked afresh', async () => {
    const a = account();
    name(a);
    const pass = await assertNameToPost(a.ctx);
    expect(await publish(a.ctx, script(), 'Feed post', POST, undefined, undefined, pass)).toBe('ab'.repeat(32));
    expect(isNameChecked(pass)).toBe(false);
    cached.clear(); // the name is gone; the server says so too
    await expect(publish(a.ctx, script(), 'Feed post', POST, undefined, undefined, pass)).rejects.toBeInstanceOf(
      NameNeededError,
    );
    expect(a.state.actions).toBe(1);
    await settle();
  });

  test('a pass for account A is not good for account B: the post is not sent as B, and the message is accurate', async () => {
    const [a, b] = [account(), account()];
    name(a);
    name(b); // even a named B: the post was written, and its media paid for, as A
    const pass = await assertNameToPost(a.ctx);
    const err = await publish(b.ctx, script(), 'Feed post', POST, undefined, undefined, pass).catch((e) => e);
    expect(err).toBeInstanceOf(AccountChangedError);
    expect(err.message).toBe(ACCOUNT_CHANGED_MESSAGE);
    expect(ACCOUNT_CHANGED_MESSAGE).toMatch(/account changed/i);
    expect(ACCOUNT_CHANGED_MESSAGE).toMatch(/not sent/);
    expect(ACCOUNT_CHANGED_MESSAGE).toMatch(/paid for and stays in your wallet/);
    expect(ACCOUNT_CHANGED_MESSAGE).not.toMatch(/Nothing was posted or paid/);
    expect(b.state.actions + a.state.actions).toBe(0);
    expect(b.counts.createSignature).toBe(0);
    // And that pass is spent: it can't be tried again as A either without a fresh check.
    expect(isNameChecked(pass)).toBe(false);
  });

  test('the whole flow with a switch after the media is paid for: inscribed once, not posted, told accurately', async () => {
    const [a, b] = [account(), account()];
    name(a);
    const s = { current: a };
    const ctx = {
      wallet: {
        getPublicKey: (x: never) => s.current.wallet.getPublicKey(x),
        createSignature: (x: never) => s.current.wallet.createSignature(x),
        listOutputs: (x: never) => s.current.wallet.listOutputs(x),
        createAction: () => s.current.wallet.createAction(),
      },
    } as unknown as OneSatContext;
    let inscribed = 0;
    const err = await postAfterPaidSteps(
      ctx,
      async () => {
        inscribed++;
        s.current = b;
        return [];
      },
      (_r, pass) => publish(ctx, script(), 'Feed post', POST, undefined, undefined, pass),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AccountChangedError);
    expect(inscribed).toBe(1);
    expect(a.state.actions + b.state.actions).toBe(0);
  });

  test('the composer: guarded from its first statement, busy before the first await, identity in the name effect', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./FeedPage.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('const send = () => oneAtATime(sending.current, async () => {');
    const body = src.slice(src.indexOf('const send = () => oneAtATime(sending.current, async () => {'));
    expect(body.indexOf("setBusy('Checking…');")).toBeGreaterThan(0);
    expect(body.indexOf("setBusy('Checking…');")).toBeLessThan(body.indexOf('await '));
    expect(body.slice(0, body.indexOf('return ( <Sheet'))).toContain("} finally { setBusy(''); }");
    expect(src).toContain('}, [needsName, apiContext, composerIdentity]);');
  });
});

describe('a batch reveal that stops on the name rule', () => {
  const item = (n: number) => ({
    outpoint: `${'ef'.repeat(32)}:${n}`,
    kid: `k${n}`,
    header: { mime: 'audio/mpeg', name: `${n}.mp3`, bytes: 3 },
    file: new Uint8Array([1, 2, 3]),
  });

  test('two revealed, then no name: says how many went out and what the rest need, never "nothing was posted or paid"', async () => {
    const a = account();
    let n = 0;
    const err = await revealMany(a.ctx, [item(0), item(1), item(2), item(3)] as never[], {
      reveal: async () => {
        if (++n > 2) throw new NameNeededError();
        return { postTxid: 'ab'.repeat(32) };
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RevealStoppedError);
    expect(err.done).toBe(2);
    expect(err.needsName).toBe(true);
    const text = revealStoppedMessage(err, 4);
    expect(text).toBe('2 of 4 revealed. The rest need a $name before they can be made public, and stay private.');
    expect(text).not.toMatch(/Nothing was posted or paid/);
  });

  test('any other stop keeps its own words', () => {
    const err = new RevealStoppedError(1, 3, new Error('Insufficient funds'));
    expect(err.needsName).toBe(false);
    expect(revealStoppedMessage(err, 3)).toBe('1 of 3 revealed. Stopped: Insufficient funds. The rest stay private.');
    expect(revealStoppedMessage(new Error('boom'), 3)).toBe('0 of 3 revealed. Stopped: boom. The rest stay private.');
  });

  test('the reveal sheet uses it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../private/PrivateVault.tsx', import.meta.url), 'utf8');
    expect(src).toContain('setError(revealStoppedMessage(e, ok.length));');
  });
});
