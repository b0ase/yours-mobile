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
    getAliasByKey: async (k) =>
      (await one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&kind=eq.plain&limit=1`)) ??
      one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&limit=1`),
    // Every name that receives for this wallet (Settings › Identity shows them all).
    listByKey: async (k) =>
      (await req(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&select=alias,kind&order=created_at.asc&limit=50`)) ||
      [],
    getAliasByKeyKind: (k, kind) => one(`bwallet_paymail_aliases?identity_key=eq.${q(k)}&kind=eq.${q(kind)}&limit=1`),
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

/** Best-effort ARC broadcast (the sender normally broadcasts already). Env: ARC_URL, ARC_API_KEY. */
function arcBroadcast(env = process.env, f = fetch) {
  const arc = String(env.ARC_URL || 'https://arc.gorillapool.io').replace(/\/$/, '');
  return async (tx, beefHex) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (env.ARC_API_KEY) headers.Authorization = `Bearer ${env.ARC_API_KEY}`;
    const body = Buffer.from(beefHex || tx.toHex(), 'hex');
    const r = await f(`${arc}/v1/tx`, { method: 'POST', headers, body });
    if (!r.ok && r.status !== 409) throw new Error(`arc ${r.status}`);
  };
}

module.exports = { supabaseStore, arcBroadcast };
