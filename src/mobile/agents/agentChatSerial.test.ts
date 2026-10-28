import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { OneSatContext } from '@1sat/actions';
import { serialSpend } from './spendQueue';
import * as trade from './agentTrade';

/**
 * b-Aware 25 Oct 2026 (donydp07): b agent chat ran its spends outside serialSpend, so a chat spend and a paired
 * agent / pot payment could each pass the daily cap check side by side and together go over it.
 */
describe('agent chat spends run inside serialSpend', () => {
  test('runAgentActionSerial waits for a spend already in the queue', async () => {
    const run = (trade as Record<string, unknown>).runAgentActionSerial as typeof trade.runAgentAction | undefined;
    expect(typeof run).toBe('function');
    let release!: () => void;
    const held = serialSpend(() => new Promise<void>((r) => (release = r)));
    let done = false;
    const p = run!({} as OneSatContext, 'no-such-account', { kind: 'send', usd: 1, to: '1x' } as never, 50).then(
      () => (done = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // still queued behind the held spend
    release();
    await held;
    await p;
    expect(done).toBe(true);
  });

  test('the chat calls the serialised runner, never the bare one', () => {
    const src = readFileSync(new URL('../agent/AgentConversation.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\brunAgentAction\(/);
    expect(src).toMatch(/\brunAgentActionSerial\(/);
  });
});
