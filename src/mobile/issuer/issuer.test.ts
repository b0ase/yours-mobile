import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { AIP, BitCom, BSV21, Inscription } from '@1sat/templates';
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Script,
  Transaction,
  type CreateActionArgs,
  type CreateActionOutput,
} from '@bsv/sdk';
import {
  inscriptionTicker,
  isInscriptionScript,
  issueMapScript,
  issuerSigningKey,
  issuerSigningPrivateKey,
  parseIssueScript,
  scriptSha256,
  signIssueWithKey,
  verifyIssueTx,
} from './issuer';
import { withIssuerSignature, type IssueRecord } from './issuerSign';
import {
  clearIssuerCache,
  duplicateTickers,
  issuerLabel,
  sharedTickerWarning,
  verifyIssuer,
  WOC_TX_HEX,
} from './issuerVerify';

const owner = PrivateKey.fromRandom();
const identityKey = owner.toPublicKey().toString();
const addr = owner.toPublicKey().toAddress();

const deployScript = (sym = 'TESTY') => BSV21.deployMint(sym, 1_000_000n, 0).lock(new P2PKH().lock(addr)).toHex();

/** A deploy tx: token output, change, signed issuer OP_RETURN (in `order`). */
function deployTx(
  opts: { sym?: string; signer?: PrivateKey; idKey?: string; tokenHex?: string; mapLast?: boolean } = {},
) {
  const tokenHex = deployScript(opts.sym);
  const map = issueMapScript({
    kind: 'bsv21',
    ticker: opts.sym ?? 'TESTY',
    scriptSha256: scriptSha256(opts.tokenHex ?? tokenHex),
    identityKey: opts.idKey ?? identityKey,
  });
  const signed = signIssueWithKey(map, opts.signer ?? issuerSigningPrivateKey(owner));
  const tx = new Transaction();
  const token = { lockingScript: Script.fromHex(tokenHex), satoshis: 1 };
  const change = { lockingScript: new P2PKH().lock(addr), satoshis: 500 };
  const ret = { lockingScript: signed, satoshis: 0 };
  for (const o of opts.mapLast === false ? [ret, change, token] : [token, change, ret]) tx.addOutput(o);
  return { tx, tokenHex, signed };
}

describe('issuer statement: sign → verify round-trip', () => {
  test('verifies, resolves the identity key and ticker', () => {
    const { tx } = deployTx();
    const v = verifyIssueTx(tx, `${tx.id('hex')}_0`);
    expect(v).toEqual({
      ok: true,
      tokenId: `${tx.id('hex')}_0`,
      identityKey,
      kind: 'bsv21',
      ticker: 'TESTY',
      address: issuerSigningKey(identityKey).toAddress(),
    });
  });

  test('accepts the dotted outpoint form', () => {
    const { tx } = deployTx();
    expect(verifyIssueTx(tx, `${tx.id('hex')}.0`).ok).toBe(true);
  });

  test('robust to output order (finds the token output by hash)', () => {
    const { tx } = deployTx({ mapLast: false });
    expect(verifyIssueTx(tx, `${tx.id('hex')}_2`).ok).toBe(true);
  });

  test('rejects a signature for a different output', () => {
    const { tx } = deployTx({ tokenHex: deployScript('OTHER') });
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`)).toEqual({
      ok: false,
      reason: 'issuer signature is for another output',
    });
  });

  test('rejects a statement claiming someone else’s identity key', () => {
    const victim = PrivateKey.fromRandom().toPublicKey().toString();
    const { tx } = deployTx({ idKey: victim }); // signed by owner's child, claims victim
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`)).toEqual({
      ok: false,
      reason: 'signature is not from the stated identity',
    });
  });

  test('rejects a tampered statement (signature no longer valid)', () => {
    const { tx, signed } = deployTx();
    const chunks = signed.chunks.slice();
    const i = chunks.findIndex((c) => c.data && Buffer.from(c.data).toString() === 'TESTY');
    chunks[i] = { op: 5, data: Array.from(Buffer.from('FAKED')) };
    tx.outputs[2].lockingScript = new Script(chunks) as never;
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  test('unsigned token → unverified, other txid → mismatch', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: Script.fromHex(deployScript()), satoshis: 1 });
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`)).toEqual({ ok: false, reason: 'no issuer signature' });
    expect(verifyIssueTx(tx, `${'ab'.repeat(32)}_0`)).toEqual({ ok: false, reason: 'tx does not match token id' });
  });
});

describe('1Sat compatibility', () => {
  test('the token output is untouched and still decodes as a BSV-21 deploy+mint', () => {
    const { tx } = deployTx();
    const tok = BSV21.decode(tx.outputs[0].lockingScript);
    expect(tok?.tokenData.op).toBe('deploy+mint');
    expect(tok?.tokenData.sym).toBe('TESTY');
    expect(Inscription.decode(tx.outputs[0].lockingScript)).not.toBeNull();
    // The issuer output is not an inscription and not a 1-sat output: indexers ignore it.
    expect(isInscriptionScript(tx.outputs[2].lockingScript.toHex())).toBe(false);
    expect(Inscription.decode(tx.outputs[2].lockingScript)).toBeNull();
  });

  test('@1sat/templates (bmap rules) reads the statement as MAP + a VALID AIP signature', () => {
    const { tx } = deployTx();
    // As an indexer sees it: parsed back from the raw tx bytes.
    const bc = BitCom.decode(Transaction.fromHex(tx.toHex()).outputs[2].lockingScript)!;
    expect(bc).not.toBeNull();
    const aips = AIP.decode(bc);
    expect(aips.length).toBe(1);
    expect(aips[0].data.address).toBe(issuerSigningKey(identityKey).toAddress());
    expect(aips[0].data.valid).toBe(true);
  });

  test('inscription helpers', () => {
    expect(isInscriptionScript(deployScript())).toBe(true);
    expect(isInscriptionScript(new P2PKH().lock(addr).toHex())).toBe(false);
    expect(inscriptionTicker(deployScript('ZED'))).toBe('ZED');
    const nft = Inscription.fromText('hello').lock(new P2PKH().lock(addr)).toHex();
    expect(isInscriptionScript(nft)).toBe(true);
    expect(inscriptionTicker(nft)).toBeNull();
  });
});

/** ProtoWallet does the real BRC-42 signing; createAction just records its args. */
function fakeCtx() {
  const proto = new ProtoWallet(owner);
  const calls: CreateActionArgs[] = [];
  const wallet = new Proxy(proto, {
    get(t, p) {
      if (p === 'createAction')
        return async (a: CreateActionArgs) => {
          calls.push(a);
          return { txid: 'f'.repeat(64) };
        };
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { ctx: { wallet } as unknown as OneSatContext, calls };
}

describe('withIssuerSignature (wallet signing path, @1sat/actions applyAip)', () => {
  test('appends a signed issuer output that verifies inside the built tx', async () => {
    const { ctx, calls } = fakeCtx();
    let rec: IssueRecord | null = null;
    const tokenHex = deployScript();
    const outputs: CreateActionOutput[] = [
      { lockingScript: tokenHex, satoshis: 1, outputDescription: 'token' },
      { lockingScript: new P2PKH().lock(addr).toHex(), satoshis: 10, outputDescription: 'fee' },
    ];
    await withIssuerSignature(ctx, 'bsv21', (r) => (rec = r)).wallet.createAction({ description: 'deploy', outputs });
    expect(calls.length).toBe(1);
    const outs = calls[0].outputs!;
    expect(outs.length).toBe(3);
    expect(outs[2].satoshis).toBe(0);
    expect(rec).toEqual({ index: 0, scriptSha256: scriptSha256(tokenHex), ticker: 'TESTY', identityKey });
    expect(parseIssueScript(Script.fromHex(outs[2].lockingScript))?.fields.kind).toBe('bsv21');

    const tx = new Transaction();
    for (const o of outs) tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
    const v = verifyIssueTx(tx, `${tx.id('hex')}_0`);
    expect(v.ok && v.identityKey).toBe(identityKey);
  });

  test('only the NEXT action, and passes through when there is no inscription', async () => {
    const { ctx, calls } = fakeCtx();
    const w = withIssuerSignature(ctx, 'ordinal').wallet;
    const plain = [{ lockingScript: new P2PKH().lock(addr).toHex(), satoshis: 5, outputDescription: 'x' }];
    await w.createAction({ description: 'a', outputs: plain });
    await w.createAction({ description: 'b', outputs: [{ ...plain[0], lockingScript: deployScript(), satoshis: 1 }] });
    expect(calls[0].outputs!.length).toBe(1);
    expect(calls[1].outputs!.length).toBe(1);
  });
});

describe('verifyIssuer (network, mocked)', () => {
  test('verified + registry handle/KYC; unsigned → Unverified issuer', async () => {
    clearIssuerCache();
    const { tx } = deployTx();
    const id = `${tx.id('hex')}_0`;
    const unsigned = new Transaction();
    unsigned.addOutput({ lockingScript: Script.fromHex(deployScript()), satoshis: 1 });
    const uid = `${unsigned.id('hex')}_0`;
    const f = (async (url: string) => {
      if (url === WOC_TX_HEX(tx.id('hex'))) return new Response(tx.toHex());
      if (url === WOC_TX_HEX(unsigned.id('hex'))) return new Response(unsigned.toHex());
      if (url.endsWith(`/issuers/${id}`))
        return Response.json({ issuer: { handle: 'testy', kyc_verified: true, identity_key: identityKey } });
      return new Response('nope', { status: 404 });
    }) as never;
    const i = await verifyIssuer(id, f);
    expect(i.status).toBe('verified');
    expect(i.handle).toBe('testy');
    expect(i.kyc).toBe(true);
    expect(issuerLabel(i)).toEqual({ text: 'Issued by $testy · KYC', verified: true });
    const u = await verifyIssuer(uid, f);
    expect(u.status).toBe('unverified');
    expect(issuerLabel(u)).toEqual({ text: 'Unverified issuer', verified: false });
  });

  test('registry naming a different key is ignored', async () => {
    clearIssuerCache();
    const { tx } = deployTx({ sym: 'MINE' });
    const id = `${tx.id('hex')}_0`;
    const f = (async (url: string) =>
      url.includes('whatsonchain')
        ? new Response(tx.toHex())
        : Response.json({
            issuer: { handle: 'imposter', kyc_verified: true, identity_key: '02'.padEnd(66, '1') },
          })) as never;
    const i = await verifyIssuer(id, f);
    expect(i.status).toBe('verified');
    expect(i.handle).toBeNull();
    expect(i.kyc).toBe(false);
  });
});

describe('shared tickers', () => {
  test('warns only when 2+ token ids share a ticker', () => {
    const a = `${'a'.repeat(64)}_0`;
    const b = `${'b'.repeat(64)}_0`;
    expect(sharedTickerWarning('testy', [a])).toBeNull();
    expect(sharedTickerWarning('testy', [a, a])).toBeNull();
    expect(sharedTickerWarning('$testy', [a, b])).toBe('Several tokens use $TESTY — check the issuer');
    const d = duplicateTickers([
      { ticker: 'TESTY', tokenId: a },
      { ticker: '$testy', tokenId: b },
      { ticker: 'ONLY', tokenId: a },
    ]);
    expect([...d.keys()]).toEqual(['TESTY']);
  });
});
