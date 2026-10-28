import { expect, test } from 'bun:test';
import { refusalCode, reservedProtocolRefusal, RESERVED_PROTOCOL_CODE } from './reservedProtocols';

test('a site asking for the reserved message-signing key is refused with ERR_RESERVED_PROTOCOL', () => {
  const r = reservedProtocolRefusal('createSignature', {
    protocolID: [1, 'message signing'],
    keyID: 'identity',
    counterparty: 'self',
    hashToDirectlySign: [1, 2, 3],
  });
  expect(r).toContain('reserved for bWalletX itself');
  expect(refusalCode(r!)).toBe(RESERVED_PROTOCOL_CODE);
});
