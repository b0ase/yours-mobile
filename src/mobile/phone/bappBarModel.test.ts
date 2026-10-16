import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BAPP_BARS, BAR_SLOTS, bappBarForPath, barButtons, type BappBarDef } from './bappBarModel';

const def = (id: string) => BAPP_BARS.find((b) => b.id === id) as BappBarDef;

describe('bApp bar: which bApp a path is', () => {
  test('bApp routes and their sub-pages', () => {
    expect(bappBarForPath('/m/bmail')?.id).toBe('bmail');
    expect(bappBarForPath('/m/bmail/')?.id).toBe('bmail');
    expect(bappBarForPath('/m/bmint/notes')?.id).toBe('bmint');
    expect(bappBarForPath('/m/names')?.id).toBe('bmint');
    expect(bappBarForPath('/m/media/album/x')?.id).toBe('bmusic');
    expect(bappBarForPath('/m/bpics')?.id).toBe('bpics');
  });
  test('wallet pages, bChatX Spaces and look-alike prefixes keep the wallet dock', () => {
    for (const p of ['/bsv-wallet', '/m/exchange', '/m/feed', '/m/chat', '/m/home', '/m/spaces', '/m/bmailer', '/'])
      expect(bappBarForPath(p)).toBeNull();
  });
});

describe('bApp bar: five slots, unused greyed', () => {
  test('every bApp gets exactly the four side slots in order (b is the centre)', () => {
    for (const b of BAPP_BARS) expect(barButtons(b, b.home).map((x) => x.slot)).toEqual([...BAR_SLOTS]);
  });
  test('slots without a real screen are greyed (route null), never faked', () => {
    const mail = barButtons(def('bmail'), '/m/bmail');
    expect(mail.every((x) => x.route === null && !x.active)).toBe(true);
    const music = barButtons(def('bmusic'), '/m/media/browse');
    expect(music.find((x) => x.slot === 'exchange')).toMatchObject({ route: '/m/media/browse', active: true });
    expect(music.filter((x) => x.route === null).map((x) => x.slot)).toEqual(['wallet', 'feed', 'chat']);
  });
  test('every slot and section route is an in-wallet path under the app or a real route', () => {
    for (const b of BAPP_BARS) {
      expect(b.sections.length).toBeGreaterThan(0);
      for (const r of [...Object.values(b.slots), ...b.sections.map((s) => s.route), b.home])
        expect(r?.startsWith('/m/')).toBe(true);
    }
  });
});

describe('bApp bar files: theme tokens, no router hooks', () => {
  const src = readFileSync(join(import.meta.dir, 'BappBar.tsx'), 'utf8');
  test('no react-router hooks (it is rendered from the shell and TopNav, props only)', () => {
    expect(src.match(/\buse(Location|Navigate|SearchParams|Params|Href|Match|NavigationType)\(/)).toBeNull();
  });
  test('colours come from theme tokens (Gold, Mono/Duo/Tri), not hard-coded gold', () => {
    expect(src).not.toMatch(/#FFD24D|#F5B800/i);
    expect(src).toContain('var(--bw-accent-hi)');
    expect(src).toContain('var(--bw-nav');
  });
});
