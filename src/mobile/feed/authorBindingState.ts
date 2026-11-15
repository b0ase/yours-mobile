/**
 * What this device remembers about the feed-author binding (authorBinding.ts), per account. Its own file with no
 * imports, so the name sync (names/accountName.ts) can clear a "needs a name" note without pulling in the feed.
 *
 * Only a cache of "the server already has this": losing it costs one more (idempotent) request, nothing else.
 */

export type AuthorBindingRecord = {
  /**
   * 'ok': the server linked `address` to `alias`. 'needs-name' / 'failed': it refused; see `at` for when.
   * 'blocked': the address is linked to another name. Not sent again for this pair for 30 days, or until the name
   * is re-signed.
   */
  status: 'ok' | 'needs-name' | 'failed' | 'blocked';
  /** The bWalletX name the claim was made for (lowercase, no domain). */
  alias: string;
  /** The posting address the claim was made for. */
  address: string;
  /** Unix ms of the answer. */
  at: number;
  /** The server's error code for a refusal. */
  code?: string;
};

const key = (identityAddress: string) => `bwallet.feedAuthor.${identityAddress}`;

export const readAuthorBinding = (identityAddress: string): AuthorBindingRecord | null => {
  try {
    const r = JSON.parse(localStorage.getItem(key(identityAddress)) || 'null') as AuthorBindingRecord | null;
    return r && typeof r.alias === 'string' && typeof r.address === 'string' && typeof r.at === 'number' ? r : null;
  } catch {
    return null;
  }
};

export const writeAuthorBinding = (identityAddress: string, record: AuthorBindingRecord | null) => {
  try {
    if (record) localStorage.setItem(key(identityAddress), JSON.stringify(record));
    else localStorage.removeItem(key(identityAddress));
  } catch {
    /* storage unavailable: the binding is sent again next time, which the server accepts */
  }
};

/**
 * The account's name was just claimed or its binding re-signed: forget a "needs a name" or "linked to another name"
 * refusal, so the next Feed open or post tries the binding again. Anything else on record stays.
 */
export const authorNameSigned = (identityAddress: string | null | undefined) => {
  const status = identityAddress ? readAuthorBinding(identityAddress)?.status : undefined;
  if (identityAddress && (status === 'needs-name' || status === 'blocked')) writeAuthorBinding(identityAddress, null);
};

const postedKey = (identityAddress: string) => `bwallet.feedPosted.${identityAddress}`;

/** This account has published to the Feed from this device (set by every successful post). */
export const hasPostedFlag = (identityAddress: string): boolean => {
  try {
    return localStorage.getItem(postedKey(identityAddress)) === '1';
  } catch {
    return false;
  }
};

export const markPosted = (identityAddress: string) => {
  try {
    if (localStorage.getItem(postedKey(identityAddress)) !== '1') localStorage.setItem(postedKey(identityAddress), '1');
  } catch {
    /* storage unavailable: the account's bSocial basket still says it has posted */
  }
};
