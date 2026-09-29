/**
 * Pin pnpm to the exact dependency versions upstream ships in bun.lock.
 *
 * Upstream Yours Wallet locks with bun; this fork installs with pnpm. Without
 * pins, pnpm resolves semver ranges to newer releases than upstream tested
 * (e.g. @bsv/sdk 2.8.x vs 2.5.0, which changed originator validation).
 * Re-run after every upstream merge:
 *
 *   pnpm exec tsx scripts/pin-from-bun-lock.ts && pnpm install
 *
 * Writes `overrides` into pnpm-workspace.yaml (between marker comments).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const lock = JSON.parse(readFileSync('bun.lock', 'utf8').replace(/,(\s*[}\]])/g, '$1')) as {
  packages: Record<string, [string, ...unknown[]]>;
};

const versionOf = (spec: string) => spec.slice(spec.lastIndexOf('@') + 1);
const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf('@'));

// Capacitor packages are this fork's own and are not in upstream's lock.
const overrides: Record<string, string> = {};
for (const [key, [spec]] of Object.entries(lock.packages)) {
  const version = versionOf(spec);
  if (!/^\d+\.\d+\.\d+/.test(version)) continue; // workspace/git/file specs
  // "a/@scope/b" means b nested under a; turn the path into pnpm's "a>b".
  const parts: string[] = [];
  const segs = key.split('/');
  for (let i = 0; i < segs.length; i++) {
    parts.push(segs[i].startsWith('@') ? `${segs[i]}/${segs[++i]}` : segs[i]);
  }
  if (parts[parts.length - 1] !== nameOf(spec)) continue; // aliased install
  // pnpm selectors allow one parent level. Deeper nests are all dev tooling
  // (puppeteer's yargs); leave those to normal resolution.
  if (parts.length > 2) continue;
  // Scope each pin to its major line so packages this fork adds (Capacitor's
  // CLI wants semver 7, say) still resolve their own majors.
  const [major, minor] = version.split('.');
  const range = major === '0' ? `~0.${minor}` : `^${major}`;
  parts[parts.length - 1] += `@${range}`;
  overrides[parts.join('>')] = version;
}

const START = '# >>> pinned from upstream bun.lock (scripts/pin-from-bun-lock.ts)';
const END = '# <<< pinned from upstream bun.lock';
const block = [
  START,
  'overrides:',
  ...Object.keys(overrides)
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(overrides[k])}`),
  END,
].join('\n');

const file = 'pnpm-workspace.yaml';
const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
const start = current.indexOf(START);
const end = current.indexOf(END);
const next =
  start !== -1 && end !== -1
    ? current.slice(0, start) + block + current.slice(end + END.length)
    : `${current.trimEnd()}${current ? '\n\n' : ''}${block}\n`;
writeFileSync(file, next);
console.log(`Pinned ${Object.keys(overrides).length} packages in ${file}`);
