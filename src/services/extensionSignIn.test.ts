/**
 * Extension sign-in (owner, 28 Oct 2026): bChatX's signBsm after a sign-in was refused as a reserved protocol.
 * The BSM chat-key proof is answered only after the approved sign-in for this exact origin, once, over that text.
 */
import { describe, expect, test } from 'bun:test';
import { BSM, Utils } from '@bsv/sdk';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { loginMessage } from '../mobile/pair/pairLogin';
import { extensionSignInStep } from './extensionSignIn';
import { refusalCode, reservedProtocolRefusal, RESERVED_PROTOCOL_CODE } from './reservedProtocols';

const ORIGIN = 'https://www.bchatx.com';
const NONCE = 'n0nce_abcdefghijk';
const NOW = Date.now();
const EXP = new Date(NOW + 120_000).toISOString();
const TEXT = loginMessage(ORIGIN, NONCE, EXP);
const login = () => ({
  protocolID: [2, 'bwallet sign in'],
  keyID: NONCE,
  counterparty: 'anyone',
  data: Utils.toArray(TEXT, 'utf8'),
});
const bsm = (text = TEXT) => ({
  protocolID: MESSAGE_SIGNING_PROTOCOL,
  keyID: 'identity',
  counterparty: 'self',
  hashToDirectlySign: BSM.magicHash(Utils.toArray(text, 'utf8')),
});
const bsmKey = { protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', forSelf: true };

describe('extensionSignInStep', () => {
  test('no follow-up without an approved sign-in', () => {
    expect(extensionSignInStep('https://a.example', 'createSignature', bsm()).kind).toBe('none');
  });

  test('a sign-in for another origin earns nothing', () => {
    expect(extensionSignInStep('https://evil.example', 'createSignature', login()).kind).toBe('none');
  });

  test('approved sign-in, then exactly one BSM proof and one key, same origin only', async () => {
    const step = extensionSignInStep(ORIGIN, 'createSignature', login(), NOW);
    expect(step.kind).toBe('login');
    if (step.kind === 'login') step.approved();
    expect(extensionSignInStep('https://evil.example', 'createSignature', bsm(), NOW).kind).toBe('none');
    expect(extensionSignInStep(ORIGIN, 'createSignature', bsm('other text'), NOW).kind).toBe('none');
    const sign = extensionSignInStep(ORIGIN, 'createSignature', bsm(), NOW);
    expect(sign.kind).toBe('bsm');
    const calls: unknown[] = [];
    const w = {
      createSignature: async (a: never) => (calls.push(a), { signature: [1] }),
      getPublicKey: async (a: never) => (calls.push(a), { publicKey: '02' }),
    };
    if (sign.kind === 'bsm') await sign.answer(w);
    expect(extensionSignInStep(ORIGIN, 'createSignature', bsm(), NOW).kind).toBe('none');
    const key = extensionSignInStep(ORIGIN, 'getPublicKey', bsmKey, NOW);
    expect(key.kind).toBe('bsm');
    if (key.kind === 'bsm') await key.answer(w);
    expect(extensionSignInStep(ORIGIN, 'getPublicKey', bsmKey, NOW).kind).toBe('none');
    expect(calls).toHaveLength(2);
  });
});

test('reserved refusal carries ERR_RESERVED_PROTOCOL', () => {
  const r = reservedProtocolRefusal('createSignature', bsm());
  expect(r).toContain('reserved for bWalletX itself');
  expect(refusalCode(r!)).toBe(RESERVED_PROTOCOL_CODE);
});
