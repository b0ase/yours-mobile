import { describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import {
  inPlaceChains,
  LINK_PATH,
  linkInPlace,
  listLinks,
  parseLinks,
  providersOf,
  shortAddress,
  signerFor,
  unlink,
  type Requester,
} from './linkedWalletsApi';

type Call = { method: string; path: string; body?: Record<string, unknown> };
const fakeReq = (answers: Record<string, unknown>) => {
  const calls: Call[] = [];
  const req: Requester = async (method, path, body) => {
    calls.push({ method, path, body });
    return answers[`${method} ${path.split('?')[0]}`] ?? {};
  };
  return { req, calls };
};

describe('linked wallets: list and unlink', () => {
  test('lists links and drops malformed rows', async () => {
    const { req, calls } = fakeReq({
      [`GET ${LINK_PATH}`]: {
        links: [
          {
            id: 'a',
            chain: 'eth',
            address: '0xAbCdEf0123456789abcdef0123456789ABCDEF01',
            verified_at: '2026-10-27T10:00:00Z',
          },
          { id: 'b', chain: 'doge', address: 'x' },
          { chain: 'sol', address: 'y' },
        ],
      },
    });
    const l = await listLinks(req);
    expect(calls).toEqual([{ method: 'GET', path: LINK_PATH, body: undefined }]);
    expect(l).toEqual([
      {
        id: 'a',
        chain: 'eth',
        address: '0xAbCdEf0123456789abcdef0123456789ABCDEF01',
        verifiedAt: '2026-10-27T10:00:00Z',
      },
    ]);
    expect(parseLinks(null)).toEqual([]);
  });

  test('unlink sends DELETE with the id', async () => {
    const { req, calls } = fakeReq({});
    await unlink(req, '1b4e28ba-2fa1-11d2-883f-0016d3cca427');
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: `${LINK_PATH}?id=1b4e28ba-2fa1-11d2-883f-0016d3cca427`,
      body: undefined,
    });
  });

  test('short address', () => {
    expect(shortAddress('0xAbCdEf0123456789abcdef0123456789ABCDEF01')).toBe('0xAbCd…EF01');
  });
});

describe('linked wallets: link flow', () => {
  test('no injected wallets (extension popup, phone): nothing signs in place', () => {
    expect(inPlaceChains(providersOf({}))).toEqual([]);
    expect(signerFor('eth', providersOf({}))).toBeNull();
  });

  test('challenge → sign → verify with the exact message', async () => {
    const message = 'www.bchatx.com wants you to sign in…\nNonce: abcdef0123456789';
    const { req, calls } = fakeReq({ [`POST ${LINK_PATH}/challenge`]: { message } });
    const seen: unknown[] = [];
    const ethereum = {
      request: async (a: { method: string; params?: unknown[] }) => {
        seen.push(a);
        return a.method === 'eth_requestAccounts' ? ['0xabc0000000000000000000000000000000000001'] : '0xsig';
      },
    };
    const p = providersOf({ ethereum });
    expect(inPlaceChains(p)).toEqual(['eth', 'bnb']);
    await linkInPlace(req, 'eth', signerFor('eth', p)!);
    // personal_sign gets the message as UTF-8 hex; nothing else is asked of the wallet (no transaction).
    expect(seen.map((s) => (s as { method: string }).method)).toEqual(['eth_requestAccounts', 'personal_sign']);
    expect((seen[1] as { params: string[] }).params[0]).toBe('0x' + Utils.toHex(Utils.toArray(message, 'utf8')));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${LINK_PATH}/challenge`,
      `POST ${LINK_PATH}/verify`,
    ]);
    expect(calls[1].body).toEqual({
      chain: 'eth',
      address: '0xabc0000000000000000000000000000000000001',
      message,
      signature: '0xsig',
    });
  });

  test('Solana signature goes up as base58', async () => {
    const { req, calls } = fakeReq({ [`POST ${LINK_PATH}/challenge`]: { message: 'm' } });
    const phantom = {
      solana: {
        connect: async () => ({ publicKey: { toString: () => 'So1Addr' } }),
        signMessage: async () => ({ signature: new Uint8Array([1, 2, 3]) }),
      },
    };
    await linkInPlace(req, 'sol', signerFor('sol', providersOf({ phantom }))!);
    expect(calls[1].body?.signature).toBe(Utils.toBase58([1, 2, 3]));
  });

  test('no message from bChatX: nothing is signed or verified', async () => {
    const { req, calls } = fakeReq({});
    let signed = false;
    await expect(
      linkInPlace(req, 'trx', { address: async () => 'T1', sign: async () => ((signed = true), 's') }),
    ).rejects.toThrow();
    expect(signed).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
