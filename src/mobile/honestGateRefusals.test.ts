/**
 * P0, 20 Nov 2026: the phone's own refusals carry their own codes. The password fallback used to answer the standard
 * denial (ERR_PERMISSION_DENIED) for a wrong password or a prompt that could not run; only its Cancel button is the
 * person's No. And the bApp frame / paired relay used to flatten every other code to 1 / REJECTED, so a site could
 * not tell a stale sheet from a failure.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSiteGate, type AuthResult } from './siteGate';
import { toXdmResponse } from './bappFrame/frameBridge';
import { USER_DENIED_CODE } from '../services/userDenied';
import {
  PROMPT_STALE_CODE,
  REFUSAL_CODES,
  WALLET_LOCKED_CODE,
  promptStaleError,
  siteBlockedError,
} from '../services/refusalCodes';

const SITE = 'https://bitsign.network';
const gateWith = (auth: () => Promise<AuthResult>, pw: Parameters<typeof createSiteGate>[0]['passwordAuth']) =>
  createSiteGate({ enabled: () => true, auth, passwordAuth: pw });
const unavailable = async (): Promise<AuthResult> => ({ status: 'unavailable' });

describe('the password fallback', () => {
  test("Cancel is the person's No: ERR_PERMISSION_DENIED", async () => {
    await expect(gateWith(unavailable, async () => 'cancelled').check(SITE, 'createSignature')).rejects.toMatchObject({
      code: USER_DENIED_CODE,
    });
  });

  test('too many wrong passwords: ERR_WALLET_LOCKED, not a denial', async () => {
    await expect(gateWith(unavailable, async () => 'locked').check(SITE, 'createAction')).rejects.toMatchObject({
      code: WALLET_LOCKED_CODE,
    });
  });

  test('a password prompt that fails: ERR_WALLET_LOCKED, not a denial', async () => {
    await expect(
      gateWith(unavailable, () => Promise.reject(new Error('no document'))).check(SITE, 'createSignature'),
    ).rejects.toMatchObject({ code: WALLET_LOCKED_CODE });
  });

  test('the right password passes', async () => {
    expect(await gateWith(unavailable, async () => 'ok').check(SITE, 'createSignature')).toBe('password');
  });

  test('Cancel on Face ID is still the standard denial', async () => {
    await expect(
      gateWith(
        async () => ({ status: 'cancelled' }),
        async () => 'ok',
      ).check(SITE, 'createSignature'),
    ).rejects.toMatchObject({ code: USER_DENIED_CODE });
  });

  test('askWalletPassword tells Cancel from too many tries (siteGatePassword.ts)', () => {
    const src = readFileSync(join(import.meta.dir, 'siteGatePassword.ts'), 'utf8');
    expect(src).toContain("cancel.onclick = () => close('cancelled')");
    expect(src).toContain("if (tries >= 5) close('locked')");
    expect(readFileSync(join(import.meta.dir, 'siteGateNative.ts'), 'utf8')).toContain(
      'passwordAuth: askWalletPasswordResult',
    );
  });
});

describe('transports keep the refusal codes', () => {
  test('bApp frame: each refusal code goes to the page as is, with its message', () => {
    for (const err of [promptStaleError(), siteBlockedError()])
      expect(toXdmResponse('9', { success: false, error: err.message, code: err.code })).toMatchObject({
        status: 'error',
        code: err.code,
        description: err.message,
      });
  });

  test('bApp frame: the stale code is never turned into the denial', () => {
    const r = toXdmResponse('9', {
      success: false,
      error: 'The request changed while it was open. Try again.',
      code: PROMPT_STALE_CODE,
    });
    expect(r.code).toBe(PROMPT_STALE_CODE);
  });

  test('paired relay passes refusal codes through (pair/sessions.ts)', () => {
    const src = readFileSync(join(import.meta.dir, 'pair', 'sessions.ts'), 'utf8');
    expect(src).toContain('isRefusalCode(r?.code)');
    expect(REFUSAL_CODES).toContain(PROMPT_STALE_CODE);
  });
});
