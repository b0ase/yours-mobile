import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk';
import { ChatApiError, type Http } from '../../chat/api';
import { BsharesApi } from '../api';
import { addSignatures, isReady, proposalTx, sighash, signedBy, toChecksig } from './multisig';
import { keysetFor, type Keyset } from './partnerLock';
import { accountScript, buildAccountProposal, type AccountProposal } from './accountRules';
import { combineRequests, fromMailbox, isMailboxUnavailable, mySigs, type AccountMailboxState } from './accountMailbox';

const ann = PrivateKey.fromRandom();
const ben = PrivateKey.fromRandom();
const cat = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const payee = PrivateKey.fromRandom().toAddress();
const pub = (k: PrivateKey) => k.toPublicKey().toString();
const toHex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const signAs = (k: PrivateKey, tx: Transaction, inputs: number[]) =>
  Object.fromEntries(
    inputs.map((i) => [i, toHex(toChecksig(ECDSA.sign(new BigNumber(sighash(tx, i)), k, true).toDER() as number[]))]),
  );

const keyset = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(cat)]);

let n = 0;
function coin(ks: Keyset, sats: number) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: accountScript(ks), satoshis: sats });
  return { sourceTx: src, vout: 0 };
}

const proposal = (proposalId = 'p-1'): AccountProposal => {
  const p = buildAccountProposal({
    partnershipId: 'room-1',
    proposalId,
    keyset,
    coins: [coin(keyset, 50_000)],
    payTo: { label: '$dee', address: payee },
    sats: 20_000,
    proposedBy: pub(ann),
    summary: 'Pay $dee 20,000 sats',
    now: new Date('2026-10-22T00:00:00Z'),
  });
  return addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
};

const state = (proposals: AccountMailboxState['proposals']): AccountMailboxState => ({
  ticker: 'ACME',
  partnershipId: 'room-1',
  agreementVersion: 1,
  rule: { kind: 'majority', m: 2 },
  keyset: { complete: true, m: 2, pubKeys: keyset.pubKeys },
  myKey: pub(ben),
  accountScript: null,
  proposals,
});
const row = (p: AccountProposal, extra: Partial<AccountMailboxState['proposals'][number]> = {}) => ({
  id: 'b1d0c2e4-0000-4000-8000-000000000001',
  summary: p.summary,
  proposedBy: p.proposedBy,
  createdAt: p.createdAt,
  proposal: p,
  ready: false,
  stale: false,
  signatureNeeded: true,
  ...extra,
});

describe('request and response mapping', () => {
  test('a mailbox request maps to a card with its id, proposer and stale flag', () => {
    const p = proposal();
    const [r] = fromMailbox(state([row(p, { stale: true })]), keyset, 'room-1');
    expect(r.mailboxId).toBe('b1d0c2e4-0000-4000-8000-000000000001');
    expect(r.from).toBe(pub(ann));
    expect(r.stale).toBe(true);
    expect(r.proposal.proposalId).toBe('p-1');
    expect(signedBy(r.proposal)).toEqual([pub(ann)]);
  });

  test("another partnership's request, or one that is not this account's payment, is never shown", () => {
    const p = proposal();
    const other = { ...p, partnershipId: 'room-2' };
    const lying = { ...proposal('p-2'), payTo: { label: '$dee', address: PrivateKey.fromRandom().toAddress() } };
    expect(fromMailbox(state([row(other), row(lying)]), keyset, 'room-1')).toEqual([]);
  });

  test("the sign body carries only this partner's signatures, keyed by input then key", () => {
    const p = proposal();
    const both = addSignatures(p, pub(ben), signAs(ben, proposalTx(p), [0]));
    expect(mySigs(both, pub(ben))).toEqual({ '0': { [pub(ben)]: both.sigs['0'][pub(ben)] } });
    expect(mySigs(both, pub(cat))).toEqual({});
  });

  test('the API speaks /partnership/<ticker>/account with the bChat bearer', async () => {
    const seen: { method: string; url: string; auth: string; body?: unknown }[] = [];
    const http: Http = async (req) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.Authorization, body: req.body });
      return {
        status: req.method === 'GET' ? 200 : 201,
        data: req.method === 'GET' ? state([]) : { ok: true, id: 'x' },
      };
    };
    const api = new BsharesApi(http, { token: 't0k', handle: 'ben', address: '' }, undefined, 'https://b.test');
    await api.partnerAccount('AC ME');
    await api.partnerAccountAction('ACME', { action: 'propose', proposal: proposal() });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: 'https://b.test/api/bitsign/bshares/partnership/AC%20ME/account',
      auth: 'Bearer t0k',
    });
    expect(seen[1].url).toBe('https://b.test/api/bitsign/bshares/partnership/ACME/account');
    expect((seen[1].body as { action: string }).action).toBe('propose');
  });

  test('a broadcast report is retried while the tx is not visible on chain, then succeeds', async () => {
    let calls = 0;
    const http: Http = async () =>
      ++calls < 3
        ? { status: 409, data: { error: "The transaction isn't visible on chain yet." } }
        : { status: 200, data: { ok: true, already: true } };
    const api = new BsharesApi(http, { token: 't', handle: 'b', address: '' });
    expect(await api.reportAccountBroadcast('ACME', 'id', 'ab'.repeat(32), [0, 0, 0])).toEqual({
      ok: true,
      already: true,
    });
    expect(calls).toBe(3);
  });
});

describe('signatures from the mailbox', () => {
  test('only signatures that verify are kept: a bad one and a stranger are dropped', () => {
    const p = proposal();
    const tx = proposalTx(p);
    const tampered: AccountProposal = {
      ...p,
      sigs: {
        '0': {
          ...p.sigs['0'],
          [pub(ben)]: signAs(ben, tx, [0])[0],
          [pub(cat)]: signAs(stranger, tx, [0])[0],
          [pub(stranger)]: signAs(stranger, tx, [0])[0],
        },
      },
    };
    const [r] = fromMailbox(state([row(tampered)]), keyset, 'room-1');
    expect(signedBy(r.proposal).sort()).toEqual([pub(ann), pub(ben)].sort());
    expect(isReady(r.proposal)).toBe(true);
  });

  test('the same request held here and on the mailbox shows once, without duplicate signatures', () => {
    const p = proposal();
    const withBen = addSignatures(p, pub(ben), signAs(ben, proposalTx(p), [0]));
    const remote = fromMailbox(state([row(p)]), keyset, 'room-1');
    const out = combineRequests([withBen], remote);
    expect(out).toHaveLength(1);
    expect(out[0].mailboxId).not.toBeNull();
    expect(Object.keys(out[0].proposal.sigs['0']).sort()).toEqual([pub(ann), pub(ben)].sort());
    expect(combineRequests([withBen, withBen], remote)).toHaveLength(1);
  });

  test('a local copy with the same id but a different transaction does not replace the mailbox copy', () => {
    const remote = fromMailbox(state([row(proposal('p-1'))]), keyset, 'room-1');
    const other = { ...proposal('p-9'), proposalId: 'p-1' };
    const out = combineRequests([other], remote);
    expect(out).toHaveLength(1);
    expect(out[0].proposal.txEF).toBe(remote[0].proposal.txEF);
  });
});

describe('fallback when the mailbox fails', () => {
  test('no answer, signed out, no mailbox or a server error means share by message', () => {
    for (const s of [undefined, 0, 401, 404, 500, 503]) expect(isMailboxUnavailable(s)).toBe(true);
    for (const s of [400, 403, 409, 413, 429]) expect(isMailboxUnavailable(s)).toBe(false);
  });

  test('a mailbox outage reaches the wallet as an error it can classify, and local requests still show', async () => {
    const down: Http = async () => ({ status: 503, data: null });
    const api = new BsharesApi(down, { token: 't', handle: 'b', address: '' });
    const err = await api.partnerAccount('ACME').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect(isMailboxUnavailable((err as ChatApiError).status)).toBe(true);
    const local = proposal();
    const out = combineRequests([local], []);
    expect(out).toEqual([{ proposal: local, mailboxId: null, stale: false, from: pub(ann) }]);
  });

  test('signed out of bChatX: the client refuses before any request, as 401', async () => {
    const api = new BsharesApi(async () => ({ status: 200, data: {} }), null);
    const err = await api.partnerAccount('ACME').catch((e: unknown) => e);
    expect(isMailboxUnavailable((err as ChatApiError).status)).toBe(true);
  });
});
