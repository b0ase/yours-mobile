import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FramePairs,
  FramedContext,
  FRAMED_TTL_MS,
  framePolicy,
  framedLabel,
  isFamilyPair,
  needsPairApproval,
  originLabel,
  pairKey,
} from './frameAccess';
import { SiteThemeFrame } from '../mobile/theme/SiteThemeFrame';
import { sheetCanTrust } from './permissionBundle';

const GAME = 'https://www.tokenblaster.lol';
const ROOM = 'https://www.bchatx.com/r/lounge';

describe('framePolicy (from Chrome sender only)', () => {
  it('leaves top frames to the existing rules', () => {
    expect(framePolicy({ frameId: 0, origin: 'http://x.test', tab: { url: 'http://x.test/' } })).toEqual({
      ok: true,
      framed: false,
    });
    expect(framePolicy(undefined)).toEqual({ ok: true, framed: false });
  });

  it('exposes the provider to an https frame under an https top', () => {
    expect(framePolicy({ frameId: 7, origin: GAME, documentLifecycle: 'active', tab: { url: ROOM } })).toEqual({
      ok: true,
      framed: true,
      frameHost: 'www.tokenblaster.lol',
      topHost: 'www.bchatx.com',
    });
  });

  it('refuses http frames, http tops and loopback inside frames', () => {
    expect(framePolicy({ frameId: 3, origin: 'http://www.tokenblaster.lol', tab: { url: ROOM } }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, origin: GAME, tab: { url: 'http://www.bchatx.com/' } }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, origin: 'http://localhost:3000', tab: { url: ROOM } }).ok).toBe(false);
  });

  it('refuses sandboxed (opaque "null"), data:, blob: and missing origins or tab URLs', () => {
    expect(framePolicy({ frameId: 3, origin: 'null', tab: { url: ROOM } }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, origin: 'data:text/html,x', tab: { url: ROOM } }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, origin: `blob:${GAME}/x`, tab: { url: ROOM } }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, origin: GAME }).ok).toBe(false);
    expect(framePolicy({ frameId: 3, tab: { url: ROOM } }).ok).toBe(false);
  });

  it('refuses prerendered or cached documents', () => {
    expect(framePolicy({ frameId: 3, origin: GAME, documentLifecycle: 'prerender', tab: { url: ROOM } }).ok).toBe(
      false,
    );
    expect(framePolicy({ frameId: 3, origin: GAME, documentLifecycle: 'cached', tab: { url: ROOM } }).ok).toBe(false);
  });

  it('ignores a page-supplied origin: only sender fields count', () => {
    const sender = {
      frameId: 4,
      origin: 'https://evil.example',
      tab: { url: 'https://evil-parent.example/' },
      // anything the page could have put in its message never reaches framePolicy
      originator: 'www.tokenblaster.lol',
      params: { domain: 'www.bchatx.com' },
    } as Parameters<typeof framePolicy>[0];
    expect(framePolicy(sender)).toEqual({
      ok: true,
      framed: true,
      frameHost: 'evil.example',
      topHost: 'evil-parent.example',
    });
  });
});

describe('pairs and family', () => {
  it('only read-only calls skip the pair question', () => {
    for (const a of ['getVersion', 'getNetwork', 'isAuthenticated', 'getPublicKey', 'listOutputs'])
      expect(needsPairApproval(a)).toBe(false);
    for (const a of [
      'createAction',
      'signAction',
      'createSignature',
      'encrypt',
      'decrypt',
      'createHmac',
      'acquireCertificate',
    ])
      expect(needsPairApproval(a)).toBe(true);
    expect(needsPairApproval(undefined)).toBe(true);
  });

  it('family-in-family pairs skip it; a stranger on either side does not', () => {
    expect(isFamilyPair('www.tokenblaster.lol', 'www.bchatx.com')).toBe(true);
    expect(isFamilyPair('www.tokenblaster.lol', 'evil.example')).toBe(false);
    expect(isFamilyPair('evil.example', 'www.bchatx.com')).toBe(false);
    expect(isFamilyPair('tokenblaster.lol.evil.example', 'bchatx.com')).toBe(false);
  });

  it('remembers approvals per (frame, top) pair, not per frame origin', async () => {
    let saved: string[] = [];
    const pairs = new FramePairs({ load: async () => [], save: async (k) => void (saved = k) });
    await pairs.add('game.example', 'room.example');
    expect(await pairs.has('game.example', 'room.example')).toBe(true);
    expect(await pairs.has('game.example', 'other.example')).toBe(false);
    expect(await pairs.has('room.example', 'game.example')).toBe(false);
    expect(saved).toEqual([pairKey('game.example', 'room.example')]);
    const again = new FramePairs({ load: async () => saved, save: async () => undefined });
    expect(await again.has('game.example', 'room.example')).toBe(true);
    await again.forgetFrame('game.example');
    expect(await again.has('game.example', 'room.example')).toBe(false);
  });

  it('notes recent parents per originator and expires them', () => {
    const c = new FramedContext();
    c.note('www.tokenblaster.lol', 'www.bchatx.com', 1000);
    expect(c.topsFor('www.tokenblaster.lol', 2000)).toEqual(['www.bchatx.com']);
    expect(c.framedByStranger('www.tokenblaster.lol', 2000)).toBe(false);
    c.note('www.tokenblaster.lol', 'evil.example', 3000);
    expect(c.framedByStranger('www.tokenblaster.lol', 3000)).toBe(true);
    expect(c.topsFor('www.tokenblaster.lol', 3000 + FRAMED_TTL_MS + 1)).toEqual([]);
  });

  it('the pair sheet can never set "Don\'t ask again"', () => {
    const items = [
      {
        requestID: 'r',
        type: 'protocol',
        originator: 'a.example',
        protocolID: [1, 'identity key retrieval'],
        framePair: 'b.example',
      },
    ];
    expect(sheetCanTrust({ items } as unknown as Parameters<typeof sheetCanTrust>[0])).toBe(false);
  });
});

describe('prompt text shows both origins', () => {
  it('labels', () => {
    expect(framedLabel('www.tokenblaster.lol', ['www.bchatx.com'])).toBe(
      'www.tokenblaster.lol (inside www.bchatx.com)',
    );
    expect(originLabel('www.tokenblaster.lol', ['www.bchatx.com'])).toBe(
      'www.tokenblaster.lol (inside www.bchatx.com)',
    );
    expect(originLabel('www.tokenblaster.lol')).toBe('www.tokenblaster.lol');
  });

  it('the sheet strip names both, and a framed sheet starts disarmed', () => {
    const html = renderToStaticMarkup(
      h(
        SiteThemeFrame,
        { originator: 'www.tokenblaster.lol', embeddedIn: ['www.bchatx.com'], theme: null },
        h('button', null, 'Allow'),
      ),
    );
    expect(html).toContain('www.tokenblaster.lol (inside www.bchatx.com)');
    expect(html).toContain('data-armed="false"');
    const top = renderToStaticMarkup(
      h(SiteThemeFrame, { originator: 'www.tokenblaster.lol', theme: null }, h('button', null, 'Allow')),
    );
    expect(top).not.toContain('(inside');
    expect(top).toContain('data-armed="true"');
  });
});

describe('manifest', () => {
  it('runs only the provider content scripts in frames, never about:blank', () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, '../../public/manifest.json'), 'utf8'));
    expect(m.content_scripts.length).toBe(2);
    for (const cs of m.content_scripts) {
      expect(cs.all_frames).toBe(true);
      expect(cs.match_about_blank).toBe(false);
    }
  });
});
