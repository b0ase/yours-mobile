import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { checkBinding } from './binding';
import { BAD_BINDING, destinationFor, type Resolved } from './names';
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
