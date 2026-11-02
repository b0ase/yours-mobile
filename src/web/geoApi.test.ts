import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// api/geo.mjs: the UK gate's first-party region source on web.bwalletx.com (src/mobile/region/region.ts).
type Res = { statusCode: number; headers: Record<string, string>; body: string };
type Geo = {
  countryFromHeader: (v: unknown) => string | null;
  default: (req: { method?: string; headers: Record<string, unknown> }, res: unknown) => void;
};
const load = async (): Promise<Geo> => (await import(String(new URL('../../api/geo.mjs', import.meta.url)))) as Geo;

const call = async (headers: Record<string, unknown>, method = 'GET'): Promise<Res> => {
  const geo = await load();
  const out: Res = { statusCode: 0, headers: {}, body: '' };
  geo.default(
    { method, headers },
    {
      set statusCode(v: number) {
        out.statusCode = v;
      },
      setHeader: (k: string, v: string) => {
        out.headers[k.toLowerCase()] = v;
      },
      end: (b: string) => {
        out.body = b;
      },
    },
  );
  return out;
};

test('reads the country from x-vercel-ip-country', async () => {
  const { countryFromHeader } = await load();
  expect(countryFromHeader('GB')).toBe('GB');
  expect(countryFromHeader('gb')).toBe('GB');
  expect(countryFromHeader(['US'])).toBe('US');
  for (const v of [undefined, '', 'GBR', '1', null]) expect(countryFromHeader(v)).toBeNull();
});

test('answers JSON, never cached, open to the extension and Desktop', async () => {
  const r = await call({ 'x-vercel-ip-country': 'GB' });
  expect(r.statusCode).toBe(200);
  expect(JSON.parse(r.body)).toEqual({ country: 'GB' });
  expect(r.headers['cache-control']).toContain('no-store');
  expect(r.headers['access-control-allow-origin']).toBe('*');
  expect(r.headers['content-type']).toContain('application/json');
  expect(JSON.parse((await call({})).body)).toEqual({ country: null });
});

test('ships with the web build (CLI uploads of build-web) and is not swallowed by the SPA rewrite', () => {
  const vite = readFileSync(new URL('../../vite.config.web.ts', import.meta.url), 'utf8');
  expect(vite).toContain("fileName: 'api/geo.mjs'");
  const cfg = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
    rewrites: { source: string; destination: string }[];
  };
  const spa = cfg.rewrites.find((r) => r.destination === '/index.html')!;
  expect(new RegExp(`^${spa.source}$`).test('/api/geo')).toBe(false);
});
