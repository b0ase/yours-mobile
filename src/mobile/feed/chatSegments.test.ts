import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// ChatSegments.tsx pulls in React/router modules; the order and default are checked from source plus the exports.
const src = readFileSync(join(import.meta.dir, 'ChatSegments.tsx'), 'utf8');

describe('Chat filters', () => {
  test('DMs sit on the left: DMs | Chatrooms | Calls', () => {
    const ids = [...src.matchAll(/\{ id: '(\w+)', label: '[^']+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual(['dms', 'rooms', 'calls']);
  });
  test('the Chat tab still opens on group chats (Chatrooms)', () => {
    expect(src).toContain("const DEFAULT_SEGMENT: ChatSegment = 'rooms';");
    expect(src).toContain('takeChatSegment() ?? DEFAULT_SEGMENT');
  });
  test('every filter is passed its badge', () => {
    expect(src).toContain('badges={badges}');
    expect(src).toMatch(/return \{ dms, rooms, calls:/);
  });
});
