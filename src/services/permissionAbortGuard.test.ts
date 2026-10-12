import { describe, expect, test } from 'bun:test';
import { preserveOriginalErrors } from './permissionAbortGuard';

class FakeManager {
  aborted: string[] = [];
  constructor(private refuse: boolean) {}
  async blockAndAbortAction(reference: string) {
    if (this.refuse)
      throw new Error(
        'The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.',
      );
    this.aborted.push(reference);
  }
  async signAction(reference: string) {
    try {
      throw new Error('broadcast failed: serviceError');
    } catch (error) {
      await this.blockAndAbortAction(reference);
      throw error;
    }
  }
}

describe('preserveOriginalErrors', () => {
  test('a refused abort no longer hides the real failure', async () => {
    const m = preserveOriginalErrors(new FakeManager(true), () => {});
    await expect(m.signAction('ref1')).rejects.toThrow('broadcast failed: serviceError');
  });
  test('a successful abort still runs', async () => {
    const m = preserveOriginalErrors(new FakeManager(false), () => {});
    await expect(m.signAction('ref2')).rejects.toThrow('broadcast failed');
    expect(m.aborted).toEqual(['ref2']);
  });
  test('without the method it is a no-op', () => {
    const o = { x: 1 };
    expect(preserveOriginalErrors(o)).toBe(o);
  });
});
