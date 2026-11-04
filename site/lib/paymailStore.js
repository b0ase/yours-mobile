// Supabase (PostgREST) store for bWallet paymail. Tables: migrations/20261001_bwallet_paymail.sql.
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
'use strict';

function supabaseStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const h = (extra = {}) => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  });
  const q = encodeURIComponent;
  const req = async (path, init = {}) => {
    const r = await f(`${url}/rest/v1/${path}`, { ...init, headers: h(init.headers) });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  const one = async (path) => (await req(path))?.[0] ?? null;
  return {
    getAlias: (alias) => one(`bwallet_paymail_aliases?alias=eq.${q(alias)}&limit=1`),
    // A wallet's plain name first; a verified social name (kind x / gmail) only if it has no plain one.
    // Only the primary name of each kind (migration STEP A: is_primary; extra plain names are false).
    getAliasByKey: async (k) =>
      (await one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&kind=eq.plain&is_primary=is.true&limit=1`)) ??
      one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&is_primary=is.true&limit=1`),
    // Every name that receives for this wallet (Settings › Identity shows them all).
    listByKey: async (k) =>
      // Removed extra names are renamed to an rm-… tombstone (they keep their payment history); hide them.
      (await req(
        `bwallet_paymail_aliases?identity_key=eq.${q(k)}&alias=not.like.rm-*&select=alias,kind,is_primary&order=created_at.asc&limit=50`,
      )) || [],
    getAliasByKeyKind: (k, kind) =>
      one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&kind=eq.${q(kind)}&is_primary=is.true&limit=1`),
    // An extra plain name (never primary). A plain INSERT: a clash (taken name, or the old
    // UNIQUE(identity_key, kind) index before STEP B) fails with 409 instead of merging.
    insertExtraAlias: async (row) =>
      (
        await req('bwallet_paymail_aliases', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ ...row, kind: 'plain', is_primary: false, updated_at: new Date().toISOString() }),
        })
      )?.[0] ?? null,
    // Make `to` the primary plain name. The partial unique index allows one primary per (key, kind),
    // so the old one is cleared first; if setting the new one fails, the old one is put back so the
    // wallet never ends up with no primary name.
    setPrimary: async (k, from, to) => {
      const patch = (alias, v) =>
        req(`bwallet_paymail_aliases?alias=eq.${q(alias)}&identity_key=eq.${q(k)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ is_primary: v, updated_at: new Date().toISOString() }),
        });
      if (from) await patch(from, false);
      try {
        await patch(to, true);
      } catch (e) {
        if (from) await patch(from, true);
        throw e;
      }
    },
    // Verified social names (alias ends .x / .gmail), for the bWalletX Market "X Accounts" filter.
    listSocial: async (suffix) =>
      (await req(`bwallet_paymail_aliases?kind=eq.${q(suffix)}&select=alias,display_name&limit=5000`)) || [],
    upsertAlias: async (row) =>
      (
        await req('bwallet_paymail_aliases?on_conflict=alias', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          // kind: 'plain' | 'x' | 'gmail' (migrations/20261004_bwallet_paymail_social_names.sql)
          body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
        })
      )[0],
    // migrations/20261024_paymail_ord_proof.sql: the owner's signature over their ordinal address.
    setOrdProof: (alias, proof) =>
      req(`bwallet_paymail_aliases?alias=eq.${q(alias)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ord_proof: proof }),
      }),
    renameAlias: (from, to) =>
      req(`bwallet_paymail_aliases?alias=eq.${q(from)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ alias: to, updated_at: new Date().toISOString() }),
      }),
    // Name forwards (migrations/20261009_bwallet_paymail_forwards.sql): old/extra name -> main name.
    getForward: (from) => one(`bwallet_paymail_forwards?from_alias=eq.${q(from)}&limit=1`),
    putForward: (row) =>
      req('bwallet_paymail_forwards?on_conflict=from_alias', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    deleteForward: (from) =>
      req(`bwallet_paymail_forwards?from_alias=eq.${q(from)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }),
    // Point every forward that targeted `from` at `to` (a renamed main name keeps its old names).
    retargetForwards: (from, to) =>
      req(`bwallet_paymail_forwards?to_alias=eq.${q(from)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ to_alias: to }),
      }),
    // Expired rename forwards, released in bulk (lookups also release them one by one).
    deleteExpiredForwards: (nowIso) =>
      req(`bwallet_paymail_forwards?expires_at=lt.${q(nowIso)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }),
    // A retired social name (.gmail) becomes a forward: its payment records move to the plain name first.
    retireToForward: async (from, to, identityKey, expiresAt) => {
      await req('bwallet_paymail_forwards?on_conflict=from_alias', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ from_alias: from, to_alias: to, identity_key: identityKey, expires_at: expiresAt }),
      });
      await req(`bwallet_paymail_payments?alias=eq.${q(from)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ alias: to }),
      });
      await req(`bwallet_paymail_aliases?alias=eq.${q(from)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
    },
    // Anti-squatting (migrations/20261010_bwallet_paymail_anti_squat.sql).
    lastRename: async (k) =>
      (await one(`bwallet_paymail_name_events?identity_key=eq.${q(k)}&kind=eq.rename&order=created_at.desc&limit=1`))
        ?.created_at ?? null,
    countIpClaims: async (ipHash, since) =>
      (
        (await req(
          `bwallet_paymail_name_events?ip_hash=eq.${q(ipHash)}&created_at=gte.${q(since)}&select=id&limit=1000`,
        )) ?? []
      ).length,
    // New names (claim or rename) by one wallet since a time: the per-key daily cap (owner, 28 Oct 2026).
    countKeyClaims: async (identityKey, since) =>
      (
        (await req(
          `bwallet_paymail_name_events?identity_key=eq.${q(identityKey)}&created_at=gte.${q(since)}&select=id&limit=1000`,
        )) ?? []
      ).length,
    // Link your accounts (migrations/20261018_social_links.sql): wallet-signed, provider-proved links.
    putSocialLink: (row) =>
      req('bwallet_social_links?on_conflict=provider,account', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    listSocialLinks: async (key) =>
      (await req(
        `bwallet_social_links?identity_key=eq.${q(key)}&select=provider,account,handle,identity_key,signature,signed_at&order=created_at.asc&limit=20`,
      )) ?? [],
    // Signed name bindings + the public append-only log (migrations/20261017_name_bindings.sql).
    // Company offers (migrations/20261024_company_offers.sql). A receipt is insert-only: no code path updates it.
    getOffer: (ref) => one(`company_offers?ref=eq.${q(ref)}&limit=1`),
    putOffer: (row) =>
      req('company_offers?on_conflict=ref', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    getReceipt: (txid) => one(`subscription_receipts?txid=eq.${q(txid)}&limit=1`),
    insertReceipt: (row) =>
      req('subscription_receipts', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      }),
    listReceipts: async (alias) =>
      (await req(`subscription_receipts?alias=eq.${q(alias)}&select=record&order=created_at.desc&limit=200`)) || [],
    getBinding: (alias) => one(`bwallet_name_bindings?alias=eq.${q(alias)}&limit=1`),
    // A released name (unlink / delete wallet) keeps no signed binding, or its next owner could never bind it
    // (b-Aware 25 Oct 2026, darkasep112: bind answered 409 "signed by another wallet" forever).
    deleteBinding: (alias) =>
      req(`bwallet_name_bindings?alias=eq.${q(alias)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    deleteBindingsByKey: (k) =>
      req(`bwallet_name_bindings?identity_key=eq.${q(k)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }),
    putBinding: (row) =>
      req('bwallet_name_bindings', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    logName: (row) =>
      req('bwallet_name_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }),
    nameLog: async (alias, limit = 200) =>
      (await req(
        `bwallet_name_log?${alias ? `alias=eq.${q(alias)}&` : ''}select=id,alias,identity_key,prev_identity_key,action,actor,seq,signature,note,prev_hash,entry_hash,created_at&order=id.desc&limit=${limit}`,
      )) ?? [],
    // Provable names (migrations/20261028_name_proofs.sql).
    // Name tokens: our own record of a token's mint outpoint (migrations/20261028_name_token_locations.sql).
    nameTokenOrigin: (name) => one(`name_token_origins?name=eq.${q(name)}&select=name,kind,origin&limit=1`),
    putNameTokenOrigin: (row) =>
      req('name_token_origins', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      }),
    getProof: (alias) =>
      one(
        `bwallet_name_proofs?alias=eq.${q(alias)}&select=alias,provider,sub,identity_key,id_token,created_at&limit=1`,
      ),
    // One `.linkedin` name per LinkedIn account: the proof already bound to this provider account, if any.
    getProofBySub: (provider, sub) =>
      one(`bwallet_name_proofs?provider=eq.${q(provider)}&sub=eq.${q(sub)}&select=alias,provider,sub&limit=1`),
    putProof: (row) =>
      req('bwallet_name_proofs', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    // Archived provider keys: name-log entries with action 'jwks' under alias 'jwks:<provider>', oldest first.
    providerKeys: async (jwksAlias) =>
      (await req(
        `bwallet_name_log?alias=eq.${q(jwksAlias)}&action=eq.jwks&select=note,created_at&order=id.asc&limit=1000`,
      )) ?? [],
    // Two-party handovers (migrations/20261017_name_handovers.sql).
    getHandover: (alias) => one(`bwallet_name_handovers?alias=eq.${q(alias)}&limit=1`),
    putHandover: (row) =>
      req('bwallet_name_handovers', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }),
    deleteHandover: (alias) =>
      req(`bwallet_name_handovers?alias=eq.${q(alias)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    handoversFor: async (key) =>
      (await req(`bwallet_name_handovers?to_key=eq.${q(key)}&select=alias,from_key,to_key,seq,created_at`)) ?? [],
    /** Point a name at a new key (the trigger logs it). Main name only if the new key has no main plain name. */
    moveAlias: async (alias, key) => {
      const hasMain = await one(
        `bwallet_paymail_aliases?identity_key=eq.${q(key)}&kind=eq.plain&is_primary=eq.true&select=alias&limit=1`,
      );
      await req(`bwallet_paymail_aliases?alias=eq.${q(alias)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ identity_key: key, is_primary: !hasMain, updated_at: new Date().toISOString() }),
      });
    },
    recordNameEvent: (row) =>
      req('bwallet_paymail_name_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      }),
    // true when this txid had not paid for a name before (and is now recorded), false when reused.
    useFeeTx: async (row) =>
      (
        (await req('bwallet_paymail_name_fees?on_conflict=txid', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify(row),
        })) ?? []
      ).length > 0,
    // Paid-name receipts, oldest first (admin CSV export). `since` = ISO time, optional.
    listNameFees: async ({ since } = {}) =>
      (await req(
        `bwallet_paymail_name_fees?select=txid,identity_key,alias,satoshis,usd,rate,kind,created_at${
          since && !Number.isNaN(Date.parse(since)) ? `&created_at=gte.${q(new Date(since).toISOString())}` : ''
        }&order=created_at.asc&limit=10000`,
      )) ?? [],
    insertPayment: (row) =>
      req('bwallet_paymail_payments', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      }),
    getPayment: (ref) => one(`bwallet_paymail_payments?reference=eq.${q(ref)}&limit=1`),
    updatePayment: (ref, patch) =>
      req(`bwallet_paymail_payments?reference=eq.${q(ref)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    listInbox: async (k) =>
      (await req(
        `bwallet_paymail_payments?identity_key=eq.${q(k)}&status=eq.received&order=received_at.asc&limit=50`,
      )) ?? [],
    // Restore from seed: received and collected payments (newest 500), for re-internalizing on a new device.
    listHistory: async (k) =>
      (await req(
        `bwallet_paymail_payments?identity_key=eq.${q(k)}&status=in.(received,collected)&order=received_at.asc&limit=500`,
      )) ?? [],
    // Apps › Add app: the wallet's own app list (one row per identity key).
    getApps: async (k) => (await one(`bwallet_user_apps?identity_key=eq.${q(k)}&select=apps&limit=1`))?.apps ?? [],
    setApps: async (k, apps) =>
      req('bwallet_user_apps?on_conflict=identity_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ identity_key: k, apps, updated_at: new Date().toISOString() }),
      }),
    // bPhone (migrations/20261008_bwallet_bphone.sql): rate card + listing per identity, and bookings.
    getBphone: (k) =>
      one(`bwallet_bphone_profiles?identity_key=eq.${q(k)}&select=identity_key,profile,updated_at&limit=1`),
    setBphone: (k, profile) =>
      req('bwallet_bphone_profiles?on_conflict=identity_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          identity_key: k,
          profile,
          listed: profile.listing.listed === true,
          category: profile.listing.category,
          updated_at: new Date().toISOString(),
        }),
      }),
    listBphone: async (category, limit) =>
      (await req(
        `bwallet_bphone_profiles?listed=is.true${category ? `&category=eq.${q(category)}` : ''}&select=identity_key,profile,updated_at&order=updated_at.desc&limit=${limit}`,
      )) || [],
    deleteBphone: async (k) => {
      await req(`bwallet_bphone_profiles?identity_key=eq.${q(k)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
    },
    insertBooking: (row) =>
      req('bwallet_bphone_bookings', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      }),
    getBooking: (id) => one(`bwallet_bphone_bookings?id=eq.${q(id)}&limit=1`),
    listBookings: async (k) =>
      (await req(`bwallet_bphone_bookings?or=(callee_key.eq.${q(k)},caller_key.eq.${q(k)})&order=at.asc&limit=200`)) ||
      [],
    updateBooking: (id, patch) =>
      req(`bwallet_bphone_bookings?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    // Unlink one name: its payment records go too (FK on alias). Callers refuse while any is uncollected.
    countUncollected: async (alias) =>
      ((await req(`bwallet_paymail_payments?alias=eq.${q(alias)}&status=eq.received&select=reference`)) ?? []).length,
    // One display name per wallet: every paymail on this identity key shows the same name.
    setDisplayNameByKey: (k, name) =>
      req(`bwallet_paymail_aliases?identity_key=eq.${q(k)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ display_name: name, updated_at: new Date().toISOString() }),
      }),
    deleteAlias: async (alias) => {
      await req(`bwallet_paymail_payments?alias=eq.${q(alias)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      await req(`bwallet_paymail_aliases?alias=eq.${q(alias)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
    },
    deleteByKey: async (k) => {
      const del = async (table) =>
        (await req(`${table}?identity_key=eq.${q(k)}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=representation' },
        })) ?? [];
      const payments = (await del('bwallet_paymail_payments')).length;
      const aliases = (await del('bwallet_paymail_aliases')).length;
      await del('bwallet_paymail_forwards');
      return { aliases, payments };
    },
    countRecentPayments: async (alias, since) => {
      const r = await f(
        `${url}/rest/v1/bwallet_paymail_payments?alias=eq.${q(alias)}&created_at=gte.${q(since)}&select=reference`,
        { method: 'HEAD', headers: h({ Prefer: 'count=exact' }) },
      );
      const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
      return m ? Number(m[1]) : 0;
    },
  };
}

/** fetch with a deadline: a slow ARC or WhatsOnChain must never hold a claim (or a Vercel function) open. */
const timed =
  (f, ms) =>
  (url, init = {}) =>
    f(url, { ...init, signal: AbortSignal.timeout(ms) });

/** Best-effort ARC broadcast (the sender normally broadcasts already). Env: ARC_URL, ARC_API_KEY. */
function arcBroadcast(env = process.env, f = fetch) {
  const arc = String(env.ARC_URL || 'https://arc.gorillapool.io').replace(/\/$/, '');
  const tf = timed(f, 10_000);
  return async (tx, beefHex) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (env.ARC_API_KEY) headers.Authorization = `Bearer ${env.ARC_API_KEY}`;
    // ARC's own extended format (EF: each input carries its source output) when the wallet sent BEEF; a wallet's
    // AtomicBEEF bytes were refused as-is (owner's $1 theme buy, 17 Oct 2026). EF does NOT carry the parent
    // transactions, only their outputs: an unmined parent the network lacks leaves this tx an orphan, and any
    // non-REJECTED answer (ANNOUNCED_TO_NETWORK included) passes here. Store claims use arcSubmit below instead.
    let hex = tx.toHex();
    if (beefHex) {
      try {
        hex = tx.toHexEF();
      } catch {
        hex = beefHex;
      }
    }
    const r = await tf(`${arc}/v1/tx`, { method: 'POST', headers, body: Buffer.from(hex, 'hex') });
    const text = await r.text().catch(() => '');
    let status = '';
    try {
      status = String(JSON.parse(text).txStatus || '');
    } catch {
      /* not JSON */
    }
    if ((!r.ok && r.status !== 409) || /REJECTED|DOUBLE_SPEND/i.test(status)) {
      console.error('arc broadcast refused', r.status, text.slice(0, 400));
      throw new Error(`arc ${r.status}`);
    }
  };
}

/**
 * ARC answers that mean the network itself has the transaction (P0, 3 Nov 2026). ANNOUNCED_TO_NETWORK, SENT_TO_NETWORK,
 * STORED, QUEUED and the like only say ARC has it: tx 5916dd14… (owner's $1 theme buy) sat at ANNOUNCED_TO_NETWORK for
 * ~16 minutes with no copy on WhatsOnChain, already marked paid; tx 07e8ae73… (25 Oct) was marked paid that way and
 * never mined (ARC later: REJECTED, orphan reaped).
 */
const ARC_ACCEPTED = new Set([
  'SEEN_ON_NETWORK',
  'SEEN_MULTIPLE_NODES',
  'ACCEPTED_BY_NETWORK',
  'MINED',
  'IMMUTABLE',
  'CONFIRMED',
]);
const ARC_REFUSED = /REJECTED|DOUBLE_SPEND/i;

/**
 * The wallet's BEEF carries every unmined ancestor in full. EF (toHexEF) carries only each input's source OUTPUT, so a
 * parent the network never received made the payment an orphan: ARC validates it from the EF and announces it, and
 * nodes hold it waiting for a parent nobody sends (07e8ae73…, theme buy marked paid 25 Oct 2026, never mined: ARC
 * REJECTED "missing inputs (orphan reaped)"). Returns the unmined ancestors of `tx`, parents before children, from the
 * transaction graph the BEEF parse linked (sourceTransaction / merklePath).
 */
function unminedAncestors(tx) {
  const out = [];
  const seen = new Set();
  const visit = (t) => {
    for (const input of t.inputs || []) {
      const p = input.sourceTransaction;
      if (!p) continue;
      const id = p.id('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      if (p.merklePath) continue; // mined: the network has it
      visit(p);
      out.push(p);
    }
  };
  visit(tx);
  return out;
}

/**
 * Post a Store payment to ARC so the network can accept it, and report what ARC said (P0, 3 Nov 2026). The buyer's
 * bWalletX broadcasts the payment itself (src/mobile/themeOrder/storePay.ts): for it this is a harmless duplicate. For
 * a payer whose wallet only signs (a site visitor's wallet, an agent, an older bWalletX) it is the broadcast.
 *  1. each unmined ancestor from the wallet's BEEF first (as EF, oldest first): a parent ARC or the nodes lack is sent
 *     instead of leaving the payment an orphan;
 *  2. the payment itself as EF, asking ARC to wait (X-WaitFor) until the network has seen it.
 * Never throws. Resolves { txid, txStatus, accepted, refused, orphan, ancestors, error? }: `accepted` only for an answer
 * that means the network has it, `refused` for REJECTED / DOUBLE_SPEND or an HTTP error other than 409 "already known".
 * Every request has a deadline. ARC_URL / ARC_API_KEY as arcBroadcast.
 */
function arcSubmit(env = process.env, f = fetch, opts = {}) {
  const arc = String(env.ARC_URL || 'https://arc.gorillapool.io').replace(/\/$/, '');
  const waitSeconds = Number(opts.waitSeconds ?? 6); // inside the functions' maxDuration (site/vercel.json)
  const log = opts.log || ((...a) => console.error(...a));
  const post = async (hex, wait) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (env.ARC_API_KEY) headers.Authorization = `Bearer ${env.ARC_API_KEY}`;
    if (wait) {
      headers['X-WaitFor'] = 'SEEN_ON_NETWORK';
      headers['X-MaxTimeout'] = String(waitSeconds);
    }
    const tf = timed(f, wait ? (waitSeconds + 6) * 1000 : 8_000);
    const r = await tf(`${arc}/v1/tx`, { method: 'POST', headers, body: Buffer.from(hex, 'hex') });
    const text = await r.text().catch(() => '');
    let body = {};
    try {
      body = JSON.parse(text) || {};
    } catch {
      /* not JSON */
    }
    return { ok: r.ok, http: r.status, txStatus: String(body.txStatus || ''), extraInfo: body.extraInfo, text };
  };
  const efOrRaw = (t) => {
    try {
      return t.toHexEF();
    } catch {
      return t.toHex();
    }
  };
  return async (tx, beefHex) => {
    const txid = tx.id('hex');
    const ancestors = beefHex ? unminedAncestors(tx) : [];
    for (const p of ancestors) {
      try {
        const a = await post(efOrRaw(p), false);
        if ((!a.ok && a.http !== 409) || ARC_REFUSED.test(a.txStatus))
          log('arc ancestor refused', p.id('hex'), a.http, a.text.slice(0, 300));
      } catch (e) {
        log('arc ancestor send failed', p.id('hex'), String(e && e.message ? e.message : e).slice(0, 200));
      }
    }
    let r;
    try {
      r = await post(beefHex ? efOrRaw(tx) : tx.toHex(), true);
    } catch (e) {
      const error = String(e && e.message ? e.message : e).slice(0, 200);
      log('arc broadcast failed', txid, error);
      return { txid, txStatus: '', accepted: false, refused: false, orphan: false, ancestors: ancestors.length, error };
    }
    const refused = (!r.ok && r.http !== 409) || ARC_REFUSED.test(r.txStatus);
    if (refused) log('arc broadcast refused', txid, r.http, r.text.slice(0, 400));
    const orphan = /ORPHAN/i.test(r.txStatus) || /orphan|missing (inputs|parent)/i.test(String(r.extraInfo || ''));
    return {
      txid,
      txStatus: r.txStatus,
      accepted: !refused && ARC_ACCEPTED.has(r.txStatus),
      refused,
      orphan,
      ancestors: ancestors.length,
    };
  };
}

/**
 * Where is this txid? (P0, 3 Nov 2026.) ARC's record first, then WhatsOnChain:
 *  - 'seen': ARC says the network has it (SEEN_ON_NETWORK, ACCEPTED, MINED…) or WhatsOnChain has it (200);
 *  - 'out': ARC holds it but the network hasn't shown it (QUEUED, ANNOUNCED_TO_NETWORK…): it may still land;
 *  - 'missing': ARC never had it or refused it (404, REJECTED) AND WhatsOnChain answers 404;
 *  - 'unclear': anything else (timeouts, errors).
 * Only 'seen' ever marks a payment paid; only 'missing' ever lets a pending payment go.
 */
function networkStatus(env = process.env, f = fetch) {
  const arc = String(env.ARC_URL || 'https://arc.gorillapool.io').replace(/\/$/, '');
  const tf = timed(f, 6_000);
  return async (txid) => {
    if (!/^[0-9a-f]{64}$/.test(String(txid))) return 'unclear';
    let fromArc = 'unclear';
    try {
      const headers = env.ARC_API_KEY ? { Authorization: `Bearer ${env.ARC_API_KEY}` } : {};
      const r = await tf(`${arc}/v1/tx/${txid}`, { headers });
      if (r.status === 404) fromArc = 'missing';
      else if (r.ok) {
        const s = String((await r.json().catch(() => ({}))).txStatus || '');
        if (ARC_ACCEPTED.has(s)) return 'seen';
        fromArc = ARC_REFUSED.test(s) ? 'missing' : s ? 'out' : 'unclear';
      }
    } catch {
      /* unclear; WhatsOnChain may still answer */
    }
    let fromWoc = 'unclear';
    try {
      const r = await tf(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`);
      if (r.status === 200) return 'seen';
      if (r.status === 404) fromWoc = 'missing';
    } catch {
      /* unclear */
    }
    if (fromArc === 'out') return 'out';
    return fromArc === 'missing' && fromWoc === 'missing' ? 'missing' : 'unclear';
  };
}

/**
 * A transaction the network has, read back from WhatsOnChain (a claim whose wallet lost its copy; storeClaim.js).
 * Resolves the parsed Transaction, or null.
 */
function wocTx(f = fetch) {
  const { Transaction } = require('@bsv/sdk');
  const tf = timed(f, 8_000);
  return async (txid) => {
    if (!/^[0-9a-f]{64}$/.test(String(txid))) return null;
    try {
      const r = await tf(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`);
      if (!r.ok) return null;
      const hex = (await r.text()).trim();
      const tx = Transaction.fromHex(hex);
      return tx.id('hex') === txid ? tx : null;
    } catch {
      return null;
    }
  };
}

/** True only when the network has the txid (networkStatus 'seen'). Fails closed. */
const networkSeen =
  (env = process.env, f = fetch) =>
  async (txid) =>
    (await networkStatus(env, f)(txid).catch(() => 'unclear')) === 'seen';

module.exports = {
  supabaseStore,
  arcBroadcast,
  arcSubmit,
  networkStatus,
  networkSeen,
  wocTx,
  unminedAncestors,
  ARC_ACCEPTED,
  timed,
};
