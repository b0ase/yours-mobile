/**
 * Upload the Google Play bundle (bWallet, android-play channel) via the Android Publisher API.
 *
 *   node scripts/play-upload.mjs --list                  # show each track's current releases
 *   node scripts/play-upload.mjs [--track internal]      # upload dist/bwallet-*-play.aab to that track
 *
 * Tracks: internal (default), alpha (closed), beta (open), production. Credentials as play-listing.mjs:
 * ~/.yours-mobile/play-service-account.json (override with PLAY_SERVICE_ACCOUNT), read at runtime, never in the repo.
 */
import { readFileSync, readdirSync } from 'fs';
import { createSign } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const PACKAGE = 'com.bitcoincorp.bwallet';
const KEY_FILE = process.env.PLAY_SERVICE_ACCOUNT ?? join(homedir(), '.yours-mobile/play-service-account.json');
const args = process.argv.slice(2);
const LIST = args.includes('--list');
const TRACK = args.includes('--track') ? args[args.indexOf('--track') + 1] : 'internal';
const VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;

const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

const token = async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 1800,
  };
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  }).then((r) => r.json());
  if (!res.access_token) throw new Error(`auth failed: ${res.error_description ?? res.error}`);
  return res.access_token;
};

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const auth = { authorization: `Bearer ${await token()}` };

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(url, { method, headers: { ...auth, ...headers }, body });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD, '')} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const { id: edit } = await call('POST', `${API}/edits`);
try {
  if (LIST) {
    const { tracks = [] } = await call('GET', `${API}/edits/${edit}/tracks`);
    for (const t of tracks)
      for (const r of t.releases ?? [])
        console.log(`${t.track}: ${r.name ?? '-'} codes=${(r.versionCodes ?? []).join(',')} status=${r.status}`);
    if (!tracks.length) console.log('(no tracks yet)');
  } else {
    const files = readdirSync('dist');
    const aab = files.includes(`bwallet-${VERSION}-play.aab`) ? `bwallet-${VERSION}-play.aab` : files.find((f) => /^bwallet-.*-play\.aab$/.test(f));
    if (!aab) throw new Error('no dist/bwallet-*-play.aab: run bash scripts/channel-build.sh android-play');
    console.log(`▸ uploading dist/${aab}`);
    const bundle = await call('POST', `${UPLOAD}/edits/${edit}/bundles?uploadType=media`, readFileSync(join('dist', aab)), {
      'content-type': 'application/octet-stream',
    });
    console.log(`  versionCode ${bundle.versionCode}`);
    await call('PUT', `${API}/edits/${edit}/tracks/${TRACK}`, JSON.stringify({
      track: TRACK,
      releases: [{ name: `${VERSION} (${bundle.versionCode})`, versionCodes: [String(bundle.versionCode)], status: 'completed' }],
    }), { 'content-type': 'application/json' });
    await call('POST', `${API}/edits/${edit}:commit`);
    console.log(`✓ ${VERSION} (${bundle.versionCode}) released to ${TRACK}`);
  }
} finally {
  await fetch(`${API}/edits/${edit}`, { method: 'DELETE', headers: auth }).catch(() => {});
}
