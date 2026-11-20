// The read-only catalogue report (scripts/contractsUnnormalised.js; final review of b-Aware row 352, F1): which older
// rows aren't in the stored form, which paid rows are no longer served, and that it only ever reads.
import { describe, expect, test } from 'bun:test';
import C from '../lib/contracts.js';
import report from '../scripts/contractsUnnormalised.js';
import * as F from './fixtures/contractIdentity.js';

const row = (origin, contract, priceUsd = 5) => ({
  origin,
  created_at: `2026-11-0${origin.slice(-1)}T00:00:00Z`,
  envelope: { contract, sale: { priceUsd, copies: 1, payTo: 'x' } },
});
const rows = [
  row('o1', F.descriptor({ source: F.SRC, codeHash: F.HASH })),
  row('o2', F.descriptor({ source: `${F.SRC}\r\n` })),
  row('o3', F.descriptor({ source: F.SRC, codeHash: F.HASH.toUpperCase() })),
  row('o4', F.descriptor({ codeHash: F.HASH })),
  row('o5', F.descriptor({ codeHash: F.HASH }), 0),
];

describe('contracts catalogue report (read-only)', () => {
  test('lists rows not in the stored form, and paid rows no longer served', () => {
    const found = report.findProblems(rows);
    expect(found.map((f) => f.origin)).toEqual(['o2', 'o3', 'o4']);
    expect(found[0].problems).toEqual(['source not normalised or code hash not lower case']);
    expect(found[1].problems).toHaveLength(2);
    expect(found[2].problems).toEqual([`paid, no longer served: ${C.codeProblem(rows[3].envelope.contract)}`]);
  });

  test('only GETs, page by page, and prints what it found', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      const q = new URL(url).searchParams;
      const offset = Number(q.get('offset'));
      return new Response(JSON.stringify(rows.slice(offset, offset + Number(q.get('limit')))));
    };
    const lines = [];
    const env = { SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_ROLE_KEY: 'test-only' };
    const readAll = report.readAll;
    expect(await readAll(fetchImpl, env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, 3)).toHaveLength(5);
    calls.length = 0;
    const found = await report.main({ fetchImpl, env, argv: ['--backfill-sql'], log: (l) => lines.push(l) });
    expect(found).toHaveLength(3);
    expect(calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://db.test/rest/v1/bwallet_contracts?select='))).toBe(true);
    expect(lines[0]).toBe('5 catalogue rows read; 3 to look at.');
    // The backfill is printed, never run: one statement per row, from the catalogue's own contractKeys.
    const sql = lines.filter((l) => l.startsWith('update '));
    expect(sql).toHaveLength(5);
    expect(sql[0]).toBe(
      `update public.bwallet_contracts set identity_keys = array['${C.contractKeys(rows[0].envelope.contract)[0]}']::text[] where origin = 'o1';`,
    );
  });

  test('refuses to run without the database settings', async () => {
    await expect(report.main({ fetchImpl: async () => new Response('[]'), env: {}, log: () => {} })).rejects.toThrow(
      /SUPABASE_URL/,
    );
  });
});
