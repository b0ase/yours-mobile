import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { CreateActionDedupe, createActionKey } from './createActionDedupe';
import {
  PROMPT_EXPIRED_CODE,
  PROMPT_EXPIRED_MESSAGE,
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

describe('BRC-219: a sheet that is up never expires on a timer', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  const wd = readFileSync(new URL('./promptWatchdog.ts', import.meta.url), 'utf8');

  test('no wall-clock expiry on any sheet (permission, seal, manifest, counterparty)', () => {
    expect(/export const PROMPT_EXPIRY_MS/.test(wd)).toBe(false);
    expect(bg.includes('PROMPT_EXPIRY_MS')).toBe(false);
    expect(bg.includes('expireSpendRequest')).toBe(false);
  });

  test('ERR_PROMPT_EXPIRED is only sent when the bridge gave up while nothing was asking', () => {
    const reply = withPromptNotShownCode({ success: false, error: promptExpiredError().message });
    expect(reply).toMatchObject({ code: PROMPT_EXPIRED_CODE, error: PROMPT_EXPIRED_MESSAGE, status: 408 });
    expect((replyError(reply) as Error & { code?: string }).code).toBe(PROMPT_EXPIRED_CODE);
    // Exactly one place closes sheets with it: cancelSitePrompts, after siteStillAsking said no.
    expect(bg.split('promptExpiredError()').length - 1).toBe(1);
    expect(bg).toMatch(
      /if \(asking\) \{[\s\S]*?return \{ cancelled: 0, committed: false, asking: true \};[\s\S]*?closePrompts\(prompts, promptExpiredError\(\)\)/,
    );
  });
});

describe('BRC-219: a Retry joins, a different request never does', () => {
  const tb = 'tokenblaster.lol';

  test('a different request is a new key (options, labels, basket, lockTime, inputBEEF, description); key order does not matter', () => {
    const k = createActionKey(tb, pay);
    const variants: object[] = [
      { ...pay, options: { noSend: true } },
      { ...pay, options: { acceptDelayedBroadcast: false } },
      { ...pay, labels: ['npg arena'] },
      { ...pay, outputs: [{ ...pay.outputs[0], basket: 'game' }] },
      { ...pay, outputs: [{ ...pay.outputs[0], outputDescription: 'entry fee' }] },
      { ...pay, lockTime: 900_000 },
      { ...pay, inputBEEF: [1, 2, 3] },
      { ...pay, description: 'NPG Arena (2)' },
    ];
    for (const v of variants) expect(createActionKey(tb, v)).not.toBe(k);
    // ...while the same arguments in any key order are the same request (a Retry still joins).
    const x = {
      outputs: [{ satoshis: 2000, lockingScript: '76a914aa88ac' }],
      description: 'NPG Arena',
      options: { noSend: false },
    };
    const y = {
      options: { noSend: false },
      description: 'NPG Arena',
      outputs: [{ lockingScript: '76a914aa88ac', satoshis: 2000 }],
    };
    expect(createActionKey(tb, x)).toBe(createActionKey(tb, y));
  });

  test('two tabs of one site never share an answer', () => {
    expect(createActionKey(tb, pay, 'tab:1')).not.toBe(createActionKey(tb, pay, 'tab:2'));
    expect(createActionKey(tb, pay, 'tab:1')).toBe(createActionKey(tb, { ...pay }, 'tab:1'));
  });

  test('a different request arriving while the first waits runs on its own; its answer is its own', () => {
    const d = new CreateActionDedupe<{ txid: string }>();
    const got: string[] = [];
    const first = d.begin(createActionKey(tb, pay, 'tab:1'), (r) => got.push(`first ${r.txid}`));
    const other = d.begin(createActionKey(tb, { ...pay, options: { noSend: true } }, 'tab:1'), (r) =>
      got.push(`other ${r.txid}`),
    );
    expect(first).toBeDefined();
    expect(other).toBeDefined();
    other!({ txid: 'nosend' });
    first!({ txid: 'abc' });
    expect(got).toEqual(['other nosend', 'first abc']);
  });

  test('background keys site createActions by tab', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toContain("sender.tab?.id !== undefined ? `tab:${sender.tab.id}` : ''");
  });
});
