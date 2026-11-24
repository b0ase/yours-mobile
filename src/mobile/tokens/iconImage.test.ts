import { afterEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import {
  DEFAULT_ICON_NOTE,
  ICON_MAX_BYTES,
  ICON_TOO_BIG_MESSAGE,
  ICON_TYPE_MESSAGE,
  ICON_INPUT_MAX_BYTES,
  ICON_INPUT_TOO_BIG_MESSAGE,
  ICON_SAVED_MESSAGE,
  canvasEncoder,
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
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_HEAD = [...'RIFF']
  .map((c) => c.charCodeAt(0))
  .concat(
    [0, 0, 0, 0],
    [...'WEBP'].map((c) => c.charCodeAt(0)),
  );
const bytes = (head: number[], n: number) => {
  const u = new Uint8Array(Math.max(n, head.length));
  u.set(head);
  return u;
};
/** A real-looking PNG of n bytes (the encoder stubs return these). */
const png = (n = 16) => new File([bytes(PNG_HEAD, n)], 'a.png', { type: 'image/png' });
const webp = (n = 16) => new File([bytes(WEBP_HEAD, n)], 'a.webp', { type: 'image/webp' });
const asText = async (f: File) => new TextDecoder('latin1').decode(await f.arrayBuffer());
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
  test('png, jpeg, webp, heic and svg are accepted as input', () => {
    expect(iconKind('image/png')).toBe('png');
    expect(iconKind('image/webp')).toBe('webp');
    expect(iconKind('image/jpeg')).toBe('jpeg');
    expect(iconKind('image/heic')).toBe('heic');
    expect(iconKind('image/svg+xml')).toBe('svg');
    expect(iconKind('image/gif')).toBeNull();
    expect(iconKind('text/html')).toBeNull();
  });
  test('other types are refused with a clear message', async () => {
    const gif = new File([new Uint8Array(5)], 'a.gif', { type: 'image/gif' });
    await expect(prepareIcon(gif, async () => png())).rejects.toThrow(ICON_TYPE_MESSAGE);
  });
  test('a jpeg is re-encoded; the output is only png or webp', async () => {
    const jpg = new File([new Uint8Array(50)], 'a.jpg', { type: 'image/jpeg' });
    const out = await prepareIcon(jpg, async () => webp());
    expect(out.kind).toBe('webp');
    expect(out.file.type).toBe('image/webp');
  });
});

describe('size validation', () => {
  test('re-encodes down until within 100 KB', async () => {
    const seen: number[] = [];
    const enc: RasterEncoder = async (_f, edge, type) => {
      seen.push(edge);
      const make = type === 'image/png' ? png : webp;
      return make(edge > 256 ? ICON_MAX_BYTES + 1 : 5000);
    };
    const out = await prepareIcon(png(), enc);
    expect(out.file.size).toBe(5000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(512);
    expect(seen.at(-1)).toBe(256);
  });
  test('still too big at the smallest step is refused', async () => {
    const enc: RasterEncoder = async (_f, _e, type) => (type === 'image/png' ? png : webp)(ICON_MAX_BYTES + 1);
    await expect(prepareIcon(png(), enc)).rejects.toThrow(ICON_TOO_BIG_MESSAGE);
  });
  test('an oversize input file is refused before any decoding', async () => {
    let called = 0;
    const big = new File([new Uint8Array(ICON_INPUT_MAX_BYTES + 1)], 'a.jpg', { type: 'image/jpeg' });
    await expect(
      prepareIcon(big, async () => {
        called++;
        return png();
      }),
    ).rejects.toThrow(ICON_INPUT_TOO_BIG_MESSAGE);
    expect(called).toBe(0);
  });
});

describe('steps that fail (iOS has no WebP encoder)', () => {
  test('a step that throws is skipped and the next one is tried', async () => {
    const tried: string[] = [];
    const enc: RasterEncoder = async (_f, edge, type) => {
      tried.push(`${type}:${edge}`);
      if (type === 'image/webp') throw new Error('no webp here');
      return png(ICON_MAX_BYTES + 1 > 0 && edge > 256 ? ICON_MAX_BYTES + 1 : 3000);
    };
    const out = await prepareIcon(png(), enc);
    expect(out.kind).toBe('png');
    expect(out.file.size).toBe(3000);
    // png 512 too big, webp x4 fail, png 384 too big, png 256 fits.
    expect(tried).toEqual([
      'image/png:512',
      'image/webp:512',
      'image/webp:384',
      'image/webp:256',
      'image/webp:128',
      'image/png:384',
      'image/png:256',
    ]);
  });
  test('when every step throws the person gets the encoder message', async () => {
    const enc: RasterEncoder = async () => {
      throw new Error('Could not read this image');
    };
    await expect(prepareIcon(png(), enc)).rejects.toThrow('Could not read this image');
  });
  test('output that is not really a png or webp is never accepted', async () => {
    const svgAsPng: RasterEncoder = async () =>
      new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'icon.png', { type: 'image/png' });
    await expect(prepareIcon(png(), svgAsPng)).rejects.toThrow();
  });
});

describe('canvasEncoder fallback (WebKit canvas makes PNG when asked for WebP)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, createImageBitmap: g.createImageBitmap };
  afterEach(() => {
    g.document = saved.document;
    g.createImageBitmap = saved.createImageBitmap;
  });
  const fakeBrowser = (made: (type: string) => Blob | null) => {
    const asked: string[] = [];
    let closed = 0;
    g.createImageBitmap = async () => ({ width: 800, height: 600, close: () => closed++ });
    g.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob | null) => void, type: string) => {
          asked.push(type);
          cb(made(type));
        },
      }),
    };
    return { asked, closed: () => closed };
  };
  test('a webp request answered with a PNG blob gives a PNG file', async () => {
    const b = fakeBrowser(() => new Blob([bytes(PNG_HEAD, 40)], { type: 'image/png' }));
    const out = await canvasEncoder(png(), 256, 'image/webp', 0.8);
    expect(b.asked).toEqual(['image/webp']);
    expect(out.type).toBe('image/png');
    expect(out.name).toBe('icon.png');
    expect(b.closed()).toBe(1);
  });
  test('prepareIcon on that browser still returns a png instead of failing', async () => {
    fakeBrowser((type) => new Blob([bytes(PNG_HEAD, type === 'image/png' ? 40 : 40)], { type: 'image/png' }));
    const out = await prepareIcon(new File([new Uint8Array(30)], 'p.jpg', { type: 'image/jpeg' }));
    expect(out.kind).toBe('png');
  });
  test('a blob of some other type, or none, is refused', async () => {
    fakeBrowser(() => new Blob([new Uint8Array(4)], { type: 'image/jpeg' }));
    await expect(canvasEncoder(png(), 256, 'image/png')).rejects.toThrow('Could not read this image');
    fakeBrowser(() => null);
    await expect(canvasEncoder(png(), 256, 'image/png')).rejects.toThrow('Could not read this image');
  });
  test('an image with too many pixels is refused before drawing', async () => {
    fakeBrowser(() => new Blob([bytes(PNG_HEAD, 40)], { type: 'image/png' }));
    g.createImageBitmap = async () => ({ width: 20000, height: 20000, close: () => {} });
    await expect(canvasEncoder(png(), 256, 'image/png')).rejects.toThrow(ICON_INPUT_TOO_BIG_MESSAGE);
  });
});

describe('svg is rasterised, never inscribed', () => {
  // The bypasses the independent review found against the old regex checker, plus the plain cases. Each must come
  // out as a raster; the SVG bytes only ever go INTO the encoder.
  const SAMPLES: Record<string, string> = {
    prefixedScript:
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    prefixedRoot: '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>',
    xlinkNamespaceHref:
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><image x:href="https://evil.example/a.png"/></svg>',
    entityHref: '<svg xmlns="http://www.w3.org/2000/svg"><image hr&#101;f="https://evil.example/a.png"/></svg>',
    entityJavascript: '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
    entityUrl: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:&#117;rl(https://evil.example/x)"/></svg>',
    cssEscapeImport:
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https://evil.example/x.css";</style></svg>',
    cssEscapeUrl: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\\72l(https://evil.example/x)"/></svg>',
    imageSet:
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background:image-set(\'https://evil.example/x.png\' 1x)"/></svg>',
    iso2022jp: '<svg xmlns="http://www.w3.org/2000/svg"><!-- \u001b$B --><script>alert(1)</script></svg>',
    onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    foreignObject: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    doctype: '<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>',
    notAnSvg: '<html><script>alert(1)</script></html>',
    clean: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="url(#g)"/></svg>',
  };
  for (const [name, text] of Object.entries(SAMPLES)) {
    test(`${name}: only the raster comes out`, async () => {
      const f = new File([text], 'a.svg', { type: 'image/svg+xml' });
      let input = '';
      const enc: RasterEncoder = async (file, _e, type) => {
        input = await file.text();
        return (type === 'image/png' ? png : webp)(900);
      };
      const out = await prepareIcon(f, enc);
      expect(input).toBe(text);
      expect(['image/png', 'image/webp']).toContain(out.file.type);
      expect(out.kind === 'png' || out.kind === 'webp').toBe(true);
      const body = (await asText(out.file)).toLowerCase();
      expect(body).not.toContain('<svg');
      expect(body).not.toContain('script');
      expect(out.file.name).not.toContain('svg');
    });
  }
  test('an svg is re-encoded even when it is tiny (no pass-through)', async () => {
    let calls = 0;
    await prepareIcon(
      new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'a.svg', { type: 'image/svg+xml' }),
      async () => {
        calls++;
        return png();
      },
    );
    expect(calls).toBe(1);
  });
});

describe('mint order and icon field', () => {
  test('icon is inscribed as a token icon, then deployed with the outpoint as icon', async () => {
    const calls: string[] = [];
    const out = await mintWithIcon(
      ctx,
      { ...form, ticker: '$VOID' },
      webp(),
      { feeSats: 3 },
      {
        inscribe: async (_c, f, ticker, what, mapType) => {
          calls.push(`inscribe:${f.type}:${ticker}:${what}:${mapType}`);
          return OUTPOINT;
        },
        deploy: async (_c, _f, o) => {
          calls.push('deploy');
          expect(o.icon).toBe(OUTPOINT);
          expect(o.feeSats).toBe(3);
          return minted(o.icon);
        },
      },
      { store: false },
    );
    // The ticker has no "$" (the MAP name adds one), and the inscription is tagged token-icon, not avatar.
    expect(calls).toEqual(['inscribe:image/webp:VOID:token:token-icon', 'deploy']);
    expect(out.tokenId).toContain(OUTPOINT);
  });
  test('skipping puts no icon field on chain and inscribes nothing', async () => {
    let inscribed = 0;
    let icon: string | null = 'unset';
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
      { store: false },
    );
    expect(inscribed).toBe(0);
    expect(icon).toBeNull();
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
        { store: false },
      ),
    ).rejects.toThrow('Icon inscription failed');
    expect(deployed).toBe(0);
  });
  test('a store build is refused before anything is inscribed', async () => {
    let inscribed = 0;
    let deployed = 0;
    const steps = {
      inscribe: async () => {
        inscribed++;
        return OUTPOINT;
      },
      deploy: async () => {
        deployed++;
        return minted(null);
      },
    };
    await expect(mintWithIcon(ctx, form, png(), { feeSats: 0 }, steps, { store: true })).rejects.toThrow();
    await expect(mintWithIcon(ctx, form, null, { feeSats: 0 }, steps, { store: true })).rejects.toThrow();
    expect(inscribed).toBe(0);
    expect(deployed).toBe(0);
  });
  test('inscription ok + deploy fails: the outpoint is kept and a retry inscribes nothing', async () => {
    const file = png();
    let inscribed = 0;
    let deploys = 0;
    let kept: { file: File; outpoint: string } | null = null;
    const steps = {
      inscribe: async () => {
        inscribed++;
        return OUTPOINT;
      },
      deploy: async (_c: OneSatContext, _f: TokenForm, o: { icon: string | null }) => {
        deploys++;
        if (deploys === 1) throw new Error('broadcast rejected');
        expect(o.icon).toBe(OUTPOINT);
        return minted(o.icon);
      },
    };
    await expect(
      mintWithIcon(ctx, form, file, { feeSats: 0 }, steps, { store: false, onInscribed: (s) => (kept = s) }),
    ).rejects.toThrow(ICON_SAVED_MESSAGE);
    expect(ICON_SAVED_MESSAGE).toBe('Your icon is saved; try the token again');
    expect(kept).toEqual({ file, outpoint: OUTPOINT });
    const out = await mintWithIcon(ctx, form, file, { feeSats: 0 }, steps, { store: false, saved: kept });
    expect(out.tokenId).toContain(OUTPOINT);
    expect(inscribed).toBe(1);
    expect(deploys).toBe(2);
  });
  test('a different picked file does not reuse the saved outpoint', async () => {
    let inscribed = 0;
    const steps = {
      inscribe: async () => {
        inscribed++;
        return `${'b'.repeat(64)}_0`;
      },
      deploy: async (_c: OneSatContext, _f: TokenForm, o: { icon: string | null }) => minted(o.icon),
    };
    const out = await mintWithIcon(ctx, form, png(), { feeSats: 0 }, steps, {
      store: false,
      saved: { file: png(), outpoint: OUTPOINT },
    });
    expect(inscribed).toBe(1);
    expect(out.tokenId).toContain('b'.repeat(64));
  });
});

describe('sheet wording', () => {
  test('skip shows the default coin; a picked image shows its size', () => {
    expect(iconSummary(null, fmt)).toEqual({ row: 'Default coin', note: DEFAULT_ICON_NOTE });
    expect(DEFAULT_ICON_NOTE).toBe('No image: uses the default coin');
    expect(iconSummary({ file: png(2048) }, fmt).row).toBe('2048 B');
  });
});
