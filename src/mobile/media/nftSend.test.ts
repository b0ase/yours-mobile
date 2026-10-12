import { describe, expect, test } from 'bun:test';
import { nftSendButton } from './nftSend';

const base = { to: '', status: 'empty' as const, busy: false, onChain: true };

describe('nftSendButton', () => {
  test('waits for a recipient', () => {
    expect(nftSendButton(base)).toEqual({ label: 'Choose who gets it', enabled: false });
    expect(nftSendButton({ ...base, status: 'loading' }).enabled).toBe(false);
  });
  test('one button names the recipient', () => {
    expect(
      nftSendButton({ ...base, status: 'ready', to: '1GipmJoVtDx5326yuJ2rWQyHaSb95ro5tS', name: '$b0asey' }),
    ).toEqual({
      label: 'Send to $b0asey',
      enabled: true,
    });
    expect(nftSendButton({ ...base, status: 'ready', to: '1GipmJoVtDx5326yuJ2rWQyHaSb95ro5tS' }).label).toBe(
      'Send to 1GipmJ…5ro5tS',
    );
  });
  test('never sends an NFT the network never saw, or twice at once', () => {
    expect(nftSendButton({ ...base, status: 'ready', to: '1abc', onChain: false })).toEqual({
      label: 'Not on the blockchain yet',
      enabled: false,
    });
    expect(nftSendButton({ ...base, status: 'ready', to: '1abc', busy: true }).enabled).toBe(false);
  });
});
