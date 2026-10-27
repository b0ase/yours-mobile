/**
 * One tap per paired sign-in (owner, 27 Oct 2026): the login signature always shows the one sheet, the identity key
 * and the matching chat-key proof ride with it, and every other call keeps its normal approval path.
 */
import { describe, expect, test } from 'bun:test';
import { BSM, Utils } from '@bsv/sdk';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import {
  BSM_FOLLOW_MS,
  closeConnectCardsFor,
  handlePairLoginCall,
  loginMessage,
  parseLoginRequest,
  watchConnectCard,
  type LoginAsk,
  type PairLoginDeps,
} from './pairLogin';

const ORIGIN = 'https://www.bchatx.com';
const NONCE = 'n0nce_abcdefghijk';
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const EXP = '2026-10-27T12:02:00.000Z';
const login = (over: Record<string, unknown> = {}, text = loginMessage(ORIGIN, NONCE, EXP)) => ({
  protocolID: [2, 'bwallet sign in'],
  keyID: NONCE,
  counterparty: 'anyone',
  data: Utils.toArray(text, 'utf8'),
  ...over,
});

const deps = (answers: boolean[] = [true]) => {
  const asks: LoginAsk[] = [];
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const signedIn: string[] = [];
  const d: PairLoginDeps = {
    wallet: {
      createSignature: async (a: never) => (calls.push({ fn: 'createSignature', args: a }), { signature: [1, 2, 3] }),
      getPublicKey: async (a: never) => (calls.push({ fn: 'getPublicKey', args: a }), { publicKey: '02ab' }),
    },
    handle: () => 'b0asex',
    proven: true,
    ask: async (a) => (asks.push(a), answers.shift() ?? false),
    onSignedIn: (o) => signedIn.push(o),
  };
  return { d, asks, calls, signedIn };
};

describe('login signature', () => {
  test('always shows the sheet, every time (never remembered)', async () => {
    const { d, asks, calls } = deps([true, true, true]);
    for (let i = 0; i < 3; i++) {
      const r = await handlePairLoginCall('CH1', ORIGIN, 'createSignature', login(), d, NOW);
      expect(r).toEqual({ result: { signature: [1, 2, 3] } });
    }
    expect(asks).toEqual(Array(3).fill({ host: 'www.bchatx.com', handle: '$b0asex', proven: true }));
    expect(calls.filter((c) => c.fn === 'createSignature')).toHaveLength(3);
  });

  test('Decline signs nothing and answers the standard denial', async () => {
    const { d, calls } = deps([false]);
    const r = await handlePairLoginCall('CH2', ORIGIN, 'createSignature', login(), d, NOW);
    expect(r).toEqual({ error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission denied.' } });
    expect(calls).toHaveLength(0);
  });

  test('a successful sign-in closes other Connect cards for that site', async () => {
    const { d, signedIn } = deps();
    let closed = 0;
    let other = 0;
    watchConnectCard(ORIGIN, () => closed++);
    const stopOther = watchConnectCard('https://other.example', () => other++);
    d.onSignedIn = closeConnectCardsFor;
    await handlePairLoginCall('CH3', ORIGIN, 'createSignature', login(), d, NOW);
    expect(closed).toBe(1);
    expect(other).toBe(0);
    stopOther();
    expect(signedIn).toEqual([]);
  });

  test('anything under the login protocol that is not this site’s exact challenge is refused without a sheet', async () => {
    const bad = [
      login({}, loginMessage('https://evil.example', NONCE, EXP)), // another site's text
      login({}, loginMessage(ORIGIN, NONCE, EXP) + '\nPay 1 BSV'),
      login({}, 'Sign in to www.bchatx.com with bWallet'),
      login({ keyID: 'othernonce123' }), // keyID not the text's nonce
      login({ counterparty: 'self' }),
      login({ hashToDirectlySign: [1, 2, 3] }),
      login({}, loginMessage(ORIGIN, NONCE, '2026-10-27T11:59:00.000Z')), // expired
      login({}, loginMessage(ORIGIN, NONCE, '2026-10-28T12:00:00.000Z')), // too far ahead
    ];
    for (const p of bad) {
      const { d, asks, calls } = deps();
      const r = await handlePairLoginCall('CH4', ORIGIN, 'createSignature', p, d, NOW);
      expect(r && 'error' in r && r.error.code).toBe('REJECTED');
      expect(asks).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  test('parseLoginRequest only takes the byte-exact text for the paired origin', () => {
    expect(parseLoginRequest(login(), ORIGIN, NOW)).toEqual({
      origin: ORIGIN,
      host: 'www.bchatx.com',
      nonce: NONCE,
      message: loginMessage(ORIGIN, NONCE, EXP),
    });
    expect(typeof parseLoginRequest(login(), 'https://bchatx.com', NOW)).toBe('string');
  });
});

describe('non-login calls are unchanged', () => {
  test('other createSignature calls go the normal way (null = not handled here)', async () => {
    const others = [
      { protocolID: [2, 'bitsign handle claim'], keyID: '1', counterparty: 'anyone', data: [1, 2] },
      { protocolID: [2, 'bwallet sign inx'], keyID: NONCE, counterparty: 'anyone', data: [1] },
      { protocolID: [1, 'bwallet sign in'], keyID: NONCE, counterparty: 'anyone', data: [1] },
      // The chat-key proof without an approved sign-in before it.
      { protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', counterparty: 'self', hashToDirectlySign: [1] },
    ];
    for (const p of others) {
      const { d, asks, calls } = deps();
      expect(await handlePairLoginCall('CH5', ORIGIN, 'createSignature', p, d, NOW)).toBeNull();
      expect(asks).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
    const { d } = deps();
    for (const a of ['createAction', 'encrypt', 'isAuthenticated', 'waitForAuthentication'])
      expect(await handlePairLoginCall('CH5', ORIGIN, a, {}, d, NOW)).toBeNull();
    expect(
      await handlePairLoginCall('CH5', ORIGIN, 'getPublicKey', { identityKey: true, privileged: true }, d, NOW),
    ).toBeNull();
    expect(
      await handlePairLoginCall('CH5', ORIGIN, 'getPublicKey', { protocolID: [2, 'x'], keyID: '1' }, d, NOW),
    ).toBeNull();
  });

  test('locked: identity key falls through to the normal path', async () => {
    const { d } = deps();
    d.wallet = undefined;
    expect(await handlePairLoginCall('CH6', ORIGIN, 'getPublicKey', { identityKey: true }, d, NOW)).toBeNull();
  });
});

describe('what rides with the one sheet', () => {
  test('identity key for a Connected pairing: no sheet', async () => {
    const { d, asks } = deps();
    expect(await handlePairLoginCall('CH7', ORIGIN, 'getPublicKey', { identityKey: true }, d, NOW)).toEqual({
      result: { publicKey: '02ab' },
    });
    expect(asks).toHaveLength(0);
  });

  test('the chat-key proof over the approved text: no sheet, once, and only that hash', async () => {
    const { d, asks, calls } = deps();
    await handlePairLoginCall('CH8', ORIGIN, 'createSignature', login(), d, NOW);
    const text = loginMessage(ORIGIN, NONCE, EXP);
    const bsm = (h: number[]) => ({
      protocolID: MESSAGE_SIGNING_PROTOCOL,
      keyID: 'identity',
      counterparty: 'self',
      hashToDirectlySign: h,
    });
    const right = Array.from(BSM.magicHash(Utils.toArray(text, 'utf8')));
    const wrong = Array.from(BSM.magicHash(Utils.toArray('something else', 'utf8')));
    expect(await handlePairLoginCall('CH8', ORIGIN, 'createSignature', bsm(wrong), d, NOW)).toBeNull();
    expect(await handlePairLoginCall('OTHER', ORIGIN, 'createSignature', bsm(right), d, NOW)).toBeNull();
    expect(await handlePairLoginCall('CH8', ORIGIN, 'createSignature', bsm(right), d, NOW + 1)).not.toBeNull();
    expect(await handlePairLoginCall('CH8', ORIGIN, 'createSignature', bsm(right), d, NOW + 2)).toBeNull(); // once
    const key = { protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', forSelf: true };
    expect(await handlePairLoginCall('CH8', ORIGIN, 'getPublicKey', key, d, NOW + 3)).toEqual({
      result: { publicKey: '02ab' },
    });
    expect(await handlePairLoginCall('CH8', ORIGIN, 'getPublicKey', key, d, NOW + 4)).toBeNull();
    expect(asks).toHaveLength(1);
    expect(calls.map((c) => c.fn)).toEqual(['createSignature', 'createSignature', 'getPublicKey']);
  });

  test('the chat-key proof after the window needs its own approval', async () => {
    const { d } = deps();
    await handlePairLoginCall('CH9', ORIGIN, 'createSignature', login(), d, NOW);
    const h = Array.from(BSM.magicHash(Utils.toArray(loginMessage(ORIGIN, NONCE, EXP), 'utf8')));
    const p = { protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', counterparty: 'self', hashToDirectlySign: h };
    expect(await handlePairLoginCall('CH9', ORIGIN, 'createSignature', p, d, NOW + BSM_FOLLOW_MS + 1)).toBeNull();
  });
});
