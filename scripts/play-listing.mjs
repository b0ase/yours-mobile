#!/usr/bin/env node
/**
 * Push the Google Play store listing (text + graphics) via the Android Publisher API.
 *
 *   node scripts/play-listing.mjs            # en-GB listing from the texts below + dist/play-assets/*
 *
 * Credentials: a service-account key at ~/.yours-mobile/play-service-account.json
 * (override with PLAY_SERVICE_ACCOUNT). It is read at runtime and never stored in the repo.
 */
import { readFileSync, existsSync } from 'fs';
import { createSign } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const PACKAGE = 'com.bitcoincorp.bwallet';
let LANG = process.env.PLAY_LANG ?? '';
const ASSETS = join(process.cwd(), 'store/play');
const KEY_FILE = process.env.PLAY_SERVICE_ACCOUNT ?? join(homedir(), '.yours-mobile/play-service-account.json');

// Texts and graphics come from store/play/ (listing.md is the source of truth for the Play listing).
const LISTING = readFileSync(join(process.cwd(), 'store/play/listing.md'), 'utf8');
const TITLE = 'bWallet';
const SHORT = LISTING.match(/\*\*Short description[^\n]*\n\n> (.+)/)[1].trim();
const FULL = LISTING.split(/\*\*Full description[^\n]*\n\n```\n/)[1]
  .split('\n```')[0]
  .trim();
const CONTACT = { contactEmail: 'support@bwalletx.com', contactWebsite: 'https://www.bwallet.space' };
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
  // The default store listing is in the app's default language (Play Console › Store settings).
  LANG ||= (await call('GET', `${API}/edits/${edit}/details`)).defaultLanguage;
  await call(
    'PUT',
    `${API}/edits/${edit}/listings/${LANG}`,
    JSON.stringify({ language: LANG, title: TITLE, shortDescription: SHORT, fullDescription: FULL }),
    { 'content-type': 'application/json' },
  );
  console.log(`✓ listing text (${LANG}): ${SHORT.length}/80 short, ${FULL.length}/4000 full`);
  const details = process.env.SKIP_DETAILS ? null : await call('GET', `${API}/edits/${edit}/details`);
  if (details)
    await call('PATCH', `${API}/edits/${edit}/details`, JSON.stringify({ ...details, ...CONTACT }), {
      'content-type': 'application/json',
    });
  if (details) console.log(`✓ contact details (default language ${details.defaultLanguage})`);

  const upload = async (type, file) => {
    const path = join(ASSETS, file);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    await call('POST', `${UPLOAD}/edits/${edit}/listings/${LANG}/${type}?uploadType=media`, readFileSync(path), {
      'content-type': 'image/png',
    });
    console.log(`✓ ${type} ← ${file}`);
  };

  for (const type of ['icon', 'featureGraphic', 'phoneScreenshots']) {
    await call('DELETE', `${API}/edits/${edit}/listings/${LANG}/${type}`);
  }
  await upload('icon', 'icon-512.png');
  await upload('featureGraphic', 'feature-graphic-1024x500.png');
  for (const f of [
    'screenshot-01-wallet.png',
    'screenshot-02-receive.png',
    'screenshot-03-send.png',
    'screenshot-04-collections.png',
  ])
    await upload('phoneScreenshots', f);

  // Unpublished apps reject changesNotSentForReview; listing changes are reviewed with the next release.
  await call('POST', `${API}/edits/${edit}:commit`);
  console.log('✓ committed');
} catch (error) {
  await fetch(`${API}/edits/${edit}`, { method: 'DELETE', headers: auth }).catch(() => {});
  throw error;
}
