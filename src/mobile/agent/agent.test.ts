import { describe, expect, test } from 'bun:test';
import { MAX_TURNS, agentRequest, parseAgentReply, type AgentMessage } from './agent';

describe('agentRequest', () => {
  test('sends the transcript as a compose chat turn, dropping blanks', () => {
    const body = agentRequest([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '  ' },
      { role: 'assistant', text: 'hello' },
    ]);
    expect(body.action).toBe('chat');
    expect(body.messages).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    expect(body.parties).toEqual([]);
    expect(body.draft).toBeNull();
  });

  test('keeps only the last MAX_TURNS', () => {
    const many: AgentMessage[] = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const body = agentRequest(many);
    expect(body.messages.length).toBe(MAX_TURNS);
    expect(body.messages[0].text).toBe('m5');
  });
});

describe('parseAgentReply', () => {
  test('plain text', () => {
    expect(parseAgentReply({ text: ' Hello ' })).toEqual({ text: 'Hello', notes: [] });
  });

  test('prepared actions become notes for bChat', () => {
    const r = parseAgentReply({
      text: 'Done.',
      created: { documentId: 'd', fileName: 'NDA.pdf' },
      pendingSignatures: [{}, {}],
      pendingMints: [{}],
    });
    expect(r.notes).toEqual([
      'Created “NDA.pdf” in bChat.',
      '2 signature requests ready to review in bChat.',
      '1 token mint ready to review in bChat.',
    ]);
  });

  test('garbage is a safe empty reply', () => {
    expect(parseAgentReply(null)).toEqual({ text: 'No reply.', notes: [] });
    expect(parseAgentReply({ text: 5 })).toEqual({ text: 'No reply.', notes: [] });
  });
});
