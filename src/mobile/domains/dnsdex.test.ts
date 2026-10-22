import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { hasReturnsWording } from '../tokens/returnsWording';
import { validateToken } from '../tokens/token';
import { emptyTokenForm } from '../tokens/token';
import {
  DNSDEX_ORIGIN,
  DOMAIN_SIGN_KEY_ID,
  DOMAIN_SIGN_PROTOCOL,
  canonicalMessage,
  domainTokenDescription,
  domainMapScript,
  loadPending,
  lookupTxt,
  normaliseDomain,
  registerDomain,
  removePending,
  savePending,
  startDomain,
  suggestDomainTicker,
  txtMatches,
  txtText,
  type DomainSigner,
  prefillDomain,
} from './dnsdex';

const ok = (s: string) => {
  const r = normaliseDomain(s);
  if (!r.ok) throw new Error(`expected ok for ${s}: ${r.error}`);
  return r.domain;
};

describe('normaliseDomain', () => {
  test('keeps just the lowercase host', () => {
    expect(ok('Example.COM')).toBe('example.com');
    expect(ok('https://www.Example.com/path?q=1#x')).toBe('www.example.com');
    expect(ok('example.com/')).toBe('example.com');
    expect(ok('example.com.')).toBe('example.com');
    expect(ok('  shop.example.co.uk:8443 ')).toBe('shop.example.co.uk');
  });
  test('IDN becomes punycode', () => {
    expect(ok('bücher.de')).toBe('xn--bcher-kva.de');
  });
  test('rejects IPs, localhost, bare names and junk', () => {
    for (const bad of [
      '',
      '192.168.1.1',
      '[::1]',
      '2001:db8::1',
      'localhost',
      'a.localhost',
      'example',
      'exa mple.com',
      '-bad.com',
      'x.123',
    ])
      expect(normaliseDomain(bad).ok).toBe(false);
  });
});

describe('ticker and description', () => {
  test('ticker passes the token form', () => {
    for (const d of [
      'example.com',
      'my-site.co.uk',
      'xn--bcher-kva.de',
      'a-very-long-domain-name-indeed.example.com',
    ]) {
      const f = {
        ...emptyTokenForm(),
        name: d,
        ticker: suggestDomainTicker(d),
        description: domainTokenDescription(d),
      };
      expect(validateToken(f, { check: () => ({ blocked: false }) } as never)).toBeNull();
    }
    expect(suggestDomainTicker('example.com')).toBe('EXAMPLE-COM');
  });
  test('description never trips the returns guard', () => {
    expect(hasReturnsWording(domainTokenDescription('example.com'))).toBe(false);
  });
  test('MAP tag names the domain', () => {
    const asm = Utils.toUTF8(domainMapScript('example.com').toBinary());
    expect(asm).toContain('domain');
    expect(asm).toContain('example.com');
  });
});

describe('canonical message', () => {
  test('start: exact key order, no tokenId', () => {
    expect(
      canonicalMessage({ action: 'start', domain: 'example.com', identityKey: '02ab', ts: 5, tokenId: 'x_0' }),
    ).toBe('{"action":"start","domain":"example.com","identityKey":"02ab","ts":5}');
  });
  test('register: tokenId before ts', () => {
    expect(
      canonicalMessage({ ts: 7, tokenId: 'abc_0', identityKey: '02ab', domain: 'example.com', action: 'register' }),
    ).toBe('{"action":"register","domain":"example.com","identityKey":"02ab","tokenId":"abc_0","ts":7}');
  });
});

/** A signer built on a real ProtoWallet, so the round trip proves dns-dex can verify what we send. */
const realSigner = () => {
  const w = new ProtoWallet(PrivateKey.fromRandom());
  const signer: DomainSigner = {
    identityKey: async () => (await w.getPublicKey({ identityKey: true })).publicKey,
    sign: async (message) =>
      Utils.toHex(
        (
          await w.createSignature({
            data: Utils.toArray(message, 'utf8'),
            protocolID: DOMAIN_SIGN_PROTOCOL,
            keyID: DOMAIN_SIGN_KEY_ID,
            counterparty: 'anyone',
          })
        ).signature,
      ),
  };
  return signer;
};

const jsonFetch = (status: number, body: unknown, seen: { url?: string; body?: Record<string, unknown> }) =>
  (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('dns-dex client', () => {
  test('start sends a signed body dns-dex can verify', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const signer = realSigner();
    const r = await startDomain(
      signer,
      'example.com',
      jsonFetch(
        200,
        {
          ok: true,
          domain: 'example.com',
          code: 'c',
          txtHost: '_dnsdex.example.com',
          txtValue: 'dnsdex-verify=c',
          resumed: false,
        },
        seen,
      ),
      1000,
    );
    expect(r.txtValue).toBe('dnsdex-verify=c');
    expect(seen.url).toBe(`${DNSDEX_ORIGIN}/api/bwallet/domain/start`);
    const { signature, ...signed } = seen.body!;
    expect(Object.keys(signed)).toEqual(['action', 'domain', 'identityKey', 'ts']);
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(JSON.stringify(signed), 'utf8'),
      signature: Utils.toArray(String(signature), 'hex'),
      protocolID: DOMAIN_SIGN_PROTOCOL,
      keyID: DOMAIN_SIGN_KEY_ID,
      counterparty: String(signed.identityKey),
    });
    expect(valid).toBe(true);
  });

  test('register carries tokenId; errors come through as plain sentences', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    await expect(
      registerDomain(
        realSigner(),
        'example.com',
        'abc_0',
        jsonFetch(409, { ok: false, error: 'DNS record not found yet.' }, seen),
      ),
    ).rejects.toThrow('DNS record not found yet.');
    expect(seen.body!.tokenId).toBe('abc_0');
    expect(Object.keys(seen.body!)).toEqual(['action', 'domain', 'identityKey', 'tokenId', 'ts', 'signature']);
  });

  test('unreachable dns-dex says so', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(startDomain(realSigner(), 'example.com', down)).rejects.toThrow("Couldn't reach dns-dex.com");
  });
});

describe('DNS TXT', () => {
  test('quoted, split and multi-value records', () => {
    expect(txtText('"dnsdex-verify=abc"')).toBe('dnsdex-verify=abc');
    expect(txtText('"dnsdex-verify=ab" "c"')).toBe('dnsdex-verify=abc');
    expect(txtMatches(['"v=spf1 -all"', '"dnsdex-verify=abc"'], 'dnsdex-verify=abc')).toBe(true);
    expect(txtMatches(['"other dnsdex-verify=abc"'], 'dnsdex-verify=abc')).toBe(true);
    expect(txtMatches(['"dnsdex-verify=abcd"'], 'dnsdex-verify=abc')).toBe(false);
    expect(txtMatches(['dnsdex-verify=abc'], 'dnsdex-verify=abc')).toBe(true);
  });

  test('falls back to Google when Cloudflare fails', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.includes('cloudflare')) return new Response('nope', { status: 500 });
      return new Response(
        JSON.stringify({
          Answer: [
            { type: 16, data: '"dnsdex-verify=abc"' },
            { type: 5, data: 'x' },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    expect(await lookupTxt('_dnsdex.example.com', f)).toEqual(['"dnsdex-verify=abc"']);
    expect(urls.length).toBe(2);
  });

  test('no answer is an empty list, not an error', async () => {
    const f = (async () => new Response(JSON.stringify({ Status: 3 }))) as unknown as typeof fetch;
    expect(await lookupTxt('_dnsdex.example.com', f)).toEqual([]);
  });
});

describe('pending listings', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  test('save, replace by domain, remove', () => {
    const s = mem();
    savePending({ domain: 'a.com', tokenId: '1_0' }, s);
    savePending({ domain: 'b.com', tokenId: '2_0' }, s);
    savePending({ domain: 'a.com', tokenId: '3_0' }, s);
    expect(loadPending(s)).toEqual([
      { domain: 'b.com', tokenId: '2_0' },
      { domain: 'a.com', tokenId: '3_0' },
    ]);
    removePending('b.com', s);
    expect(loadPending(s)).toEqual([{ domain: 'a.com', tokenId: '3_0' }]);
  });
  test('garbage or missing storage is empty', () => {
    expect(loadPending({ getItem: () => '{nope', setItem: () => undefined })).toEqual([]);
    expect(loadPending(null)).toEqual([]);
  });
});

describe('prefillDomain (the /m/mint/domain?d= deep link)', () => {
  test('a valid domain is cleaned', () => {
    expect(prefillDomain('https://Example.COM/x')).toEqual({ value: 'example.com', error: '' });
  });
  test('an invalid one keeps the raw text with the normal error', () => {
    expect(prefillDomain('localhost')).toEqual({ value: 'localhost', error: 'Use a public domain name.' });
  });
  test('missing or blank is empty, no error', () => {
    expect(prefillDomain(null)).toEqual({ value: '', error: '' });
    expect(prefillDomain('  ')).toEqual({ value: '', error: '' });
  });
});
