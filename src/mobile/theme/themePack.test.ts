import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'bun:test';
import { THEMES, accentById } from './accents';
import {
  BUNDLED_PACKS,
  THEME_PACK_FORMAT,
  THEME_TIERS,
  accentOfPack,
  bundledId,
  holderUnlocked,
  lightLookOk,
  parseCatalog,
  parseThemePack,
  type ThemePack,
} from './themePack';

const JSON_PATH = resolve(__dirname, '../../../site/lib/themes.json');
const catalogJson = () => ({ format: THEME_PACK_FORMAT, tiers: THEME_TIERS, packs: BUNDLED_PACKS });

const TOKEN = `${'ab'.repeat(32)}_0`;
const holder = (): ThemePack => ({
  ...(BUNDLED_PACKS.find((p) => p.id === 'vexvoid') as ThemePack),
  id: 'vex-holders',
  tier: 'holder',
  token: { kind: 'bsv21', id: TOKEN, symbol: 'VEX', dec: 0, min_raw: '10' },
});

describe('theme pack format (bwx-theme/1)', () => {
  it('expresses every bundled pack and round-trips through the validator', () => {
    expect(BUNDLED_PACKS.map((p) => p.id)).toEqual(THEMES.map((a) => a.id));
    for (const p of BUNDLED_PACKS) {
      const back = parseThemePack(JSON.parse(JSON.stringify(p)));
      expect(back, p.id).toEqual(p);
      expect(bundledId(p)).toBe(p.id);
      const a = accentOfPack(p);
      const orig = accentById(p.id);
      expect({ ...a, id: orig.id, kind: orig.kind, group: orig.group, edition: orig.edition }).toEqual(orig);
    }
  });

  it('site/lib/themes.json matches the bundled packs (WRITE_THEMES=1 regenerates it)', () => {
    const want = JSON.stringify(catalogJson(), null, 2) + '\n';
    if (process.env.WRITE_THEMES === '1') writeFileSync(JSON_PATH, want);
    expect(readFileSync(JSON_PATH, 'utf8')).toBe(want);
  });

  it('light packs keep light cards and black text', () => {
    for (const p of BUNDLED_PACKS.filter((x) => x.look.scheme === 'light'))
      expect(lightLookOk(p.look), p.id).toBe(true);
    const white = BUNDLED_PACKS.find((p) => p.id === 'white') as ThemePack;
    const darkCards = { ...white, look: { ...white.look, surface: '#17191E' } };
    expect(parseThemePack(darkCards)).toBeNull();
    const greyText = { ...white, look: { ...white.look, text: '#777777' } };
    expect(parseThemePack(greyText)).toBeNull();
  });

  it('refuses malformed or unsafe packs', () => {
    const p = BUNDLED_PACKS[0] as ThemePack;
    expect(parseThemePack({ ...p, format: 'x' })).toBeNull();
    expect(parseThemePack({ ...p, tier: 'gift' })).toBeNull();
    expect(parseThemePack({ ...p, id: 'Bad Id' })).toBeNull();
    expect(parseThemePack({ ...p, look: { ...p.look, accent: 'red' } })).toBeNull();
    expect(parseThemePack({ ...p, look: { ...p.look, glow: 'url(https://x/y.png)' } })).toBeNull();
    expect(parseThemePack({ ...p, look: { ...p.look, shadow: 'none; background: red' } })).toBeNull();
    expect(parseThemePack({ ...p, tier: 'premium' })).toBeNull();
    expect(parseThemePack({ ...p, tier: 'premium', price_usd: 1 })?.price_usd).toBe(1);
    expect(parseThemePack({ ...holder(), token: undefined })).toBeNull();
    expect(parseCatalog({ packs: [p, { nope: 1 }] })).toHaveLength(1);
    expect(parseCatalog(null)).toEqual([]);
  });

  it('holder packs unlock at the token minimum (same check as token rooms)', () => {
    const h = parseThemePack(holder()) as ThemePack;
    expect(h).not.toBeNull();
    expect(holderUnlocked(h, [])).toBe(false);
    expect(holderUnlocked(h, [{ kind: 'bsv21', id: TOKEN, amountRaw: '9' }])).toBe(false);
    expect(holderUnlocked(h, [{ kind: 'coll', id: TOKEN, amountRaw: '99' }])).toBe(false);
    expect(holderUnlocked(h, [{ kind: 'bsv21', id: TOKEN, amountRaw: '10' }])).toBe(true);
    expect(holderUnlocked(BUNDLED_PACKS[0] as ThemePack, [{ kind: 'bsv21', id: TOKEN, amountRaw: '10' }])).toBe(false);
  });
});

describe('site/api/themes.js', () => {
  const req = createRequire(import.meta.url);
  const handler = req('../../../site/api/themes.js') as (q: unknown, r: unknown) => void;
  const call = (method: string, url: string) => {
    const out = { statusCode: 0, body: '', headers: {} as Record<string, string> };
    handler(
      { method, url },
      {
        set statusCode(v: number) {
          out.statusCode = v;
        },
        setHeader: (k: string, v: string) => (out.headers[k] = v),
        end: (b?: string) => (out.body = b ?? ''),
      },
    );
    return out;
  };
  it('serves the catalog read-only, filtered by tier', () => {
    const all = call('GET', '/api/themes');
    expect(all.statusCode).toBe(200);
    expect(parseCatalog(JSON.parse(all.body))).toHaveLength(BUNDLED_PACKS.length);
    expect(JSON.parse(call('GET', '/api/themes?tier=premium').body).packs).toEqual([]);
    expect(call('GET', '/api/themes?tier=nope').statusCode).toBe(400);
    expect(call('POST', '/api/themes').statusCode).toBe(405);
  });
});
