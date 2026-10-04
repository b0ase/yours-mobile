import { describe, expect, test } from 'bun:test';
import { decryptAgentKeyFile, encryptAgentKeyFile } from './agentKeyFile';

// Placeholder strings, not keys: the file format doesn't care what the secrets are.
const secrets = { payPk: 'pay-placeholder', ordPk: 'ord-placeholder', identityPk: 'id-placeholder' };

describe('agent key file', () => {
  test('round-trips with the passphrase, refuses the wrong one', async () => {
    const f = await encryptAgentKeyFile({ name: 'trader', identityAddress: '1Id' }, secrets, 'correct horse battery', 1000);
    expect(f.format).toBe('bwalletx.agentkey/1');
    expect(JSON.stringify(f)).not.toContain('placeholder');
    expect(await decryptAgentKeyFile(f, 'correct horse battery')).toEqual(secrets);
    await expect(decryptAgentKeyFile(f, 'wrong passphrase!')).rejects.toThrow('Wrong passphrase');
  });

  test('short passphrases are refused', async () => {
    await expect(encryptAgentKeyFile({ name: 'x', identityAddress: '1' }, secrets, 'short')).rejects.toThrow();
  });
});
