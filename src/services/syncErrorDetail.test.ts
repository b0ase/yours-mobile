import { describe, expect, test } from 'bun:test';
import { StorageClient } from '@bsv/wallet-toolbox-client';
import {
  isWebKitIdbAbort,
  pageShape,
  syncErrorDetail,
  tagStorageCall,
  tagStorageClientErrors,
} from './syncErrorDetail';
import { createDeviceSync } from './deviceSync';

/** What wallet.1sat.app answers for any error that is not a WalletError (StorageServer.publicWalletErrorJson). */
class WERR_INTERNAL extends Error {
  constructor() {
    super('An internal error has occurred.');
    this.name = 'WERR_INTERNAL';
  }
}

describe('6 Nov 2026: a failed sync says which backup call failed, on what, and where', () => {
  test("a backup RPC's error carries its method and the page's shape, never its rows", async () => {
    class Client {
      async rpcCall(method: string, params: unknown[]): Promise<unknown> {
        void method;
        void params;
        throw new WERR_INTERNAL();
      }
    }
    const undo = tagStorageClientErrors(Client);
    expect(tagStorageClientErrors(Client)).toBeInstanceOf(Function); // twice is harmless
    const secretish = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ'; // WIF-shaped: must never be logged
    const chunk = {
      transactions: [{ rawTx: new Array(300_000).fill(0), txid: 'ab'.repeat(32) }, { rawTx: [1, 2] }],
      outputs: [{ lockingScript: [0x76, 0xa9], derivationPrefix: secretish }],
    };
    const e = await new Client().rpcCall('processSyncChunk', [{}, chunk]).catch((x: unknown) => x);
    const line = syncErrorDetail(e);
    expect(line).toStartWith('WERR_INTERNAL: An internal error has occurred. · in processSyncChunk (');
    expect(line).toContain('transactions 2, outputs 1, longest transactions.rawTx 300000');
    expect(line).not.toContain(secretish);
    expect(line).not.toContain('ab'.repeat(32));
    expect(line).toMatch(/ · at .+@.+:\d+/); // where it was thrown
    undo();
    expect(await new Client().rpcCall('makeAvailable', []).catch((x: unknown) => syncErrorDetail(x))).not.toContain(
      ' in ',
    );
  });

  test('the toolbox StorageClient is wrapped once (initWallet installs it at boot)', () => {
    const proto = StorageClient.prototype as unknown as Record<string | symbol, unknown>;
    const undo = tagStorageClientErrors(StorageClient);
    const wrapped = proto.rpcCall;
    expect(proto[Symbol.for('bwx.storageCall.wrapped')]).toBe(true);
    tagStorageClientErrors(StorageClient)(); // a second install is a no-op, and so is its undo
    expect(proto.rpcCall).toBe(wrapped);
    void undo; // left installed: other files in this run (initWallet's wiring test) install it too
  });

  test("WebKit's storage-process abort is named; key-like text in a message is cut; the line is bounded", () => {
    const e = new Error('Attempt to open a cursor in database without an in-progress transaction');
    e.name = 'UnknownError';
    expect(isWebKitIdbAbort(e.message)).toBe(true);
    expect(syncErrorDetail(e)).toContain('WebKit ended this IndexedDB transaction');
    const k = 'f'.repeat(64);
    expect(syncErrorDetail(new Error(`bad key ${k}`))).toContain('bad key ffff…');
    expect(syncErrorDetail(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(700);
    expect(syncErrorDetail('plain')).toBe('string: plain');
    expect(pageShape({})).toBe('empty page');
    // The innermost call wins.
    const t = tagStorageCall(tagStorageCall(new Error('e'), { method: 'getSyncChunk' }), { method: 'setActive' });
    expect(syncErrorDetail(t)).toContain('in getSyncChunk');
  });

  test("device sync's failure line in the sync log carries the call, not just the message", async () => {
    const lines: string[] = [];
    const sync = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => undefined,
      push: async () => {
        throw tagStorageCall(new WERR_INTERNAL(), { method: 'processSyncChunk', page: 'outputs 8, ~1 KB' });
      },
      log: (...a: unknown[]) => lines.push(a.map(String).join(' ')),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const r = await sync.pushNow();
    expect(r.ok).toBe(false);
    expect(lines.join('\n')).toContain(
      'push failed (retry in 1 min): WERR_INTERNAL: An internal error has occurred. · in processSyncChunk (outputs 8, ~1 KB)',
    );
  });

  test("review: a stack frame's query string or hash is never logged", () => {
    const e = new Error('x');
    e.stack =
      'Error: x\n    at push (https://web.bwalletx.com/assets/app.js?tok=SECRETVALUE#frag:12:3)\npush@app.js?tok=OTHERSECRET:7:1';
    const line = syncErrorDetail(e);
    expect(line).toContain('push@app.js:12 < push@app.js:7');
    expect(line).not.toContain('SECRETVALUE');
    expect(line).not.toContain('OTHERSECRET');
  });

  test('review: word runs (a seed), byte arrays and 16+ hex or base64 are cut; names and our own notes are kept', () => {
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const e = new Error(
      `bad: ${seed} [12,34,56,78,90,12,34,56,78,9] deadbeefcafebabe QUJDREVGR0hJSktM short [1,2,3] cafe`,
    );
    e.name = 'TransactionInactiveError';
    const line = syncErrorDetail(tagStorageCall(e, { method: 'processSyncChunk', page: 'outputs 8, ~1 KB' }));
    for (const w of ['ability', 'absorb', 'accident', '56,78', 'beefcafe', 'R0hJSktM']) expect(line).not.toContain(w);
    expect(line).toStartWith('TransactionInactiveError: bad: ');
    expect(line).toContain('short [1,2,3] cafe');
    expect(line).toContain('in processSyncChunk (outputs 8, ~1 KB)');
    const w = new Error('Attempt to open a cursor in database without an in-progress transaction');
    expect(syncErrorDetail(w)).toContain(
      'WebKit ended this IndexedDB transaction (the app was suspended, or its storage process was lost)',
    );
  });

  test('review: it never throws, whatever the error is', () => {
    const hostile = {
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(() => syncErrorDetail(hostile)).not.toThrow();
    expect(syncErrorDetail(hostile)).toBe('an error that could not be read');
  });
});
