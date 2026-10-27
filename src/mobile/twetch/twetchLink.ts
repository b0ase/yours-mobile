/**
 * The Twetch signing key kept in bWalletX (post to Twetch from bChatX, 27 Oct 2026).
 *
 * - Where it comes from: the user's Twetch 12 words (or a WIF). The key is the one at DEFAULT_TWETCH_WALLET_PATH
 *   (m/0/0), the same path a "Restore from Twetch" account uses for its wallet key (Keys.service.ts).
 * - How it is checked before it is kept: GET api.twetch.com /v1/auth/user-by-pubkey/<derived pubkey> must name a
 *   user, and that user's publicKey (GET /v1/users/<id>) must be the derived pubkey exactly. Otherwise it is not
 *   linked ("these words aren't a Twetch account"). Both are public reads.
 * - How it is stored: the WIF goes into the account's encrypted key blob (encryptedKeys, field twetchWif), next to
 *   the account's own keys, so it is encrypted with the wallet password, re-encrypted on a password change and
 *   carried by encrypted backups. Only public facts go in settings.twetch (pubkey, address, user id, name, the
 *   sites the user let sign in).
 * - Every signature re-checks: the decrypted key's pubkey must equal the linked Twetch publicKey, or nothing is
 *   signed (TwetchKeyMismatch).
 *
 * The key never leaves the wallet: sites get signatures and a transaction the user approved, nothing else.
 */
import { PrivateKey } from '@bsv/sdk';
import { DEFAULT_TWETCH_WALLET_PATH } from '../../utils/constants';
import { generateKeysFromTag } from '../../utils/keys';
import { TWETCH_API } from '../feed/post';
import { decrypt, encrypt } from '../../utils/crypto';

/** Public facts about the linked Twetch account (settings.twetch). */
export type TwetchLink = {
  publicKey: string;
  address: string;
  userId: string;
  name: string;
  /** Origins the user has approved a Twetch sign-in for (the sheet shows only the first time per site). */
  loginSites?: string[];
  linkedAt: number;
};

export class TwetchKeyMismatch extends Error {
  constructor() {
    super('The stored Twetch key does not match your Twetch account. Link Twetch again in Settings.');
    this.name = 'TwetchKeyMismatch';
  }
}

type F = (url: string, init?: RequestInit) => Promise<Response>;

/** The Twetch key from 12 words (m/0/0) or a WIF. Throws a readable error for anything else. */
export const twetchKeyFrom = (wordsOrWif: string): PrivateKey => {
  const s = wordsOrWif.trim().replace(/\s+/g, ' ');
  if (!s) throw new Error('Enter your Twetch 12 words.');
  if (!s.includes(' ')) {
    try {
      return PrivateKey.fromWif(s);
    } catch {
      throw new Error("That isn't a valid key.");
    }
  }
  try {
    return generateKeysFromTag(s.toLowerCase(), DEFAULT_TWETCH_WALLET_PATH).privKey;
  } catch {
    throw new Error("Those words aren't a valid recovery phrase.");
  }
};

/**
 * Look the key up on Twetch. Returns the account, or a reason it can't be linked. Read-only GETs; a network error
 * is thrown (try again) rather than reported as "no account".
 */
export const lookupTwetchAccount = async (
  publicKey: string,
  f: F = (u, i) => fetch(u, i),
): Promise<{ userId: string; name: string } | string> => {
  const pk = publicKey.toLowerCase();
  const r = await f(`${TWETCH_API}/v1/auth/user-by-pubkey/${pk}`);
  if (r.status === 404) return "These words aren't a Twetch account.";
  if (!r.ok) throw new Error(`Couldn't reach Twetch (${r.status}). Try again.`);
  const id = ((await r.json()) as { userId?: unknown }).userId;
  if (!(typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))))
    return "These words aren't a Twetch account.";
  const u = await f(`${TWETCH_API}/v1/users/${encodeURIComponent(String(id))}`);
  if (!u.ok) throw new Error(`Couldn't reach Twetch (${u.status}). Try again.`);
  const user = (await u.json()) as { publicKey?: unknown; name?: unknown };
  if (typeof user.publicKey !== 'string' || user.publicKey.toLowerCase() !== pk)
    return "This key isn't the signing key of that Twetch account.";
  return { userId: String(id), name: typeof user.name === 'string' ? user.name.slice(0, 40) : '' };
};

/** Check a candidate key against Twetch; the link to save, or why not. */
export const verifyTwetchKey = async (key: PrivateKey, f?: F): Promise<TwetchLink | string> => {
  const pub = key.toPublicKey();
  const publicKey = pub.toString();
  const found = await lookupTwetchAccount(publicKey, f);
  if (typeof found === 'string') return found;
  return { publicKey, address: pub.toAddress(), userId: found.userId, name: found.name, linkedAt: Date.now() };
};

/** The decrypted key, only if it is the linked account's key. Throws TwetchKeyMismatch otherwise. */
export const matchingKey = (wif: string | undefined, link: TwetchLink | undefined): PrivateKey => {
  if (!wif || !link) throw new TwetchKeyMismatch();
  let key: PrivateKey;
  try {
    key = PrivateKey.fromWif(wif);
  } catch {
    throw new TwetchKeyMismatch();
  }
  if (key.toPublicKey().toString().toLowerCase() !== link.publicKey.toLowerCase()) throw new TwetchKeyMismatch();
  return key;
};

/** "@name" for the sheet, falling back to the Twetch user number. */
export const twetchHandle = (link: Pick<TwetchLink, 'name' | 'userId'>) =>
  link.name ? `@${link.name}` : `Twetch user ${link.userId}`;

/* ---------- storage (account record) ---------- */

/** What the store needs from ChromeStorageService (narrow, so tests pass a fake). */
export type TwetchStorage = {
  getCurrentAccountObject: () => {
    account?: { encryptedKeys?: string; settings?: { twetch?: TwetchLink }; addresses?: { identityAddress?: string } };
  };
  getPassKey: () => Promise<string | undefined>;
  updateNested: (key: 'accounts', update: Record<string, unknown>) => Promise<unknown>;
  get?: (keys: string[]) => Promise<{ keyRekey?: unknown }>;
};
export type Crypto = {
  encrypt: (plain: string, key: string) => Promise<string>;
  decrypt: (data: string, key: string) => Promise<string>;
};

export type TwetchStore = {
  link: () => TwetchLink | undefined;
  /** The verified key for signing (decrypts per call). Throws when locked or on a mismatch. */
  key: () => Promise<PrivateKey>;
  /** The account's own recovery phrase, if it has one (offered as "use this account's words"). */
  accountWords: () => Promise<string | undefined>;
  save: (link: TwetchLink, key: PrivateKey) => Promise<void>;
  addLoginSite: (origin: string) => Promise<void>;
  forget: () => Promise<void>;
};

export const makeTwetchStore = (s: TwetchStorage, c: Crypto): TwetchStore => {
  const current = () => {
    const a = s.getCurrentAccountObject().account;
    const id = a?.addresses?.identityAddress;
    if (!a || !id) throw new Error('No account open.');
    return { a, id };
  };
  const openKeys = async () => {
    const { a, id } = current();
    const passKey = await s.getPassKey();
    if (!passKey || !a.encryptedKeys) throw new Error('bWalletX is locked. Unlock it and try again.');
    return { a, id, passKey, keys: JSON.parse(await c.decrypt(a.encryptedKeys, passKey)) as Record<string, unknown> };
  };
  const writeAccount = async (id: string, a: object, patch: object) =>
    s.updateNested('accounts', { [id]: { ...a, ...patch } });
  const setLink = async (link: TwetchLink) => {
    const { a, id } = current();
    await writeAccount(id, a, { settings: { ...(a.settings ?? {}), twetch: link } });
  };
  return {
    link: () => s.getCurrentAccountObject().account?.settings?.twetch,
    key: async () => {
      const link = s.getCurrentAccountObject().account?.settings?.twetch;
      const { keys } = await openKeys();
      return matchingKey(keys.twetchWif as string | undefined, link);
    },
    accountWords: async () => {
      const { keys } = await openKeys();
      return typeof keys.mnemonic === 'string' ? keys.mnemonic : undefined;
    },
    save: async (link, key) => {
      if (key.toPublicKey().toString().toLowerCase() !== link.publicKey.toLowerCase()) throw new TwetchKeyMismatch();
      if ((await s.get?.(['keyRekey']))?.keyRekey) throw new Error('Wallet keys are being re-encrypted; try again.');
      const { a, passKey, keys } = await openKeys();
      const plain = JSON.stringify({ ...keys, twetchWif: key.toWif() });
      const sealed = await c.encrypt(plain, passKey);
      if ((await c.decrypt(sealed, passKey)) !== plain) throw new Error('Saving the key failed; nothing changed.');
      const settings = { ...(a.settings ?? {}), twetch: { ...link, loginSites: [] } };
      await writeAccount(current().id, a, { encryptedKeys: sealed, settings });
    },
    addLoginSite: async (origin) => {
      const link = s.getCurrentAccountObject().account?.settings?.twetch;
      if (!link || link.loginSites?.includes(origin)) return;
      await setLink({ ...link, loginSites: [...(link.loginSites ?? []), origin].slice(-50) });
    },
    forget: async () => {
      const { a, passKey, keys } = await openKeys();
      delete keys.twetchWif;
      const sealed = await c.encrypt(JSON.stringify(keys), passKey);
      const settings = { ...(a.settings ?? {}) } as Record<string, unknown>;
      delete settings.twetch;
      await writeAccount(current().id, a, { encryptedKeys: sealed, settings });
    },
  };
};

/** The store over the wallet's ChromeStorageService and its own encryption. */
export const twetchStoreFor = (chromeStorageService: unknown): TwetchStore =>
  makeTwetchStore(chromeStorageService as TwetchStorage, { encrypt, decrypt });
