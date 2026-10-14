import { describe, expect, test } from 'bun:test';
import { unzipSync, zipSync } from 'fflate';
import {
  BackupPasswordError,
  ENVELOPE_ENTRY,
  ENVELOPE_ITERATIONS,
  envelopeHeader,
  openBackup,
  PAYLOAD_ENTRY,
  sealBackup,
} from './backupEnvelope';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** An old-format (v1) master backup: a plain ZIP, as WalletBackupService writes it. */
const oldFixture = () =>
  zipSync({
    'manifest.json': enc('{"version":2,"accounts":[]}'),
    'chromeStorage.json': enc('{"salt":"00112233445566778899aabbccddeeff","accounts":{}}'),
    'settings.bin': new Uint8Array([1, 2, 3]),
  });

describe('backup envelope', () => {
  test('old-format files open unchanged (version 1)', async () => {
    const { files, version } = await openBackup(oldFixture(), 'any password');
    expect(version).toBe(1);
    expect(dec(files['chromeStorage.json'])).toContain('"salt"');
    expect(files['settings.bin']).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('new files: 600k PBKDF2 header, still a ZIP, round-trip with the password', async () => {
    const sealed = await sealBackup(oldFixture(), 'k7M-pq2_Wz9!rT4@hB6+');
    const outer = unzipSync(sealed);
    expect(Object.keys(outer).sort()).toEqual([ENVELOPE_ENTRY, PAYLOAD_ENTRY].sort());
    const h = envelopeHeader(outer);
    expect(h?.version).toBe(2);
    expect(h?.iterations).toBe(ENVELOPE_ITERATIONS);
    expect(ENVELOPE_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    // Nothing readable outside the ciphertext.
    expect(dec(sealed)).not.toContain('chromeStorage');
    const { files, version } = await openBackup(sealed, 'k7M-pq2_Wz9!rT4@hB6+');
    expect(version).toBe(2);
    expect(dec(files['manifest.json'])).toBe('{"version":2,"accounts":[]}');
  });

  test('new files reject a wrong password', async () => {
    const sealed = await sealBackup(oldFixture(), 'right password here', 100_000);
    await expect(openBackup(sealed, 'wrong password here')).rejects.toBeInstanceOf(BackupPasswordError);
  });

  test('a tampered header (lower iterations) fails, out-of-range headers are refused', async () => {
    const sealed = await sealBackup(oldFixture(), 'right password here', 200_000);
    const outer = unzipSync(sealed);
    const h = JSON.parse(dec(outer[ENVELOPE_ENTRY]));
    const tamper = (patch: object) =>
      zipSync({ [ENVELOPE_ENTRY]: enc(JSON.stringify({ ...h, ...patch })), [PAYLOAD_ENTRY]: outer[PAYLOAD_ENTRY] });
    await expect(openBackup(tamper({ iterations: 150_000 }), 'right password here')).rejects.toBeInstanceOf(
      BackupPasswordError,
    );
    await expect(openBackup(tamper({ iterations: 10 }), 'right password here')).rejects.toThrow(/key derivation/);
    await expect(openBackup(tamper({ version: 3 }), 'right password here')).rejects.toThrow(/newer version/);
  });
});
