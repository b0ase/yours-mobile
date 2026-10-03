import { MAX_TURNS } from './agent';
import { PROVIDERS, type ProviderId } from './providers';

/**
 * Third-party AI consent (Apple 5.1.2(i)): before the first b agent message to a provider, the
 * user is told who receives what and must allow it. Stored per provider on this device;
 * Settings › b agent can revoke it. Nothing is sent without it (AgentPage checks before every send).
 *
 * 'paid' = bWallet's pay-per-message mode: the message goes to bit-sign (bitcoinchat.online), which
 * forwards it to Anthropic on bCorp's key (bit-sign src/lib/paid-agent-server.ts).
 */
export type ConsentTarget = 'paid' | ProviderId;

const KEY = 'bwallet.agent.consent';

export const consentTarget = (mode: 'paid' | 'own', provider: ProviderId): ConsentTarget =>
  mode === 'paid' ? 'paid' : provider;

export type ConsentInfo = {
  /** Who processes the messages, for the sheet's title. */
  provider: string;
  /** Every party the text passes through, in order. */
  route: string;
  terms: string;
};

export const consentInfo = (t: ConsentTarget): ConsentInfo =>
  t === 'paid'
    ? {
        provider: 'Anthropic',
        route:
          'bWallet’s server (bitcoinchat.online, run by The Bitcoin Corporation Ltd), which passes it to Anthropic',
        terms: 'Anthropic’s commercial terms and privacy policy (anthropic.com/legal)',
      }
    : {
        provider: PROVIDERS[t].label,
        route: `${PROVIDERS[t].label} directly from your phone, using your own API key`,
        terms: `${PROVIDERS[t].label}’s terms and privacy policy for API use`,
      };

/** What the sheet says is sent, and what is not. Kept here so the test can hold it to MAX_TURNS. */
export const SENT_TEXT = `Your message and the recent conversation (up to the last ${MAX_TURNS} messages), plus bWallet’s fixed instructions to b.`;
/** Pay-per-message also needs the payment proven: bWallet's server sees the txid and your bChat sign-in, not the provider. */
export const PAID_EXTRA_TEXT =
  'To check your payment, bWallet’s server also receives the payment’s transaction id and your bChat sign-in. Anthropic does not.';
export const NOT_SENT_TEXT =
  'Nothing else from your wallet: not your keys or recovery phrase, balances, addresses, contacts, chats or files.';

const read = (): Partial<Record<ConsentTarget, string>> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const write = (v: Partial<Record<ConsentTarget, string>>) => {
  try {
    if (Object.keys(v).length) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: consent is asked again next time */
  }
};

export const hasConsent = (t: ConsentTarget) => !!read()[t];
export const grantConsent = (t: ConsentTarget, now = Date.now()) =>
  write({ ...read(), [t]: new Date(now).toISOString() });
export const revokeConsent = (t: ConsentTarget) => {
  const v = read();
  delete v[t];
  write(v);
};
/** Providers the user has allowed, with when. */
export const consents = (): { target: ConsentTarget; at: string }[] =>
  Object.entries(read()).map(([target, at]) => ({ target: target as ConsentTarget, at: String(at) }));
export const clearConsents = () => write({});
