/**
 * P0, 20 Nov 2026: only a real "No" tap may answer ERR_PERMISSION_DENIED. Every refusal the wallet makes on its own
 * answers with its own code and a plain sentence (services/refusalCodes.ts), and the reason is logged. These fail on
 * test/5.2.59-1p, where each path below answered the site ERR_PERMISSION_DENIED (wallet.denyPermission /
 * userDeniedError).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUserDenied, USER_DENIED_CODE, withDenialCode } from './userDenied';
import { withPromptNotShownCode } from './promptWatchdog';
import {
  INTERNAL_REFUSAL_CODE,
  PAIRING_ENDED_CODE,
  PROMPT_STALE_CODE,
  PROMPT_STALE_MESSAGE,
  SEAL_NOT_COVERED_CODE,
  SITE_BLOCKED_CODE,
  SPEND_NOT_COVERED_CODE,
  WALLET_LOCKED_CODE,
  internalRefusal,
  pairingEndedError,
  promptStaleError,
  sealNotCoveredError,
  sheetBuildRefusal,
  siteBlockedError,
  spendNotCoveredError,
  walletLockedError,
  withRefusalCode,
} from './refusalCodes';
import { NO_PAYEES_REFUSAL, RECIPIENTS_REFUSAL } from './spendRecipients';
import { BLOCKED_SITE_REFUSAL } from './permissionBundle';
import { SEAL_BUSY_REFUSAL } from './sealPass';
import { rejectManagerRequest } from './promptWatchdog';

const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
const between = (from: string, to: string) => {
  const i = bg.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = bg.indexOf(to, i + from.length);
  expect(j).toBeGreaterThan(i);
  return bg.slice(i, j);
};

describe('each wallet refusal has its own code (bit-sign #774 list), never the denial', () => {
  const cases: [string, Error & { code: string }, string][] = [
    ['stale sheet', promptStaleError(), PROMPT_STALE_CODE],
    ['blocked site', siteBlockedError(), SITE_BLOCKED_CODE],
    ['pairing ended', pairingEndedError(), PAIRING_ENDED_CODE],
    ['password / check failed', walletLockedError(), WALLET_LOCKED_CODE],
    ['seal pass busy', sealNotCoveredError(), SEAL_NOT_COVERED_CODE],
    ['payees unreadable', spendNotCoveredError(), SPEND_NOT_COVERED_CODE],
    ['internal', internalRefusal('reserved basket'), INTERNAL_REFUSAL_CODE],
  ];
  for (const [name, err, code] of cases)
    test(name, () => {
      expect(err.code).toBe(code);
      expect(err.name).toBe(code);
      expect(err.message.length).toBeGreaterThan(10);
      expect(isUserDenied(err)).toBe(false);
      expect(isUserDenied(err.message)).toBe(false);
    });

  test('the stale message is the spec sentence', () => {
    expect(PROMPT_STALE_MESSAGE).toBe('The request changed while it was open. Try again.');
  });

  test('a sheet that cannot be built says why', () => {
    expect(sheetBuildRefusal(new Error(NO_PAYEES_REFUSAL)).code).toBe(SPEND_NOT_COVERED_CODE);
    expect(sheetBuildRefusal(new Error(RECIPIENTS_REFUSAL)).code).toBe(SPEND_NOT_COVERED_CODE);
    const other = sheetBuildRefusal(new Error('queue full'));
    expect(other.code).toBe(INTERNAL_REFUSAL_CODE);
    expect(other.message).toContain('queue full');
  });
});

describe('a reply that carries only the message gets its code back', () => {
  const reply = (error: string) => withPromptNotShownCode(withRefusalCode(withDenialCode({ success: false, error })));
  test.each([
    [PROMPT_STALE_MESSAGE, PROMPT_STALE_CODE],
    [BLOCKED_SITE_REFUSAL, SITE_BLOCKED_CODE],
    ['This pairing has ended', PAIRING_ENDED_CODE],
    [walletLockedError().message, WALLET_LOCKED_CODE],
    [SEAL_BUSY_REFUSAL, SEAL_NOT_COVERED_CODE],
    [NO_PAYEES_REFUSAL, SPEND_NOT_COVERED_CODE],
    [internalRefusal('x').message, INTERNAL_REFUSAL_CODE],
  ])('%s', (error, code) => {
    expect(reply(error)).toMatchObject({ success: false, error, code });
  });
  test('a real No is still ERR_PERMISSION_DENIED', () => {
    expect(reply('Permission denied.')).toMatchObject({ code: USER_DENIED_CODE });
  });
  test('an unrelated failure is left alone', () => {
    expect(reply('Insufficient funds')).toEqual({ success: false, error: 'Insufficient funds' });
  });
});

describe("the manager's own request is settled with our error, not the toolbox's denial", () => {
  test('rejectManagerRequest passes the coded error to the waiting call', async () => {
    const pending: unknown[] = [];
    const active = new Map([['r1', { pending: [{ reject: (e: unknown) => pending.push(e) }] }]]);
    let denied = false;
    await rejectManagerRequest(
      { activeRequests: active, denyPermission: async () => void (denied = true) },
      'r1',
      promptStaleError(),
    );
    expect(denied).toBe(false);
    expect((pending[0] as { code: string }).code).toBe(PROMPT_STALE_CODE);
  });
});

describe('background.ts routes every non-user refusal through its own code', () => {
  test('replies to sites add the refusal code', () => {
    expect(bg).toMatch(/withPromptNotShownCode\(withRefusalCode\(withDenialCode\(response\)\)\)/);
  });

  test('showPermissionPrompt: reserved, blocked and unbuildable sheets never use denyPermission', () => {
    const fn = between('const showPermissionPrompt = ', 'pendingPermissionRequests.set(request.requestID');
    // The one denyPermission left is the remembered No (the person's own earlier answer).
    expect(fn.split('denyPermission(').length - 1).toBe(1);
    expect(fn).toContain('reject(userDeniedError())');
    expect(fn).toContain('siteBlockedError()');
    expect(fn).toContain('sheetBuildRefusal(');
    expect(fn).toContain('internalRefusal(RESERVED_REFUSAL)');
    expect(fn).toContain('internalRefusal(RESERVED_LABEL_REFUSAL)');
    expect(fn).toContain('internalRefusal(RESERVED_BASKET_REFUSAL)');
  });

  test('refuseRequest logs one [bwx-req] line with the code and reason, and settles the manager with our error', () => {
    const fn = between('const refuseRequest = ', 'const showPermissionPrompt = ');
    expect(fn).toContain('[bwx-req] refused');
    expect(fn).toContain('reason=${err.message}');
    expect(fn).toContain('rejectManagerRequest(wallet, request.requestID, err)');
    expect(fn).not.toContain('denyPermission(');
  });

  test('a bundle answer: a stale sheet and an ended pairing have their own codes', () => {
    const fn = between('const processBundlePermissionResponse', 'let workFailed = false;');
    expect(fn).toContain('pairingEndedError()');
    expect(fn).toContain('promptStaleError()');
    expect(fn).not.toContain("new Error('This pairing has ended')");
    // A seal line refused because the sheet went stale is stale, not denied.
    expect(fn).toMatch(
      /isSealRequestId\(r\.requestID\)\)\s*return pending\.reject\(result\.stale \? promptStaleError\(\) : userDeniedError\(\)\)/,
    );
  });

  test('a single answer: ended pairing and a changed payee list have their own codes', () => {
    const fn = between('const processPermissionResponse = ', 'const processGroupedPermissionResponse');
    expect(fn).toContain('pairingEndedError()');
    expect(fn).toContain('promptStaleError()');
    expect(fn).not.toContain("new Error('This pairing has ended')");
  });

  test('a seal-protocol signature during an approved seal is ERR_SEAL_NOT_COVERED', () => {
    const fn = between('const processCWICreateSignature = ', 'sealPasses?.approve(sealSite, seal);');
    expect(fn).toContain('throw sealNotCoveredError()');
  });
});
