#!/usr/bin/env node
// Ship an app with bWalletX (Apps tab): pnpm add-app <url> [group] [--name "Name"] [--desc "Tagline"]
// Fetches the site's title, description and icon (apple-touch-icon → icon → og:image → /favicon.ico),
// renders the icon to a 96px PNG in src/mobile/brand/apps/radar/, and appends the app to
// src/mobile/ownerApps.ts. Needs ImageMagick (`magick`). Groups: market social media tools money explore
// learn games (default: tools).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(ROOT, 'src/mobile/ownerApps.ts');
const ICONS = join(ROOT, 'src/mobile/brand/apps/radar');
const GROUPS = ['market', 'social', 'media', 'tools', 'money', 'explore', 'learn', 'games'];

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const nameArg = flag('--name');
const descArg = flag('--desc');
let [raw, group = 'tools'] = args;
if (!raw) {
  console.error('usage: pnpm add-app <url> [group] [--name "Name"] [--desc "Tagline"]');
  process.exit(1);
}
if (!GROUPS.includes(group)) {
  console.error(`group must be one of: ${GROUPS.join(' ')}`);
  process.exit(1);
}
const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
const host = url.hostname.replace(/^www\./, '');
const list = readFileSync(LIST, 'utf8');
if (list.includes(`url: '${url.origin}`)) {
  console.error(`${host} is already in ownerApps.ts`);
  process.exit(1);
}

const get = (u) => fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 bWalletX add-app' } });
const html = await get(url.href).then((r) => r.text()).catch(() => '');
const meta = (re) => html.match(re)?.[1]?.trim();
const decode = (s) => s?.replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const title = decode(
  nameArg ||
    meta(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) ||
    meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
    meta(/<title[^>]*>([^<]+)<\/title>/i) ||
    host,
).split(/\s[|–-]\s/)[0].slice(0, 40);
const desc = decode(
  descArg ||
    meta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
    meta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i) ||
    host,
).slice(0, 90);

const iconHrefs = [
  meta(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)/i),
  meta(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon/i),
  meta(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)/i),
  meta(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon/i),
  meta(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i),
  '/favicon.ico',
].filter(Boolean);

const slug = `owner-${host.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
const out = join(ICONS, `${slug}.png`);
const tmp = mkdtempSync(join(tmpdir(), 'add-app-'));
let ok = false;
for (const h of iconHrefs) {
  try {
    const r = await get(new URL(h, url).href);
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) continue; // dead links often answer JSON/HTML
    const file = join(tmp, 'icon');
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    // First frame of .ico, flattened onto black, 96px square.
    execFileSync('magick', [`${file}[0]`, '-background', 'black', '-flatten', '-resize', '96x96', '-gravity', 'center', '-extent', '96x96', out]);
    ok = true;
    break;
  } catch {
    /* try the next candidate */
  }
}
if (!ok) {
  execFileSync('magick', ['-size', '96x96', 'xc:#17191E', '-font', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '-gravity', 'center', '-fill', '#F5B800', '-pointsize', '48', '-annotate', '0', title[0].toUpperCase(), out]);
  console.warn('No usable icon found: used a lettered placeholder.');
}

const id = slug.replace(/-/g, '_');
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const next = list
  .replace('// ADD-APP:IMPORTS', `import ${id} from './brand/apps/radar/${slug}.png';\n// ADD-APP:IMPORTS`)
  .replace(
    '  // ADD-APP:ENTRIES',
    `  { name: ${q(title)}, url: ${q(url.origin + (url.pathname === '/' ? '' : url.pathname))}, desc: ${q(desc)}, group: '${group}', icon: ${id}, source: 'owner' },\n  // ADD-APP:ENTRIES`,
  );
writeFileSync(LIST, next);
console.log(`Added ${title} (${host}) to ${group}: ${desc}`);
