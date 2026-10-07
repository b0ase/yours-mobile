import { afterEach, expect, test } from 'bun:test';
import { ORDNANCE_API, absoluteUrl, loadWeapons, normOutpoint, normaliseWeapon, type Weapon } from './ordnance';

const weapon = (over: Partial<Weapon>): Weapon => ({
  id: 'pnee-shotgun',
  name: 'PNEE Shotgun',
  rarity: 'common',
  tagline: '',
  description: '',
  edition: 100,
  priceSats: 20000,
  model: '/1satordnance/models/sawedoff.glb',
  modelBase: 'sawedoff',
  tint: '#c9b37a',
  image: '/1satordnance/art/pnee-shotgun.png',
  ...over,
});

test('relative manifest paths resolve against tokenblaster.lol, not the wallet page', () => {
  expect(absoluteUrl('/1satordnance/art/pnee-shotgun.png')).toBe(
    'https://www.tokenblaster.lol/1satordnance/art/pnee-shotgun.png',
  );
  expect(absoluteUrl('models/minigun.glb')).toBe('https://www.tokenblaster.lol/models/minigun.glb');
  expect(absoluteUrl('//cdn.example.com/x.glb')).toBe('https://cdn.example.com/x.glb');
});

test('absolute and data URLs pass through; empty stays empty', () => {
  expect(absoluteUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
  expect(absoluteUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  expect(absoluteUrl('')).toBe('');
  expect(absoluteUrl(undefined as unknown as string)).toBeUndefined();
});

test('normaliseWeapon fixes image and model and leaves the rest alone', () => {
  const w = normaliseWeapon(weapon({}));
  expect(w.image).toBe('https://www.tokenblaster.lol/1satordnance/art/pnee-shotgun.png');
  expect(w.model).toBe('https://www.tokenblaster.lol/1satordnance/models/sawedoff.glb');
  expect(w.modelBase).toBe('sawedoff');
  expect(w.id).toBe('pnee-shotgun');
  // The checks the cabinet makes on the model path still hold after resolving.
  expect(w.model.endsWith('/sawedoff.glb')).toBe(true);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('loadWeapons returns the catalogue with resolved URLs', async () => {
  let calls = 0;
  globalThis.fetch = (async (url: string) => {
    calls++;
    expect(url).toBe(`${ORDNANCE_API}/manifest`);
    return new Response(JSON.stringify({ weapons: [weapon({}), weapon({ id: 'x', image: 'https://a.b/c.png' })] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const ws = await loadWeapons();
  expect(ws.map((w) => w.image)).toEqual([
    'https://www.tokenblaster.lol/1satordnance/art/pnee-shotgun.png',
    'https://a.b/c.png',
  ]);
  await loadWeapons();
  expect(calls).toBe(1); // cached for the session
});

test('normOutpoint treats txid_0 and txid.0 alike', () => {
  expect(normOutpoint('ab.0')).toBe('ab_0');
  expect(normOutpoint('ab_0')).toBe('ab_0');
});
