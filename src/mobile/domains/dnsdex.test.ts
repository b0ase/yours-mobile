import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { hasReturnsWording } from '../tokens/returnsWording';
import { LINK_KEY_ID, LINK_PROTOCOL, linkMessage, parseLinkValue, verifyLink } from './bdnsx';
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
  txtLinksTo,
  linkRecord,
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
const realSigner = (priv: PrivateKey = PrivateKey.fromRandom()) => {
  const w = new ProtoWallet(priv);
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
    signLink: async (message) =>
      Utils.toBase64(
        (
          await w.createSignature({
            data: Utils.toArray(message, 'utf8'),
            protocolID: LINK_PROTOCOL,
            keyID: LINK_KEY_ID,
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
    const link = await linkRecord(signer, 'example.com');
    const r = await startDomain(
      signer,
      'example.com',
      jsonFetch(
        200,
        { ok: true, domain: 'example.com', txtHost: link.txtHost, txtValue: link.txtValue, resumed: false },
        seen,
      ),
      1000,
    );
    expect(r.txtHost).toBe('_bdnsx.example.com');
    expect(r.txtValue).toBe(link.txtValue);
    expect(r.identityKey).toBe(link.identityKey);
    expect(seen.url).toBe(`${DNSDEX_ORIGIN}/api/bwallet/domain/start`);
    const { signature, linkSignature, ...signed } = seen.body!;
    expect(await verifyLink('example.com', link.identityKey, String(linkSignature))).toBe(true);
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

  test('start refuses a record the server changed', async () => {
    const signer = realSigner();
    const link = await linkRecord(signer, 'example.com');
    const other = await linkRecord(realSigner(), 'example.com');
    for (const bad of [
      { txtHost: '_dnsdex.example.com', txtValue: link.txtValue },
      { txtHost: link.txtHost, txtValue: other.txtValue },
    ])
      await expect(
        startDomain(
          signer,
          'example.com',
          jsonFetch(200, { ok: true, domain: 'example.com', resumed: false, ...bad }, {}),
        ),
      ).rejects.toThrow('different DNS record');
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
    expect(txtText('"bdnsx1 key=02ab"')).toBe('bdnsx1 key=02ab');
    expect(txtText('"bdnsx1 key=02" "ab"')).toBe('bdnsx1 key=02ab');
    expect(txtText('bdnsx1 key=02ab')).toBe('bdnsx1 key=02ab');
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

/** Contract test vector: private scalar 1 (a well-known test key, never a real one). */
const VECTOR_KEY = new PrivateKey(1);
const VECTOR_ID = VECTOR_KEY.toPublicKey().toString();

describe('bDNSx link record', () => {
  test('test vector: message, value, round trip', async () => {
    const link = await linkRecord(realSigner(VECTOR_KEY), 'example.com');
    expect(VECTOR_ID).toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(linkMessage('example.com', VECTOR_ID)).toBe(
      'bdnsx-link|v1|domain=example.com|identityKey=0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );
    expect(link.txtHost).toBe('_bdnsx.example.com');
    expect(link.txtValue).toBe(`bdnsx1 key=${VECTOR_ID} sig=${link.linkSignature}`);
    expect(link.txtValue.length).toBeLessThan(255);
    expect(parseLinkValue(link.txtValue)).toEqual({ identityKey: VECTOR_ID, signature: link.linkSignature });
    expect(await verifyLink('example.com', VECTOR_ID, link.linkSignature)).toBe(true);
    // Deterministic (RFC 6979), so the dns-dex side can check the same bytes.
    expect((await linkRecord(realSigner(VECTOR_KEY), 'example.com')).txtValue).toBe(link.txtValue);
  });

  test('DNS answers: accepts our signed record among others, split or not', async () => {
    const link = await linkRecord(realSigner(VECTOR_KEY), 'example.com');
    const quoted = `"${link.txtValue}"`;
    const split = `"${link.txtValue.slice(0, 50)}" "${link.txtValue.slice(50)}"`;
    expect(await txtLinksTo(['"v=spf1 -all"', quoted], 'example.com', VECTOR_ID)).toBe(true);
    expect(await txtLinksTo([split], 'example.com', VECTOR_ID)).toBe(true);
    expect(await txtLinksTo([link.txtValue], 'example.com', VECTOR_ID)).toBe(true);
  });

  test('negatives: wrong domain, wrong key, tampered sig, malformed', async () => {
    const link = await linkRecord(realSigner(VECTOR_KEY), 'example.com');
    const other = await linkRecord(realSigner(), 'example.com');
    expect(await txtLinksTo([link.txtValue], 'example.org', VECTOR_ID)).toBe(false);
    expect(await txtLinksTo([link.txtValue], 'example.com', other.identityKey)).toBe(false);
    expect(await txtLinksTo([other.txtValue], 'example.com', VECTOR_ID)).toBe(false);
    const sig = Utils.toArray(link.linkSignature, 'base64');
    sig[sig.length - 1] ^= 1;
    const tampered = `bdnsx1 key=${VECTOR_ID} sig=${Utils.toBase64(sig)}`;
    expect(await txtLinksTo([tampered], 'example.com', VECTOR_ID)).toBe(false);
    expect(await txtLinksTo(['"v=spf1 -all"', '"dnsdex-verify=abc"'], 'example.com', VECTOR_ID)).toBe(false);
    for (const bad of [
      `bdnsx1 key=${VECTOR_ID}`,
      `bdnsx1 sig=${link.linkSignature} key=${VECTOR_ID}`,
      `bdnsx1 key=${VECTOR_ID} sig=${link.linkSignature} extra=1`,
      `bdnsx1  key=${VECTOR_ID} sig=${link.linkSignature}`,
      `bdnsx2 key=${VECTOR_ID} sig=${link.linkSignature}`,
      `bdnsx1 key=${VECTOR_ID.toUpperCase()} sig=${link.linkSignature}`,
      `bdnsx1 key=${VECTOR_ID} sig=${link.linkSignature.replace(/=+$/, '')}!`,
    ]) {
      expect(parseLinkValue(bad)).toBeNull();
      expect(await txtLinksTo([bad], 'example.com', VECTOR_ID)).toBe(false);
    }
  });
});
