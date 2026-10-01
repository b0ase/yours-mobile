import { describe, expect, test } from 'bun:test';
import { PROVIDERS, PROVIDER_IDS, buildProviderRequest, callProvider, providerError, toTurns } from './providers';

const KEY = 'sk-test-SECRET-1234567890';
const msgs = [
  { role: 'assistant' as const, text: 'hello' },
  { role: 'user' as const, text: 'a' },
  { role: 'user' as const, text: 'b' },
  { role: 'assistant' as const, text: 'c' },
  { role: 'user' as const, text: 'd' },
];

describe('toTurns', () => {
  test('starts with the user and alternates', () => {
    expect(toTurns(msgs)).toEqual([
      { role: 'user', text: 'a\n\nb' },
      { role: 'assistant', text: 'c' },
      { role: 'user', text: 'd' },
    ]);
  });
});

describe('buildProviderRequest', () => {
  test('Anthropic: direct-browser header, system separate, key only in x-api-key', () => {
    const r = buildProviderRequest('anthropic', KEY, 'claude-haiku-4-5-20251001', 'SYS', msgs);
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(r.init.headers['x-api-key']).toBe(KEY);
    const body = JSON.parse(r.init.body);
    expect(body.system).toBe('SYS');
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.messages[0].role).toBe('user');
    expect(r.init.body).not.toContain(KEY);
  });

  test('OpenAI / OpenRouter: bearer key, system message first', () => {
    for (const p of ['openai', 'openrouter'] as const) {
      const r = buildProviderRequest(p, KEY, '', 'SYS', msgs);
      expect(new URL(r.url).origin).toBe(PROVIDERS[p].origin);
      expect(r.init.headers.authorization).toBe(`Bearer ${KEY}`);
      const body = JSON.parse(r.init.body);
      expect(body.model).toBe(PROVIDERS[p].defaultModel);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
      expect(r.init.body).not.toContain(KEY);
    }
  });

  test('bad model ids fall back to the default', () => {
    const r = buildProviderRequest('openai', KEY, 'x"; drop', 'S', msgs);
    expect(JSON.parse(r.init.body).model).toBe(PROVIDERS.openai.defaultModel);
  });
});

describe('key never leaves the device except to the provider', () => {
  test('every provider sends the key only to its own origin', async () => {
    for (const p of PROVIDER_IDS) {
      const seen: string[] = [];
      const fake = (async (url: string, init: RequestInit) => {
        seen.push(new URL(url).origin);
        expect(init.credentials).toBe('omit');
        const body =
          p === 'anthropic'
            ? { content: [{ type: 'text', text: 'ok' }] }
            : { choices: [{ message: { content: 'ok' } }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      expect(await callProvider(p, KEY, '', 'S', [{ role: 'user', text: 'hi' }], 16, fake)).toBe('ok');
      expect(seen).toEqual([PROVIDERS[p].origin]);
    }
  });

  test('errors never echo the key', () => {
    expect(providerError(400, { error: { message: `bad key ${KEY}` } }, KEY)).not.toContain(KEY);
    expect(providerError(400, { error: { message: 'Incorrect API key sk-abcdef123456' } }, 'x')).not.toContain(
      'sk-abcdef123456',
    );
    expect(providerError(401, {}, KEY)).toContain('rejected the key');
  });
});
