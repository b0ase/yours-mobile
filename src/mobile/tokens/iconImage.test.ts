import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { BWALLET_MARK_ICON } from '../names/personalToken';
import {
  DEFAULT_ICON_NOTE,
  ICON_MAX_BYTES,
  ICON_TOO_BIG_MESSAGE,
  ICON_TYPE_MESSAGE,
  checkSvg,
  iconKind,
  iconSummary,
  mintWithIcon,
  prepareIcon,
  type RasterEncoder,
} from './iconImage';
import { emptyTokenForm, type TokenForm } from './token';
import type { MintedToken } from './mintToken';

const form: TokenForm = { ...emptyTokenForm(), name: 'Void', ticker: 'VOID' };
const ctx = {} as OneSatContext;
const OUTPOINT = `${'a'.repeat(64)}_0`;
const png = (n = 10) => new File([new Uint8Array(n)], 'a.png', { type: 'image/png' });
const minted = (icon: string | null): MintedToken => ({
  tokenId: `t_0:${icon}`,
  ticker: 'VOID',
  name: 'Void',
  supply: '1',
  decimals: 0,
  description: '',
  min: '1',
});
const fmt = (n: number) => `${n} B`;

describe('icon types', () => {
  test('png, webp and svg only', () => {
    expect(iconKind('image/png')).toBe('png');
    expect(iconKind('image/webp')).toBe('webp');
    expect(iconKind('image/svg+xml')).toBe('svg');
    expect(iconKind('image/jpeg')).toBeNull();
    expect(iconKind('image/gif')).toBeNull();
    expect(iconKind('text/html')).toBeNull();
  });
  test('other types are refused with a clear message', async () => {
    const gif = new File([new Uint8Array(5)], 'a.gif', { type: 'image/gif' });
    await expect(prepareIcon(gif, async () => png())).rejects.toThrow(ICON_TYPE_MESSAGE);
  });
});

describe('size validation', () => {
  test('re-encodes down until within 100 KB', async () => {
    const seen: number[] = [];
    const enc: RasterEncoder = async (_f, edge, type) => {
      seen.push(edge);
      const size = edge > 256 ? ICON_MAX_BYTES + 1 : 5000;
      return new File([new Uint8Array(size)], 'i', { type });
    };
    const out = await prepareIcon(png(), enc);
    expect(out.file.size).toBe(5000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(512);
    expect(seen.at(-1)).toBe(256);
  });
  test('still too big at the smallest step is refused', async () => {
    const enc: RasterEncoder = async (_f, _e, type) => new File([new Uint8Array(ICON_MAX_BYTES + 1)], 'i', { type });
    await expect(prepareIcon(png(), enc)).rejects.toThrow(ICON_TOO_BIG_MESSAGE);
  });
  test('an oversize svg is refused', async () => {
    const big = new File([`<svg xmlns="x">${' '.repeat(ICON_MAX_BYTES)}</svg>`], 'a.svg', { type: 'image/svg+xml' });
    await expect(prepareIcon(big)).rejects.toThrow(ICON_TOO_BIG_MESSAGE);
  });
  test('a clean svg passes and keeps its type', async () => {
    const f = new File(['<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="url(#g)"/></svg>'], 'a.svg', {
      type: 'image/svg+xml',
    });
    const out = await prepareIcon(f);
    expect(out.file.type).toBe('image/svg+xml');
    expect(out.kind).toBe('svg');
  });
});

describe('svg sanitiser', () => {
  const bad = (s: string) => expect(checkSvg(s).ok).toBe(false);
  test('rejects script', () => bad('<svg xmlns="x"><script>alert(1)</script></svg>'));
  test('rejects event handlers', () => {
    bad('<svg xmlns="x" onload="alert(1)"></svg>');
    bad('<svg xmlns="x"><rect onclick = "x()"/></svg>');
    bad('<svg xmlns="x"><rect/ onmouseover=\'x()\'></svg>');
  });
  test('rejects external hrefs and urls', () => {
    bad('<svg xmlns="x"><image href="https://evil.example/a.png"/></svg>');
    bad('<svg xmlns="x"><use xlink:href="//evil.example/a.svg#x"/></svg>');
    bad('<svg xmlns="x"><image href="data:image/png;base64,AAAA"/></svg>');
    bad('<svg xmlns="x"><a href="javascript:alert(1)"><rect/></a></svg>');
    bad('<svg xmlns="x"><rect style="fill:url(https://evil.example/x)"/></svg>');
    bad('<svg xmlns="x"><style>@import "https://evil.example/x.css";</style></svg>');
  });
  test('rejects foreignObject, embeds and doctype', () => {
    bad('<svg xmlns="x"><foreignObject><div/></foreignObject></svg>');
    bad('<svg xmlns="x"><iframe src="x"/></svg>');
    bad('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="x"/>');
    bad('<html></html>');
  });
  test('allows in-file fragments', () => {
    const ok = '<svg xmlns="x"><defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)"/></svg>';
    expect(checkSvg(ok).ok).toBe(true);
  });
});

describe('mint order and icon field', () => {
  test('icon is inscribed with its content type, then deployed with the outpoint as icon', async () => {
    const calls: string[] = [];
    const file = new File([new Uint8Array(4)], 'icon.webp', { type: 'image/webp' });
    const out = await mintWithIcon(
      ctx,
      form,
      file,
      { feeSats: 3 },
      {
        inscribe: async (_c, f, ticker) => {
          calls.push(`inscribe:${f.type}:${ticker}`);
          return OUTPOINT;
        },
        deploy: async (_c, _f, o) => {
          calls.push('deploy');
          expect(o.icon).toBe(OUTPOINT);
          expect(o.feeSats).toBe(3);
          return minted(o.icon);
        },
      },
    );
    expect(calls).toEqual(['inscribe:image/webp:VOID', 'deploy']);
    expect(out.tokenId).toContain(OUTPOINT);
  });
  test('skipping uses the default coin and inscribes nothing', async () => {
    let inscribed = 0;
    let icon: string | null = '';
    await mintWithIcon(
      ctx,
      form,
      null,
      { feeSats: 0 },
      {
        inscribe: async () => {
          inscribed++;
          return 'x_0';
        },
        deploy: async (_c, _f, o) => {
          icon = o.icon;
          return minted(o.icon);
        },
      },
    );
    expect(inscribed).toBe(0);
    expect(icon === BWALLET_MARK_ICON).toBe(true);
  });
  test('a failed inscription mints nothing', async () => {
    let deployed = 0;
    await expect(
      mintWithIcon(
        ctx,
        form,
        png(4),
        { feeSats: 0 },
        {
          inscribe: async () => {
            throw new Error('Icon inscription failed');
          },
          deploy: async () => {
            deployed++;
            return minted(null);
          },
        },
      ),
    ).rejects.toThrow('Icon inscription failed');
    expect(deployed).toBe(0);
  });
});

describe('sheet wording', () => {
  test('skip shows the default coin; a picked image shows its size', () => {
    expect(iconSummary(null, fmt)).toEqual({ row: 'Default coin', note: DEFAULT_ICON_NOTE });
    expect(DEFAULT_ICON_NOTE).toBe('No image: uses the default coin');
    expect(iconSummary({ file: png(2048) }, fmt).row).toBe('2048 B');
  });
});
