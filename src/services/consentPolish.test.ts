/**
 * Consent polish after the review of 1020b69c (13 Nov 2026):
 *  1. The SIGN ONCE card never says "No money moves" (a BitPlan token can deposit, start a checkout, spend credits),
 *     shows the protocol name, uses the careful card's plain style, stays one tap, and offers Block this site.
 *  2. A "Not now" to a one-signature request stands for the site's registrable domain for 3 minutes, survives a
 *     service worker restart (chrome.storage.session), and one-signature sheets are capped per minute overall.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ONCE_DENIAL_MS, ONCE_SHEETS_PER_MINUTE, OnceDenials, onceSiteKey } from './sessionDenials';

const root = join(import.meta.dir, '..');
const sheet = readFileSync(join(root, 'pages', 'requests', 'BundleSheet.tsx'), 'utf8');
const bg = readFileSync(join(root, 'background.ts'), 'utf8');
const signOnce = sheet.slice(
  sheet.indexOf("} else if (kind === 'signonce') {"),
  sheet.indexOf("} else if (kind === 'private') {"),
);

describe('the SIGN ONCE card', () => {
  test('never says no money moves', () => {
    expect(signOnce.length).toBeGreaterThan(0);
    expect(signOnce).not.toMatch(/No money moves/);
  });
  test('shows the protocol name on its face, and keeps the warning words', () => {
    expect(signOnce).toContain('data-testid="sign-once-protocol"');
    expect(signOnce).toContain('request.items[0]?.protocolID?.[1]');
    expect(signOnce).toContain('Other sites could accept it as you. Only sign if you trust {name}.');
  });
  test('careful style (red tone), one tap on "Sign once", with Not now and Block this site', () => {
    expect(sheet).toContain("tone={careful || kind === 'signonce' ? 'red' : 'gold'}");
    expect(sheet).toContain("tertiary={careful || kind === 'signonce' ? block : undefined}");
    // The main button is still allow ("Sign once"), not the careful card's Not now.
    expect(sheet).toContain('primary={careful ? deny : allow}');
    expect(sheet).toMatch(
      /kind === 'signonce'\s*\?\s*request\.items\[0\]\?\.usageType === 'hmac'\s*\?\s*'Allow once'\s*:\s*'Sign once'/,
    );
  });
});

describe('a "Not now" to a one-signature request stands for 3 minutes', () => {
  const memStore = () => {
    let saved: [string, number][] = [];
    return {
      saved: () => saved,
      store: {
        load: async () => saved,
        save: async (e: [string, number][]) => void (saved = e.map((x) => [...x] as [string, number])),
      },
    };
  };
  test('per registrable domain, for ONCE_DENIAL_MS, then the site may ask again', async () => {
    let now = 1_000;
    const d = new OnceDenials(undefined, () => now);
    await d.note('evil.example');
    expect(ONCE_DENIAL_MS).toBe(3 * 60_000);
    for (const o of ['evil.example', 'EVIL.example:443', 'a.evil.example', 'x.y.evil.example', 'evil.example:8443'])
      expect(await d.active(o)).toBe(true);
    expect(await d.active('good.example')).toBe(false);
    now += ONCE_DENIAL_MS - 1;
    expect(await d.active('b.evil.example')).toBe(true);
    now += 1;
    expect(await d.active('evil.example')).toBe(false);
  });
  test('survives a service worker restart (chrome.storage.session)', async () => {
    const { store, saved } = memStore();
    let now = 5_000;
    await new OnceDenials(store, () => now).note('a.evil.example');
    expect(saved().length).toBe(1);
    const restarted = new OnceDenials(store, () => now);
    expect(await restarted.active('b.evil.example')).toBe(true);
    now += ONCE_DENIAL_MS;
    expect(await restarted.active('b.evil.example')).toBe(false);
  });
  test('Forget site and opening Permissions clear it (stored copy too)', async () => {
    const { store, saved } = memStore();
    const d = new OnceDenials(store);
    await d.note('a.example');
    await d.note('b.example');
    await d.forget('www.a.example');
    expect(await d.active('a.example')).toBe(false);
    expect(await d.active('b.example')).toBe(true);
    await d.clear();
    expect(await d.active('b.example')).toBe(false);
    expect(saved()).toEqual([]);
  });
  test('onceSiteKey: registrable domain, but one site per shared-hosting host or pairing', () => {
    expect(onceSiteKey('https://a.b.evil.example')).toBe('evil.example');
    expect(onceSiteKey('shop.example.co.uk')).toBe('example.co.uk');
    expect(onceSiteKey('one.vercel.app')).toBe('one.vercel.app');
    expect(onceSiteKey('x.one.vercel.app')).toBe('one.vercel.app');
    expect(onceSiteKey('user.github.io')).toBe('user.github.io');
    expect(onceSiteKey('bchatx.com.c' + 'ab'.repeat(22) + '.paired.invalid')).toBe(
      'bchatx.com.c' + 'ab'.repeat(22) + '.paired.invalid',
    );
    expect(onceSiteKey('localhost:3000')).toBe('localhost');
    expect(onceSiteKey('10.0.0.5')).toBe('10.0.0.5');
  });
  test('at most ONCE_SHEETS_PER_MINUTE one-signature sheets a minute, all sites together', () => {
    let now = 0;
    const d = new OnceDenials(undefined, () => now);
    for (let i = 0; i < ONCE_SHEETS_PER_MINUTE; i++) expect(d.allowSheet()).toBe(true);
    expect(d.allowSheet()).toBe(false);
    now += 60_000;
    expect(d.allowSheet()).toBe(true);
  });

  test('background: a refused one-signature request is remembered on both answer paths', () => {
    const bundle = bg.slice(bg.indexOf('const processBundlePermissionResponse'));
    const denied = bundle.slice(bundle.indexOf('...result.denied.map('));
    expect(denied.slice(0, denied.indexOf('await wallet?.denyPermission(r.requestID);'))).toContain(
      'noteOnceDenial(r as BundleRequest);',
    );
    const single = bg.slice(bg.indexOf('const processPermissionResponse'));
    const no = single.slice(single.indexOf('} else {\n      noteBasketDenial(pending.request);'));
    expect(no.slice(0, no.indexOf('.denyPermission(response.requestID)'))).toContain(
      'noteOnceDenial(pending.request);',
    );
  });
  test('background: while it stands, the site gets no sheet (refused like a session basket No)', () => {
    const prompt = bg.slice(bg.indexOf('const showPermissionPrompt'));
    const check = prompt.slice(prompt.indexOf('const deniedThisSession ='), prompt.indexOf('if (denied) {'));
    expect(check).toContain('isOneUseRequestID(request.requestID)');
    expect(check).toContain('.active(normalizeOriginator(request.originator))');
    expect(check).toContain('!onceDenials.allowSheet()');
    const branch = prompt.slice(prompt.indexOf('if (denied) {'), prompt.indexOf('if (blocked) {'));
    expect(branch).toContain('reject(userDeniedError())');
  });
  test('background: Forget site and opening Permissions (from the wallet only) clear it', () => {
    expect(bg).toContain("['one-signature answers', () => onceDenials.forget(site)]");
    const list = bg.slice(bg.indexOf("case 'PERMISSIONS_LIST_ALL':"));
    expect(list.slice(0, list.indexOf('return true;'))).toContain('if (isFromExtension) void onceDenials.clear();');
    // Stored in chrome.storage.session, as the basket answers are.
    expect(bg).toContain('chrome.storage.session.set({ [ONCE_DENIALS_KEY]: entries })');
  });
});
