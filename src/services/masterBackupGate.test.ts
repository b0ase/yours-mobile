import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createMasterBackupGate } from './masterBackupGate';

describe('master backup gate', () => {
  test('passes straight through when no backup runs', async () => {
    const g = createMasterBackupGate();
    expect(g.active).toBe(false);
    await g.wait();
  });
  test('holds callers during a backup and releases them all when it ends', async () => {
    const g = createMasterBackupGate();
    g.begin();
    const done: number[] = [];
    const a = g.wait().then(() => done.push(1));
    const b = g.wait().then(() => done.push(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toEqual([]);
    g.end();
    await Promise.all([a, b]);
    expect(done).toEqual([1, 2]);
    expect(g.active).toBe(false);
  });
  test('ensureWallet waits on the gate instead of failing; it opens before the export and closes after the reopen', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).not.toContain('Wallet is busy with a master backup');
    expect(bg).toContain('if (masterBackupGate.active) await masterBackupGate.wait();');
    expect(bg).toMatch(/masterBackupInFlight = true;\n\s+masterBackupGate\.begin\(\);/);
    expect(bg).toMatch(/failed to restore original account:', err\);\n\s+\} finally \{\n\s+masterBackupGate\.end\(\);/);
  });
});

describe('masterBackupGate timeout', () => {
  test('a backup that never ends rejects waiting callers after the timeout', async () => {
    const g = createMasterBackupGate();
    g.begin();
    await expect(g.wait(20)).rejects.toThrow('busy with a master backup');
    g.end();
    await expect(g.wait(20)).resolves.toBeUndefined();
  });
});
