/**
 * The requests the background answers without a sheet, one request at a time (background.ts showPermissionPrompt):
 *  - a pinned site's self-encrypt (pinnedMint.ts shouldDeferEncrypt), inside its rate cap;
 *  - that site's own action label while its mint createAction runs and before its spend reached a sheet;
 *  - a stream pass's spend (within its budget) and its label (streamGrants.ts passCovers; allowances only).
 * Each is answered with oneUseGrant: nothing stored, so the next call on that protocol is judged again (b-Aware row
 * 207: these were a 60-second grant every call on the protocol rode).
 *
 * SYNCHRONOUS up to grantPermission, and so must be every caller up to this call (review of 8155671a). The manager
 * releases every call queued on the request's key when it is answered, and a decrypt has an encrypt's key (same site,
 * protocol, counterparty and usage type 'encrypting'). With no await between the decision and grantPermission, and
 * guardSharedKeySigning releasing a one-use answer with no store write, nothing can join the request between the
 * check (no decrypt in flight) and its release. Never put an await in front of the grantPermission calls below.
 *
 * Kept out of background.ts so it can be tested with the real permissions manager (oneShotGrant.test.ts).
 */
import { oneUseGrant } from './oneShotGrant';
import {
  labelCoveredByIntent,
  shouldDeferEncrypt,
  type DeferredEncrypts,
  type MintIntent,
  type MintPermissionRequest,
  type ProtocolCalls,
} from './pinnedMint';
import { passCovers, type StreamPass } from './streamGrants';

export type SheetlessRequest = MintPermissionRequest & {
  requestID: string;
  spending?: { satoshis?: number };
};

export type SheetlessDeps = {
  wallet: { grantPermission: (params: ReturnType<typeof oneUseGrant>) => Promise<void> } | undefined;
  /** The site key the mint state is kept under (normalised originator); '' for the wallet itself or no site. */
  mintSite: string;
  protocolCalls: ProtocolCalls;
  deferredEncrypts: DeferredEncrypts;
  mintIntents: Map<string, MintIntent & { spendSeen?: boolean }>;
  /** The site's running stream pass, already looked up (undefined without allowances). */
  streamPass: StreamPass | undefined;
  /** The originator in the stream pass's form. */
  normalize: (originator: string) => string;
  now?: () => number;
};

/** The grant in flight when the request was answered without a sheet; null when it needs the usual sheet path. */
export const answerWithoutSheet = (request: SheetlessRequest, deps: SheetlessDeps): Promise<void> | null => {
  const { wallet, mintSite } = deps;
  if (!wallet) return null;
  if (mintSite) {
    const asSite = { ...request, originator: mintSite };
    const now = (deps.now ?? Date.now)();
    if (shouldDeferEncrypt(asSite, deps.protocolCalls, deps.deferredEncrypts, now)) {
      deps.deferredEncrypts.note(mintSite, request.protocolID as [number, string], now);
      // No await before this call (see above).
      return wallet.grantPermission(oneUseGrant(request.requestID));
    }
    const intent = deps.mintIntents.get(mintSite);
    // No await before this call (see above).
    if (intent && !intent.spendSeen && labelCoveredByIntent(asSite, intent))
      return wallet.grantPermission(oneUseGrant(request.requestID));
  }
  const pass = deps.streamPass;
  if (pass && request.originator && passCovers(pass, { ...request, originator: deps.normalize(request.originator) })) {
    if (request.type === 'spending') pass.charged = request.spending?.satoshis;
    // No await before this call (see above).
    return wallet.grantPermission(oneUseGrant(request.requestID));
  }
  return null;
};
