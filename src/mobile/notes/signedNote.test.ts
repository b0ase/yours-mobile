import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { isReservedProtocol } from '../../services/reservedProtocols';
import { NOTE_PROTOCOL, signNote, verifyNote } from './signedNote';

const wallet = new ProtoWallet(PrivateKey.fromRandom());

describe('signed notes', () => {
  test('a signed note verifies, and any change breaks it', async () => {
    const note = await signNote(wallet, '  I owe Touman 0.25 BSV  ', Date.UTC(2026, 9, 26));
    expect(note.text).toBe('I owe Touman 0.25 BSV');
    expect(note.date).toBe('2026-10-26T00:00:00.000Z');
    expect(verifyNote(note)).toBe(true);
    expect(verifyNote(JSON.parse(JSON.stringify(note)))).toBe(true);
    expect(verifyNote({ ...note, text: 'I owe Touman 2.5 BSV' })).toBe(false);
    expect(verifyNote({ ...note, date: '2026-10-27T00:00:00.000Z' })).toBe(false);
    const other = await signNote(new ProtoWallet(PrivateKey.fromRandom()), note.text);
    expect(verifyNote({ ...note, signer: other.signer })).toBe(false);
    expect(verifyNote({ ...other, signature: note.signature })).toBe(false);
  });

  test('empty and oversized notes are refused', async () => {
    await expect(signNote(wallet, '   ')).rejects.toThrow();
    await expect(signNote(wallet, 'x'.repeat(4001))).rejects.toThrow();
  });

  test('outside apps cannot use the note protocol', () => {
    expect(isReservedProtocol(NOTE_PROTOCOL)).toBe(true);
  });
});
