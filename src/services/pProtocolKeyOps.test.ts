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
import {
  guardReservedProtocols,
  MODULE_PROBE_ANSWER,
  P_MODULE_PROTOCOL_REFUSAL,
  reservedProtocolRefusal,
} from './reservedProtocols';
import { hasOneSatModule } from '@1sat/actions';
import { P1SAT_MODULE_PROTOCOL } from '@1sat/types';

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

/**
 * Review 16, F3: the SDK lowercases and trims protocol names before deriving (KeyDeriver.computeInvoiceNumber), so
 * "P 1sat" and " p 1sat" reach the same keys as "p 1sat" but are not routed to the module and were not refused. At level
 * 0 the manager grants them with no prompt: [0, 'p 1sat'] is the legacy 1Sat asset key space. F8: the 1sat module probe
 * (hasOneSatModule) must still say yes, so 1sat dApps can find the module.
 */
describe('F3: name variants of "p" protocols are refused too; the module probe still answers', () => {
  const variants = ['P 1sat', ' p 1sat', 'p 1sat ', 'P 1SAT', '  p bsv21'];
  for (const name of variants)
    test(`"${name}" gets no key operation at level 0, 1 or 2`, async () => {
      for (const level of [0, 1, 2] as const)
        for (const [method, args] of calls.filter(([m]) => m !== 'revealSpecificKeyLinkage')) {
          const { w, asked } = wallet();
          const fn = (w as unknown as Record<string, (a: unknown, o?: string) => Promise<unknown>>)[method];
          await expect(fn.call(w, { ...args, protocolID: [level, name] }, SITE)).rejects.toThrow(
            P_MODULE_PROTOCOL_REFUSAL,
          );
          expect(asked).toEqual([]);
        }
    });

  test('a name variant cannot take createSignature around the module either', async () => {
    const { w, asked } = wallet();
    await expect(w.createSignature({ ...common, data: [1], protocolID: [1, 'P 1sat'] } as never, SITE)).rejects.toThrow(
      P_MODULE_PROTOCOL_REFUSAL,
    );
    expect(asked).toEqual([]);
  });

  test('the 1sat module probe answers yes, with a fixed key and nothing derived', async () => {
    const { w, asked } = wallet();
    const asSite = { getPublicKey: (a: unknown) => w.getPublicKey(a as never, SITE) };
    expect(await hasOneSatModule(asSite as never)).toBe(true);
    const r = (await w.getPublicKey(
      { protocolID: P1SAT_MODULE_PROTOCOL, keyID: 'anything', counterparty: 'self' } as never,
      SITE,
    )) as { publicKey: string };
    expect(r.publicKey).toBe(MODULE_PROBE_ANSWER);
    expect(asked).toEqual([]);
    // The background's early check lets the probe through to that answer.
    expect(reservedProtocolRefusal('getPublicKey', { protocolID: P1SAT_MODULE_PROTOCOL, keyID: 'x' })).toBeNull();
    // Only getPublicKey: the probe protocol signs, encrypts and HMACs nothing.
    await expect(
      w.encrypt({ protocolID: P1SAT_MODULE_PROTOCOL, keyID: 'x', plaintext: [1] } as never, SITE),
    ).rejects.toThrow(P_MODULE_PROTOCOL_REFUSAL);
  });
});

describe("the wallet's own module keys still work after the review fixes", () => {
  for (const name of ['p 1sat', 'p bsv21', 'p opns', 'p lock', 'P 1sat'])
    test(`the wallet itself uses "${name}" keys at levels 0 and 1 (legacy 1Sat assets included)`, async () => {
      for (const level of [0, 1] as const) {
        const { w, asked } = wallet();
        await w.getPublicKey({ ...common, protocolID: [level, name] } as never, ADMIN);
        await w.encrypt({ ...common, plaintext: [1], protocolID: [level, name] } as never, ADMIN);
        await w.createHmac({ ...common, data: [1], protocolID: [level, name] } as never, ADMIN);
        expect(asked).toEqual(['getPublicKey', 'encrypt', 'createHmac']);
      }
    });
});
