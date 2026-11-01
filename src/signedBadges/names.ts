/**
 * "signed by $alice": a proof's claimed $name is shown only when our paymail says alice's key IS the signing key and
 * alice's own wallet signed that binding (docs/NAME-BINDINGS.md). Anything else shows the short key. Results are
 * cached for ten minutes per (name, key). Pure over `fetch`, so it is unit-tested with a fake.
 */
import { checkBinding } from '../mobile/names/binding';
import { CAP, fill, getCapabilities, type Fetch } from '../mobile/names/names';
import { SIGNER_RE, type VerifiedProof } from './record';

/** bWalletX names live here (the background build has no paymail defines, so the domain is written out). */
export const SIGNER_DOMAIN = 'bwalletx.com';
const TTL_MS = 10 * 60_000;

/** A bWalletX name the account goes by, as "$alice": from "$alice", "alice@bwalletx.com" (or bmailx/bwallet.space). */
export const signerFromName = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return undefined;
  const s = name.trim().toLowerCase();
  const m = /^\$?([a-z0-9][a-z0-9_.-]*)(?:@(bwalletx\.com|bmailx\.com|bwallet\.space))?$/.exec(s);
  if (!m || (!s.startsWith('$') && !m[2])) return undefined;
  const signer = `$${m[1]}`;
  return SIGNER_RE.test(signer) ? signer : undefined;
};

export const createNameCheck = (f: Fetch, now: () => number = Date.now) => {
  const cache = new Map<string, { at: number; ok: Promise<boolean> }>();
  let pkiTemplate: { at: number; tpl: Promise<string | undefined> } | undefined;

  const template = () => {
    if (!pkiTemplate || now() - pkiTemplate.at > TTL_MS) {
      const tpl = getCapabilities(f, SIGNER_DOMAIN)
        .then((caps) => (typeof caps[CAP.pki] === 'string' ? (caps[CAP.pki] as string) : undefined))
        .catch(() => undefined);
      pkiTemplate = { at: now(), tpl };
    }
    return pkiTemplate.tpl;
  };

  const check = async (signer: string, publicKey: string): Promise<boolean> => {
    const alias = signer.replace(/^\$/, '');
    const tpl = await template();
    if (!tpl) return false;
    const res = await f(fill(tpl, alias, SIGNER_DOMAIN));
    if (!res.ok) return false;
    const id = (await res.json()) as { pubkey?: unknown; binding?: unknown };
    if (typeof id?.pubkey !== 'string' || id.pubkey.toLowerCase() !== publicKey) return false;
    return (await checkBinding(alias, id.pubkey.toLowerCase(), id.binding)) === 'signed';
  };

  /** True when `signer` ($alice) is bound to `publicKey` by alice's own signed binding. */
  const nameMatches = (signer: string, publicKey: string): Promise<boolean> => {
    if (!SIGNER_RE.test(signer)) return Promise.resolve(false);
    const k = `${signer}|${publicKey}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < TTL_MS) return hit.ok;
    const ok = check(signer, publicKey).catch(() => false);
    cache.set(k, { at: now(), ok });
    return ok;
  };

  /** Fill `name` on each proof whose claimed $name checks out. */
  const nameProofs = async (byKey: Record<string, VerifiedProof[]>): Promise<Record<string, VerifiedProof[]>> => {
    const all = Object.values(byKey).flat();
    await Promise.all(
      all.map(async (p) => {
        if (p.claimedName && (await nameMatches(p.claimedName, p.publicKey))) p.name = p.claimedName;
      }),
    );
    return byKey;
  };

  return { nameMatches, nameProofs };
};
