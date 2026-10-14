import { describe, expect, test } from 'bun:test';
import { BigNumber, BSM, HD, Mnemonic, P2PKH, PrivateKey, Signature, Transaction, Utils } from '@bsv/sdk';
import user220501 from './fixtures/twetch-user-220501.json';
import replyFixture from './fixtures/twetch-reply-tx-d53c3cd9.json';
import {
  apiSigMessage,
  bsmBase64,
  candidateKeys,
  keyForLink,
  linkLabel,
  notAcceptedNote,
  registerBody,
  scriptTexts,
  twetchHeaders,
  twetchImageScript,
  twetchPostScript,
  verifyAip,
  verifyTwetchAccount,
  type RegisterResult,
  type TwetchClient,
  type TwetchUser,
} from './twetch';
import { encrypt } from '../../utils/crypto';

// Generated keys only: never a real Twetch key.
const freshMnemonic = () => Mnemonic.fromRandom(128).toString();
const PARENT = 'fb99ac003431cfdb6fe143d6bc9d22190c91c5319b3459f2299535a30bba05c3';

/** Fixture-backed Twetch: maps pubkey → id and id → user. */
const fakeClient = (users: TwetchUser[], byPub: Record<string, number> = {}): TwetchClient & { posts: string[] } => {
  const posts: string[] = [];
  return {
    posts,
    userIdByPubkey: async (pub) => byPub[pub] ?? users.find((u) => u.publicKey === pub)?.id ?? null,
    user: async (id) => users.find((u) => u.id === id) ?? null,
    registerPost: async (_h, body): Promise<RegisterResult> => {
      posts.push(body);
      return { ok: true, id: 7400001 };
    },
  };
};

describe('Twetch API request signature', () => {
  test('signs "METHOD\\npath\\nuserId\\nts\\nbody" exactly as twetch.mjs', () => {
    expect(apiSigMessage('POST', '/v1/posts', 220501, 1700000000000, '{"a":1}')).toBe(
      'POST\n/v1/posts\n220501\n1700000000000\n{"a":1}',
    );
    // twetch.mjs signs the path without a query string and an empty body for GETs.
    expect(apiSigMessage('get', '/v1/users/1/posts?limit=5', 1, 2, '')).toBe('GET\n/v1/users/1/posts\n1\n2\n');
  });

  test('headers: user, ts and a BSM base64 signature that recovers to the key', () => {
    const key = PrivateKey.fromRandom();
    const body = '{"x":1}';
    const h = twetchHeaders(key, 42, 'POST', '/v1/posts', body, 1234);
    expect(h['x-twetch-user']).toBe('42');
    expect(h['x-twetch-ts']).toBe('1234');
    expect(h['content-type']).toBe('application/json');
    const msg = Utils.toArray(apiSigMessage('POST', '/v1/posts', 42, 1234, body), 'utf8');
    const sig = Utils.toArray(h['x-twetch-sig'], 'base64');
    expect(sig.length).toBe(65);
    const pub = Signature.fromCompact(sig).RecoverPublicKey((sig[0] - 27) & 3, new BigNumber(BSM.magicHash(msg)));
    expect(pub.toString()).toBe(key.toPublicKey().toString());
    expect(BSM.verify(msg, Signature.fromCompact(sig), key.toPublicKey())).toBe(true);
  });

  test('bsmBase64 is deterministic for one key and message', () => {
    const key = PrivateKey.fromRandom();
    expect(bsmBase64(key, 'hello')).toBe(bsmBase64(key, 'hello'));
  });

  test('register body: userId, content, txHex, paidSats, replyPostId only for replies', () => {
    expect(JSON.parse(registerBody({ userId: 1, text: ' hi ', rawTx: 'ab', paidSats: 30 }))).toEqual({
      userId: 1,
      content: 'hi',
      txHex: 'ab',
      paidSats: 30,
    });
    expect(JSON.parse(registerBody({ userId: 1, text: 'hi', rawTx: 'ab', paidSats: 30, replyPostId: 9 }))).toEqual({
      userId: 1,
      content: 'hi',
      txHex: 'ab',
      paidSats: 30,
      replyPostId: 9,
    });
  });
});

describe('Twetch post tx structure', () => {
  const key = PrivateKey.fromRandom();
  const address = key.toPublicKey().toAddress();

  test('post: B text/markdown UTF-8 | MAP SET app twetch type post | AIP BITCOIN_ECDSA address base64-sig (twetch.mjs)', () => {
    const t = scriptTexts(twetchPostScript('  gm Twetch  ', key));
    expect(t.slice(0, 18)).toEqual([
      'OP_0',
      'OP_106',
      '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
      'gm Twetch',
      'text/markdown',
      'UTF-8',
      '|',
      '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
      'SET',
      'app',
      'twetch',
      'type',
      'post',
      '|',
      '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva',
      'BITCOIN_ECDSA',
      address,
      t[17],
    ]);
    expect(t.length).toBe(18);
    expect(Utils.toArray(t[17], 'base64').length).toBe(65); // base64 text signature, as Twetch indexes
  });

  test('the AIP signature verifies over the signed part', () => {
    expect(verifyAip(twetchPostScript('hello', key))).toBe(true);
    expect(verifyAip(twetchPostScript('hello', key, PARENT))).toBe(true);
  });

  test('reply: MAP reply <parent txid>, in the same place as a reply from Twetch’s own app', () => {
    const t = scriptTexts(twetchPostScript('yes', key, PARENT));
    const ours = t.slice(t.indexOf('SET'), t.indexOf('|', t.indexOf('SET')));
    const theirs = replyFixture.pushes.slice(replyFixture.pushes.indexOf('SET'), replyFixture.pushes.indexOf('ts'));
    expect(ours).toEqual(theirs);
  });

  test('image output: B <bytes> <mime>, no encoding or name', () => {
    const t = scriptTexts(twetchImageScript([0xff, 0xd8, 0xff, 0x00], 'image/jpeg'));
    expect(t).toEqual(['OP_0', 'OP_106', '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut', 'ffd8ff00', 'image/jpeg']);
  });

  test('refuses empty text and bad parent ids', () => {
    expect(() => twetchPostScript('  ', key)).toThrow();
    expect(() => twetchPostScript('x', key, 'nope')).toThrow();
  });
});

describe('Twetch key verification at link time', () => {
  test('candidate keys come from the seed (m/0/0 first) plus the account’s own WIFs', () => {
    const m = freshMnemonic();
    const c = candidateKeys(m);
    expect(c[0].path).toBe('m/0/0');
    const want = HD.fromSeed(Mnemonic.fromString(m).toSeed()).derive('m/0/0').privKey.toPublicKey().toString();
    expect(c[0].key.toPublicKey().toString()).toBe(want);
    const wif = PrivateKey.fromRandom();
    expect(candidateKeys(null, { walletWif: wif.toWif() }).map((k) => k.path)).toEqual(['wallet']);
  });

  test('match: Twetch maps the derived key to a user whose signing key is that key', async () => {
    const m = freshMnemonic();
    const k = candidateKeys(m).find((c) => c.path === 'm/0/1')!.key;
    const pub = k.toPublicKey().toString();
    const res = await verifyTwetchAccount(fakeClient([{ id: 99, name: 'alice', publicKey: pub }]), candidateKeys(m), 5);
    expect(res).toEqual({ ok: true, link: { userId: 99, pubkey: pub, path: 'm/0/1', name: 'alice', linkedAt: 5 } });
    if (res.ok) {
      expect(linkLabel(res.link)).toBe('Twetch: linked as @alice (#99)');
      expect(keyForLink(res.link, m).toPublicKey().toString()).toBe(pub);
    }
  });

  test('mismatch: the key maps to a user whose current signing key is different (e.g. rotated)', async () => {
    const m = freshMnemonic();
    const pub = candidateKeys(m)[0].key.toPublicKey().toString();
    const res = await verifyTwetchAccount(
      fakeClient([{ id: user220501.id, name: user220501.name, publicKey: user220501.publicKey }], { [pub]: 220501 }),
      candidateKeys(m),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('mismatch');
  });

  test('not found: no candidate key is a Twetch user', async () => {
    const res = await verifyTwetchAccount(fakeClient([]), candidateKeys(freshMnemonic()));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-found');
  });

  test('a link whose key no longer derives is refused', () => {
    expect(() => keyForLink({ path: 'm/0/0', pubkey: user220501.publicKey }, freshMnemonic())).toThrow();
  });

  test('the not-accepted note keeps the post', () => {
    expect(notAcceptedNote('signature expired')).toBe("Posted on chain; Twetch didn't accept it (signature expired)");
  });
});

describe('postToTwetch (fixtures, no network)', () => {
  test('pays from the Twetch address, broadcasts, then registers with signed headers; never loses the post', async () => {
    const { postToTwetch } = await import('./twetchPost');
    const m = freshMnemonic();
    const key = candidateKeys(m)[0].key;
    const pub = key.toPublicKey().toString();
    const from = key.toPublicKey().toAddress();
    const passKey = 'ab'.repeat(32);
    const accounts = {
      ID1: {
        addresses: { identityAddress: 'ID1' },
        encryptedKeys: await encrypt(JSON.stringify({ mnemonic: m }), passKey),
        twetch: { userId: 77, pubkey: pub, path: 'm/0/0', name: 'bob', linkedAt: 1 },
      },
    };
    const store = {
      getAllAccounts: () => Object.values(accounts),
      getPassKey: async () => passKey,
      getCustomFeeRate: () => 100,
    } as unknown as Parameters<typeof postToTwetch>[0];
    // A funding tx paying the Twetch address.
    const src = new Transaction();
    src.addOutput({ lockingScript: new P2PKH().lock(from), satoshis: 5000 });
    const broadcasts: string[] = [];
    const headers: Record<string, string>[] = [];
    const client = {
      ...fakeClient([]),
      registerPost: async (h: Record<string, string>, body: string): Promise<RegisterResult> => {
        headers.push(h);
        expect(JSON.parse(body)).toMatchObject({ userId: 77, content: 'gm', replyPostId: 123 });
        return { ok: true, id: 555 };
      },
    };
    const chain = {
      coins: async () => [{ txid: src.id('hex'), vout: 0, sats: 5000, rawTx: src.toBinary() }],
      broadcast: async (raw: string) => void broadcasts.push(raw),
    };
    const r = await postToTwetch(
      store,
      'ID1',
      { text: 'gm', reply: { txid: PARENT, twetchId: 123 } },
      { client, chain },
    );
    expect(r).toMatchObject({ status: 'posted', twetchId: 555 });
    const tx = Transaction.fromHex(broadcasts[0]);
    // Parsed back from hex, everything after OP_RETURN is one data chunk: check the bytes.
    const out0 = tx.outputs[0].lockingScript.toHex();
    // 'reply' then a 64-byte push (0x40 = '@') of the parent txid.
    expect(out0).toContain(Utils.toHex(Utils.toArray(`reply@${PARENT}`, 'utf8')));
    expect(out0).toContain(Utils.toHex(Utils.toArray('twetch', 'utf8')));
    expect(tx.outputs.at(-1)!.lockingScript.toHex()).toBe(new P2PKH().lock(from).toHex()); // change to the Twetch address
    expect(headers[0]['x-twetch-user']).toBe('77');

    // Twetch says no → the tx is still out; a note, not an error.
    const refusing = {
      ...client,
      registerPost: async (): Promise<RegisterResult> => ({ ok: false, status: 401, reason: 'bad sig' }),
    };
    const r2 = await postToTwetch(store, 'ID1', { text: 'again' }, { client: refusing, chain });
    expect(r2).toMatchObject({ status: 'not-accepted', note: "Posted on chain; Twetch didn't accept it (bad sig)" });

    // No coins at the Twetch address → nothing broadcast, a note.
    const broke = { coins: async () => [], broadcast: chain.broadcast };
    const r3 = await postToTwetch(store, 'ID1', { text: 'x' }, { client, chain: broke });
    expect(r3.status).toBe('failed');
  });
});
