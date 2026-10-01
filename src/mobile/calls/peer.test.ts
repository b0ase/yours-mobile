import { describe, expect, test } from 'bun:test';
import { SERVICES, type Fetch } from '../names/names';
import { resolveCallee, verifyCaller } from './peer';

const ALICE = '02' + 'a'.repeat(64);
const MALLORY = '03' + 'c'.repeat(64);
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
/** OpNS "alice" is owned by ALICE's identity key. */
const f: Fetch = async (url) =>
  url === `${SERVICES.opnsApi}/alice`
    ? json({ owner: '1AliceOwnerAddressxxxxxxxxxxxxxxx', map: { 'opns.idKey': ALICE } })
    : new Response('', { status: 404 });

describe('call a name', () => {
  test('an OpNS name resolves to its identity key', async () => {
    expect(await resolveCallee(f, 'alice')).toEqual({ key: ALICE, label: 'alice', verified: true });
  });
  test('a bare address cannot be called (no key)', async () => {
    await expect(resolveCallee(f, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).rejects.toThrow('not an address');
  });
});

describe('who is calling', () => {
  test('a label that resolves to the caller key is verified', async () => {
    expect(await verifyCaller(f, ALICE, 'alice')).toMatchObject({ label: 'alice', verified: true });
  });
  test('⚠ a caller claiming someone else’s name is shown unverified with their key', async () => {
    const p = await verifyCaller(f, MALLORY, 'alice');
    expect(p.verified).toBe(false);
    expect(p.label).toContain('03cccc…cccc');
    expect(p.label).toContain('says alice');
  });
  test('no label → short key', async () => {
    expect(await verifyCaller(f, MALLORY, null)).toMatchObject({ verified: false, label: '03cccc…cccc' });
  });
});
