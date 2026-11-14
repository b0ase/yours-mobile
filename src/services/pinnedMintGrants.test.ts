/**
 * b-Aware 25 Oct 2026 (fzsusanto row 120) and 3 Nov (izkalavender row 207): a pinned mint site's let-through
 * self-encrypt was answered with a 60 s grant. The permission manager stores protocol grants per site + protocol with
 * no usage type, so inside that minute a decrypt, signature or HMAC on the same protocol rode the encrypt's grant.
 * Grants from builds before 5.2.44 had no expiry at all and were never removed.
 * Real LocalWalletPermissionsManager over an in-memory grant store; the wallet underneath is a stub.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import {
  deferredEncryptGrant,
  isLegacyPinnedMintGrant,
  labelCoveredByIntent,
  mintIntentFor,
  PINNED_MINT_MIGRATION_KEY,
  revokeLegacyPinnedMintGrants,
  revokeLegacyPinnedMintGrantsOnce,
} from './pinnedMint';

const ADMIN = 'wallet-admin-id';
const SITE = 'bvideox.com';
const PID: [2, string] = [2, 'bvideox records'];

/** A manager whose protocol sheets are answered by `answer` (or left open). Counts every protocol sheet. */
const manager = (store: InMemoryPermissionStore, answer?: (m: LocalWalletPermissionsManager, id: string) => void) => {
  let prompts = 0;
  const w = {
    encrypt: async () => ({ ciphertext: [1] }),
    decrypt: async () => ({ plaintext: [1] }),
    createSignature: async () => ({ signature: [1] }),
    createHmac: async () => ({ hmac: [1] }),
    getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
    listActions: async () => ({ actions: [], totalActions: 0 }),
  };
  const mgr = new LocalWalletPermissionsManager(w as never, ADMIN, {}, { store } as never);
  let answering = !!answer;
  mgr.bindCallback('onProtocolPermissionRequested', (async (r: { requestID: string }) => {
    prompts++;
    if (answering) setTimeout(() => answer?.(mgr, r.requestID), 0);
  }) as never);
  return { mgr, prompts: () => prompts, stopAnswering: () => (answering = false) };
};

const args = { protocolID: PID, keyID: '1', counterparty: 'self' };
/** Wait (event-driven, generous timeout) until `ok()` holds. Timing-free, so a slow first run can't flip a result. */
const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
};
/** The call went through: it resolved (no sheet left open). */
const allowed = (p: Promise<unknown>) =>
  Promise.race([p.then(() => 'allowed'), new Promise((r) => setTimeout(() => r('still waiting'), 5000))]);
/** The call raised sheet number `n` and is still waiting on it (never resolved on an old grant). */
const asked = async (p: Promise<unknown>, prompts: () => number, n: number) => {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await until(() => settled || prompts() >= n);
  await new Promise((r) => setTimeout(r, 20));
  return !settled && prompts() === n ? 'asked' : settled ? 'allowed' : `prompts ${prompts()}`;
};

describe('a let-through encrypt answers that one request only', () => {
  test('after it, decrypt, sign and HMAC on the same protocol each ask', async () => {
    const store = new InMemoryPermissionStore();
    const first = manager(store, (m, id) => void m.grantPermission(deferredEncryptGrant(id)));
    expect(await allowed(first.mgr.encrypt({ ...args, plaintext: [1] } as never, SITE))).toBe('allowed');
    expect(first.prompts()).toBe(1);

    // The same manager (as in the background), nobody answering now: a decrypt raises its own sheet.
    first.stopAnswering();
    expect(await asked(first.mgr.decrypt({ ...args, ciphertext: [1] } as never, SITE), first.prompts, 2)).toBe('asked');

    // Any manager over the same grant store: decrypt, sign and HMAC each ask, none rides the encrypt's grant.
    for (const call of [
      (m: LocalWalletPermissionsManager) => m.decrypt({ ...args, ciphertext: [1] } as never, SITE),
      (m: LocalWalletPermissionsManager) => m.createSignature({ ...args, data: [1] } as never, SITE),
      (m: LocalWalletPermissionsManager) => m.createHmac({ ...args, data: [1] } as never, SITE),
    ]) {
      const later = manager(store);
      expect(await asked(call(later.mgr), later.prompts, 1)).toBe('asked');
    }
  });

  test('the next encrypt asks again too (it is let through by its own answer, inside the rate cap)', async () => {
    const store = new InMemoryPermissionStore();
    const first = manager(store, (m, id) => void m.grantPermission(deferredEncryptGrant(id)));
    await first.mgr.encrypt({ ...args, plaintext: [1] } as never, SITE);
    const next = manager(store);
    expect(await asked(next.mgr.encrypt({ ...args, plaintext: [2] } as never, SITE), next.prompts, 1)).toBe('asked');
  });

  test('the background answers a deferred encrypt with deferredEncryptGrant, never the 60 s oneShotGrant', () => {
    const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
    const branch = bg.slice(
      bg.indexOf('if (shouldDeferEncrypt(asSite'),
      bg.indexOf('const intent = mintIntents.get(mintSite)'),
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('grantPermission(deferredEncryptGrant(request.requestID))');
    expect(branch).not.toContain('oneShotGrant');
  });
});

const grant = (originator: string, protocolLevel: number, protocolName: string, expiry: number) => ({
  key: { type: 'protocol' as const, originator, privileged: false, protocolLevel, protocolName, counterparty: 'self' },
  expiry,
  grantedAt: 0,
});

describe('old never-expiring pinned-mint grants are removed on upgrade', () => {
  const later = Math.floor(Date.now() / 1000) + 90 * 86400;
  const seed = async () => {
    const store = new InMemoryPermissionStore();
    for (const g of [
      grant(SITE, 2, 'bvideox records', 0), // the old let-through encrypt grant
      grant(SITE, 1, 'action label bvideox records', 0), // the old let-through label grant
      grant('www.bvideox.com', 2, 'bvideox records', later), // a dated sheet grant: kept
      grant('other.example', 2, 'other records', 0), // not a pinned site: not ours to sweep here
      grant(ADMIN, 2, 'bvideox records', 0), // the wallet itself
    ])
      await store.putGrant(g as never);
    return store;
  };
  const names = async (s: InMemoryPermissionStore) =>
    (await s.listGrants({ type: 'protocol' }))
      .map((g) => `${g.key.originator}|${(g.key as { protocolName: string }).protocolName}`)
      .sort();

  test("only the home site's expiry-0 grants for its pinned mint protocol and its labels go", async () => {
    const store = await seed();
    expect(await revokeLegacyPinnedMintGrants(store, ADMIN)).toBe(2);
    expect(await names(store)).toEqual(
      ['other.example|other records', `${ADMIN}|bvideox records`, 'www.bvideox.com|bvideox records'].sort(),
    );
  });

  test('a dated grant is never legacy', () => {
    expect(isLegacyPinnedMintGrant(grant(SITE, 2, 'bvideox records', later), ADMIN)).toBe(false);
    expect(isLegacyPinnedMintGrant(grant(SITE, 2, 'bvideox records', 0), ADMIN)).toBe(true);
  });

  test('runs once per account, and again when the flag cannot be read', async () => {
    const kv = new Map<string, unknown>();
    const io = {
      get: async (k: string) => ({ [k]: kv.get(k) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) kv.set(k, v);
      },
    };
    const store = await seed();
    expect(await revokeLegacyPinnedMintGrantsOnce(store, ADMIN, io, 'acct')).toBe(2);
    expect(kv.get(PINNED_MINT_MIGRATION_KEY('acct'))).toBe(true);
    await store.putGrant(grant(SITE, 2, 'bvideox records', 0) as never);
    expect(await revokeLegacyPinnedMintGrantsOnce(store, ADMIN, io, 'acct')).toBe(0);
    const broken = { get: async () => Promise.reject(new Error('no storage')), set: io.set };
    expect(await revokeLegacyPinnedMintGrantsOnce(store, ADMIN, broken, 'acct')).toBe(1);
  });

  test('wallet start-up runs the sweep', () => {
    const init = readFileSync(join(import.meta.dir, '..', 'initWallet.ts'), 'utf8');
    expect(init).toContain('await revokeLegacyPinnedMintGrantsOnce(');
  });
});

describe("a mint's label cover is a label use only", () => {
  test('the real manager asks a label as usageType generic, an HMAC under its name as hmac; only the first is covered', async () => {
    const intent = mintIntentFor(SITE, {
      description: 'bVideoX: 1 private video record',
      labels: ['bvideox records'],
      outputs: [{ satoshis: 0 }],
      options: { spendingAuthorization: { protocolID: PID } },
    })!;
    const seen: Record<string, unknown>[] = [];
    const w = {
      createHmac: async () => ({ hmac: [1] }),
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
      listActions: async () => ({ actions: [], totalActions: 0 }),
    };
    const mgr = new LocalWalletPermissionsManager(w as never, ADMIN, { seekPermissionWhenApplyingActionLabels: true }, {
      store: new InMemoryPermissionStore(),
    } as never);
    mgr.bindCallback(
      'onProtocolPermissionRequested',
      (async (r: Record<string, unknown>) => void seen.push(r)) as never,
    );
    const label = (mgr as unknown as { ensureLabelAccess: (a: object) => Promise<boolean> }).ensureLabelAccess({
      originator: SITE,
      label: 'bvideox records',
      reason: 'mint',
      usageType: 'apply',
    });
    const hmac = mgr.createHmac(
      { protocolID: [1, 'action label bvideox records'], keyID: '1', data: [1] } as never,
      SITE,
    );
    label.catch(() => undefined);
    hmac.catch(() => undefined);
    await until(() => seen.length >= 2);
    expect(seen.map((r) => r.usageType).sort()).toEqual(['generic', 'hmac']);
    for (const r of seen) expect(labelCoveredByIntent(r as never, intent)).toBe(r.usageType === 'generic');
  });
});
