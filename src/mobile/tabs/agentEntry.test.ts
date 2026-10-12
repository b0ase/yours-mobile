import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPublic, toRouter } from '../url/publicUrl';
import { AGENT_ROUTE, agentMenuTarget, showAgentInMenu } from './agentEntry';

describe('classic layout b agent menu entry', () => {
  test('opens the agent from anywhere else', () => {
    expect(agentMenuTarget('/bsv-wallet')).toBe(AGENT_ROUTE);
    expect(agentMenuTarget('/m/chat')).toBe('/m/ask-b');
  });

  test('goes back when the agent is already open (same toggle as the old top-bar b)', () => {
    expect(agentMenuTarget('/m/ask-b')).toBe(-1);
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

  test('Ask b lives at /ask-b; old /agent and /m/agent links still open it (12 Oct 2026)', () => {
    expect(AGENT_ROUTE).toBe('/m/ask-b');
    expect(toPublic('/m/ask-b', '')).toBe('/ask-b');
    expect(toRouter('/ask-b', '')).toBe('/m/ask-b');
    expect(toRouter('/agent', '')).toBe('/m/agent');
    const routes = readFileSync(join(import.meta.dir, 'MobileRoutes.tsx'), 'utf8');
    expect(routes).toContain('<Route path="ask-b" element={<AgentPage />} />');
    expect(routes).toContain('<Route path="agent" element={<Navigate to="/m/ask-b" replace />} />');
  });
});
