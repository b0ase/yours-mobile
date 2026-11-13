/**
 * Consent polish after the review of 1020b69c (13 Nov 2026):
 *  1. The SIGN ONCE card never says "No money moves" (a BitPlan token can deposit, start a checkout, spend credits),
 *     shows the protocol name, uses the careful card's plain style, stays one tap, and offers Block this site.
 *  2. A "Not now" to a one-signature request stands for the site for 10 minutes, so a site can't loop sheets.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ONCE_DENIAL_MS, OnceDenials } from './sessionDenials';

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
    expect(sheet).toMatch(/kind === 'signonce'\s*\?\s*'Sign once'/);
  });
});

describe('a "Not now" to a one-signature request stands for 10 minutes', () => {
  test('per site, for ONCE_DENIAL_MS, then the site may ask again', () => {
    let now = 1_000;
    const d = new OnceDenials(() => now);
    d.note('evil.example');
    expect(d.active('evil.example')).toBe(true);
    expect(d.active('EVIL.example:443')).toBe(true);
    expect(d.active('good.example')).toBe(false);
    now += ONCE_DENIAL_MS - 1;
    expect(d.active('evil.example')).toBe(true);
    now += 1;
    expect(d.active('evil.example')).toBe(false);
  });
  test('Forget site and opening Permissions clear it', () => {
    const d = new OnceDenials();
    d.note('a.example');
    d.note('b.example');
    d.forget('a.example');
    expect(d.active('a.example')).toBe(false);
    expect(d.active('b.example')).toBe(true);
    d.clear();
    expect(d.active('b.example')).toBe(false);
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
    expect(check).toContain('onceDenials.active(normalizeOriginator(request.originator))');
    const branch = prompt.slice(prompt.indexOf('if (denied) {'), prompt.indexOf('if (blocked) {'));
    expect(branch).toContain('reject(userDeniedError())');
  });
  test('background: Forget site and opening Permissions (from the wallet only) clear it', () => {
    expect(bg).toContain("['one-signature answers', () => onceDenials.forget(site)]");
    const list = bg.slice(bg.indexOf("case 'PERMISSIONS_LIST_ALL':"));
    expect(list.slice(0, list.indexOf('return true;'))).toContain('if (isFromExtension) onceDenials.clear();');
  });
});
