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
    deleteByKey: async (k) => {
      const del = async (table) =>
        (await req(`${table}?identity_key=eq.${q(k)}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=representation' },
        })) ?? [];
      const payments = (await del('bwallet_paymail_payments')).length;
      const aliases = (await del('bwallet_paymail_aliases')).length;
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
