import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveRoute, shareNativeFile, type NativeFileShare } from './backupFile';

const file = () => new File([new Uint8Array([1, 2, 3, 250])], 'bwallet-backup.zip', { type: 'application/zip' });

const fakeIo = (share: NativeFileShare['share']) => {
  const calls: string[] = [];
  const io: NativeFileShare = {
    clear: async () => void calls.push('clear'),
    write: async (path, data) => {
      calls.push(`write ${path} ${data}`);
      return `file:///cache/${path}`;
    },
    share: async (uri, name) => {
      calls.push(`share ${uri} ${name}`);
      return share(uri, name);
    },
  };
  return { io, calls };
};

describe('encrypted backup on mobile (Android had no way to save it)', () => {
  test('the app always uses the native share sheet', () => {
    expect(saveRoute(file(), true)).toBe('native');
  });
  test('a browser without file sharing downloads', () => {
    expect(saveRoute(file(), false)).toBe('download');
  });
  test('writes the sealed bytes to the private cache, then shares that file', async () => {
    const { io, calls } = fakeIo(async () => undefined);
    expect(await shareNativeFile(file(), io)).toBe(true);
    expect(calls).toEqual([
      'clear',
      `write backup-share/bwallet-backup.zip ${btoa(String.fromCharCode(1, 2, 3, 250))}`,
      'share file:///cache/backup-share/bwallet-backup.zip bwallet-backup.zip',
    ]);
  });
  test('closing the sheet is a cancel, not an error', async () => {
    const { io } = fakeIo(async () => {
      throw new Error('Share canceled');
    });
    expect(await shareNativeFile(file(), io)).toBe(false);
  });
  test('a real failure reaches the screen', async () => {
    const { io } = fakeIo(async () => {
      throw new Error('No app can handle this');
    });
    expect(shareNativeFile(file(), io)).rejects.toThrow('No app can handle this');
  });
  test('the "not available in this app" dead end is gone from the save step', () => {
    const src = readFileSync(join(import.meta.dir, 'BackupStep.tsx'), 'utf8');
    expect(src).not.toContain("Saving files isn't available in this app yet");
  });
});

describe('Create password: the generated password is selectable text', () => {
  test('shown as plain text with user-select: all, next to the Copy button', () => {
    const src = readFileSync(join(import.meta.dir, '../names/PasswordFields.tsx'), 'utf8');
    expect(src).toContain('data-testid="password-selectable"');
    expect(src).toContain("userSelect: 'all'");
    expect(src).toContain("WebkitUserSelect: 'all'");
    expect(src).toContain("{copied ? 'Copied' : 'Copy'}");
  });
});

describe('saveRoute on desktop and in the extension (owner, 15 Oct 2026)', () => {
  test('a non-touch browser downloads instead of sharing', () => {
    const file = new File(['x'], 'a.zip');
    const g = globalThis as { matchMedia?: unknown };
    const prev = g.matchMedia;
    g.matchMedia = () => ({ matches: false });
    try {
      expect(saveRoute(file, false)).toBe('download');
      expect(saveRoute(file, true)).toBe('native');
    } finally {
      g.matchMedia = prev;
    }
  });
});
