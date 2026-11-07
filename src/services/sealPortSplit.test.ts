/**
 * Review of fix/sheet-recipients (MED 3): the seal checks mixed two site keys. signing(sealSite) and protocolCalls
 * kept the port (@1sat normalizeOriginator) while coversProtocol / count(mintSite) used the toolbox's hostname, so a
 * second seal-protocol signature from bitsign.example:8443 during bitsign.example's approval was neither refused nor
 * counted, and could share the one answer.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtocolCalls } from './pinnedMint';
import { permissionSite } from './permissionSite';
import { SEAL_PROTOCOL, SealPasses, type SealSign } from './sealPass';

const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
const sign = { protocolID: [...SEAL_PROTOCOL], counterparty: 'anyone', keyID: 'n' };

describe('one site key for every seal check', () => {
  test('a :8443 signature during the approved seal is refused, and counted against the cover', () => {
    const passes = new SealPasses();
    const calls = new ProtocolCalls();
    const X = 'https://bitsign.example';
    const Y = 'https://bitsign.example:8443';
    calls.start('createSignature', permissionSite(X), sign);
    passes.approve(permissionSite(X), { nonce: 'n', recordHash: 'ab'.repeat(32) } as SealSign);
    // Y arrives while X signs: refused at the door (background.ts processCWICreateSignature) ...
    expect(passes.signing(permissionSite(Y))).toBe(true);
    // ... and even counted, X's protocol request would no longer be covered.
    calls.start('createSignature', permissionSite(Y), sign);
    const req = {
      type: 'protocol',
      originator: 'bitsign.example',
      protocolID: [...SEAL_PROTOCOL],
      counterparty: 'anyone',
    };
    expect(passes.coversProtocol(req, calls.count('bitsign.example', [2, 'bitsign seal']))).toBe(false);
  });

  test('background.ts keys the seal pass, protocol calls and pay calls with permissionSite', () => {
    const sig = bg.slice(bg.indexOf('const processCWICreateSignature'));
    const keyed = sig.indexOf('sealSite = message.originator');
    expect(keyed).toBeGreaterThan(0);
    expect(keyed).toBeLessThan(sig.indexOf('sealPasses?.signing(sealSite)'));
    expect(sig.slice(keyed, keyed + 160)).toContain('permissionSite(message.originator)');
    expect(bg).toContain('protocolCalls.start(String(message.action), permissionSite(message.originator)');
    const pay = bg.slice(bg.indexOf('const trackPayCall'), bg.indexOf('const trackPayCall') + 400);
    expect(pay).toContain('permissionSite(originator)');
    const key = bg.slice(bg.indexOf('const sealSiteKey ='), bg.indexOf('const sealSiteKey =') + 220);
    expect(key).toContain('permissionSite(message.originator)');
  });
});

describe('background.ts: every paying sheet is checked', () => {
  test('a payment with no bound payee list is refused, never shown', () => {
    expect(bg).toContain('NO_PAYEES_REFUSAL');
  });
  test('the single-request answer (processPermissionResponse) checks spendApprovalMatches before granting', () => {
    const fn = bg.slice(bg.indexOf('const processPermissionResponse'));
    const body = fn.slice(0, fn.indexOf('closeDappPopupIfNoUi();\n  };'));
    expect(body).toContain('spendApprovalMatches(');
    expect(body.indexOf('spendApprovalMatches(')).toBeLessThan(body.indexOf('.grantPermission({'));
  });
  test('wallet teardown releases running spend runs', () => {
    const drop = bg.slice(bg.indexOf('const dropWalletContext'), bg.indexOf('const dropWalletContext') + 400);
    expect(drop).toContain('releaseSpendRuns()');
  });
});
