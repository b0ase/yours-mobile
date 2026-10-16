import { describe, expect, it } from 'bun:test';
import { REMOTE_AGENTS, isRemoteAgentReady, remoteAgentBalanceSats } from './remoteAgents';

describe('remote agents', () => {
  it('bmovies waits for setup until its keys are filled in', () => {
    const b = REMOTE_AGENTS.find((a) => a.name === 'bmovies')!;
    expect(b.owner).toBe('@b0asex');
    expect(b.dailyCapUsd).toBe(1.3);
    expect(b.approvalAboveUsd).toBe(0.13);
    expect(isRemoteAgentReady(b)).toBe(false);
    expect(isRemoteAgentReady({ ...b, identityKey: '02ab', receiveAddress: '1abc' })).toBe(true);
  });

  it('adds confirmed and unconfirmed sats', async () => {
    const urls: string[] = [];
    const f = async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ confirmed: 1000, unconfirmed: 50 }));
    };
    expect(await remoteAgentBalanceSats('1abc', f as unknown as typeof fetch)).toBe(1050);
    expect(urls[0]).toContain('/address/1abc/balance');
  });
});
