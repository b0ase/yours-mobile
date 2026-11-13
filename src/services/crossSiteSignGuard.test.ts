import { describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import { gzipSync, zlibSync } from 'fflate';
import { MAX_SCAN_CHARS, scanSignData } from './signDataScan';
import {
  BLIND_SIGN_REFUSAL,
  bareHost,
  MAX_SIGN_DATA,
  boundHosts,
  normaliseKey,
  crossSiteSignRefusal,
  guardCrossSiteSigning,
  sameSite,
  setProvenPairingCheck,
} from './crossSiteSignGuard';

const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
/** Deterministic pseudo-random bytes. */
const rand = (n: number, seed: number) => {
  let x = seed;
  return Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff);
};
const sig = (s: string) => ({ protocolID: [2, 'good login'], keyID: '1', counterparty: 'anyone', data: bytes(s) });

describe('crossSiteSignRefusal (audit 24 Oct B1)', () => {
  test('refuses a SIWE-style challenge relayed from another site', () => {
    const msg = 'good.com wants you to sign in with your Bitcoin account:\nNonce: 123';
    expect(crossSiteSignRefusal('evil.com', sig(msg))).toContain('different site');
    expect(crossSiteSignRefusal('good.com', sig(msg))).toBeNull();
  });

  test('refuses a JSON challenge whose domain/origin/audience is another site', () => {
    for (const field of ['domain', 'origin', 'host', 'audience', 'aud']) {
      const msg = JSON.stringify({ [field]: 'https://good.com', nonce: 'abc' });
      expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
      expect(crossSiteSignRefusal('good.com', sig(msg))).toBeNull();
    }
  });

  test('subdomains, ports and the pairing key count as the same site', () => {
    const msg = JSON.stringify({ domain: 'bchatx.com' });
    expect(crossSiteSignRefusal('app.bchatx.com', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal('bchatx.com:8443', sig(msg))).toBeNull();
    // A pairing that proved its origin counts as that site.
    setProvenPairingCheck(() => true);
    expect(crossSiteSignRefusal('bchatx.com.paired.invalid', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal(`bchatx.com.c${'ab'.repeat(22)}.paired.invalid`, sig(msg))).toBeNull();
    expect(crossSiteSignRefusal(`evil.com.c${'ab'.repeat(22)}.paired.invalid`, sig(msg))).not.toBeNull();
    setProvenPairingCheck(() => false);
  });

  test('b-Aware 25 Oct (0xzero): an unproven pairing claiming a site gets no login signature for it', () => {
    const forged = `good.com.c${'ab'.repeat(22)}.paired.invalid`;
    const login = 'good.com wants you to sign in with your Bitcoin account:\nNonce: 123';
    expect(crossSiteSignRefusal(forged, sig(login))).toContain('different site');
    expect(crossSiteSignRefusal(`https://${forged}`, sig(JSON.stringify({ domain: 'good.com' })))).not.toBeNull();
    // Blind hashes too, even when the claimed host is one of our chat sites.
    expect(crossSiteSignRefusal(`bchatx.com.c${'ab'.repeat(22)}.paired.invalid`, { hashToDirectlySign: [1, 2] })).toBe(
      BLIND_SIGN_REFUSAL,
    );
    // Data that names no site still signs.
    expect(crossSiteSignRefusal(forged, sig('bwx-podcast:42:nonce'))).toBeNull();
    // Proven only for its own key: another channel claiming the same host stays unproven.
    setProvenPairingCheck((o) => o.toLowerCase().includes(`c${'cd'.repeat(22)}`));
    expect(crossSiteSignRefusal(`good.com.c${'cd'.repeat(22)}.paired.invalid`, sig(login))).toBeNull();
    expect(crossSiteSignRefusal(forged, sig(login))).not.toBeNull();
    setProvenPairingCheck(() => false);
  });

  test('one matching field cannot launder a second, foreign one', () => {
    const msg = JSON.stringify({ origin: 'evil.com', domain: 'good.com' });
    expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
  });

  test('data that names no site, free links, and binary data sign as before', () => {
    expect(crossSiteSignRefusal('evil.com', sig('bwx-podcast:42:nonce'))).toBeNull();
    expect(crossSiteSignRefusal('evil.com', sig('look at https://good.com/post/1'))).toBeNull();
    expect(crossSiteSignRefusal('evil.com', { data: [0, 255, 1, 2, 200, 3] })).toBeNull();
    // hashToDirectlySign from an outside caller is now refused (b-Aware 24 Oct, see below).
    expect(crossSiteSignRefusal(undefined, sig(JSON.stringify({ domain: 'good.com' })))).toBeNull();
  });

  test('b-Aware 24 Oct (b_feedback 51): uri/url/site/callback fields and login lines are bindings', () => {
    const shapes = [
      JSON.stringify({ url: 'https://good.com/login' }),
      JSON.stringify({ uri: 'https://good.com/login' }),
      JSON.stringify({ site: 'good.com' }),
      JSON.stringify({ callback: 'https://good.com/cb' }),
      JSON.stringify({ redirect_uri: 'https://good.com/cb' }),
      JSON.stringify({ message: 'good.com wants you to sign in' }),
      'Login: good.com wants you to sign in',
      'good.com wallet login: 0123abcd',
      'bitcoinchat.online wallet login: 0123abcd',
      'Sign in to good.com with bWallet\n\nNonce: 1',
    ];
    for (const msg of shapes) {
      expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
    }
    expect(crossSiteSignRefusal('good.com', sig('good.com wallet login: 0123abcd'))).toBeNull();
    expect(crossSiteSignRefusal('app.good.com', sig(JSON.stringify({ url: 'https://good.com/x' })))).toBeNull();
  });

  test("bit-sign's Sign in with bWallet challenge is bound to its origin", () => {
    const msg = [
      'Sign in to www.bchatx.com with bWallet',
      '',
      'This proves you hold this wallet. It does not spend anything.',
      '',
      'Origin: https://www.bchatx.com',
      'Nonce: abc',
      'Expires: 2026-10-24T15:00:00Z',
    ].join('\n');
    expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
    expect(crossSiteSignRefusal('www.bchatx.com', sig(msg))).toBeNull();
  });

  test('ordinary prose about logging in is not a binding', () => {
    expect(crossSiteSignRefusal('evil.com', sig('I logged in today and it worked'))).toBeNull();
    expect(crossSiteSignRefusal('evil.com', sig('post: read https://good.com/news first'))).toBeNull();
  });

  test('boundHosts reads both forms', () => {
    expect(boundHosts('a.io wants you to sign in\norigin=https://b.io:3000/x').sort()).toEqual(['a.io', 'b.io']);
  });
});

describe('guardCrossSiteSigning', () => {
  const make = () => {
    const calls: string[] = [];
    const m = {
      createSignature: async (_a: unknown, o?: string) => (calls.push(`sig:${o}`), { signature: [1] }),
      createHmac: async (_a: unknown, o?: string) => (calls.push(`hmac:${o}`), { hmac: [1] }),
    };
    return { m: guardCrossSiteSigning(m, 'admin.local'), calls };
  };
  const relayed = sig(JSON.stringify({ domain: 'good.com', nonce: 'n' }));

  test('refuses before reaching the manager (so no prompt is shown)', async () => {
    const { m, calls } = make();
    await expect(m.createSignature(relayed, 'evil.com')).rejects.toThrow('different site');
    await expect(m.createHmac(relayed, 'evil.com')).rejects.toThrow('different site');
    expect(calls).toEqual([]);
  });

  test('the right site and the wallet itself go through', async () => {
    const { m, calls } = make();
    await m.createSignature(relayed, 'good.com');
    await m.createSignature(relayed, 'admin.local');
    expect(calls).toEqual(['sig:good.com', 'sig:admin.local']);
  });
});

describe('sameSite: shared hosting and dot boundaries', () => {
  test('parent and subdomain match', () => {
    expect(sameSite('app.bchatx.com', 'bchatx.com')).toBe(true);
    expect(sameSite('bchatx.com', 'a.b.bchatx.com')).toBe(true);
  });
  test('siblings on shared suffixes are different sites', () => {
    expect(sameSite('evil.vercel.app', 'good.vercel.app')).toBe(false);
    expect(sameSite('evil.github.io', 'good.github.io')).toBe(false);
    expect(sameSite('evil.co.uk', 'good.co.uk')).toBe(false);
  });
  test('no match without a dot boundary', () => {
    expect(sameSite('notbchatx.com', 'bchatx.com')).toBe(false);
    expect(sameSite('bchatx.com', 'notbchatx.com')).toBe(false);
  });
  test('relays between shared-hosting siblings are refused', () => {
    for (const [evil, good] of [
      ['evil.vercel.app', 'good.vercel.app'],
      ['evil.github.io', 'good.github.io'],
      ['evil.co.uk', 'good.co.uk'],
      ['notbchatx.com', 'bchatx.com'],
    ])
      expect(crossSiteSignRefusal(evil, sig(JSON.stringify({ domain: good })))).not.toBeNull();
  });
});

describe('b-Aware 24-25 Oct: encoded and blind challenges', () => {
  const msg = 'good.example wants you to sign in with your Bitcoin account';
  const caller = 'https://evil.example';
  test('a challenge sent as base64 or hex is read and checked', () => {
    expect(crossSiteSignRefusal(caller, { data: bytes(btoa(msg)) })).toContain('good.example');
    const hex = Array.from(new TextEncoder().encode(msg), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(crossSiteSignRefusal(caller, { data: bytes(hex) })).toContain('good.example');
    expect(crossSiteSignRefusal(caller, { data: bytes(`{"challenge":"${btoa(msg)}"}`) })).toContain('good.example');
  });
  test('JSON escapes and percent-encoding do not hide the site', () => {
    expect(crossSiteSignRefusal(caller, { data: bytes('{"\\u0064omain":"good\\u002eexample"}') })).toContain(
      'good.example',
    );
    expect(crossSiteSignRefusal(caller, { data: bytes('domain%3Dgood.example') })).toContain('good.example');
  });
  test('a hash to sign blind is refused for outside callers', () => {
    expect(crossSiteSignRefusal(caller, { hashToDirectlySign: [1, 2, 3] })).toBe(BLIND_SIGN_REFUSAL);
  });
  test('our chat sites may sign a hash (bChatX AIP posts), look-alikes and parents may not', () => {
    for (const ok of [
      'https://bchatx.com',
      'https://www.bchatx.com',
      'https://chat.bwalletx.com',
      'https://bit-sign.online',
    ])
      expect(crossSiteSignRefusal(ok, { hashToDirectlySign: [1, 2, 3] })).toBeNull();
    for (const bad of [
      'https://bwalletx.com',
      'https://evilbchatx.com',
      'https://bchatx.com.evil.io',
      'https://web.bwalletx.com',
    ])
      expect(crossSiteSignRefusal(bad, { hashToDirectlySign: [1, 2, 3] })).toBe(BLIND_SIGN_REFUSAL);
  });
  test('the caller signing its own encoded challenge, and plain posts, still work', () => {
    expect(crossSiteSignRefusal('https://good.example', { data: bytes(btoa(msg)) })).toBeNull();
    expect(crossSiteSignRefusal(caller, { data: bytes('hello world, a plain post') })).toBeNull();
  });
});

describe('b-Aware 25 Oct (yudhaekasaputra1, widiaaw382): the guard fails closed for outside callers', () => {
  test('a site-bound message over 64 KB is refused, not waved through', () => {
    const big = 'good.com wants you to sign in\n' + 'x'.repeat(70 * 1024);
    expect(crossSiteSignRefusal('evil.com', sig(big))).not.toBeNull();
    // Even one naming no site: the wallet can't read it, so it can't say it names none.
    expect(crossSiteSignRefusal('good.com', sig('y'.repeat(70 * 1024)))).not.toBeNull();
  });

  test('data that is not a byte array is refused', () => {
    const msg = JSON.stringify({ domain: 'good.com' });
    expect(crossSiteSignRefusal('evil.com', { data: msg })).not.toBeNull();
    expect(crossSiteSignRefusal('evil.com', { data: { 0: 1, length: 1 } })).not.toBeNull();
    expect(crossSiteSignRefusal('evil.com', { data: new Uint8Array(bytes(msg)) })).not.toBeNull();
  });

  test('IP-literal and localhost sites in the message are bindings', () => {
    for (const msg of [
      '10.0.0.5 wants you to sign in',
      JSON.stringify({ domain: '192.168.1.20' }),
      JSON.stringify({ origin: 'http://localhost:3000' }),
      'localhost wallet login: 0123abcd',
    ]) {
      expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
    }
    expect(crossSiteSignRefusal('10.0.0.5', sig('10.0.0.5 wants you to sign in'))).toBeNull();
    expect(
      crossSiteSignRefusal('http://localhost:3000', sig(JSON.stringify({ origin: 'http://localhost:3000' }))),
    ).toBeNull();
  });

  test('a caller with no parsable host gets nothing that names a site', () => {
    const login = 'good.com wants you to sign in';
    expect(crossSiteSignRefusal('intranet', sig(login))).not.toBeNull();
    expect(crossSiteSignRefusal('intranet', { hashToDirectlySign: [1, 2, 3] })).toBe(BLIND_SIGN_REFUSAL);
    expect(crossSiteSignRefusal('intranet', sig('bwx-podcast:42:nonce'))).toBeNull();
  });
});

describe('b-Aware 28 Oct (Jacob Anderson, 0qu5xz): more login wordings bind the site', () => {
  const unproven = `good.com.c${'ab'.repeat(22)}.paired.invalid`;
  test.each([
    'Sign into good.com\nNonce: 8f2a',
    'Log onto good.com with your wallet. Nonce: 8f2a',
    'good.com - sign in\nNonce: 8f2a',
    'good.com: login request 8f2a',
    'Welcome to good.com! Sign this message. Nonce: 8f2a',
    'Verify your identity for good.com (nonce 8f2a)',
    'Authenticate with good.com\nNonce: 8f2a',
    'Connect to good.com — nonce 8f2a',
    'good.com requests authentication. Nonce: 8f2a',
  ])('%p: refused from evil.com and an unproven pairing, allowed from good.com', (msg) => {
    expect(crossSiteSignRefusal('evil.com', sig(msg))).toContain('different site');
    expect(crossSiteSignRefusal('good.com', sig(msg))).toBeNull();
    setProvenPairingCheck(() => false);
    expect(crossSiteSignRefusal(unproven, sig(msg))).toContain('did not prove its site');
  });

  test('a plain mention of a site is not a binding', () => {
    expect(crossSiteSignRefusal('evil.com', sig('Read this on good.com'))).toBeNull();
    expect(boundHosts('Read this on good.com')).toEqual([]);
  });
});

describe('TERRORNODE audit 29 Oct: bit-sign login wording on tokenblaster (www vs apex)', () => {
  const login = (host: string) =>
    bytes(`Sign in to ${host} with bWallet\nNonce: ${'a1'.repeat(16)}\nIssued At: 2026-10-29T10:00:00.000Z`);
  test('the named host matches the caller: www. and apex count as the same site, both ways', () => {
    for (const caller of ['https://www.tokenblaster.lol', 'https://tokenblaster.lol', 'www.tokenblaster.lol'])
      for (const named of ['www.tokenblaster.lol', 'tokenblaster.lol'])
        expect(crossSiteSignRefusal(caller, { data: login(named) })).toBeNull();
  });
  test('any other named host is still refused', () => {
    for (const named of ['evil.com', 'tokenblaster.lol.evil.com', 'wwwtokenblaster.lol', 'tokenblaster.lo'])
      expect(crossSiteSignRefusal('https://www.tokenblaster.lol', { data: login(named) })).toMatch(/different site/);
    expect(crossSiteSignRefusal('https://evil.com', { data: login('www.tokenblaster.lol') })).toMatch(/different site/);
  });
});

describe('login wordings and camelCase keys (b-Aware 29 Oct, squ11z1)', () => {
  const cases = [
    'Sign in with victim.example',
    'Continue with victim.example',
    'Continue to victim.example',
    'Login via victim.example',
    'Log in with victim.example\nNonce: 1',
    'Sign-in using victim.example',
    'Sign up for victim.example',
    'victim.example wants to connect',
    'victim.example wants to sign you in',
    '{"redirectUrl":"https://victim.example/callback","nonce":"n"}',
    '{"callbackUrl":"https://victim.example/cb"}',
    '{"returnTo":"https://victim.example"}',
    '{"rpId":"victim.example"}',
    '{"relyingParty":"victim.example"}',
    '{"redirect-uri":"https://victim.example/cb"}',
    '{"RedirectURI":"https://victim.example/cb"}',
    '{"postLoginRedirect":"https://victim.example/"}',
    '{"appOrigin":"https://victim.example"}',
    '{"expectedDomain":"victim.example"}',
    'loginUrl=https://victim.example/x&nonce=1',
  ];
  test.each(cases)('%s: refused cross-site, allowed for its own site', (msg) => {
    expect(crossSiteSignRefusal('evil.com', sig(msg))).toContain('different site');
    expect(crossSiteSignRefusal('victim.example', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal('www.victim.example', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal('victim.example.paired.invalid', sig(msg))).not.toBeNull();
  });

  test('normaliseKey folds camel, Pascal, kebab and snake to one form', () => {
    for (const k of ['redirectUrl', 'RedirectUrl', 'redirect-url', 'redirect_url', 'REDIRECT_URL', 'redirectURL'])
      expect(normaliseKey(k)).toBe('redirect_url');
    expect(normaliseKey('returnTo')).toBe('return_to');
  });

  test('ordinary messages are unaffected', () => {
    for (const msg of [
      'Read this on victim.example',
      'look at https://victim.example/post/1',
      'I signed in yesterday, continue reading at victim.example',
      '{"text":"see https://victim.example","userId":"abc","createdAt":"2026-10-29"}',
      '{"subdomain":"victim.example","nonce":"n"}',
      'bwx-podcast:42:nonce',
    ])
      expect(crossSiteSignRefusal('evil.com', sig(msg))).toBeNull();
  });
});

describe('b-Aware triage 13 Nov: data that is not plain text is read leniently, not waved through', () => {
  const login = JSON.stringify({ domain: 'good.com', nonce: 'n1' });
  const padded = [...Array(400).fill(0x01), ...bytes(login)];
  const badUtf8 = [0xff, ...bytes(login)];
  const utf16 = (s: string) => Array.from(s).flatMap((c) => [c.charCodeAt(0), 0]);
  const unproven = `good.com.c${'ab'.repeat(22)}.paired.invalid`;

  test('control-byte padding or an invalid UTF-8 byte no longer hides the site (fails on the old guard)', () => {
    for (const data of [padded, badUtf8, utf16(login), [0x00, 0xc3, ...bytes('good.com wants you to sign in')]]) {
      const r = crossSiteSignRefusal('evil.com', { data });
      expect(r).toContain('different site');
      expect(r).toContain('good.com');
      expect(r).toContain('not plain text');
      // The site it names may still sign it, and so may a subdomain.
      expect(crossSiteSignRefusal('good.com', { data })).toBeNull();
      expect(crossSiteSignRefusal('https://app.good.com', { data })).toBeNull();
    }
  });

  test('base64 inside binary, an unparsable caller and an unproven pairing are covered too', () => {
    const b64 = [0xfe, 0x00, ...bytes(btoa('good.com wants you to sign in'))];
    expect(crossSiteSignRefusal('evil.com', { data: b64 })).toContain('good.com');
    expect(crossSiteSignRefusal('intranet', { data: padded })).toContain('different site');
    setProvenPairingCheck(() => false);
    expect(crossSiteSignRefusal(unproven, { data: badUtf8 })).toContain('did not prove its site');
  });

  test('one matching name does not launder a foreign one in binary data', () => {
    const data = [0xff, ...bytes(JSON.stringify({ origin: 'good.com', domain: 'evil.com' }))];
    expect(crossSiteSignRefusal('good.com', { data })).toContain('evil.com');
  });

  // Callers that sign genuine binary must keep working.
  test('BRC-103/104 mutual-auth nonces still sign', () => {
    // initialResponse: the two 32-byte nonces concatenated.
    for (let seed = 1; seed <= 200; seed++)
      expect(crossSiteSignRefusal('https://app.example', { data: rand(64, seed) })).toBeNull();
  });

  test('hashes, keys and other high-entropy binary still sign', () => {
    for (let seed = 1; seed <= 50; seed++)
      expect(crossSiteSignRefusal('https://app.example', { data: rand(4096, seed) })).toBeNull();
    expect(crossSiteSignRefusal('https://app.example', { data: [0x02, ...rand(32, 99)] })).toBeNull();
  });

  test("bit-sign's seal record and an e2e envelope over binary still sign for bit-sign", () => {
    const record = JSON.stringify({
      v: 1,
      kind: 'nds-seal',
      docHash: 'ab'.repeat(32),
      signedAt: '2026-11-13T10:00:00Z',
    });
    expect(crossSiteSignRefusal('https://bit-sign.online', { data: bytes(record) })).toBeNull();
    expect(crossSiteSignRefusal('https://bit-sign.online', { data: [0xff, ...bytes(record)] })).toBeNull();
    expect(crossSiteSignRefusal('https://bit-sign.online', { data: [...rand(33, 3), ...rand(200, 4)] })).toBeNull();
  });
});

// Review of 13 Nov 2026 (s2): cost on crafted input, AuthFetch frames, and the readings the first fix missed.
describe('review 13 Nov: the scan is linear and bounded (A1)', () => {
  const M = MAX_SIGN_DATA;
  const fill = (s: string, n: number) =>
    Array.from(s.repeat(Math.ceil(n / s.length)).slice(0, n), (c) => c.charCodeAt(0) & 0xff);
  const worst: [string, number[]][] = [
    // 70.5 s on the first fix, 4.5 s for plain text on the guard before it.
    ['0xff 0x85 + escapes + 64K a', [0xff, 0x85, ...fill('\\u0041%41', 10), ...fill('a', M - 12)]],
    ['64K a', fill('a', M)],
    ['0xff + 64K a', [0xff, ...fill('a', M - 1)]],
    ['controls + a', [...Array(7000).fill(1), ...fill('a', M - 7000)]],
    ['words without separators', [0xff, ...fill('ab-cd_', M - 1)]],
    ['a. runs', [0xff, ...fill('a.', M - 1)]],
    ['host-ish lines', [0xff, ...fill('\na.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a1 sign', M - 1)]],
    ['NUL interleaved', [0xff, ...fill('a\0', M - 1)]],
    ['%41 runs', [0xff, ...fill('%41', M - 1)]],
    ['\\u0041 runs', [0xff, ...fill('\\u0041', M - 1)]],
    ['base64 tokens', [0xff, ...fill(btoa('aaaaaaaaaaaaaaaaaaaaaaaa') + ' ', M - 1)]],
    [
      'distinct base64 tokens',
      fill(Array.from({ length: 4000 }, (_, k) => btoa(String(k).padStart(14, 'q'))).join(' '), M),
    ],
    ['triple percent + controls + login words', fill('%25252F sign \x01 log : ', M)],
    ['& without ;', fill('&', M)],
    ['backslashes', fill('\\', M)],
    ['url=url=url=', fill('url=', M)],
    ['tabs inside URLs', fill('url=https://a\t', M)],
    ['sign in to a.a.a', fill('sign in to ' + 'a.'.repeat(300), M)],
    ['random', rand(M, 5)],
    // URL values read to the end of their authority (re-review N1).
    ['url=https:a dense', fill('url=https:a ', M)],
    ['quoted URL without a closing quote', fill('"url":"https:', M)],
    ['escaped quoted URLs', fill('url="https:\\\\', M)],
    ['XML URL fields', fill('<url>https:', M)],
    ['Ruby hash keys', fill('"domain"=>"', M)],
  ];
  test.each(worst)('%s: within the character budget and fast', (_name, data) => {
    const { chars } = scanSignData(new Uint8Array(data));
    expect(chars).toBeLessThanOrEqual(MAX_SCAN_CHARS);
    const t = performance.now();
    crossSiteSignRefusal('https://app.example', { data });
    // Measured 2-17 ms on an M-series Mac; the bound is generous so a loaded test machine doesn't flake.
    expect(performance.now() - t).toBeLessThan(250);
  });

  test('more reading than the budget allows is refused, not signed', () => {
    const bomb = gzipSync(new Uint8Array(20_000_000), { level: 9 });
    expect(crossSiteSignRefusal('https://app.example', { data: Array.from(bomb) })).toContain('too much encoded data');
  });
});

describe('review 13 Nov: AuthFetch (BRC-104) frames sign under the BRC-103 protocol only (A2, N2, N3)', () => {
  // The exact framing of @bsv/sdk AuthFetch.serializeRequest / SimplifiedFetchTransport responses.
  const opt = (w: InstanceType<typeof Utils.Writer>, v?: string) => {
    if (!v) return w.writeVarIntNum(-1);
    const b = Utils.toArray(v, 'utf8');
    w.writeVarIntNum(b.length);
    w.write(b);
  };
  const request = (method: string, path: string, search: string, headers: [string, string][], body?: string) => {
    const w = new Utils.Writer();
    w.write(rand(32, 11));
    w.writeVarIntNum(method.length);
    w.write(Utils.toArray(method));
    opt(w, path);
    opt(w, search);
    w.writeVarIntNum(headers.length);
    for (const [k, v] of headers) {
      opt(w, k);
      opt(w, v);
    }
    opt(w, body);
    return w.toArray();
  };
  const response = (status: number, headers: [string, string][], body?: string) => {
    const w = new Utils.Writer();
    w.write(rand(32, 12));
    w.writeVarIntNum(status);
    w.writeVarIntNum(headers.length);
    for (const [k, v] of headers) {
      opt(w, k);
      opt(w, v);
    }
    opt(w, body);
    return w.toArray();
  };
  const json: [string, string][] = [['content-type', 'application/json']];
  const signs = (data: number[]) =>
    crossSiteSignRefusal('https://app.example', { protocolID: [2, 'auth message signature'], data });

  test.each([
    [
      'imageUrl on a CDN',
      request(
        'POST',
        '/api/posts',
        '',
        json,
        JSON.stringify({ text: 'hi', imageUrl: 'https://cdn.othercdn.net/a.png' }),
      ),
    ],
    [
      'webhook_url',
      request('POST', '/api/jobs', '', json, JSON.stringify({ webhook_url: 'https://hooks.zapier.com/x' })),
    ],
    ['?url= link preview', request('GET', '/api/preview', '?url=https%3A%2F%2Fyoutube.com%2Fwatch', [])],
    [
      'link.url',
      request(
        'POST',
        '/api/bookmark',
        '',
        json,
        JSON.stringify({ link: { url: 'https://en.wikipedia.org/wiki/Bitcoin' } }),
      ),
    ],
    [
      'origin of an import',
      request('POST', '/api/import', '', json, JSON.stringify({ origin: 'https://github.com/foo/bar' })),
    ],
    [
      'a free link in text',
      request('POST', '/api/v1/post', '', json, JSON.stringify({ text: 'hello, see https://news.example/a' })),
    ],
    ['an empty GET (path/search/body absent)', request('GET', '', '', [])],
    [
      'a bearer token naming its audience',
      request('GET', '/me', '', [['authorization', `Bearer x.${btoa('{"aud":"api.other.example"}')}.y`]]),
    ],
    [
      'a response with a redirect field',
      response(200, [['x-bsv-payment-version', '1.0']], JSON.stringify({ redirect: 'https://pay.example/r' })),
    ],
  ])('%s: signs (as on the guard before the fix)', (_name, data) => {
    expect(signs(data)).toBeNull();
  });

  test.each([
    ['a domain field', request('POST', '/login', '', json, JSON.stringify({ domain: 'good.com', nonce: 'n' }))],
    ['a login line', request('POST', '/x', '', json, JSON.stringify({ message: 'good.com wants you to sign in' }))],
    ['?audience=', request('GET', '/token', '?audience=good.com', [])],
    ['an rpId', request('POST', '/webauthn', '', json, JSON.stringify({ rpId: 'good.com' }))],
    // N3: real bodies with fields that would bind in a login challenge.
    [
      'a profile website',
      request('POST', '/api/profile', '', json, JSON.stringify({ name: 'Bob', website: 'https://bob.dev' })),
    ],
    [
      'a DNS record host',
      request(
        'POST',
        '/api/records',
        '',
        json,
        JSON.stringify({ type: 'A', host: 'www.mydomain.org', value: '1.2.3.4' }),
      ),
    ],
    ['?domain= whois', request('GET', '/api/whois', '?domain=example.org', [])],
    [
      'a bookmarked site',
      request('POST', '/api/bookmarks', '', json, JSON.stringify({ site: 'news.ycombinator.com' })),
    ],
  ])('%s: signs under auth message signature (a BRC-103 peer reads no site names)', (_name, data) => {
    expect(signs(data)).toBeNull();
    // Under any other protocol the same bytes are just data and are read whole.
    expect(crossSiteSignRefusal('https://app.example', { protocolID: [2, 'good login'], data })).toContain(
      'different site',
    );
  });

  // N2: under another protocol a frame-shaped message hides nothing in its nonce, headers or path.
  const raw = (s: string) => Array.from(new TextEncoder().encode(s));
  const vi = (n: number) => (n < 0xfd ? [n] : [0xfd, n & 0xff, n >> 8]);
  const str = (s: string) => [...vi(raw(s).length), ...raw(s)];
  const ABSENT = Array(9).fill(0xff);
  const fake = (nonce: number[], path: string | null, headers: [string, string][], body: string | null) => [
    ...nonce,
    ...str('POST'),
    ...(path === null ? ABSENT : str(path)),
    ...ABSENT,
    ...vi(headers.length),
    ...headers.flatMap(([k, v]) => [...str(k), ...str(v)]),
    ...(body === null ? ABSENT : str(body)),
  ];
  const A = Array(32).fill(0x41);
  test.each([
    ['domain=good.com in the nonce', fake(raw(' domain=good.com '.padEnd(32, ' ')), '/', [], '')],
    ['a domain in an x-bsv header', fake(A, '/', [['x-bsv-note', '{"domain":"good.com","nonce":"n"}']], '')],
    ['a login line in authorization', fake(A, '/', [['authorization', 'good.com wants you to sign in']], '')],
    ['a domain in the path', fake(A, '/login;domain=good.com', [], '')],
    ['a domain in the body', fake(A, '/', [], JSON.stringify({ domain: 'good.com' }))],
    ['a response with a domain header', [...A, 200, 1, ...str('x-bsv-a'), ...str('domain: good.com'), ...ABSENT]],
  ])('frame-shaped %s under a login protocol: refused for evil.com', (_name, data) => {
    expect(crossSiteSignRefusal('https://evil.com', { protocolID: [2, 'good login'], data })).toContain('good.com');
    expect(crossSiteSignRefusal('https://evil.com', { data })).toContain('good.com');
  });

  test('data that only looks like a frame is read whole, with every binding key', () => {
    const frame = request('POST', '/x', '', json, JSON.stringify({ redirect_uri: 'https://good.com/cb' }));
    expect(signs([...frame, 0x00])).toContain('good.com'); // a trailing byte: not exactly one frame
  });
});

describe('review 13 Nov: readings the first fix missed (A3, A4)', () => {
  const login = JSON.stringify({ domain: 'good.com', nonce: 'n1' });
  const lat = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const b64 = (a: number[]) => btoa(String.fromCharCode(...a));
  const hex = (a: number[]) => a.map((b) => b.toString(16).padStart(2, '0')).join('');
  const utf16le = (s: string) => Array.from(s).flatMap((c) => [c.charCodeAt(0), 0]);
  const utf16be = (s: string) => Array.from(s).flatMap((c) => [0, c.charCodeAt(0)]);
  const utf32le = (s: string) => Array.from(s).flatMap((c) => [c.charCodeAt(0), 0, 0, 0]);
  test.each([
    ['domain split by 0x01 in text', lat('{"domain":"go\x01od.com","nonce":"n1"}')],
    ['domain split by NUL in text', lat('{"domain":"go\x00od.com","nonce":"n1"}')],
    ['ASCII padding + a UTF-16LE login', [...bytes('x'.repeat(400)), ...utf16le(login)]],
    ['UTF-16LE login', utf16le(login)],
    ['UTF-16BE login with a BOM', [0xfe, 0xff, ...utf16be(login)]],
    ['UTF-32LE login', utf32le(login)],
    ['a stray % after a percent-encoded redirect', bytes('redirect_uri=https%3A%2F%2Fgood.com%2Fcb&note=100%')],
    ['base64 of (0xff + login) in JSON', bytes(JSON.stringify({ token: b64([0xff, ...bytes(login)]) }))],
    ['base64 of (0xff + login) after token=, in binary', [0xff, ...bytes('token=' + b64([0xff, ...bytes(login)]))]],
    ['hex of (0xff + login)', bytes('token=' + hex([0xff, ...bytes(login)]))],
    ['base64 of a UTF-16 login', bytes('token=' + b64(utf16le(login)))],
    ['gzip of the login', Array.from(gzipSync(bytes(login) as unknown as Uint8Array))],
    ['zlib of the login', Array.from(zlibSync(Uint8Array.from(bytes(login))))],
    ['uri https:\\\\good.com', bytes(JSON.stringify({ uri: 'https:\\good.com/login', nonce: 'n' }))],
    ['uri https:/good.com', bytes(JSON.stringify({ uri: 'https:/good.com/login', nonce: 'n' }))],
    ['uri https:good.com', bytes(JSON.stringify({ uri: 'https:good.com/login', nonce: 'n' }))],
    ['uri with a tab in the host', bytes(JSON.stringify({ uri: 'https://go\tod.com/login', nonce: 'n' }))],
    ['uri //good.com', bytes(JSON.stringify({ uri: '//good.com/login', nonce: 'n' }))],
    ['an HTML entity for the dot', bytes('domain: good&#46;com')],
    ['a mixed-case key', bytes('{"DoMaIn":"good.com"}')],
    ['JSON nested in a JSON string', bytes(JSON.stringify({ payload: JSON.stringify({ domain: 'good.com' }) }))],
    ['a field after another in a query string', bytes('note=1&domain=good.com')],
    ['0xff + \\u-escaped key', [0xff, ...bytes('{"\\u0064omain":"good\\u002ecom"}')]],
  ])('%s: refused for evil.com, allowed for good.com', (_name, data) => {
    expect(crossSiteSignRefusal('https://evil.com', { data })).toContain('good.com');
    expect(crossSiteSignRefusal('https://good.com', { data })).toBeNull();
  });

  test('a Unicode (IDN) domain is compared in punycode', () => {
    const data = bytes(JSON.stringify({ domain: 'bücher.de' }));
    expect(crossSiteSignRefusal('https://evil.com', { data })).toContain('xn--bcher-kva.de');
    expect(crossSiteSignRefusal('https://xn--bcher-kva.de', { data })).toBeNull();
  });

  test('bareHost reads URLs the way a URL parser does', () => {
    for (const v of [
      'https:\\\\good.com',
      'https:/good.com',
      'https:good.com',
      'https://go\tod.com',
      '//good.com/x',
      'https://u:p@good.com:8443/x',
      'GOOD.COM.',
      'good.com:443',
    ])
      expect(bareHost(v)).toBe('good.com');
    expect(bareHost('mailto:a@good.com')).toBeNull();
    expect(bareHost('note')).toBeNull();
  });

  test('a line break still ends a value in line-based challenges', () => {
    const msg = 'Sign in to www.bchatx.com with bWallet\nOrigin: https://www.bchatx.com\nNonce: abc';
    expect(crossSiteSignRefusal('https://www.bchatx.com', { data: bytes(msg) })).toBeNull();
    expect(
      crossSiteSignRefusal('https://www.bchatx.com', { data: bytes(JSON.stringify({ message: msg })) }),
    ).toBeNull();
  });
});

// Re-review of 13 Nov 2026 (N1, N4, N5).
describe('re-review 13 Nov: a URL host is read as a URL parser reads it (N1)', () => {
  const urls = [
    'https://evil.com&@good.com/login',
    'https://a&b@good.com/login',
    'https://evil.com;@good.com/',
    'https://evil.com|@good.com/',
    'https://evil.com,@good.com/',
    'https://evil.com<@good.com/',
    'https://evil.com @good.com/',
    "https://evil.com'@good.com/",
    'https://evil.com`@good.com/',
    'https://evil.com}@good.com/',
    'https://evil.com]@good.com/',
    'https://u@evil.com@good.com/',
    'https://user:pa&ss@good.com/x',
    'https://evil.com?@good.com/', // the parser says evil.com
    'https://evil.com#@good.com/', // evil.com
    'https:evil.com&@good.com',
    '//evil.com&@good.com/x',
  ];
  test.each(urls)('%s: the guard and new URL() agree on the host', (url) => {
    const host = new URL(url.startsWith('//') ? `https:${url}` : url).hostname;
    // Quoted (JSON): exactly the parser's host.
    const json = bytes(JSON.stringify({ uri: url, nonce: 'n' }));
    expect(crossSiteSignRefusal(`https://${host}`, { data: json })).toBeNull();
    expect(crossSiteSignRefusal('https://other.example', { data: json })).toContain(host);
    // Unquoted (a form, a text line): the parser's host always counts; a form parser's split may name another too.
    for (const data of [bytes(`redirect_uri=${encodeURIComponent(url)}&state=1`), bytes(`uri=${url}`)]) {
      expect(scanSignData(new Uint8Array(data)).hosts).toContain(host);
      expect(crossSiteSignRefusal('https://other.example', { data })).not.toBeNull();
    }
  });
  test('an escaped quote in the userinfo: the parser host is named (the decoded pass also names evil.com)', () => {
    const data = bytes(JSON.stringify({ uri: 'https://evil.com"@good.com/', nonce: 'n' }));
    expect(crossSiteSignRefusal('https://evil.com', { data })).toContain('good.com');
  });
  test('the form from the review: redirect_uri=https%3A%2F%2Fevil.com%26%40good.com%2Fcb', () => {
    const data = bytes('redirect_uri=https%3A%2F%2Fevil.com%26%40good.com%2Fcb&state=1');
    expect(crossSiteSignRefusal('https://evil.com', { data })).toContain('good.com');
  });
  test('a long userinfo does not push the host out of reach', () => {
    const url = `https://evil.com${'x'.repeat(5000)}@good.com/login`;
    for (const data of [
      bytes(JSON.stringify({ uri: url })),
      bytes(`uri=${url}`),
      bytes(`redirect_uri=${encodeURIComponent(url)}`),
    ])
      expect(scanSignData(new Uint8Array(data)).hosts).toContain('good.com');
  });
  test('a later email on the same JSON line is not a URL host', () => {
    const data = bytes(JSON.stringify({ uri: 'https://good.com', email: 'me@x.example', nonce: 'n' }));
    expect(crossSiteSignRefusal('https://good.com', { data })).toBeNull();
  });
});

describe('re-review 13 Nov: more spellings (N5)', () => {
  test.each([
    ['a Ruby hash', bytes('{"domain"=>"good.com", "nonce"=>"n"}')],
    ['XML <Audience>', bytes('<Assertion><Audience>good.com</Audience><Nonce>n</Nonce></Assertion>')],
    ['XML <domain>', bytes('<login><domain>good.com</domain></login>')],
    ['five %25 layers', bytes('domain=good%25252525252Ecom')],
    ['an IDN in a login line', bytes('Sign in to bücher.de\nNonce: 1')],
    ['a zero-width character in the key', bytes(JSON.stringify({ ['dom​ain']: 'good.com' }))],
    ['an ideographic full stop', bytes(JSON.stringify({ domain: 'good。com' }))],
  ])('%s: refused for evil.com', (_name, data) => {
    expect(crossSiteSignRefusal('https://evil.com', { data })).not.toBeNull();
  });
  test('own-site messages from the review still sign', () => {
    const own: [string, string][] = [
      [
        'good.com',
        'good.com wants you to sign in with your Bitcoin account:\n1abc\n\nURI: https://good.com/login\nVersion: 1\nNonce: 32891756\nIssued At: 2026-11-13T10:00:00Z',
      ],
      [
        'https://app.good.com',
        JSON.stringify({ domain: 'good.com', redirect_uri: 'https://app.good.com/cb?x=1&y=2#frag', nonce: 'n' }),
      ],
      ['https://good.com', 'client_id=abc&redirect_uri=https%3A%2F%2Fgood.com%2Fcb&state=xyz%ZZ&scope=openid+profile'],
      [
        'https://bit-sign.online',
        JSON.stringify({
          v: 1,
          kind: 'nds-seal',
          docHash: 'ab'.repeat(32),
          signer: '$b0ase',
          signedAt: '2026-11-13T10:00:00Z',
          origin: 'https://bit-sign.online',
        }),
      ],
      [
        'https://bchatx.com',
        '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAutcheck this https://youtube.com/watch?v=abctext/markdownUTF-81PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5SETappbchatx.comtypepostcontexturlurlhttps://youtube.com/watch?v=abc',
      ],
      ['https://bchatx.com', 'SET app bchatx.com type like context url url https://youtube.com/watch'],
      ['https://good.com', JSON.stringify({ uri: 'https://user:pa&ss@good.com/x' })],
    ];
    for (const [caller, msg] of own) expect(crossSiteSignRefusal(caller, { data: bytes(msg) })).toBeNull();
  });
});

describe('re-review 13 Nov: random binary is not read as naming a site (N4)', () => {
  // xorshift32: reproducible, better spread than the LCG above.
  const xs = (seed: number) => {
    let x = seed >>> 0 || 1;
    return (n: number) =>
      Array.from({ length: n }, () => {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x & 0xff;
      });
  };
  test('4,000 random 4 KB blobs and 300 random 64 KB blobs: none refused', () => {
    let refused = 0;
    const examples: string[] = [];
    const r = xs(20261113);
    for (let k = 0; k < 4300; k++) {
      const data = r(k < 4000 ? 4096 : MAX_SIGN_DATA);
      const why = crossSiteSignRefusal('https://app.example', { data });
      if (why) {
        refused++;
        if (examples.length < 3) examples.push(why);
      }
    }
    expect({ refused, examples }).toEqual({ refused: 0, examples: [] });
  }, 60_000);
  test('a gzip bomb is refused; a gzip of 200 KB of legitimate text is read', () => {
    expect(
      crossSiteSignRefusal('https://app.example', { data: Array.from(gzipSync(new Uint8Array(10_000_000))) }),
    ).toContain('too much encoded data');
    const log = new TextEncoder().encode('log line number something happened ok\n'.repeat(5500));
    expect(crossSiteSignRefusal('https://app.example', { data: Array.from(gzipSync(log)) })).toBeNull();
  });
});
