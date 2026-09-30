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

const PACKAGE = 'com.bitcoincorp.bcorpwallet';
const LANG = process.env.PLAY_LANG ?? 'en-GB';
const ASSETS = join(process.cwd(), 'dist/play-assets');
const KEY_FILE = process.env.PLAY_SERVICE_ACCOUNT ?? join(homedir(), '.yours-mobile/play-service-account.json');

const TITLE = 'bCorp Wallet (Beta)';
const SHORT = 'The BSV wallet for tokens: 1Sat Ordinals, BSV-21 and BRC-100 apps.';
const FULL = `bCorp Wallet is the BSV wallet for tokens, from The Bitcoin Corporation Ltd.

• Hold and send BSV, 1Sat Ordinals and BSV-21 tokens
• Use BRC-100 apps in the built-in browser, where you approve every request
• Non-custodial: private keys stay on your device, encrypted with your password in the Android Keystore
• Optional fingerprint unlock
• Open source: https://github.com/b0ase/yours-mobile

Transaction records sync to 1Sat wallet storage by default; you can change the storage provider in settings.

Based on the open-source Yours Wallet (MIT licence). Not affiliated with or endorsed by its authors.

This is beta software. Use a new wallet with small amounts only, and keep your recovery phrase safe.`;

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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
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
  if (!res.ok) throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD, '')} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const { id: edit } = await call('POST', `${API}/edits`);
try {
  await call(
    'PUT',
    `${API}/edits/${edit}/listings/${LANG}`,
    JSON.stringify({ language: LANG, title: TITLE, shortDescription: SHORT, fullDescription: FULL }),
    { 'content-type': 'application/json' },
  );
  console.log(`✓ listing text (${LANG})`);

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
  for (const n of [1, 2, 3, 4]) await upload('phoneScreenshots', `phone-${n}.png`);

  // Unpublished apps reject changesNotSentForReview; listing changes are reviewed with the next release.
  await call('POST', `${API}/edits/${edit}:commit`);
  console.log('✓ committed');
} catch (error) {
  await fetch(`${API}/edits/${edit}`, { method: 'DELETE', headers: auth }).catch(() => {});
  throw error;
}
