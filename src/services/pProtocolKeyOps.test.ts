/**
 * b-Aware G2 (Hulk, 31 Oct 2026, Medium): a protocol name starting "p " sends a key operation to the asset permission
 * module (toolbox delegateToPModuleIfNeeded) BEFORE the manager's ensureProtocolPermission. The module passes
 * getPublicKey, encrypt, decrypt, HMAC and the rest straight to the base wallet, so a site got key operations under
 * any keyID and counterparty with no sheet and no grant. createSignature keeps the module's own check (a commitment
 * from an approved createAction, or its prompt).
 *
 * Real pieces, as initWallet wires them: createAssetPermissionModules on a base wallet, LocalWalletPermissionsManager
 * with those modules, guardReservedProtocols on it. The base wallet is a fake that records what it is asked.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import { createAssetPermissionModules } from '@1sat/permission-module';
import { guardReservedProtocols, P_MODULE_PROTOCOL_REFUSAL } from './reservedProtocols';

const ADMIN = 'admin.bwalletx.test';
const SITE = 'https://evil.example';
/** "p <scheme>": built, not written as a literal, so the protocol registry scan doesn't read it as a wallet protocol. */
const pProtocol = (scheme: string, level: 0 | 1 | 2 = 1) => [level, `p ${scheme}`] as [0 | 1 | 2, string];

function wallet() {
  const asked: string[] = [];
  const answer = (name: string, value: Record<string, unknown>) => async () => {
    asked.push(name);
    return value;
  };
  const base = {
    getPublicKey: answer('getPublicKey', { publicKey: '02'.padEnd(66, '1') }),
    encrypt: answer('encrypt', { ciphertext: [1, 2, 3] }),
    decrypt: answer('decrypt', { plaintext: [1, 2, 3] }),
    createHmac: answer('createHmac', { hmac: [9] }),
    verifyHmac: answer('verifyHmac', { valid: true }),
    createSignature: answer('createSignature', { signature: [7] }),
    verifySignature: answer('verifySignature', { valid: true }),
    revealSpecificKeyLinkage: answer('revealSpecificKeyLinkage', { encryptedLinkage: [5] }),
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
  };
  const store = new InMemoryPermissionStore();
  const prompts: string[] = [];
  const modules = createAssetPermissionModules({
    wallet: base as never,
    promptHandler: async (r: { kind: string }) => {
      prompts.push(r.kind);
      return true;
    },
    adminOriginator: ADMIN,
    permissionStore: store as never,
  });
  const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, { permissionModules: modules }, {
    store,
  } as never);
  const sheets: string[] = [];
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: { type: string }) => {
    sheets.push(r.type);
    throw new Error('User denied');
  };
  return { w: guardReservedProtocols(mgr, ADMIN), asked, prompts, sheets };
}

const common = { keyID: 'any-key', counterparty: 'self' };
const calls: [string, Record<string, unknown>][] = [
  ['getPublicKey', { ...common }],
  ['encrypt', { ...common, plaintext: [1] }],
  ['decrypt', { ...common, ciphertext: [1] }],
  ['createHmac', { ...common, data: [1] }],
  ['verifyHmac', { ...common, data: [1], hmac: [1] }],
  ['verifySignature', { ...common, data: [1], signature: [1] }],
  [
    'revealSpecificKeyLinkage',
    { keyID: 'any-key', counterparty: '02'.padEnd(66, '3'), verifier: '02'.padEnd(66, '4') },
  ],
];

describe('G2: "p" protocol names get no key operations for a site without a check', () => {
  for (const [method, args] of calls)
    test(`${method} with a "p <scheme>" protocol is refused for a site, before the base wallet is asked`, async () => {
      for (const scheme of ['1sat', 'bsv21', 'opns', 'lock']) {
        const { w, asked } = wallet();
        const fn = (w as unknown as Record<string, (a: unknown, o?: string) => Promise<unknown>>)[method];
        await expect(fn.call(w, { ...args, protocolID: pProtocol(scheme) }, SITE)).rejects.toThrow(
          P_MODULE_PROTOCOL_REFUSAL,
        );
        expect(asked).toEqual([]);
      }
    });

  test('createSignature keeps the module check: the site gets the module sheet, not a silent signature', async () => {
    const { w, asked, prompts } = wallet();
    await w.createSignature({ ...common, data: [1, 2, 3], protocolID: pProtocol('1sat') } as never, SITE);
    expect(prompts).toEqual(['signature']);
    expect(asked).toEqual(['createSignature']);
  });

  test("the wallet's own module key operations (admin) are unchanged", async () => {
    const { w, asked, sheets } = wallet();
    const r = (await w.getPublicKey({ ...common, protocolID: pProtocol('1sat') } as never, ADMIN)) as {
      publicKey?: string;
    };
    expect(typeof r.publicKey).toBe('string');
    await w.encrypt({ ...common, plaintext: [1], protocolID: pProtocol('lock', 2) } as never, ADMIN);
    expect(asked).toEqual(['getPublicKey', 'encrypt']);
    expect(sheets).toEqual([]);
  });

  test('a protocol that merely contains "p " elsewhere is not caught by this rule (normal permission path)', async () => {
    const { w, asked } = wallet();
    const err = await w.getPublicKey({ ...common, protocolID: [1, 'shop pay'] } as never, SITE).catch((e: Error) => e);
    expect(String((err as Error)?.message ?? '')).not.toContain(P_MODULE_PROTOCOL_REFUSAL);
    expect(asked).toEqual([]); // no grant in the store: the base wallet is not asked
  });
});
