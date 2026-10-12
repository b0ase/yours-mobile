import { describe, expect, test } from 'bun:test';
import {
  describeStaleFix,
  dropSpentTokenOutputs,
  fixStaleToken,
  healTokenSends,
  journalSendEnd,
  journalSendStart,
  openJournalTokens,
  strandedChangeOutputs,
  type HealAction,
  type JournalStore,
  type LocalTokenOutput,
  type TokenSendJournalEntry,
} from './tokenSendHeal';

// TERANODE, 12 Oct 2026.
const TOKEN = '8cc12904e6d7491077d6d511d9846ac39e58f058603f6b2cc710e216ab89f012_0';
const MINT = '8cc12904e6d7491077d6d511d9846ac39e58f058603f6b2cc710e216ab89f012.0';
const SEND = '75f04ce83532e7280b5ba068462a0c3004d3e75260b2957f35b37de2b5f5e9a0';
const CHANGE = `${SEND}.1`;
const H160 = 'ab'.repeat(20);

const parse = (script: string) => {
  const [tokenId, amt, hash160] = script.split('|');
  return { tokenId, amt, hash160: hash160 || null };
};
const sendAction = (status: string): HealAction => ({
  txid: SEND,
  status,
  description: 'Send TERANODE to 1 recipient',
  outputs: [
    { outputIndex: 0, lockingScript: `${TOKEN}|1000|${'cd'.repeat(20)}` },
    {
      outputIndex: 1,
      lockingScript: `${TOKEN}|20999000|${H160}`,
      customInstructions: JSON.stringify({ id: TOKEN, amt: '20999000', keyID: `${TOKEN}-1760000000000` }),
    },
  ],
});

const memJournal = (initial: TokenSendJournalEntry[] = []) => {
  let entries = initial;
  const store: JournalStore = {
    get: async () => entries,
    set: async (e) => {
      entries = e;
    },
  };
  return { store, entries: () => entries };
};

describe('unfinished token sends', () => {
  test('only unfinished token sends with a keyID count', () => {
    expect(strandedChangeOutputs([sendAction('completed')], parse)).toEqual([]);
    expect(strandedChangeOutputs([{ ...sendAction('failed'), description: 'Tip @x' }], parse)).toEqual([]);
    const s = strandedChangeOutputs([sendAction('failed')], parse);
    expect(s).toEqual([
      { tokenId: TOKEN, keyID: `${TOKEN}-1760000000000`, hash160: H160, amt: '20999000', actionTxid: SEND },
    ]);
    expect(strandedChangeOutputs([sendAction('unsigned')], parse, 'other_0')).toEqual([]);
  });

  test('broadcast then not recorded: the valid change is imported with its stored keyID', async () => {
    const imported: unknown[] = [];
    const r = await healTokenSends({
      listActions: async () => [sendAction('unsigned')],
      parse,
      findValidUnspent: async (tokenId, h) =>
        tokenId === TOKEN && h === H160 ? [{ outpoint: `${SEND}_1`, amt: '20999000' }] : [],
      haveOutput: async () => false,
      importOutput: async (a) => void imported.push(a),
      now: () => 0,
    });
    expect(imported).toEqual([{ txid: SEND, vout: 1, keyID: `${TOKEN}-1760000000000`, tokenId: TOKEN, hash160: H160 }]);
    expect(r.imported).toEqual([{ outpoint: CHANGE, tokenId: TOKEN, amt: '20999000' }]);
  });

  test('nothing imported twice, errors reported not thrown', async () => {
    const r = await healTokenSends({
      listActions: async () => [sendAction('sending'), sendAction('failed')],
      parse,
      findValidUnspent: async () => [{ outpoint: CHANGE, amt: '20999000' }],
      haveOutput: async () => true,
      importOutput: async () => {
        throw new Error('should not run');
      },
      now: () => 0,
    });
    expect(r.imported).toEqual([]);
    expect(r.checked).toBe(1);
    const bad = await healTokenSends({
      listActions: async () => [sendAction('failed')],
      parse,
      findValidUnspent: async () => {
        throw new Error('indexer down');
      },
      haveOutput: async () => false,
      importOutput: async () => undefined,
      now: () => 0,
    });
    expect(bad.errors[0]).toContain('indexer down');
  });

  test('journal: open until a txid comes back; open entries name their token; done ones are cleared', async () => {
    const j = memJournal();
    const id = await journalSendStart(j.store, TOKEN, 1000);
    expect(openJournalTokens(j.entries(), 2000)).toEqual([TOKEN]);
    await journalSendEnd(j.store, id, SEND);
    expect(j.entries()[0]).toMatchObject({ txid: SEND, done: true });
    expect(openJournalTokens(j.entries(), 2000)).toEqual([]);
    await healTokenSends({
      listActions: async () => [],
      parse,
      findValidUnspent: async () => [],
      haveOutput: async () => false,
      importOutput: async () => undefined,
      journal: { read: j.store.get, write: j.store.set },
      now: () => 2000,
    });
    expect(j.entries()).toEqual([]);
  });
});

const spendDeps = (local: LocalTokenOutput[], overlay: Record<string, string>, chain: Record<string, string> = {}) => {
  const dropped: string[] = [];
  return {
    dropped,
    deps: {
      localOutputs: async () => local,
      overlayStatus: async (_t: string, ops: string[]) => new Map(ops.map((o) => [o, overlay[o]])),
      chainSpends: async (ops: string[]) => new Map(ops.map((o) => [o, chain[o] ?? null])),
      relinquish: async (o: string) => void dropped.push(o),
    },
  };
};

describe('post-merge spend pass', () => {
  test('relinquishes outputs the overlay or the chain reports spent, keeps the rest', async () => {
    const other = 'ee'.repeat(32);
    const { deps, dropped } = spendDeps(
      [
        { outpoint: MINT, tokenId: TOKEN, amt: '21000000' },
        { outpoint: CHANGE, tokenId: TOKEN, amt: '20999000' },
        { outpoint: `${other}.0`, tokenId: `${other}_0`, amt: '5' },
      ],
      { [MINT]: 'spent', [CHANGE]: 'valid', [`${other}.0`]: 'valid' },
      { [`${other}.0`]: 'ff'.repeat(32) },
    );
    const r = await dropSpentTokenOutputs(deps);
    expect(dropped.sort()).toEqual([MINT, `${other}.0`].sort());
    expect(r.dropped.map((d) => d.outpoint).sort()).toEqual([MINT, `${other}.0`].sort());
  });

  test('an overlay failure is reported; the chain check still runs', async () => {
    const { deps, dropped } = spendDeps([{ outpoint: MINT, tokenId: TOKEN, amt: '21000000' }], {}, { [MINT]: SEND });
    const r = await dropSpentTokenOutputs({
      ...deps,
      overlayStatus: async () => {
        throw new Error('timeout');
      },
    });
    expect(dropped).toEqual([MINT]);
    expect(r.errors[0]).toContain('timeout');
  });
});

describe('Fix and send (stale)', () => {
  test('drops the spent mint, imports the derivable valid change, reports both', async () => {
    const { deps, dropped } = spendDeps([{ outpoint: MINT, tokenId: TOKEN, amt: '21000000' }], { [MINT]: 'spent' });
    const r = await fixStaleToken(
      {
        spendPass: (id) => dropSpentTokenOutputs(deps, { tokenId: id }),
        healSends: async () => ({ imported: [], checked: 0, errors: [] }),
        recover: async () => [
          { outpoint: CHANGE, tokenId: TOKEN, amt: '20999000' },
          { outpoint: `${'aa'.repeat(32)}.0`, tokenId: 'other_0', amt: '1' },
        ],
      },
      TOKEN,
    );
    expect(dropped).toEqual([MINT]);
    expect(r.imported).toEqual([{ outpoint: CHANGE, tokenId: TOKEN, amt: '20999000' }]);
    const fmt = (a: bigint) => a.toLocaleString('en-US');
    expect(describeStaleFix(r, fmt, 'TERANODE')).toBe('Removed 1 already-spent record, added 20,999,000 TERANODE');
    expect(describeStaleFix({ dropped: [], imported: [] }, fmt, 'T')).toContain('Nothing to fix');
  });

  test('the same change found by heal and walk counts once', async () => {
    const one = { outpoint: CHANGE, tokenId: TOKEN, amt: '20999000' };
    const r = await fixStaleToken(
      {
        spendPass: async () => ({ dropped: [], checked: 0, errors: [] }),
        healSends: async () => ({ imported: [one], checked: 1, errors: [] }),
        recover: async () => [{ ...one, outpoint: `${SEND}_1` }],
      },
      TOKEN,
    );
    expect(r.imported).toHaveLength(1);
  });
});
