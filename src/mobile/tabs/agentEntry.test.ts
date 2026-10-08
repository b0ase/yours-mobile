import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ROUTE, agentMenuTarget, showAgentInMenu } from './agentEntry';

describe('classic layout b agent menu entry', () => {
  test('opens the agent from anywhere else', () => {
    expect(agentMenuTarget('/bsv-wallet')).toBe(AGENT_ROUTE);
    expect(agentMenuTarget('/m/chat')).toBe('/m/agent');
  });

  test('goes back when the agent is already open (same toggle as the old top-bar b)', () => {
    expect(agentMenuTarget('/m/agent')).toBe(-1);
  });

  test('shown in the classic layout only', () => {
    expect(showAgentInMenu(false)).toBe(true);
    expect(showAgentInMenu(true)).toBe(false);
  });

  test('TopNav drawer wires the entry', () => {
    const src = readFileSync(join(import.meta.dir, 'TopNav.tsx'), 'utf8');
    expect(src).toContain('showAgentInMenu(phone)');
    expect(src).toContain('agentMenuTarget(pathname)');
  });
});
