/**
 * b-Aware rows 214 / 322 / 326 (debited at authorisation, never refunded) and 83 / 370 (one call pays any payee up to
 * the whole balance, no notice), backlog 21 Nov 2026 rank 7.
 *
 * An envelope payment is now held at authorisation, keyed by the toolbox's action reference, settled when the wallet
 * signs it, and given back when the action fails or is aborted before that, or is left unsigned past the hold
 * deadline. A `seekPermission=false` probe and the BRC-177 prefunding check never take anything. One payment without a
 * sheet is at most a tenth of what was put in (the sheet says so); a bigger one gets the normal pay sheet. Each spend
 * records where it went, and Settings › Envelopes lists it.
 *
 * Real pieces as initWallet wires them: LocalWalletPermissionsManager, guardEnvelopes, the spend ledger, the labels
 * guard and preserveOriginalErrors. The base wallet is a fake that funds the outputs from one coin and records what is
 * signed and aborted. No network, no keys of anyone's.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import {
  BRC177_PREFLIGHT_REASON,
  EnvelopeStore,
  envelopePerSpendLimit,
  guardEnvelopes,
  type EnvelopeBackend,
  type EnvelopeState,
} from './envelopes';
import { withLocalSpendLedger } from './spendLedger';
import { preserveOriginalErrors } from './permissionAbortGuard';
import { guardLabelsOnSpend } from './labelsOnSpend';

const ADMIN = 'admin.bwalletx.test';
const SITE = 'https://arcade.example';
const KEY = normalizeOriginator(SITE);
const FUNDS = 1_000_000;
const FEE = 2;
const FILL = 10_000; // per-payment limit 1,000
const payeeAddress = new PrivateKey(99).toAddress();
const payee = new P2PKH().lock(payeeAddress).toHex();

const memBackend = (): EnvelopeBackend => {
  let data: unknown;
  return {
    load: async () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    save: async (s: EnvelopeState) => {
      data = JSON.parse(JSON.stringify(s));
    },
  };
};

type Mode = { signFails?: 'before-share' | 'after-share' };

/** A base wallet holding one coin: createAction funds the outputs from it and leaves change. */
function fakeBase(mode: Mode) {
  const calls: string[] = [];
  const src = new Transaction();
  src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
  src.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()), satoshis: FUNDS });
  src.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: src.id('hex'), txid: true }]]);
  const signable = new Map<string, number[]>();
  const shared = new Set<string>();
  let n = 0;
  return {
    calls,
    createAction: async (args: { outputs?: { lockingScript: string; satoshis: number }[] }) => {
      calls.push('createAction');
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      const tx = new Transaction();
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
      let out = 0;
      for (const o of args.outputs ?? []) {
        tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
        out += o.satoshis;
      }
      tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(6).toAddress()), satoshis: FUNDS - out - FEE });
      const beef = new Beef();
      beef.mergeTransaction(tx);
      const reference = `ref-${++n}`;
      const atomic = beef.toBinaryAtomic(tx.id('hex'));
      signable.set(reference, atomic);
      return { signableTransaction: { tx: atomic, reference } };
    },
    signAction: async (args: { reference: string }) => {
      calls.push('signAction');
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      if (mode.signFails === 'after-share') {
        shared.add(args.reference);
        throw new Error('broadcast answer lost');
      }
      if (mode.signFails === 'before-share') throw new Error('could not sign');
      const tx = signable.get(args.reference)!;
      return { txid: Transaction.fromAtomicBEEF(tx).id('hex'), tx };
    },
    abortAction: async (args: { reference: string }) => {
      calls.push('abortAction');
      if (shared.has(args.reference))
        throw new Error(
          'The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.',
        );
      return { aborted: true };
    },
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    listActions: async () => ({ totalActions: 0, actions: [] }),
    encrypt: async (a: { plaintext: number[] }) => ({ ciphertext: a.plaintext }),
    decrypt: async (a: { ciphertext: number[] }) => ({ plaintext: a.ciphertext }),
  };
}

/** The extension's chain for envelopes (initWallet): manager → envelopes → spend ledger → errors kept → labels. */
async function wallet(opts: { mode?: Mode; sheet?: boolean; holdTimeoutMs?: number; fill?: number } = {}) {
  const base = fakeBase(opts.mode ?? {});
  const store = new InMemoryPermissionStore();
  const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, {}, { store } as never);
  const sheets: { satoshis?: number }[] = [];
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: { spending?: { satoshis: number } }) => {
    sheets.push({ satoshis: r.spending?.satoshis });
    if (!opts.sheet) throw new Error('User denied');
    return true;
  };
  const envelopes = new EnvelopeStore(memBackend());
  if (opts.fill !== 0) await envelopes.fill(KEY, opts.fill ?? FILL);
  const ledger = { total: async () => 0, record: async () => undefined };
  const w = guardLabelsOnSpend(
    preserveOriginalErrors(
      withLocalSpendLedger(
        guardEnvelopes(mgr, {
          envelopes,
          adminOriginator: ADMIN,
          normalize: normalizeOriginator,
          holdTimeoutMs: opts.holdTimeoutMs,
        }),
        ledger as never,
        () => undefined,
      ),
      () => undefined,
    ),
    { adminOriginator: ADMIN },
  );
  const balance = async () => (await envelopes.get(KEY))?.balanceSats;
  return { w, base, sheets, envelopes, balance };
}

const pay = (satoshis: number, options: Record<string, unknown> = {}) => ({
  description: 'Play one round',
  outputs: [{ lockingScript: payee, satoshis, outputDescription: 'one round' }],
  options,
});

describe('rank 7: an envelope payment is held, then settled on signing or given back', () => {
  test('a payment that signs is taken once, and its payee is written down', async () => {
    const { w, balance, sheets, envelopes } = await wallet();
    await w.createAction(pay(500) as never, SITE);
    expect(sheets).toHaveLength(0);
    expect(await balance()).toBe(FILL - 500 - FEE);
    const last = (await envelopes.get(KEY))!.history.at(-1)!;
    expect(last.kind).toBe('spend');
    expect(last.sats).toBe(500 + FEE);
    expect(last.to).toEqual([payeeAddress]);
  });

  test('failed build: signing fails before anything is shared → the envelope is unchanged', async () => {
    const { w, base, balance } = await wallet({ mode: { signFails: 'before-share' } });
    await expect(w.createAction(pay(500) as never, SITE)).rejects.toThrow('could not sign');
    expect(base.calls).toContain('abortAction');
    expect(await balance()).toBe(FILL);
  });

  test('failed build: a check after the envelope said yes refuses the action → the envelope is unchanged', async () => {
    const { w, balance } = await wallet();
    const m = w as unknown as Record<string, (a: unknown) => Promise<boolean>>;
    const inner = m.ensureSpendingAuthorization;
    m.ensureSpendingAuthorization = async (a: unknown) => {
      await inner.call(w, a);
      throw new Error('a label was refused');
    };
    await expect(w.createAction(pay(500) as never, SITE)).rejects.toThrow('a label was refused');
    expect(await balance()).toBe(FILL);
  });

  test('abort: the site builds, then aborts before signing → the envelope is unchanged', async () => {
    const { w, balance } = await wallet();
    const r = (await w.createAction(pay(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    expect(await balance()).toBe(FILL - 500 - FEE); // held while the site holds the action
    expect((await w.abortAction({ reference: r.signableTransaction.reference } as never, SITE)).aborted).toBe(true);
    expect(await balance()).toBe(FILL);
  });

  test('timeout: an action left unsigned is blocked and aborted, and the envelope is given back', async () => {
    const { w, base, balance } = await wallet({ holdTimeoutMs: 40 });
    const r = (await w.createAction(pay(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    expect(await balance()).toBe(FILL - 500 - FEE);
    await new Promise((res) => setTimeout(res, 150));
    expect(base.calls).toContain('abortAction');
    expect(await balance()).toBe(FILL);
    // It can no longer be signed: the money can't move after it was given back.
    await expect(w.signAction({ reference: r.signableTransaction.reference, spends: {} } as never, SITE)).rejects.toThrow();
  });

  test('a site that signs its built action in time pays once and is not aborted by the deadline', async () => {
    const { w, base, balance } = await wallet({ holdTimeoutMs: 60 });
    const r = (await w.createAction(pay(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    await w.signAction({ reference: r.signableTransaction.reference, spends: {} } as never, SITE);
    await new Promise((res) => setTimeout(res, 150));
    expect(base.calls).not.toContain('abortAction');
    expect(await balance()).toBe(FILL - 500 - FEE);
  });

  test('already shared: signing failed after the network may have it → stays taken (never refunded twice)', async () => {
    const { w, balance } = await wallet({ mode: { signFails: 'after-share' } });
    await expect(w.createAction(pay(500) as never, SITE)).rejects.toThrow('broadcast answer lost');
    expect(await balance()).toBe(FILL - 500 - FEE);
  });

  test('a signed no-send action aborted later stays taken (the site holds a signed transaction)', async () => {
    const { w, balance } = await wallet();
    const r = (await w.createAction(pay(500, { noSend: true }) as never, SITE)) as { txid: string };
    expect(await balance()).toBe(FILL - 500 - FEE);
    await w.abortAction({ reference: r.txid } as never, SITE).catch(() => undefined);
    expect(await balance()).toBe(FILL - 500 - FEE);
  });

  test('two payments at once, one aborted and one signed: exactly the signed one is taken', async () => {
    const { w, balance } = await wallet();
    const [a, b] = await Promise.all([
      w.createAction(pay(300, { signAndProcess: false }) as never, SITE) as Promise<{
        signableTransaction: { reference: string };
      }>,
      w.createAction(pay(700, { signAndProcess: false }) as never, SITE) as Promise<{
        signableTransaction: { reference: string };
      }>,
    ]);
    await Promise.all([
      w.abortAction({ reference: a.signableTransaction.reference } as never, SITE),
      w.signAction({ reference: b.signableTransaction.reference, spends: {} } as never, SITE),
    ]);
    expect(await balance()).toBe(FILL - 700 - FEE);
  });
});

describe('rank 7: probes and prefunding checks never take anything', () => {
  test('hasSpendingAuthorization (seekPermission=false) answers without debiting', async () => {
    const { w, balance } = await wallet();
    const probe = (satoshis: number) =>
      (w as unknown as { hasSpendingAuthorization: (a: unknown) => Promise<boolean> }).hasSpendingAuthorization({
        originator: SITE,
        satoshis,
      });
    expect(await probe(500)).toBe(true);
    expect(await probe(500)).toBe(true);
    expect(await probe(FILL)).toBe(false); // over the per-payment limit: a real payment would ask
    expect(await balance()).toBe(FILL);
  });

  test('the BRC-177 prefunding check answers without debiting; the payment itself is taken once', async () => {
    const { w, balance } = await wallet();
    const ensure = (w as unknown as { ensureSpendingAuthorization: (a: unknown) => Promise<boolean> })
      .ensureSpendingAuthorization;
    expect(await ensure.call(w, { originator: SITE, satoshis: 600, reason: BRC177_PREFLIGHT_REASON })).toBe(true);
    expect(await balance()).toBe(FILL);
  });

  test('the toolbox still uses that prefunding reason and binds the reference just before the spend check', () => {
    const src = readFileSync(
      new URL('../../node_modules/@bsv/wallet-toolbox-client/out/index.client.mjs', import.meta.url),
      'utf8',
    );
    expect(src).toContain(`reason: "${BRC177_PREFLIGHT_REASON}"`);
    const create = src.slice(src.indexOf('this.bindPendingAction(reference, originator, vargs.isNoSend);'));
    const between = create.slice(0, create.indexOf('await this.ensureSpendingAuthorization({'));
    expect(between.length).toBeGreaterThan(0);
    expect(between.length).toBeLessThan(2_000);
    // No await between binding the reference and asking: the envelope hold is tied to this action, never another.
    expect(between).not.toContain('await ');
    expect(between).toContain('this.verifyRequestedOutputsPresent(tx, args)');
  });
});

describe('rank 7: one payment without a sheet is at most a tenth of the envelope', () => {
  test('the limit is a tenth of what was put in', () => {
    expect(envelopePerSpendLimit(FILL)).toBe(1_000);
    expect(envelopePerSpendLimit(5)).toBe(1);
  });

  test('over-limit payee: a payment above the limit gets the pay sheet; Deny leaves the envelope unchanged', async () => {
    const { w, sheets, balance } = await wallet({ sheet: false });
    await expect(w.createAction(pay(5_000) as never, SITE)).rejects.toThrow();
    expect(sheets).toEqual([{ satoshis: 5_000 + FEE }]);
    expect(await balance()).toBe(FILL);
  });

  test('over-limit payee: Approve on the sheet pays it, and the envelope is still unchanged', async () => {
    const { w, sheets, balance } = await wallet({ sheet: true });
    await w.createAction(pay(5_000) as never, SITE);
    expect(sheets).toHaveLength(1);
    expect(await balance()).toBe(FILL);
  });

  test('draining it in one call is refused: the whole balance asks', async () => {
    const { w, sheets, balance } = await wallet({ sheet: false });
    await expect(w.createAction(pay(FILL - FEE) as never, SITE)).rejects.toThrow();
    expect(sheets).toHaveLength(1);
    expect(await balance()).toBe(FILL);
  });

  test('a top-up raises the limit to a tenth of the new balance', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(KEY, 1_000);
    expect((await store.get(KEY))?.perSpendSats).toBe(100);
    await store.fill(KEY, 9_000);
    expect((await store.get(KEY))?.perSpendSats).toBe(1_000);
  });
});

describe('rank 7: the sheet and Settings say what happens', () => {
  test('the envelope sheet names the per-payment limit; Settings lists each payment and where it went', () => {
    const sheet = readFileSync(new URL('../pages/requests/EnvelopeRequest.tsx', import.meta.url), 'utf8');
    expect(sheet).toContain('envelopePerSpendLimit');
    expect(sheet).toContain('data-testid="envelope-limit"');
    const settings = readFileSync(new URL('../pages/EnvelopesSettings.tsx', import.meta.url), 'utf8');
    expect(settings).toContain('data-testid="envelope-payment"');
    expect(settings).toMatch(/\.to\b/);
  });
});
