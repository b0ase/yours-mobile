// The read-only catalogue report (scripts/contractsUnnormalised.js; reviews of b-Aware row 352): which older rows
// aren't in the stored form, which paid rows aren't served and why, and that it only ever reads.
import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import C from '../lib/contracts.js';
import report from '../scripts/contractsUnnormalised.js';
import * as F from './fixtures/contractIdentity.js';

const priv = new PrivateKey(31);
const wallet = new ProtoWallet(priv);
const address = priv.toAddress();
const envelope = (contract, priceUsd) => ({
  format: C.CONTRACT_FORMAT,
  contract,
  description: 'd',
  author: { name: 'a', address },
  sale: { priceUsd, copies: 1, payTo: address },
});
/** The wallet's own publish: the author's key, then the signature over the rest. */
const signed = async (env) => {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const unsigned = { ...env, author: { ...env.author, identityKey: publicKey } };
  const { signature } = await wallet.createSignature({
    data: C.contractSigningBytes(unsigned),
    protocolID: C.CONTRACT_SIGN_PROTOCOL,
    keyID: C.CONTRACT_SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { ...unsigned, authorSig: Utils.toHex(signature) };
};
const row = (n, env) => ({ origin: `o${n}`, created_at: `2026-11-0${n}T00:00:00Z`, envelope: env });
const rows = [
  row(1, await signed(envelope(F.descriptor({ source: F.SRC, codeHash: F.HASH }), 5))),
  row(2, await signed(envelope(F.descriptor({ source: `${F.SRC}\r\n` }), 5))),
  row(3, await signed(envelope(F.descriptor({ source: F.SRC, codeHash: F.HASH.toUpperCase() }), 5))),
  row(4, await signed(envelope(F.descriptor({ codeHash: F.HASH }), 5))),
  row(5, envelope(F.descriptor({ codeHash: F.HASH }), 0)),
  row(6, envelope(F.descriptor({ source: F.SRC }), 5)),
  row(7, await signed(envelope(F.descriptor({ source: F.lookalikeSources[0][1] }), 0))),
];

describe('contracts catalogue report (read-only)', () => {
  test('lists rows not in the stored form, and paid rows not served, with the reason', async () => {
    const found = await report.findProblems(rows);
    expect(Object.fromEntries(found.map((f) => [f.origin, f.problems]))).toEqual({
      o2: [`not in the stored form: ${C.formProblem(rows[1].envelope.contract)}`],
      o3: [
        `not in the stored form: ${C.formProblem(rows[2].envelope.contract)}`,
        `paid, not served: ${C.CODE_HASH_RULE}`,
      ],
      o4: [`paid, not served: ${C.codeProblem(rows[3].envelope.contract)}`],
      // Unsigned paid.
      o6: [`paid, not served: ${C.UPDATE_TO_SIGN}`],
      o7: [`not in the stored form: ${C.LOOKALIKE}`],
    });
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
    expect(await report.readAll(fetchImpl, env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, 3)).toHaveLength(7);
    calls.length = 0;
    const found = await report.main({ fetchImpl, env, argv: ['--backfill-sql'], log: (l) => lines.push(l) });
    expect(found).toHaveLength(5);
    expect(calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://db.test/rest/v1/bwallet_contracts?select='))).toBe(true);
    expect(lines[0]).toBe('7 catalogue rows read; 5 to look at.');
    // The backfill is printed, never run: one statement per row, from the catalogue's own contractKeys.
    const sql = lines.filter((l) => l.startsWith('update '));
    expect(sql).toHaveLength(7);
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
