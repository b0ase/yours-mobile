import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { CreateActionDedupe, createActionKey } from './createActionDedupe';
import {
  PROMPT_EXPIRED_CODE,
  PROMPT_EXPIRED_MESSAGE,
  PROMPT_EXPIRY_MS,
  promptExpiredError,
  withPromptNotShownCode,
} from './promptWatchdog';
import { replyError } from './userDenied';

const pay = { description: 'NPG Arena', outputs: [{ lockingScript: '76a914aa88ac', satoshis: 2000 }] };

describe('createAction dedupe (a site Retry while the first call runs)', () => {
  test('same site + same payment = same key; any difference = new key', () => {
    const k = createActionKey('tokenblaster.lol', pay);
    expect(createActionKey('tokenblaster.lol', { ...pay })).toBe(k);
    expect(createActionKey('other.site', pay)).not.toBe(k);
    expect(createActionKey('tokenblaster.lol', { ...pay, reference: 'x' })).not.toBe(k);
    expect(
      createActionKey('tokenblaster.lol', { ...pay, outputs: [{ lockingScript: '76a914aa88ac', satoshis: 2001 }] }),
    ).not.toBe(k);
  });

  test('the retry joins: the work runs once and both callers get the same answer', () => {
    const d = new CreateActionDedupe<{ txid: string }>();
    const key = createActionKey('tokenblaster.lol', pay);
    const got: string[] = [];
    let runs = 0;
    const first = d.begin(key, (r) => got.push(`first ${r.txid}`));
    if (first) runs++;
    const retry = d.begin(key, (r) => got.push(`retry ${r.txid}`));
    if (retry) runs++;
    expect(runs).toBe(1);
    expect(retry).toBeUndefined();
    first!({ txid: 'abc' });
    first!({ txid: 'again' }); // answered once only
    expect(got).toEqual(['first abc', 'retry abc']);
    expect(d.running(key)).toBe(false);
    // After the answer a new call is a new call (the repeat guard judges it as before).
    expect(d.begin(key, () => undefined)).toBeDefined();
  });

  test('background routes site createActions through it', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toContain('const respond = createActionDedupe.begin(key, sendResponse);');
    expect(bg).toContain('runDappRequest(processCWICreateAction(message, respond).finally(donePay));');
  });
});

describe('payment sheets expire unanswered', () => {
  test('about 60 s, with a clear code the page sees', () => {
    expect(PROMPT_EXPIRY_MS).toBe(60_000);
    const reply = withPromptNotShownCode({ success: false, error: promptExpiredError().message });
    expect(reply).toMatchObject({ code: PROMPT_EXPIRED_CODE, error: PROMPT_EXPIRED_MESSAGE, status: 408 });
    expect((replyError(reply) as Error & { code?: string }).code).toBe(PROMPT_EXPIRED_CODE);
  });

  test('every sheet still pending (not approved or signed) expires, by rejecting the request', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    // All permission sheets, the manifest and counterparty sheets (docs/BIOMETRIC-GATE.md, 29 Oct 2026).
    expect(bg).toContain("expireSpendRequest(request.requestID, 'groupedPermission');");
    expect(bg).toContain("expireSpendRequest(request.requestID, 'counterpartyPermission');");
    expect(bg).toContain('if (pendingPermissionRequests.has(id)) expireSpendRequest(id);');
    expect(bg).toContain('failUnshownPrompt(p, promptExpiredError());');
  });
});
