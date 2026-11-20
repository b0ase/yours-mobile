// READ-ONLY report on the contracts catalogue (final review of b-Aware row 352). It only GETs bwallet_contracts; it
// never writes. It prints:
//  - rows whose source isn't normalised or whose code hash isn't lower case (lib/contracts.js formProblem). New
//    listings can't be stored that way any more, and the catalogue looks a copy's original up by the normalised source
//    only, so such an original can be missed by a later renamed copy;
//  - paid rows the catalogue no longer serves because they carry no source, or a code hash that isn't their source's
//    sha256 (lib/contracts.js codeProblem).
// With --backfill-sql it also prints (never runs) the UPDATE statements for the proposed identity_keys column
// (migrations-proposed/20261120_contract_identity_keys.sql), one per row, from the same contractKeys the catalogue uses.
// Run from site/: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/contractsUnnormalised.js [--backfill-sql]
const { codeProblem, contractKeys, formProblem } = require('../lib/contracts');

/** [{ origin, created_at, name, problems }] for the rows with something to report. */
function findProblems(rows) {
  const out = [];
  for (const r of rows) {
    const c = r?.envelope?.contract;
    const problems = [];
    if (formProblem(c)) problems.push('source not normalised or code hash not lower case');
    if (Number(r?.envelope?.sale?.priceUsd) > 0) {
      const why = codeProblem(c);
      if (why) problems.push(`paid, no longer served: ${why}`);
    }
    if (problems.length) out.push({ origin: r.origin, created_at: r.created_at, name: c?.name, problems });
  }
  return out;
}

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** The proposed backfill, one statement per row (printed only). */
const backfillSql = (rows) =>
  rows.map(
    (r) =>
      `update public.bwallet_contracts set identity_keys = array[${contractKeys(r.envelope?.contract).map(sqlText).join(', ')}]::text[] where origin = ${sqlText(r.origin)};`,
  );

/** Every row, oldest first, in pages; GET only. */
async function readAll(fetchImpl, base, key, page = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += page) {
    const url = `${base.replace(/\/$/, '')}/rest/v1/bwallet_contracts?select=origin,envelope,created_at&order=created_at.asc&limit=${page}&offset=${offset}`;
    const r = await fetchImpl(url, { method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`bwallet_contracts answered ${r.status}`);
    const got = await r.json();
    rows.push(...got);
    if (got.length < page) return rows;
  }
}

async function main({ fetchImpl = fetch, env = process.env, argv = process.argv.slice(2), log = console.log } = {}) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const rows = await readAll(fetchImpl, base, key);
  const found = findProblems(rows);
  log(`${rows.length} catalogue rows read; ${found.length} to look at.`);
  for (const f of found) log(`${f.origin}  ${f.created_at}  ${JSON.stringify(f.name)}  ${f.problems.join('; ')}`);
  if (argv.includes('--backfill-sql')) for (const line of backfillSql(rows)) log(line);
  return found;
}

if (require.main === module)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });

module.exports = { backfillSql, findProblems, main, readAll };
