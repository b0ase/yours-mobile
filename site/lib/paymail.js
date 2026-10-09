// bWallet paymail (bsvalias) core. Pure logic + an injectable store, so it's unit-testable.
//
// The server holds NO private keys, of users or of its own:
//   - Users register alias → identity public key (+ ordinal receive address, profile), proving
//     ownership with a BRC-42/43 signature (protocol [2,'bwallet paymail'], keyID '1',
//     counterparty 'anyone') over a canonical message with a timestamp.
//   - P2P destinations use BRC-29 derivation with the "anyone" key (private key 1) as the
//     sender: child = identityKey.deriveChild(anyone, "2-3241645161d8-<prefix> <suffix>").
//     Only the identity private key can spend it; the wallet internalizes the output as a
//     "wallet payment" with senderIdentityKey = anyone's public key.
//   - Received transactions are verified against the reference's outputs and parked in an
//     inbox (beef + derivation) that the wallet collects with a signed request.
'use strict';
const { Beef, KeyDeriver, P2PKH, PrivateKey, PublicKey, ProtoWallet, Random, Transaction, Utils } = require('@bsv/sdk');

const BRC29 = [2, '3241645161d8'];
const SIGN_PROTOCOL = [2, 'bwallet paymail'];
const SIGN_KEY_ID = '1';
const ANYONE_PUB = new PrivateKey(1).toPublicKey().toString();
const SIG_WINDOW_MS = 5 * 60 * 1000;
const MAX_SATS = 21e14;
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
/**
 * Verified social names (bWalletX "Continue with X / Google", owner 4 Oct 2026): `b0asex.x`,
 * `theirname.gmail`. Registering one needs bit-sign to confirm the caller's key belongs to the
 * account that proved that X username / Gmail address (socialCheck), so nobody else can take it.
 */
const SOCIAL_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.(x|gmail)$/;
const aliasOk = (a) => ALIAS_RE.test(a) || SOCIAL_RE.test(a);
/**
 * Social names are bWalletX's own record (lib/social.js): `<name>.x` / `<name>.gmail` registers only
 * with a Continue with X / Google ticket + secret proving that name. Aliases are unique, so one X
 * name or Gmail address = one wallet.
 */
const { openTicket, socialAliasFor } = require('./social');
async function ticketSocialCheck(alias, proof, env = process.env) {
  if (!proof || !proof.ticket || !proof.secret) return 'Continue with X or Google first';
  const p = openTicket(proof.ticket, proof.secret, env);
  if (!p) return 'That sign-in has expired. Please sign in again.';
  return p.alias === alias ? null : 'That name does not match your sign-in';
}
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const RESERVED = new Set([
  // Impersonation and technical names.
  'admin', 'administrator', 'root', 'support', 'help', 'helpdesk', 'security', 'system', 'staff',
  'team', 'official', 'billing', 'payments', 'legal', 'abuse', 'moderator', 'mod', 'postmaster',
  'webmaster', 'noreply', 'no-reply', 'notifications', 'paymail', 'api', 'www', 'info',
  // Our companies and products (owner, 9 Oct 2026). Kept in step with bit-sign's reserved handles.
  'bwallet', 'bwalletx', 'bcorp', 'bitcoincorp', 'bitcoin-corp', 'thebitcoincorp', 'bitsign', 'bit-sign',
  'bchat', 'bchatx', 'bspaces', 'bmail', 'bmovies', 'bvault', 'btrust', 'bapps', 'bitcoinos',
  'npg', 'ninjapunkgirls', 'kintsugi', 'moneybutton', 'divvy', 'path401', 'path402', 'path403',
]);
/**
 * ⚠ A SOCIAL ALIAS IS RESERVED BY ITS BASE NAME. `bcorp.x` is proven by whoever holds X @bcorp,
 * which need not be us, so the suffix must not let a reserved name back in: `bcorp.x`,
 * `bcorp.gmail` and `bcorp` all refuse. Existing records are untouched (this runs at register).
 */
const reservedBase = (alias) => RESERVED.has(String(alias).replace(/\.(x|gmail)$/, ''));

const cleanDomain = (d) =>
  String(d || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
/** Primary paymail domain: PAYMAIL_DOMAIN, else the first of PAYMAIL_DOMAINS. */
const domain = (env = process.env) => domains(env)[0];
/**
 * Every domain we answer for: PAYMAIL_DOMAIN (primary) + the comma-separated PAYMAIL_DOMAINS.
 * An alias is one record whatever the domain, so switching the primary keeps old addresses working.
 */
function domains(env = process.env) {
  const list = [env.PAYMAIL_DOMAIN, ...String(env.PAYMAIL_DOMAINS || '').split(',')].map(cleanDomain).filter(Boolean);
  const out = [...new Set(list)];
  return out.length ? out : ['bwallet-nine.vercel.app'];
}
/** Public base URL for capability endpoints (defaults to https://<primary domain>). */
const baseUrl = (env = process.env) => String(env.PAYMAIL_BASE_URL || `https://${domain(env)}`).replace(/\/$/, '');

function capabilities(env = process.env) {
  const b = `${baseUrl(env)}/api/paymail`;
  return {
    bsvalias: '1.0',
    capabilities: {
      pki: `${b}/id/{alias}@{domain.tld}`,
      f12f968c92d6: `${b}/profile/{alias}@{domain.tld}`,
      a9f510c16bde: `${b}/verify/{alias}@{domain.tld}/{pubkey}`,
      '2a40af698840': `${b}/p2p-destination/{alias}@{domain.tld}`,
      '5f1323cddf31': `${b}/receive-tx/{alias}@{domain.tld}`,
      '5c55a7fdb7bb': `${b}/receive-beef/{alias}@{domain.tld}`,
      ordAddress: `${b}/ord/{alias}@{domain.tld}`,
    },
  };
}

/** "alice@domain" → { alias, domain } when the domain is one of ours and the alias is well-formed. */
function parseHandleParts(handle, env = process.env) {
  const s = decodeURIComponent(String(handle || ''))
    .trim()
    .toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  const alias = s.slice(0, at);
  const d = s.slice(at + 1);
  if (!domains(env).includes(d) || !aliasOk(alias)) return null;
  return { alias, domain: d };
}

/** "alice@domain" → "alice" when the domain is one of ours and the alias is well-formed. */
function parseHandle(handle, env = process.env) {
  const p = parseHandleParts(handle, env);
  return p ? p.alias : null;
}

const RESERVED_MSG = 'That alias is reserved';
function validAlias(alias) {
  if (!aliasOk(alias)) return 'Alias must be 1-32 chars: a-z, 0-9, - or _ (not at the ends)';
  if (reservedBase(alias)) return RESERVED_MSG;
  return null;
}

/** Canonical message the wallet signs. Field order is fixed; values are stringified. */
function signedMessage(action, fields) {
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
}

/** Verify a BRC-43 signature by `identityKey` (counterparty 'anyone' on the signer side). */
async function verifySigned(body, action, now = Date.now()) {
  const identityKey = String(body.identityKey || '').toLowerCase();
  if (!PUBKEY_RE.test(identityKey)) return 'Invalid identity key';
  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) return 'Signature expired; check your clock';
  if (!/^[0-9a-f]{16,200}$/i.test(String(body.signature || ''))) return 'Missing signature';
  const fields = { ...(body.fields || {}), identityKey, timestamp: String(ts) };
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(signedMessage(action, fields), 'utf8'),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: identityKey,
    });
    return valid ? null : 'Bad signature';
  } catch {
    return 'Bad signature';
  }
}

const deriver = new KeyDeriver(new PrivateKey(1));
/** BRC-29 P2PKH destination for `identityKey`; returns script + derivation the wallet needs. */
function deriveDestination(identityKey, satoshis) {
  const derivationPrefix = Utils.toBase64(Random(16));
  const derivationSuffix = Utils.toBase64(Random(16));
  const pub = deriver.derivePublicKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, identityKey, false);
  const script = new P2PKH().lock(pub.toAddress()).toHex();
  return { script, satoshis, derivationPrefix, derivationSuffix };
}

/** Parse a raw tx hex or BEEF hex. Returns { tx, beefHex|null }. */
function parseIncoming(hexOrBeef) {
  const hex = String(hexOrBeef || '').trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 20) throw new Error('Not hex');
  try {
    const beef = Beef.fromString(hex, 'hex');
    const last = beef.txs[beef.txs.length - 1];
    const tx = last && beef.findAtomicTransaction(last.txid);
    if (tx) return { tx, beefHex: hex };
  } catch {
    /* not BEEF */
  }
  return { tx: Transaction.fromHex(hex), beefHex: null };
}

/** Each expected output must appear in the tx with the same script and ≥ satoshis. Returns vouts or null. */
function matchOutputs(tx, expected) {
  const used = new Set();
  const vouts = [];
  for (const e of expected) {
    const i = tx.outputs.findIndex(
      (o, idx) => !used.has(idx) && o.lockingScript.toHex() === e.script && Number(o.satoshis) >= Number(e.satoshis),
    );
    if (i < 0) return null;
    used.add(i);
    vouts.push(i);
  }
  return vouts;
}

/**
 * Request handlers. `store` implements:
 *   getAlias(alias) → row|null            getAliasByKey(identityKey) → row|null
 *   upsertAlias(row) → row                renameAlias(from, to)
 *   insertPayment(row)                    getPayment(reference) → row|null
 *   updatePayment(reference, patch)       listInbox(identityKey) → rows (status 'received')
 *   countRecentPayments(alias, sinceIso) → number
 *   deleteByKey(identityKey) → { aliases, payments } (counts)
 * `broadcast(tx, beefHex)` is optional (best-effort).
 */
function makeHandlers({
  store,
  env = process.env,
  broadcast,
  now = () => Date.now(),
  socialCheck = ticketSocialCheck,
}) {
  // Aliases are unique across all our domains (the store is keyed by alias alone).
  const handleOf = (alias, d = domain(env)) => `${alias}@${d}`;
  const publicAlias = async (handle) => {
    const p = parseHandleParts(handle, env);
    if (!p) return [404, { error: 'not-found' }];
    const row = await store.getAlias(p.alias);
    if (!row) return [404, { error: 'not-found' }];
    return [200, { ...row, _domain: p.domain }];
  };

  return {
    caps: async () => [200, capabilities(env)],

    pki: async ({ handle }) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      return [200, { bsvalias: '1.0', handle: handleOf(row.alias, row._domain), pubkey: row.identity_key }];
    },

    profile: async ({ handle }) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      return [200, { name: row.display_name || row.alias, avatar: row.avatar || '' }];
    },

    verify: async ({ handle, pubkey }) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      const pk = String(pubkey || '').toLowerCase();
      return [
        200,
        { bsvalias: '1.0', handle: handleOf(row.alias, row._domain), pubkey: pk, match: pk === row.identity_key },
      ];
    },

    ord: async ({ handle }) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      if (!row.ord_address) return [404, { error: 'no-ord-address' }];
      return [200, { address: row.ord_address }];
    },

    p2pDestination: async ({ handle }, body) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      const satoshis = Math.floor(Number(body && body.satoshis));
      if (!Number.isFinite(satoshis) || satoshis < 1 || satoshis > MAX_SATS)
        return [400, { error: 'invalid-satoshis' }];
      const since = new Date(now() - 60 * 60 * 1000).toISOString();
      if ((await store.countRecentPayments(row.alias, since)) > 200) return [429, { error: 'rate-limited' }];
      const out = deriveDestination(row.identity_key, satoshis);
      const reference = Utils.toHex(Random(16));
      await store.insertPayment({
        reference,
        alias: row.alias,
        identity_key: row.identity_key,
        satoshis,
        outputs: [out],
        status: 'pending',
      });
      return [200, { outputs: [{ script: out.script, satoshis }], reference }];
    },

    receive: async ({ handle }, body) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      const reference = String((body && body.reference) || '');
      const pay = reference && (await store.getPayment(reference));
      if (!pay || pay.alias !== row.alias) return [404, { error: 'unknown-reference' }];
      let parsed;
      try {
        parsed = parseIncoming(body.beef || body.hex);
      } catch {
        return [400, { error: 'invalid-transaction' }];
      }
      const txid = parsed.tx.id('hex');
      if (pay.status !== 'pending') {
        if (pay.txid === txid) return [200, { txid, note: 'already received' }];
        return [409, { error: 'reference-already-used' }];
      }
      const vouts = matchOutputs(parsed.tx, pay.outputs);
      if (!vouts) return [400, { error: 'outputs-do-not-match-reference' }];
      if (broadcast) {
        try {
          await broadcast(parsed.tx, parsed.beefHex);
        } catch (e) {
          // The sender normally broadcasts first (1Sat sendBsv does); log and keep going.
          console.error('paymail broadcast failed', String(e && e.message ? e.message : e).slice(0, 200));
        }
      }
      const outputs = pay.outputs.map((o, i) => ({ ...o, vout: vouts[i] }));
      await store.updatePayment(reference, {
        status: 'received',
        txid,
        beef: parsed.beefHex,
        raw_tx: parsed.beefHex ? null : parsed.tx.toHex(),
        outputs,
        sender_handle: String((body.metadata && body.metadata.sender) || '').slice(0, 128) || null,
        note: String((body.metadata && body.metadata.note) || '').slice(0, 256) || null,
        received_at: new Date(now()).toISOString(),
      });
      return [200, { txid, note: `Received by ${handleOf(row.alias, row._domain)}` }];
    },

    // ---- wallet-authenticated ------------------------------------------------
    register: async (_q, body) => {
      body = body || {};
      const f = body.fields || {};
      const alias = String(f.alias || '').toLowerCase();
      const bad = validAlias(alias);
      // Reserved names refuse NEW claims only: whoever already holds one (us) can still update it.
      if (bad && bad !== RESERVED_MSG) return [400, { error: bad }];
      if (f.ordAddress && !/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(f.ordAddress)))
        return [400, { error: 'Invalid ordAddress' }];
      const sigErr = await verifySigned(body, 'register', now());
      if (sigErr) return [401, { error: sigErr }];
      const identityKey = String(body.identityKey).toLowerCase();
      const taken = await store.getAlias(alias);
      if (bad === RESERVED_MSG && !(taken && String(taken.identity_key).toLowerCase() === identityKey))
        return [400, { error: bad }];
      // A verified name needs proof only to claim it; its owner can update the profile without signing in again.
      const ownsIt = taken && String(taken.identity_key).toLowerCase() === identityKey;
      if (SOCIAL_RE.test(alias) && !ownsIt) {
        const refused = await socialCheck(alias, body.social, env);
        if (refused) return [403, { error: refused }];
      }
      if (taken && taken.identity_key !== identityKey) return [409, { error: 'That name is taken' }];
      // Verified social names sit beside the plain name (one of each kind per wallet): b0asex.x is
      // added, boase stays. A plain name still renames, keeping the inbox.
      const kind = SOCIAL_RE.test(alias) ? (alias.endsWith('.x') ? 'x' : 'gmail') : 'plain';
      // One identity per wallet (owner, 4 Oct 2026): a verified X / Google name always wins, so a
      // wallet that has one can't also take a plain name. Plain-name identities are separate accounts.
      if (kind === 'plain') {
        const social =
          (await store.getAliasByKeyKind?.(identityKey, 'x')) ||
          (await store.getAliasByKeyKind?.(identityKey, 'gmail'));
        if (social)
          return [
            409,
            { error: `This wallet's name is ${handleOf(social.alias)}. Add another account for a different name.` },
          ];
      }
      const mine =
        kind === 'plain' ? await store.getAliasByKey(identityKey) : await store.getAliasByKeyKind?.(identityKey, kind);
      if (mine && mine.alias !== alias && (mine.kind ?? 'plain') === kind) await store.renameAlias(mine.alias, alias);
      const row = await store.upsertAlias({
        kind,
        alias,
        identity_key: identityKey,
        ord_address: f.ordAddress || null,
        // Keep what's there when an update leaves a field out.
        display_name: String(f.name || '').slice(0, 64) || (ownsIt ? taken.display_name : null) || null,
        avatar: String(f.avatar || '').slice(0, 512) || (ownsIt ? taken.avatar : null) || null,
      });
      return [200, { paymail: handleOf(row.alias), pubkey: identityKey }];
    },

    // Market › Social: names whose owners may have a personal token. provider=all → every kind.
    social: async (q) => {
      const kinds = q.provider === 'all' ? ['x', 'gmail', 'plain'] : [q.provider === 'google' ? 'gmail' : 'x'];
      const rows = [];
      for (const k of kinds)
        for (const r of store.listSocial ? await store.listSocial(k) : []) rows.push({ ...r, kind: k });
      return [200, { accounts: rows.map((r) => ({ alias: r.alias, name: r.display_name || null, kind: r.kind })) }];
    },

    lookup: async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'invalid-key' }];
      // The wallet's identity: its verified social name wins over an older plain one.
      const row =
        (await store.getAliasByKeyKind?.(key, 'x')) ||
        (await store.getAliasByKeyKind?.(key, 'gmail')) ||
        (await store.getAliasByKey(key));
      if (!row) return [404, { error: 'not-found' }];
      // All names that receive for this wallet, so none is invisible (owner, 4 Oct 2026).
      const all = store.listByKey ? await store.listByKey(key) : [row];
      const names = all.map((r) => ({
        paymail: handleOf(r.alias),
        kind: r.kind || 'plain',
        main: r.alias === row.alias,
      }));
      return [200, { paymail: handleOf(row.alias), alias: row.alias, names }];
    },

    inbox: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'inbox', now());
      if (sigErr) return [401, { error: sigErr }];
      const rows = await store.listInbox(String(body.identityKey).toLowerCase());
      return [
        200,
        {
          senderIdentityKey: ANYONE_PUB,
          payments: rows.map((r) => ({
            reference: r.reference,
            txid: r.txid,
            beef: r.beef,
            rawTx: r.raw_tx,
            sender: r.sender_handle,
            note: r.note,
            outputs: r.outputs.map((o) => ({
              vout: o.vout,
              satoshis: o.satoshis,
              derivationPrefix: o.derivationPrefix,
              derivationSuffix: o.derivationSuffix,
            })),
          })),
        },
      ];
    },

    ack: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'ack', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const refs = String((body.fields && body.fields.references) || '')
        .split(',')
        .filter(Boolean)
        .slice(0, 100);
      let done = 0;
      for (const ref of refs) {
        const p = await store.getPayment(ref);
        if (p && p.identity_key === key && p.status === 'received') {
          await store.updatePayment(ref, { status: 'collected', collected_at: new Date(now()).toISOString() });
          done++;
        }
      }
      return [200, { collected: done }];
    },

    // Account deletion (Apple 5.1.1(v), Google Play): removes the alias and every inbox row for
    // this identity key. The wallet collects the inbox first, so no uncollected payment's
    // derivation data is lost. On-chain payments themselves are unaffected.
    // Apps › Add app (owner, 5 Oct 2026): the wallet's own list, so a 12-word restore brings it back.
    // Signed by the identity key both ways; the list is private to that wallet.
    appsGet: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'apps-get', now());
      if (sigErr) return [401, { error: sigErr }];
      return [200, { apps: (await store.getApps?.(String(body.identityKey).toLowerCase())) ?? [] }];
    },
    appsPut: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'apps-put', now());
      if (sigErr) return [401, { error: sigErr }];
      let apps;
      try {
        apps = JSON.parse(String(body.fields?.apps || '[]'));
      } catch {
        return [400, { error: 'apps must be JSON' }];
      }
      if (!Array.isArray(apps) || apps.length > 200) return [400, { error: 'Up to 200 apps' }];
      const clean = [];
      for (const a of apps) {
        let u;
        try {
          u = new URL(String(a?.url || ''));
        } catch {
          return [400, { error: 'Each app needs a valid https link' }];
        }
        if (u.protocol !== 'https:') return [400, { error: 'Apps must use https' }];
        clean.push({ url: u.href.slice(0, 300), name: String(a?.name || u.hostname).slice(0, 40) });
      }
      await store.setApps(String(body.identityKey).toLowerCase(), clean);
      return [200, { apps: clean }];
    },

    // Unlink one of this wallet's names (Settings › Identity). The name becomes free for anyone.
    unlink: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'unlink', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const key = String(body.identityKey).toLowerCase();
      const row = alias ? await store.getAlias(alias) : null;
      if (!row || String(row.identity_key).toLowerCase() !== key)
        return [404, { error: 'That name is not on this wallet' }];
      if (store.countUncollected && (await store.countUncollected(alias)) > 0)
        return [
          409,
          { error: 'A payment to this name is still arriving. Open the wallet to collect it, then try again.' },
        ];
      await store.deleteAlias(alias);
      return [200, { unlinked: handleOf(alias) }];
    },

    delete: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'delete', now());
      if (sigErr) return [401, { error: sigErr }];
      if (!body.fields || body.fields.confirm !== 'DELETE') return [400, { error: 'confirm must be DELETE' }];
      const key = String(body.identityKey).toLowerCase();
      const row = await store.getAliasByKey(key);
      const removed = await store.deleteByKey(key);
      await store.deleteBphone?.(key);
      return [200, { deleted: true, alias: row ? row.alias : null, ...removed }];
    },

    // ---- bPhone: charge to receive calls (docs/BPHONE-PLAN.md) --------------------------------
    // The rate card + listing are public (a caller reads them before dialling); writes are signed.
    // Bookings are between two identity keys; each side reads its own with a signed request.
    'bphone-get': async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'invalid-key' }];
      const row = await store.getBphone?.(key);
      if (!row) return [404, { error: 'not-found' }];
      return [200, { key, profile: row.profile, ...(await nameOf(key)) }];
    },
    'bphone-put': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-put', now());
      if (sigErr) return [401, { error: sigErr }];
      let raw;
      try {
        raw = JSON.parse(String(body.fields?.profile || ''));
      } catch {
        return [400, { error: 'profile must be JSON' }];
      }
      const profile = cleanProfile(raw);
      if (typeof profile === 'string') return [400, { error: profile }];
      profile.updatedAt = now();
      const key = String(body.identityKey).toLowerCase();
      await store.setBphone(key, profile);
      return [200, { profile }];
    },
    // Who is listed, newest first; ?category= narrows. Only listed profiles, never the unlisted rate cards.
    'bphone-directory': async (q) => {
      const category = BPHONE_CATEGORIES.includes(q.category) ? q.category : null;
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const rows = (await store.listBphone?.(category, limit)) ?? [];
      const listings = [];
      for (const r of rows)
        listings.push({ key: r.identity_key, profile: r.profile, ...(await nameOf(r.identity_key)) });
      return [200, { listings }];
    },
    // Ask for a call at a time (the callee's listing must take bookings).
    'bphone-book': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-book', now());
      if (sigErr) return [401, { error: sigErr }];
      const f = body.fields || {};
      const callee = String(f.calleeKey || '').toLowerCase();
      const caller = String(body.identityKey).toLowerCase();
      if (!PUBKEY_RE.test(callee)) return [400, { error: 'invalid callee' }];
      if (callee === caller) return [400, { error: 'You cannot book yourself' }];
      const prof = await store.getBphone?.(callee);
      if (!prof || prof.profile?.listing?.booking === false)
        return [404, { error: 'This person does not take bookings' }];
      const req = cleanBookingRequest(f, now());
      if (typeof req === 'string') return [400, { error: req }];
      const open = (await store.listBookings(caller)).filter(
        (b) => b.status === 'requested' && b.caller_key === caller,
      );
      if (open.length >= 20) return [429, { error: 'Too many open requests' }];
      const calleeName = await nameOf(callee);
      const row = {
        id: Utils.toHex(Random(16)),
        callee_key: callee,
        caller_key: caller,
        caller_label: req.callerLabel,
        callee_label: calleeName.paymail || '',
        at: req.at,
        minutes: req.minutes,
        note: req.note,
        status: 'requested',
        rate: prof.profile?.rate ?? null,
        created_at: new Date(now()).toISOString(),
        updated_at: new Date(now()).toISOString(),
      };
      await store.insertBooking(row);
      return [200, { booking: bookingOut(row) }];
    },
    // Every booking this identity is part of, soonest first.
    'bphone-bookings': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-bookings', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const rows = await store.listBookings(key);
      return [200, { bookings: rows.map(bookingOut).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) }];
    },
    // Callee: confirm / decline / cancel. Caller: cancel. Nothing else moves.
    'bphone-book-act': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-book-act', now());
      if (sigErr) return [401, { error: sigErr }];
      const f = body.fields || {};
      const key = String(body.identityKey).toLowerCase();
      const id = String(f.id || '');
      const action = String(f.action || '');
      if (!/^[0-9a-f]{32}$/.test(id)) return [400, { error: 'invalid booking' }];
      const row = await store.getBooking(id);
      if (!row) return [404, { error: 'not-found' }];
      const isCallee = row.callee_key === key;
      const isCaller = row.caller_key === key;
      if (!isCallee && !isCaller) return [403, { error: 'Not your booking' }];
      let status;
      if (action === 'cancel') status = 'cancelled';
      else if (isCallee && action === 'confirm' && row.status === 'requested') status = 'confirmed';
      else if (isCallee && action === 'decline' && row.status === 'requested') status = 'declined';
      else return [400, { error: `Cannot ${action} a ${row.status} booking` }];
      if (row.status === 'declined' || row.status === 'cancelled') return [400, { error: `Already ${row.status}` }];
      const patch = { status, updated_at: new Date(now()).toISOString() };
      await store.updateBooking(id, patch);
      return [200, { booking: bookingOut({ ...row, ...patch }) }];
    },
  };

  /** The paymail + profile name / avatar for a key, for directory rows and bookings ('' when it has none). */
  async function nameOf(key) {
    const row =
      (await store.getAliasByKeyKind?.(key, 'x')) ||
      (await store.getAliasByKeyKind?.(key, 'gmail')) ||
      (await store.getAliasByKey(key));
    return row
      ? { paymail: handleOf(row.alias), name: row.display_name || null, avatar: row.avatar || null }
      : { paymail: null, name: null, avatar: null };
  }
}

const BPHONE_CATEGORIES = require('./bphone').CATEGORIES;
const { cleanProfile, cleanBookingRequest } = require('./bphone');

/** A booking row as the wallet reads it (src/mobile/calls/rateCard.ts parseBooking). */
const bookingOut = (r) => ({
  id: r.id,
  calleeKey: r.callee_key,
  callerKey: r.caller_key,
  callerLabel: r.caller_label || '',
  calleeLabel: r.callee_label || '',
  at: new Date(r.at).toISOString(),
  minutes: r.minutes,
  note: r.note || '',
  status: r.status,
  rate: r.rate ?? null,
  createdAt: new Date(r.created_at).toISOString(),
});

module.exports = {
  socialAliasFor,
  ANYONE_PUB,
  BRC29,
  SIGN_PROTOCOL,
  SIGN_KEY_ID,
  capabilities,
  parseHandle,
  parseHandleParts,
  validAlias,
  signedMessage,
  verifySigned,
  deriveDestination,
  parseIncoming,
  matchOutputs,
  makeHandlers,
  domain,
  domains,
  baseUrl,
  PublicKey,
};
