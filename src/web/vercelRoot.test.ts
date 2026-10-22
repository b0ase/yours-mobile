import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vercel reads vercel.json from the repo root on a git build and from build-web on a CLI upload: both must match,
// or deep links (/restore, /lock, /m/market) 404 on web.bwalletx.com (22 Oct 2026).
test('repo-root vercel.json matches src/web/vercel.json', () => {
  const root = resolve(__dirname, '../..');
  expect(readFileSync(resolve(root, 'vercel.json'), 'utf8')).toBe(
    readFileSync(resolve(root, 'src/web/vercel.json'), 'utf8'),
  );
});

test('deep paths fall through to index.html', () => {
  const cfg = JSON.parse(readFileSync(resolve(__dirname, 'vercel.json'), 'utf8')) as {
    rewrites: { source: string; destination: string }[];
  };
  const spa = cfg.rewrites.find((r) => r.destination === '/index.html');
  expect(spa).toBeDefined();
  const re = new RegExp(`^${spa!.source.replace(/\(\(\?!/, '((?!')}$`);
  for (const p of ['/restore', '/lock/subscriptions', '/m/market']) expect(re.test(p)).toBe(true);
  expect(re.test('/assets/main.js')).toBe(false);
});
