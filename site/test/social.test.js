const { describe, expect, test } = require('bun:test');
const social = require('../lib/social');

// Test-only values (not real credentials).
const ENV = { SOCIAL_SEAL_KEY: 'ab'.repeat(32), X_CLIENT_ID: 'test-client', X_CLIENT_SECRET: 'test-secret' };
const secret = 'phone-secret-0123456789';
const vh = social.sha256Hex(secret);

describe('Continue with X (bWalletX own OAuth)', () => {
  test('start: sealed state, PKCE, our callback', () => {
    const [s, r] = social.start({ provider: 'x', verifier_hash: vh }, ENV);
    expect(s).toBe(200);
    const u = new URL(r.authorizeUrl);
    expect(u.host).toBe('x.com');
    expect(u.searchParams.get('redirect_uri')).toBe('https://pay.bwallet.space/api/social/x/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(social.open(u.searchParams.get('state'), ENV).vh).toBe(vh);
    expect(social.start({ provider: 'x', verifier_hash: 'nope' }, ENV)[0]).toBe(400);
    expect(social.start({ provider: 'x', verifier_hash: vh }, { SOCIAL_SEAL_KEY: ENV.SOCIAL_SEAL_KEY })[0]).toBe(503);
  });

  test('callback → ticket that only opens with the secret', async () => {
    const [, r] = social.start({ provider: 'x', verifier_hash: vh }, ENV);
    const state = new URL(r.authorizeUrl).searchParams.get('state');
    const fakeX = async (url) => ({
      json: async () =>
        url.includes('/oauth2/token')
          ? { access_token: 'tok' }
          : { data: { id: '42', username: 'B0aseX', name: 'Richard', profile_image_url: 'https://pbs/x_normal.jpg' } },
    });
    const to = await social.callback('x', { state, code: 'c' }, ENV, fakeX);
    expect(to.startsWith('https://www.bwallet.space/social#')).toBe(true);
    const q = new URLSearchParams(to.split('#')[1]);
    const t = q.get('t');
    const p = social.openTicket(t, secret, ENV);
    expect(p).toMatchObject({ provider: 'x', name: 'b0asex', alias: 'b0asex.x', avatar: 'https://pbs/x_400x400.jpg' });
    expect(p).toMatchObject({ choose_handle: true, suggested_handle: 'b0asex' });
    // Never a handle from an email.
    expect(social.suggestedHandleFor('google', 'their.name@gmail.com')).toBeNull();
    expect(social.suggestedHandleFor('x', 'B0ase_X')).toBe('b0ase-x');
    expect(social.openTicket(t, 'wrong', ENV)).toBeNull();
    expect(social.openTicket(t, secret, ENV, Date.now() + social.TTL_MS + 1)).toBeNull();
    expect(social.openTicket(t.slice(0, -3) + 'AAA', secret, ENV)).toBeNull();
  });

  test('callback errors and tampered state go back to the app as errors', async () => {
    expect(await social.callback('x', { state: 'junk', code: 'c' }, ENV)).toContain('error=');
    const [, r] = social.start({ provider: 'x', verifier_hash: vh }, ENV);
    const state = new URL(r.authorizeUrl).searchParams.get('state');
    expect(await social.callback('x', { state, error: 'access_denied' }, ENV)).toContain('error=cancelled');
    expect(await social.callback('google', { state, code: 'c' }, ENV)).toContain('error=');
  });

  test('web return: lands on web.bwalletx.com in the same tab; anything else falls back to the app page', async () => {
    const stateOf = (body) => new URL(social.start(body, ENV)[1].authorizeUrl).searchParams.get('state');
    const fakeX = async (url) => ({
      json: async () =>
        String(url).includes('/token') ? { access_token: 'a' } : { data: { id: '1', username: 'B0aseX', name: 'B' } },
    });
    const web = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'web' }), code: 'c' },
      ENV,
      fakeX,
    );
    expect(web.startsWith('https://web.bwalletx.com/#')).toBe(true);
    expect(web).toContain('t=');
    const evil = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'https://evil.example/' }), code: 'c' },
      ENV,
      fakeX,
    );
    expect(evil.startsWith('https://www.bwallet.space/social#')).toBe(true);
    const cancelled = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'web' }), error: 'access_denied' },
      ENV,
    );
    expect(cancelled).toBe('https://web.bwalletx.com/#error=cancelled');
    const beta = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'beta' }), code: 'c' },
      ENV,
      fakeX,
    );
    expect(beta.startsWith('https://beta.bwalletx.com/#')).toBe(true);
    const testers = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'testers' }), code: 'c' },
      ENV,
      fakeX,
    );
    expect(testers.startsWith('https://bwalletx.com/testers#')).toBe(true);
    const desktop = await social.callback(
      'x',
      { state: stateOf({ provider: 'x', verifier_hash: vh, return_to: 'desktop' }), code: 'c' },
      ENV,
      fakeX,
    );
    expect(desktop.startsWith('https://desktop.bwalletx.com/#')).toBe(true);
  });
});

describe('Link your accounts: GitHub / LinkedIn (env-gated)', () => {
  test('providers reports only configured pairs; unconfigured start is 503', () => {
    expect(social.providers(ENV)).toEqual({ x: true, google: false, github: false, linkedin: false });
    expect(social.start({ provider: 'github', verifier_hash: vh }, ENV)[0]).toBe(503);
    expect(social.start({ provider: 'linkedin', verifier_hash: vh }, ENV)[0]).toBe(503);
    expect(social.start({ provider: 'facebook', verifier_hash: vh }, ENV)[0]).toBe(400);
  });

  test('github: our callback, ticket carries the login', async () => {
    const env = { ...ENV, GITHUB_CLIENT_ID: 'gh-test', GITHUB_CLIENT_SECRET: 'gh-secret' };
    const [s, r] = social.start({ provider: 'github', verifier_hash: vh }, env);
    expect(s).toBe(200);
    const u = new URL(r.authorizeUrl);
    expect(u.host).toBe('github.com');
    expect(u.searchParams.get('redirect_uri')).toBe('https://pay.bwallet.space/api/social/github/callback');
    const fake = async (url) => ({
      json: async () =>
        url.includes('access_token') ? { access_token: 'tok' } : { id: 7, login: 'Octo', name: 'Oc', avatar_url: 'a' },
    });
    const to = await social.callback('github', { state: u.searchParams.get('state'), code: 'c' }, env, fake);
    const p = social.openTicket(new URLSearchParams(to.split('#')[1]).get('t'), secret, env);
    expect(p).toMatchObject({ provider: 'github', id: '7', name: 'octo', alias: null, suggested_handle: null });
  });

  test('linkedin: opaque id, display name only', async () => {
    const env = { ...ENV, LINKEDIN_CLIENT_ID: 'li-test', LINKEDIN_CLIENT_SECRET: 'li-secret' };
    const [, r] = social.start({ provider: 'linkedin', verifier_hash: vh }, env);
    const state = new URL(r.authorizeUrl).searchParams.get('state');
    const fake = async (url) => ({
      json: async () => (url.includes('accessToken') ? { access_token: 'tok' } : { sub: 'abc', name: 'Rich B' }),
    });
    const to = await social.callback('linkedin', { state, code: 'c' }, env, fake);
    const p = social.openTicket(new URLSearchParams(to.split('#')[1]).get('t'), secret, env);
    expect(p).toMatchObject({ provider: 'linkedin', id: 'abc', display: 'Rich B', suggested_handle: null });
  });
});
