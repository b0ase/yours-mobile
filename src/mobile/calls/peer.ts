import { parseRecipient, resolveRecipient, ResolveError, type Fetch } from '../names/names';
import { shortKey, type Peer } from './machine';

/**
 * "Call a name": $handle, paymail or OpNS name → the callee's IDENTITY KEY, via the same
 * resolution the Send screen uses (paymail pki / OpNS idKey). A bare address has no key.
 */
export async function resolveCallee(f: Fetch, raw: string): Promise<Peer> {
  const p = parseRecipient(raw);
  if (p.kind === 'address') throw new ResolveError('Call a $handle, paymail or name, not an address');
  const r = await resolveRecipient(f, p);
  if (!r.pubkey || !/^0[23][0-9a-f]{64}$/i.test(r.pubkey)) {
    throw new ResolveError(`${r.input} has no identity key to call`);
  }
  return { key: r.pubkey.toLowerCase(), label: r.input, verified: true };
}

/**
 * Who is calling. The server stores the label the CALLER asserted; anyone could claim
 * "$boase". So it is shown as verified only if resolving that label yields the caller's key;
 * otherwise the short key is shown with the claim alongside.
 */
export async function verifyCaller(f: Fetch, key: string, label: string | null): Promise<Peer> {
  if (!label) return { key, label: shortKey(key), verified: false };
  try {
    const resolved = await resolveCallee(f, label);
    if (resolved.key === key) return { key, label, verified: true };
  } catch {
    /* fall through */
  }
  return { key, label: `${shortKey(key)} (says ${label})`, verified: false };
}
