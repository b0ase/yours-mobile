/**
 * Sign in with bWalletX from a site, in the Chrome extension (owner, 28 Oct 2026: bChatX sign-in failed with
 * `This protocol is reserved for bWalletX itself: "message signing"`).
 *
 * bit-sign / bChatX sign in with two calls, in order:
 *   1. createSignature { protocolID: [2, 'bwallet sign in'], keyID: <nonce>, counterparty: 'anyone',
 *      data: utf8(bit-sign's challenge text for THIS origin) }  - the normal approval sheet asks the user;
 *   2. @1sat/actions signBsm over the same text: createSignature { protocolID: [1, 'message signing'],
 *      keyID: 'identity', counterparty: 'self', hashToDirectlySign: BSM.magicHash(text) }, then
 *      getPublicKey { protocolID: [1, 'message signing'], keyID: 'identity', forSelf: true }.
 *
 * Step 2 uses a reserved protocol (services/reservedProtocolList.ts), so the extension refused it. The paired phone
 * already answers it the safe way (mobile/pair/pairLogin.ts); this file gives the extension the same rule: only after
 * step 1 succeeded for a byte-exact challenge naming this sender's own origin, once, within two minutes, and only for
 * the BSM hash of that very text. Every other use of [1, 'message signing'] is still refused.
 */
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { isLoginProtocolCall, noteApprovedLogin, parseLoginRequest, takeBsmFollowUp } from '../mobile/pair/pairLogin';

type BaseWallet = {
  createSignature: (a: never) => Promise<unknown>;
  getPublicKey: (a: never) => Promise<unknown>;
};

export type ExtensionSignInStep =
  | { kind: 'none' }
  /** A valid sign-in signature for this origin: call approved() once the wallet has signed it. */
  | { kind: 'login'; approved: () => void }
  /** The approved sign-in's chat-key proof: answer it with the wallet's own keys. */
  | { kind: 'bsm'; answer: (w: BaseWallet) => Promise<unknown> };

const channelFor = (origin: string) => `ext:${origin}`;

export function extensionSignInStep(
  senderOrigin: string,
  action: string,
  params: unknown,
  now = Date.now(),
): ExtensionSignInStep {
  let origin: string;
  try {
    origin = new URL(senderOrigin).origin;
  } catch {
    return { kind: 'none' };
  }
  const channel = channelFor(origin);
  if (isLoginProtocolCall(action, params)) {
    const req = parseLoginRequest(params, origin, now);
    // Not bit-sign's challenge for this origin: it goes the normal way (a sheet), and earns no follow-up.
    if (typeof req === 'string') return { kind: 'none' };
    return { kind: 'login', approved: () => void noteApprovedLogin(channel, req.message, Date.now()) };
  }
  if (!takeBsmFollowUp(channel, action, params, now)) return { kind: 'none' };
  const p = params as Record<string, unknown>;
  return {
    kind: 'bsm',
    answer: (w) =>
      action === 'createSignature'
        ? w.createSignature({
            protocolID: MESSAGE_SIGNING_PROTOCOL,
            keyID: 'identity',
            counterparty: 'self',
            hashToDirectlySign: p.hashToDirectlySign,
          } as never)
        : w.getPublicKey({ protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', forSelf: true } as never),
  };
}
