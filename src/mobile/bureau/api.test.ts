import { describe, expect, test } from 'bun:test';
import type { Http } from '../chat/api';
import { BureauClient, BureauError, classifyBytes, type BytesFetch } from './api';

const enc = (s: string) => new TextEncoder().encode(s);

const setup = (responses: { status: number; data: unknown }[], bytes: Parameters<BytesFetch>[0][] = []) => {
  const calls: Parameters<Http>[0][] = [];
  let tokens = 0;
  const http: Http = async (req) => {
    calls.push(req);
    return responses.shift() ?? { status: 500, data: null };
  };
  const byteCalls: { url: string; headers: Record<string, string> }[] = [];
  const byteResponses = [...bytes] as unknown as { status: number; mime: string; bytes: Uint8Array }[];
  const client = new BureauClient({
    http,
    bytes: async (url, headers) => {
      byteCalls.push({ url, headers });
      return byteResponses.shift() ?? { status: 500, mime: '', bytes: new Uint8Array() };
    },
    token: async () => 'tok-1',
    refresh: async () => `tok-${++tokens + 1}`,
    origin: 'https://bitsign.test',
  });
  return { client, calls, byteCalls };
};

describe('bureau bit-sign client', () => {
  test('sends the wallet session as a bearer to the right route', async () => {
    const { client, calls } = setup([
      { status: 200, data: { signatures: [{ id: 'a', signature_type: 'DOCUMENT', created_at: 'x' }] } },
    ]);
    const rows = await client.vault();
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://bitsign.test/api/bitsign/signatures',
      headers: { Accept: 'application/json', Authorization: 'Bearer tok-1' },
    });
  });

  test('a 401 signs in again once and retries with the new token', async () => {
    const { client, calls } = setup([
      { status: 401, data: { error: 'Unauthorized' } },
      { status: 200, data: { grants: [] } },
    ]);
    expect(await client.sharedWithMe()).toEqual([]);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  test("a refusal surfaces the server's words and status", async () => {
    const { client } = setup([{ status: 403, data: { error: 'Not yours', code: 'forbidden' } }]);
    const e = await client.vault().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BureauError);
    expect((e as BureauError).message).toBe('Not yours');
    expect((e as BureauError).status).toBe(403);
    expect((e as BureauError).code).toBe('forbidden');
  });

  test('a network failure is a BureauError with status 0', async () => {
    const client = new BureauClient({
      http: async () => {
        throw new Error('offline');
      },
      bytes: async () => ({ status: 200, mime: '', bytes: new Uint8Array() }),
      token: async () => 't',
      refresh: async () => 't',
    });
    const e = (await client.vault().catch((x: unknown) => x)) as BureauError;
    expect(e.status).toBe(0);
  });

  test('preview: bearer on the bytes request, "No data stored" is a state, not an error', async () => {
    const { client, byteCalls } = setup([], [
      { status: 404, mime: 'application/json', bytes: enc('{"error":"No data stored"}') },
    ] as never);
    const c = await client.preview('id 1');
    expect(c.kind).toBe('empty');
    expect(byteCalls[0]).toEqual({
      url: 'https://bitsign.test/api/bitsign/signatures/id%201/preview',
      headers: { Authorization: 'Bearer tok-1' },
    });
  });

  test('preview: a real 404 throws', async () => {
    const { client } = setup([], [
      { status: 404, mime: 'application/json', bytes: enc('{"error":"Not found"}') },
    ] as never);
    const e = (await client.preview('x').catch((x: unknown) => x)) as BureauError;
    expect(e.message).toBe('Not found');
  });
});

describe('classifyBytes', () => {
  test('pdf by type or by magic', () => {
    expect(classifyBytes(enc('%PDF-1.7'), '').kind).toBe('pdf');
    expect(classifyBytes(enc('x'), 'application/pdf; q=1').kind).toBe('pdf');
  });
  test('html, text, image, encrypted, other', () => {
    expect(classifyBytes(enc('<p>'), 'text/html').kind).toBe('html');
    expect(classifyBytes(enc('hi'), 'text/plain').kind).toBe('text');
    expect(classifyBytes(enc('x'), 'image/png').kind).toBe('image');
    expect(classifyBytes(enc('{"encryption_version":2}'), 'application/json').kind).toBe('encrypted');
    expect(classifyBytes(enc('x'), 'application/zip').kind).toBe('other');
  });
});
