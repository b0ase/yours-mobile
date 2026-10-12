// PNEE vaults (lib/pnee.js). Five price signers, the burn attester and the public list of vaults.
//   GET  /api/pnee?op=config                 → { issuer, oracles[5], params, kit, signers }
//   GET  /api/pnee?op=price                  → { ts, lockTime, priceCents, sources, signed: [5 × {signer, priceCents, s, padding}] }
//   POST /api/pnee?op=attest  { beef, vaultIndex }  → { signature } issuer co-signature for a close (checked first)
//   POST /api/pnee?op=submit  { txid, send? }       → records what a broadcast tx did to vaults (read from the chain)
//   GET  /api/pnee?op=vaults                 → { vaults, totals, price } for bwalletx.com/backing
//   GET  /api/pnee?op=inbox&to=<identityKey> → PNEE sends addressed to that identity key, for the wallet to accept
// Keys: PNEE_ISSUER_KEY, PNEE_ORACLE_1..5 (env only). DB: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (tables pnee_vaults, pnee_sends: migrations/20261012_pnee_vaults.sql).
const { Transaction } = require('@bsv/sdk');
const N = require('../lib/pnee');
const K = require('../lib/strategyKeys');

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=15' : 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
async function db(path, init = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('unconfigured');
  const r = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok && r.status !== 409) throw new Error(`db ${r.status}`);
  return r.status === 204 || init.method === 'PATCH' ? null : r.json().catch(() => null);
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const timeout = (ms) => AbortSignal.timeout(ms);
/** Chain median time past: the round time (a tx's nLockTime can't be later than this and still be final). */
async function chainMtp() {
  const r = await fetch(`${WOC}/chain/info`, { signal: timeout(8000) });
  const j = await r.json();
  return BigInt(j.mediantime);
}
/** Public BSV/USD sources, in cents. */
const SOURCES = {
  whatsonchain: async () => Number((await (await fetch(`${WOC}/exchangerate`, { signal: timeout(6000) })).json()).rate),
  coingecko: async () =>
    Number(
      (
        await (
          await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd', {
            signal: timeout(6000),
          })
        ).json()
      )['bitcoin-cash-sv'].usd,
    ),
  coinpaprika: async () =>
    Number(
      (await (await fetch('https://api.coinpaprika.com/v1/tickers/bsv-bitcoin-sv', { signal: timeout(6000) })).json())
        .quotes.USD.price,
    ),
  gateio: async () =>
    Number(
      (
        await (
          await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BSV_USDT', { signal: timeout(6000) })
        ).json()
      )[0].last,
    ),
};
async function livePrice() {
  const sources = {};
  await Promise.all(
    Object.entries(SOURCES).map(async ([k, f]) => {
      try {
        const v = Math.round((await f()) * 100);
        if (Number.isFinite(v) && v > 0) sources[k] = v;
      } catch {
        /* source down */
      }
    }),
  );
  const ok = Object.values(sources);
  if (ok.length < 2) throw new Error('Fewer than two price sources answered');
  return { priceCents: N.median(ok), sources };
}

function keysOr503(res) {
  const keys = N.signerKeys();
  if (!keys) send(res, 503, { error: 'PNEE signers are not configured on this server' });
  return keys;
}
const cfgOf = (keys) => ({ issuer: keys.issuerPub, oracles: keys.rabin.map((k) => k.n) });

/** A tx from the chain (1Sat / JungleBus), cached for this invocation. */
function chainTxs(beefTx) {
  const memo = new Map();
  if (beefTx) {
    const add = (t) => {
      if (!t || memo.has(t.id('hex'))) return;
      memo.set(t.id('hex'), t);
      for (const i of t.inputs) add(i.sourceTransaction);
    };
    add(beefTx);
  }
  return async (txid) => {
    if (!memo.has(txid)) memo.set(txid, await K.chain.tx(txid));
    return memo.get(txid);
  };
}

async function price(res) {
  const keys = keysOr503(res);
  if (!keys) return;
  const [ts, live] = await Promise.all([chainMtp(), livePrice()]);
  return send(res, 200, {
    ts: Number(ts),
    lockTime: Number(ts),
    priceCents: live.priceCents,
    sources: live.sources,
    signed: N.signRound(keys, BigInt(live.priceCents), ts),
  });
}

async function attest(b, res) {
  const keys = keysOr503(res);
  if (!keys) return;
  let tx;
  try {
    tx = Transaction.fromAtomicBEEF(Array.from(Buffer.from(String(b.beef || ''), 'hex')));
  } catch {
    return send(res, 400, { error: 'Bad transaction' });
  }
  const sources = {};
  for (const inp of tx.inputs) {
    const p = inp.sourceTransaction && inp.sourceTransaction.outputs[inp.sourceOutputIndex];
    if (p)
      sources[`${inp.sourceTXID || inp.sourceTransaction.id('hex')}_${inp.sourceOutputIndex}`] = {
        script: p.lockingScript.toHex(),
        satoshis: p.satoshis,
      };
    if (!inp.sourceTXID && inp.sourceTransaction) inp.sourceTXID = inp.sourceTransaction.id('hex');
  }
  const getTx = chainTxs(tx);
  const memo = new Map();
  const cfg = cfgOf(keys);
  const r = await N.attestClose({
    tx,
    vaultIndex: Number(b.vaultIndex) || 0,
    sources,
    keys,
    cfg,
    genuine: (op) => N.tokenGenuine(op, cfg, getTx, memo),
  });
  return r.error ? send(res, 422, r) : send(res, 200, r);
}

async function submit(b, res) {
  const keys = keysOr503(res);
  if (!keys) return;
  const txid = String(b.txid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return send(res, 400, { error: 'Bad txid' });
  const tx = await K.chain.tx(txid);
  if (!tx) return send(res, 202, { pending: true }); // not on the chain indexers yet: the wallet retries
  const getTx = chainTxs(tx);
  const ch = await N.vaultChanges(tx, cfgOf(keys), async (op) => {
    const [t, v] = op.split('_');
    const p = await getTx(t);
    return p && p.outputs[Number(v)] ? p.outputs[Number(v)].lockingScript.toHex() : null;
  });
  const row = (v) => ({
    outpoint: v.outpoint,
    owner: v.owner,
    open_ts: Number(v.openTs),
    sats: v.sats,
    debt: Number(v.debt),
    last_ts: Number(v.lastTs),
    status: 'open',
    updated_at: new Date().toISOString(),
  });
  for (const v of ch.opened)
    await db('pnee_vaults?on_conflict=outpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ ...row(v), first_outpoint: v.outpoint }),
    });
  for (const v of ch.moved)
    await db(`pnee_vaults?outpoint=eq.${v.from}`, { method: 'PATCH', body: JSON.stringify(row(v)) });
  for (const v of ch.ended)
    await db(`pnee_vaults?outpoint=eq.${v.outpoint}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: v.method === 'liquidate' ? 'liquidated' : 'closed',
        end_txid: v.txid,
        updated_at: new Date().toISOString(),
      }),
    });
  // A PNEE send to another bWalletX identity: keep it so their wallet can accept it (chain-checked here).
  const s = b.send;
  if (s && /^0[23][0-9a-f]{64}$/.test(String(s.to || '')) && typeof s.keyID === 'string' && s.keyID.length < 80) {
    const vout = Number(s.vout) || 0;
    const out = tx.outputs[vout];
    const t = out && N.tokenState(out.lockingScript.toHex());
    if (t && (await N.tokenGenuine(`${txid}_${vout}`, cfgOf(keys), getTx)))
      await db('pnee_sends?on_conflict=txid,vout', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({
          txid,
          vout,
          recipient: s.to,
          sender: /^0[23][0-9a-f]{64}$/.test(String(s.from || '')) ? s.from : null,
          key_id: s.keyID,
          amount: Number(t.amount),
          holder: t.holder,
        }),
      });
  }
  return send(res, 200, { ok: true, opened: ch.opened.length, moved: ch.moved.length, ended: ch.ended.length });
}

async function vaults(res) {
  const [list, live] = await Promise.all([
    db('pnee_vaults?select=*&status=eq.open&order=sats.desc&limit=500').catch(() => null),
    livePrice().catch(() => null),
  ]);
  if (!list) return send(res, 503, { error: 'Vault list unavailable' });
  const now = Math.floor(Date.now() / 1000);
  const px = live ? BigInt(live.priceCents) : null;
  let sats = 0n;
  let pnee = 0n;
  const out = list.map((v) => {
    sats += BigInt(v.sats);
    pnee += BigInt(v.debt);
    return {
      outpoint: v.outpoint,
      owner: v.owner,
      sats: Number(v.sats),
      pnee: Number(v.debt),
      ratioPct: px ? N.ratioPct(v.sats, px, v.debt) : null,
      atRisk: px ? (N.ratioPct(v.sats, px, v.debt) ?? Infinity) < Number(N.P.liqRatioPct) : false,
      lastPriceRoundAgeSec: Math.max(0, now - Number(v.last_ts)),
    };
  });
  return send(res, 200, {
    vaults: out,
    totals: {
      vaults: out.length,
      sats: Number(sats),
      pnee: Number(pnee),
      ratioPct: px && pnee > 0n ? N.ratioPct(sats, px, pnee) : null,
    },
    price: live ? { priceCents: live.priceCents, sources: live.sources, at: now } : null,
    params: N.KIT.params,
    signers:
      'All five price signer keys and the burn attester key are run by The Bitcoin Corporation Ltd on the bwallet.space server.',
  });
}

async function inbox(req, res) {
  const to = new URL(req.url, 'http://x').searchParams.get('to') || '';
  if (!/^0[23][0-9a-f]{64}$/.test(to)) return send(res, 400, { error: 'Bad identity key' });
  const list = await db(
    `pnee_sends?select=txid,vout,sender,key_id,amount,created_at&recipient=eq.${to}&order=created_at.desc&limit=200`,
  );
  return send(res, 200, { sends: list || [] });
}

module.exports = async (req, res) => {
  const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'GET') {
      if (op === 'config') {
        const keys = keysOr503(res);
        return keys && send(res, 200, N.publicConfig(keys));
      }
      if (op === 'price') return await price(res);
      if (op === 'vaults') return await vaults(res);
      if (op === 'inbox') return await inbox(req, res);
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (op === 'attest') return await attest(b, res);
      if (op === 'submit') return await submit(b, res);
    }
    return send(res, 404, { error: 'Unknown op' });
  } catch (e) {
    return send(res, 500, { error: e && e.message === 'unconfigured' ? 'Not configured' : 'Server error' });
  }
};
