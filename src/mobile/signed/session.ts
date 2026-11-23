import type { OneSatContext } from '@1sat/actions';
import { sdk as toolboxSdk } from '@bsv/wallet-toolbox-client';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import {
  findSealAction,
  recoverNativeSeals,
  type ListActionsFn,
  type SealApi,
  type SealTxLookup,
} from '../chat/nativeSeal';
import { heldSealStore, readHeldSeals, sealedLedger } from './held';
import type { Get } from './sync';

/**
 * Signed's link to bit-sign: the wallet's own bChatX session (the same Bearer the seal page and chat use,
 * chat/api.ts loadSession). Reading never signs in by itself: with no session the page says so and offers a button.
 */
export const sessionHandle = (): string => loadSession()?.handle ?? '';

/** GET with the current session, or null when there is none (signed out). */
export const sessionGet = (): Get | null => {
  const s = loadSession();
  if (!s) return null;
  const c = new BchatClient(defaultHttp(isNative), s);
  return (path) => c.request('GET', path);
};

/** The explicit "Sign in" button: the wallet's key signs bChatX's challenge (as the seal page does). */
export const signInToBchat = async (ctx: OneSatContext): Promise<void> => {
  const s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(ctx));
  saveSession(s);
};

const client = async (ctx: OneSatContext): Promise<BchatClient> => {
  let s = loadSession();
  if (!s) {
    s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(ctx));
    saveSession(s);
  }
  return new BchatClient(defaultHttp(isNative), s);
};

/** The seal routes, exactly as the seal page calls them (NativeSealPage `api`). */
const sealApi =
  (ctx: OneSatContext): SealApi =>
  async (path, body) => {
    const c = await client(ctx);
    try {
      const data = (await c.request('POST', `/api/bitsign/nds/seal/${path}`, body)) as Record<string, unknown>;
      return { ok: true, status: 200, body: data ?? {} };
    } catch (e) {
      if (e instanceof ChatApiError)
        return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
      throw e;
    }
  };

/** An unsure seal's transaction in this wallet's own storage (as NativeSealPage `txLookup`). */
const txLookup = (ctx: OneSatContext): SealTxLookup => ({
  find: (script, sinceMs) =>
    findSealAction(
      (args) => ctx.wallet.listActions(args) as ReturnType<ListActionsFn>,
      script,
      sinceMs,
      toolboxSdk.specOpFailedActions,
    ),
  beef: async (txid) => {
    try {
      const services = ctx.services as unknown as {
        getBeefForTxid?: (t: string) => Promise<{ toBinaryAtomic(t: string): number[] }>;
      };
      return services?.getBeefForTxid ? (await services.getBeefForTxid(txid)).toBinaryAtomic(txid) : null;
    } catch {
      return null;
    }
  },
});

export type FinishResult = 'finished' | 'still_held' | 'failed';

/**
 * Finish: the seal page's own recovery (nativeSeal.recoverNativeSeals) for ONE held document, with the same store,
 * ledger and lookup. Nothing new is signed or paid: it records a payment already made, or releases one never made.
 */
export const finishHeld = async (
  ctx: OneSatContext,
  documentId: string,
  recover: typeof recoverNativeSeals = recoverNativeSeals,
): Promise<FinishResult> => {
  try {
    await recover(sealApi(ctx), heldSealStore(), documentId, sealedLedger(), txLookup(ctx));
  } catch {
    return 'failed';
  }
  return readHeldSeals().some((p) => p.documentId === documentId) ? 'still_held' : 'finished';
};
