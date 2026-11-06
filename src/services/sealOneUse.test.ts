/**
 * Before 5.2.51 (b-Aware triage 6 Nov 2026, izkalavender residual widened by 46987bd6): the one Seal sheet answered
 * the seal's protocol request with a 60-second grant, so for a minute the site could get more `bitsign seal`
 * signatures, over anything, with no sheet. The answer must cover exactly that one signature.
 *
 * Real LocalWalletPermissionsManager over a ProtoWallet with an in-memory grant store; the sheet is the callback.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import { oneUseGrant } from './oneShotGrant';
import { SEAL_PROTOCOL, SealPasses, type SealSign } from './sealPass';

const SITE = 'bitsign.example';
const sign = (keyID: string, text: string) => ({
  protocolID: [...SEAL_PROTOCOL] as [2, string],
  keyID,
  counterparty: 'anyone',
  data: Array.from(new TextEncoder().encode(text)),
});

const setup = () => {
  const store = new InMemoryPermissionStore();
  const keys = new ProtoWallet(PrivateKey.fromRandom());
  const underlying = {
    createSignature: (a: never, o?: string) => keys.createSignature(a, o),
    getPublicKey: (a: never, o?: string) => keys.getPublicKey(a, o),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }), // no on-chain permission tokens
  };
  const mgr = new LocalWalletPermissionsManager(underlying as never, 'admin', {}, { store });
  const sheets: string[] = [];
  let answerFirstWithSealPass = true;
  mgr.bindCallback('onProtocolPermissionRequested', (async (r: { requestID: string; protocolID: unknown }) => {
    sheets.push(r.requestID);
    if (answerFirstWithSealPass) {
      answerFirstWithSealPass = false;
      await mgr.grantPermission(oneUseGrant(r.requestID)); // what background.ts gives a seal-covered request
    } else await mgr.denyPermission(r.requestID); // any later sheet: the person says no
  }) as never);
  return { mgr, sheets };
};

describe('the Seal sheet covers exactly one signature', () => {
  test('the seal itself is signed after its one sheet', async () => {
    const { mgr, sheets } = setup();
    const out = await mgr.createSignature(sign('nonce-aaaaaaaaaaaaaaaa', 'the record'), SITE);
    expect(out.signature.length).toBeGreaterThan(0);
    expect(sheets.length).toBe(1);
  });

  test('a second seal-protocol signature right after asks again (and a No refuses it)', async () => {
    const { mgr, sheets } = setup();
    await mgr.createSignature(sign('nonce-aaaaaaaaaaaaaaaa', 'the record'), SITE);
    await expect(mgr.createSignature(sign('nonce-bbbbbbbbbbbbbbbb', 'something else'), SITE)).rejects.toThrow();
    expect(sheets.length).toBe(2);
  });

  test('the pass lets through one protocol request only, and refuses other seal signs while the seal signs', () => {
    let now = 1_000;
    const passes = new SealPasses(() => now);
    const seal = { nonce: 'nonce-aaaaaaaaaaaaaaaa', recordHash: 'ab'.repeat(32) } as SealSign;
    const req = {
      type: 'protocol',
      originator: SITE,
      protocolID: [...SEAL_PROTOCOL],
      counterparty: 'anyone',
    };
    expect(passes.signing(SITE)).toBe(false);
    passes.approve(SITE, seal);
    expect(passes.signing(SITE)).toBe(true); // other seal-protocol signs from the site are refused meanwhile
    expect(passes.coversProtocol(req, 1)).toBe(true);
    expect(passes.coversProtocol(req, 1)).toBe(false); // used up
    passes.signed(SITE, seal.recordHash);
    expect(passes.signing(SITE)).toBe(false);
    expect(passes.coversProtocol(req, 1)).toBe(false);
    now += 1;
  });
});

describe('background.ts answers a seal with the one-use grant', () => {
  const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
  test('the seal-covered branch grants oneUseGrant, never the 60 s oneShotGrant', () => {
    const at = bg.indexOf('if (sealCovered && accountContext?.wallet) {');
    const branch = bg.slice(at, bg.indexOf('return;', at));
    expect(branch).toContain('grantPermission(oneUseGrant(request.requestID))');
    expect(branch).not.toContain('oneShotGrant');
  });
  test('createSignature refuses other seal-protocol signs while a seal is signing, before the wallet is asked', () => {
    const fn = bg.slice(bg.indexOf('const processCWICreateSignature'));
    const refuse = fn.indexOf('sealPasses?.signing(sealSite)');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(fn.indexOf('w.createSignature('));
  });
});
