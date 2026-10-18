#!/usr/bin/env node
/**
 * App Store Connect from the command line (owner, 18 Oct 2026: xcodebuild's own upload kept failing with
 * "Failed to Use Accounts" although Xcode was signed in).
 *
 * Key: an App Store Connect API key (App Manager) at ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8, with
 * ~/.appstoreconnect/config.json = { "keyId", "issuerId" }. Neither lives in this repo. The key file is only read
 * to sign a 20-minute token, never printed.
 *
 *   node scripts/asc.mjs auth                         check the key works
 *   node scripts/asc.mjs upload <archive.xcarchive>   export + upload with the key
 *   node scripts/asc.mjs builds [version]             recent builds and their processing state
 *   node scripts/asc.mjs submit <version> <build> [--notes "What's new"]
 *                                                     add the version, attach the build, submit for review
 */
import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_ID = process.env.ASC_BUNDLE_ID || 'com.bitcoincorp.bwallet';
const TEAM_ID = 'ZQ4NX9NJ89';
const API = 'https://api.appstoreconnect.apple.com';
const DIR = join(homedir(), '.appstoreconnect');
const { keyId, issuerId } = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const KEY_PATH = join(DIR, 'private_keys', `AuthKey_${keyId}.p8`);

const b64url = (b) => Buffer.from(b).toString('base64url');

function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const sig = createSign('SHA256')
    .update(`${head}.${body}`)
    .sign({ key: readFileSync(KEY_PATH, 'utf8'), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

async function api(method, path, data) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const why =
      (json.errors ?? [])
        .map((e) => {
          // Apple lists what is missing (screenshots, privacy, age rating…) under meta.associatedErrors.
          const more = Object.values(e.meta?.associatedErrors ?? {})
            .flat()
            .map((a) => `\n    - ${a.detail ?? a.title}`)
            .join('');
          return `${e.title}: ${e.detail}${more}`;
        })
        .join('; ') || text;
    throw new Error(`${method} ${path} → ${res.status} ${why}`);
  }
  return json;
}

async function appId() {
  // filter[bundleId] also returns com.bitcoincorp.bwallet.private, in no fixed order: match exactly.
  const r = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = r.data?.find((a) => a.attributes?.bundleId === BUNDLE_ID);
  if (!app) throw new Error(`No app with bundle id ${BUNDLE_ID}`);
  return app.id;
}

async function builds(version) {
  const app = await appId();
  const q = version ? `&filter[preReleaseVersion.version]=${version}` : '';
  const r = await api('GET', `/v1/builds?filter[app]=${app}${q}&sort=-uploadedDate&limit=10&include=preReleaseVersion`);
  const ver = Object.fromEntries((r.included ?? []).map((i) => [i.id, i.attributes.version]));
  return r.data.map((b) => ({
    id: b.id,
    version: ver[b.relationships?.preReleaseVersion?.data?.id] ?? '?',
    build: b.attributes.version,
    state: b.attributes.processingState,
    uploaded: b.attributes.uploadedDate,
  }));
}

function upload(archive) {
  const out = mkdtempSync(join(tmpdir(), 'asc-export-'));
  const plist = join(out, 'ExportOptions.plist');
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>method</key><string>app-store-connect</string><key>destination</key><string>upload</string><key>teamID</key><string>${TEAM_ID}</string></dict></plist>
`,
  );
  execFileSync(
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath',
      archive,
      '-exportOptionsPlist',
      plist,
      '-exportPath',
      join(out, 'export'),
      '-allowProvisioningUpdates',
      '-authenticationKeyPath',
      KEY_PATH,
      '-authenticationKeyID',
      keyId,
      '-authenticationKeyIssuerID',
      issuerId,
    ],
    { stdio: 'inherit' },
  );
}

async function submit(version, buildNumber, notes) {
  const app = await appId();
  const build = (await builds(version)).find((b) => b.build === String(buildNumber));
  if (!build) throw new Error(`Build ${version} (${buildNumber}) not found yet. Apple may still be processing it.`);
  if (build.state !== 'VALID') throw new Error(`Build ${version} (${buildNumber}) is ${build.state}, not VALID yet.`);

  // The version: reuse one that is still editable, else add it.
  const vs = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${version}`);
  let v = vs.data[0];
  // Apple allows one unreleased version at a time: an open draft (e.g. the first-ever 1.0) is renamed instead.
  const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED'];
  if (!v) {
    const all = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=10`);
    const draft = all.data.find((d) => EDITABLE.includes(d.attributes.appStoreState));
    if (draft) {
      v = (
        await api('PATCH', `/v1/appStoreVersions/${draft.id}`, {
          type: 'appStoreVersions',
          id: draft.id,
          attributes: { versionString: version },
        })
      ).data;
      console.log(`✓ open version ${draft.attributes.versionString} renamed to ${version}`);
    }
  }
  if (!v) {
    v = (
      await api('POST', '/v1/appStoreVersions', {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version },
        relationships: { app: { data: { type: 'apps', id: app } } },
      })
    ).data;
    console.log(`✓ added version ${version}`);
  }
  await api('PATCH', `/v1/appStoreVersions/${v.id}/relationships/build`, { type: 'builds', id: build.id });
  console.log(`✓ build ${buildNumber} attached`);

  if (notes) {
    const locs = await api('GET', `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`);
    try {
      for (const l of locs.data)
        await api('PATCH', `/v1/appStoreVersionLocalizations/${l.id}`, {
          type: 'appStoreVersionLocalizations',
          id: l.id,
          attributes: { whatsNew: notes },
        });
      console.log(`✓ What's New set (${locs.data.length} language${locs.data.length === 1 ? '' : 's'})`);
    } catch (e) {
      // The first release on the App Store has no What's New.
      if (!/whatsNew/.test(e.message)) throw e;
      console.log("· What's New skipped: not allowed on a first release");
    }
  }

  const sub = (
    await api('POST', '/v1/reviewSubmissions', {
      type: 'reviewSubmissions',
      attributes: { platform: 'IOS' },
      relationships: { app: { data: { type: 'apps', id: app } } },
    })
  ).data;
  await api('POST', '/v1/reviewSubmissionItems', {
    type: 'reviewSubmissionItems',
    relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } },
    },
  });
  await api('PATCH', `/v1/reviewSubmissions/${sub.id}`, {
    type: 'reviewSubmissions',
    id: sub.id,
    attributes: { submitted: true },
  });
  console.log(`✓ ${version} (${buildNumber}) submitted for review`);
}

// Add a processed build to one TestFlight beta group by name (no Beta App Review is requested here).
async function addToGroup(version, buildNumber, groupName) {
  const app = await appId();
  const build = (await builds(version)).find((b) => b.build === String(buildNumber));
  if (!build || build.state !== 'VALID')
    throw new Error(`Build ${version} (${buildNumber}) is ${build?.state ?? 'not found'}`);
  const gs = await api('GET', `/v1/apps/${app}/betaGroups?limit=50`);
  // ASC shows "<name> internal/external"; the API name is just <name>, so match the suffix on isInternalGroup.
  const m = /^(.*) (internal|external)$/.exec(groupName);
  const g =
    gs.data.find((x) => x.attributes.name === groupName) ??
    (m && gs.data.find((x) => x.attributes.name === m[1] && x.attributes.isInternalGroup === (m[2] === 'internal')));
  if (!g)
    throw new Error(
      `No beta group "${groupName}" (have: ${gs.data.map((x) => JSON.stringify(x.attributes.name)).join(', ') || 'none'})`,
    );
  // An internal group set to "all builds" gets every processed build already; Apple refuses an explicit add.
  if (g.attributes.isInternalGroup && g.attributes.hasAccessToAllBuilds) {
    const d = await api('GET', `/v1/builds/${build.id}/buildBetaDetail`);
    console.log(
      `✓ "${groupName}" has access to all builds · ${version} (${buildNumber}) internal state ${d.data.attributes.internalBuildState}`,
    );
    return;
  }
  await api('POST', `/v1/betaGroups/${g.id}/relationships/builds`, [{ type: 'builds', id: build.id }]);
  console.log(
    `✓ ${version} (${buildNumber}) added to "${groupName}" (${g.attributes.isInternalGroup ? 'internal' : 'external'})`,
  );
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'auth') console.log(`✓ key works · app ${await appId()}`);
  else if (cmd === 'upload') upload(args[0]);
  else if (cmd === 'builds') console.table(await builds(args[0]));
  else if (cmd === 'group') await addToGroup(args[0], args[1], args[2]);
  else if (cmd === 'submit') {
    const i = args.indexOf('--notes');
    await submit(args[0], args[1], i >= 0 ? args[i + 1] : undefined);
  } else {
    console.log('usage: asc.mjs auth | upload <archive> | builds [version] | submit <version> <build> [--notes "…"]');
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
