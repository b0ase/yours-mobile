import { describe, expect, it } from 'bun:test';
import { masterBackupFileName, streamDataToZip } from './masterExporter';

describe('masterBackupFileName', () => {
  it('names the zip for the account, never a key', () => {
    const d = new Date(2026, 9, 11, 12);
    expect(masterBackupFileName('vexvoid', d)).toBe('bwalletx-backup-vexvoid-2026-10-11.zip');
    expect(masterBackupFileName('$VexVoid', d)).toBe('bwalletx-backup-vexvoid-2026-10-11.zip');
    expect(masterBackupFileName('Account 1', d)).toBe('bwalletx-backup-account-1-2026-10-11.zip');
    expect(masterBackupFileName('', d)).toBe('bwalletx-backup-account-2026-10-11.zip');
  });
});

describe('streamDataToZip save route', () => {
  const run = async (saveResult: boolean) => {
    const g = globalThis as unknown as { chrome?: unknown };
    const prev = g.chrome;
    g.chrome = {
      runtime: {
        onMessage: { addListener: () => undefined, removeListener: () => undefined },
        sendMessage: async () => ({ success: true, data: btoa('zipbytes') }),
      },
    };
    const stages: string[] = [];
    const saved: File[] = [];
    const cs = {
      getCurrentAccountObject: () => ({ account: { name: 'Account 1', addresses: { identityAddress: 'x' } } }),
    } as unknown as Parameters<typeof streamDataToZip>[0];
    try {
      const r = await streamDataToZip(
        cs,
        (e) => void stages.push(e.stage ?? ''),
        undefined,
        undefined,
        async (f) => {
          saved.push(f);
          return saveResult;
        },
      );
      return { r, stages, saved };
    } finally {
      g.chrome = prev;
    }
  };
  it('hands the file to the save route and completes only when saved', async () => {
    const { r, stages, saved } = await run(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/\.zip$/);
    expect(r.saved).toBe(true);
    expect(stages).toContain('complete');
  });
  it('a cancelled share sheet is not "complete"', async () => {
    const { r, stages } = await run(false);
    expect(r.saved).toBe(false);
    expect(stages).not.toContain('complete');
  });
});
