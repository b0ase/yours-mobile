import { describe, expect, test } from 'bun:test';
import * as bip39 from 'bip39';
import { askBMessage, errorReportText, redactSecrets } from './errorReport';

const PHRASE12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const PHRASE24 = bip39.generateMnemonic(256);
const WIF = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ';
const HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('redactSecrets', () => {
  test('hides a 12-word recovery phrase, even with numbering and capitals', () => {
    const out = redactSecrets(`Invalid Mnemonic! input: ${PHRASE12}`);
    expect(out).not.toContain('abandon');
    expect(out).not.toContain('accident');
    expect(out).toContain('[recovery words hidden]');
    expect(redactSecrets(PHRASE12.toUpperCase())).not.toContain('ABANDON');
  });
  test('hides a 24-word phrase', () => {
    const out = redactSecrets(`restore failed for ${PHRASE24}`);
    for (const w of PHRASE24.split(' ').slice(0, 5)) expect(out.split(/\s+/)).not.toContain(w);
  });
  test('hides WIF keys and 64-hex secrets', () => {
    expect(redactSecrets(`bad key ${WIF}`)).not.toContain(WIF);
    expect(redactSecrets(`priv ${HEX}`)).not.toContain(HEX);
  });
  test('hides labelled passwords and seeds', () => {
    const out = redactSecrets('password: hunter2hunter2 and seed=foo');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('foo');
  });
  test('hides balances and amounts', () => {
    const out = redactSecrets('Insufficient funds: balance is 12.3456 BSV, need 50000 sats');
    expect(out).not.toContain('12.3456');
    expect(out).not.toContain('50000');
  });
  test('keeps an ordinary error readable', () => {
    expect(redactSecrets("That's not your bWalletX password.")).toBe("That's not your bWalletX password.");
    expect(redactSecrets('Broadcast failed: txn-mempool-conflict')).toBe('Broadcast failed: txn-mempool-conflict');
  });
});

describe('askBMessage / errorReportText', () => {
  const ctx = { screen: 'Add account', version: '5.1.90', edition: 'bWalletX' };
  test('carries the error, screen, version and edition', () => {
    const m = askBMessage('Broadcast failed', ctx);
    expect(m).toContain('Broadcast failed');
    expect(m).toContain('Add account');
    expect(m).toContain('5.1.90');
    expect(m).toContain('bWalletX');
  });
  test('never carries secrets', () => {
    const m = askBMessage(`failed with ${PHRASE12} ${WIF}`, ctx);
    expect(m).not.toContain('abandon');
    expect(m).not.toContain(WIF);
    expect(errorReportText(`password: secret123`, ctx)).not.toContain('secret123');
  });
});
