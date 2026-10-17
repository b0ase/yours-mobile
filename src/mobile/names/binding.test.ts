import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { checkBinding, keyChange, trustCurrentKey } from './binding';
import { BAD_BINDING, KEY_CHANGED, destinationFor, type Resolved } from './names';
import { signRequest } from './paymail';

const wallet = (n: number) => {
  const priv = new PrivateKey(n);
  const w = new ProtoWallet(priv);
  return Object.assign(w, { key: priv.toPublicKey().toString() });
};

/** The binding as the server would serve it after the owner's bindMyNames(). */
const bindingFrom = async (w: ReturnType<typeof wallet>, alias: string, seq: number) => {
  const r = await signRequest(w, 'bind', { alias, seq: String(seq) });
  return { alias, identityKey: r.identityKey, seq, timestamp: String(r.timestamp), signature: r.signature };
};

describe('signed name bindings (wallet)', () => {
  test("the owner's own signature verifies for its key", async () => {
    const owner = wallet(5);
    expect(await checkBinding('npg', owner.key, await bindingFrom(owner, 'npg', 1))).toBe('signed');
  });

  test('a name repointed to another key, or a binding for another name, is bad; no binding is unsigned', async () => {
    const owner = wallet(5);
    const other = wallet(6);
    const b = await bindingFrom(owner, 'npg', 1);
    expect(await checkBinding('npg', other.key, { ...b, identityKey: undefined })).toBe('bad');
    expect(await checkBinding('npgx', owner.key, b)).toBe('bad');
    expect(await checkBinding('npg', owner.key, undefined)).toBe('unsigned');
  });

  test('a bad binding blocks the payment', () => {
    const r = {
      input: '$npg',
      target: 'npg@x',
      targetKind: 'paymail',
      via: 'p2p-paymail',
      nameBinding: 'bad',
    } as Resolved;
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: BAD_BINDING });
    expect(destinationFor({ ...r, nameBinding: 'unsigned' }, 'bsv').ok).toBe(true);
  });
});

describe('handovers and key changes (BRC-169 4.4)', () => {
  // Our own storage: other test files install a localStorage stand-in that doesn't keep values.
  const mem = new Map<string, string>();
  const real = globalThis.localStorage;
  beforeAll(() => {
    globalThis.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });
  afterAll(() => {
    globalThis.localStorage = real;
  });

  const handedOver = async (
    from: ReturnType<typeof wallet>,
    to: ReturnType<typeof wallet>,
    alias: string,
    seq: number,
  ) => {
    const rel = await signRequest(from, 'release', { alias, to: to.key, seq: String(seq) });
    const b = await bindingFrom(to, alias, seq);
    return {
      ...b,
      handover: { from: from.key, releaseSignature: rel.signature, releaseTimestamp: String(rel.timestamp) },
    };
  };

  test('a two-party handover verifies; a forged release does not', async () => {
    const a = wallet(21);
    const b = wallet(22);
    const c = wallet(23);
    const ok = await handedOver(a, b, 'shop', 2);
    expect(await checkBinding('shop', b.key, ok)).toBe('signed');
    const forged = await handedOver(c, b, 'shop', 2); // release signed by someone who wasn't the owner…
    expect(await checkBinding('shop', b.key, { ...forged, handover: { ...forged.handover, from: a.key } })).toBe('bad');
  });

  test('a key change without a handover from the key we knew is stopped; with one, it is accepted', async () => {
    localStorage.clear();
    const a = wallet(31);
    const b = wallet(32);
    expect(keyChange('cafe', a.key, 'signed')).toBe('signed');
    trustCurrentKey('cafe', a.key); // paid once: remembered
    expect(keyChange('cafe', b.key, 'signed')).toBe('changed'); // quietly moved
    expect(keyChange('cafe', b.key, 'signed', a.key)).toBe('signed'); // handed over by the key we knew
    expect(
      destinationFor(
        {
          input: '$cafe',
          target: 'cafe@x',
          targetKind: 'paymail',
          via: 'p2p-paymail',
          nameBinding: 'changed',
        } as Resolved,
        'bsv',
      ),
    ).toEqual({ ok: false, error: KEY_CHANGED });
  });
});
