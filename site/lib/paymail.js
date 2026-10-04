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
  'admin',
  'root',
  'support',
  'help',
  'bwallet',
  'bcorp',
  'paymail',
  'api',
  'www',
  'info',
  'security',
]);

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

function validAlias(alias) {
  if (!aliasOk(alias)) return 'Alias must be 1-32 chars: a-z, 0-9, - or _ (not at the ends)';
  if (RESERVED.has(alias)) return 'That alias is reserved';
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
function makeHandlers({ store, env = process.env, broadcast, now = () => Date.now(), socialCheck = ticketSocialCheck }) {
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
      if (bad) return [400, { error: bad }];
      if (f.ordAddress && !/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(f.ordAddress)))
        return [400, { error: 'Invalid ordAddress' }];
      const sigErr = await verifySigned(body, 'register', now());
      if (sigErr) return [401, { error: sigErr }];
      const identityKey = String(body.identityKey).toLowerCase();
      if (SOCIAL_RE.test(alias)) {
        const refused = await socialCheck(alias, body.social, env);
        if (refused) return [403, { error: refused }];
      }
      const taken = await store.getAlias(alias);
      if (taken && taken.identity_key !== identityKey) return [409, { error: 'That name is taken' }];
      // Verified social names sit beside the plain name (one of each kind per wallet): b0asex.x is
      // added, boase stays. A plain name still renames, keeping the inbox.
      const kind = SOCIAL_RE.test(alias) ? (alias.endsWith('.x') ? 'x' : 'gmail') : 'plain';
      // One identity per wallet (owner, 4 Oct 2026): a verified X / Google name always wins, so a
      // wallet that has one can't also take a plain name. Plain-name identities are separate accounts.
      if (kind === 'plain') {
        const social = (await store.getAliasByKeyKind?.(identityKey, 'x')) || (await store.getAliasByKeyKind?.(identityKey, 'gmail'));
        if (social) return [409, { error: `This wallet's name is ${handleOf(social.alias)}. Add another account for a different name.` }];
      }
      const mine = kind === 'plain' ? await store.getAliasByKey(identityKey) : await store.getAliasByKeyKind?.(identityKey, kind);
      if (mine && mine.alias !== alias && (mine.kind ?? 'plain') === kind) await store.renameAlias(mine.alias, alias);
      const row = await store.upsertAlias({
        kind,
        alias,
        identity_key: identityKey,
        ord_address: f.ordAddress || null,
        display_name: String(f.name || '').slice(0, 64) || null,
        avatar: String(f.avatar || '').slice(0, 512) || null,
      });
      return [200, { paymail: handleOf(row.alias), pubkey: identityKey }];
    },

    social: async (q) => {
      const suffix = q.provider === 'google' ? 'gmail' : 'x';
      const rows = store.listSocial ? await store.listSocial(suffix) : [];
      return [200, { accounts: rows.map((r) => ({ alias: r.alias, name: r.display_name || null })) }];
    },

    lookup: async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'invalid-key' }];
      // The wallet's identity: its verified social name wins over an older plain one.
      const row =
        (await store.getAliasByKeyKind?.(key, 'x')) || (await store.getAliasByKeyKind?.(key, 'gmail')) || (await store.getAliasByKey(key));
      if (!row) return [404, { error: 'not-found' }];
      // All names that receive for this wallet, so none is invisible (owner, 4 Oct 2026).
      const all = store.listByKey ? await store.listByKey(key) : [row];
      const names = all.map((r) => ({ paymail: handleOf(r.alias), kind: r.kind || 'plain', main: r.alias === row.alias }));
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
    // Unlink one of this wallet's names (Settings › Identity). The name becomes free for anyone.
    unlink: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'unlink', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const key = String(body.identityKey).toLowerCase();
      const row = alias ? await store.getAlias(alias) : null;
      if (!row || String(row.identity_key).toLowerCase() !== key) return [404, { error: 'That name is not on this wallet' }];
      if (store.countUncollected && (await store.countUncollected(alias)) > 0)
        return [409, { error: 'A payment to this name is still arriving. Open the wallet to collect it, then try again.' }];
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
      return [200, { deleted: true, alias: row ? row.alias : null, ...removed }];
    },
  };
}

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
