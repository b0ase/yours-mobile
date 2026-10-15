/**
 * bit-sign calls for the bPics market (/api/bitsign/bpics/*), kept in the market chunk so a store build has none
 * of the paths (BPICS_MARKET_ENABLED, storeBuild.ts).
 */
import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from '../../chat/api';
import { walletSigner } from '../../chat/signer';
import { parseItems, type MarketItem, type ReportReason } from './listing';

export class BpicsClient extends BchatClient {
  async feed(): Promise<MarketItem[]> {
    return parseItems(await this.call('GET', '/api/bitsign/bpics/feed', undefined, false));
  }
  async mine(): Promise<MarketItem[]> {
    return parseItems(await this.call('GET', '/api/bitsign/bpics/feed?mine=1'));
  }
  async escrowKey(): Promise<string | null> {
    const r = await this.call<{ key?: unknown }>('GET', '/api/bitsign/bpics/escrow-key', undefined, false);
    return typeof r?.key === 'string' && /^0[23][0-9a-f]{64}$/i.test(r.key) ? r.key : null;
  }
  register(itemId: string, escrow: string): Promise<unknown> {
    return this.call('POST', '/api/bitsign/bpics/items', { item_id: itemId, escrow });
  }
  claim(body: { address: string; issued_at: string; signature: string; origins: string[] }) {
    return this.call<{ listed?: string[]; refused?: { id: string; error: string }[] }>(
      'POST',
      '/api/bitsign/bpics/claims',
      body,
    );
  }
  /** null while the payment is not visible yet (202): try again shortly. */
  async unlock(itemId: string, txid: string): Promise<{ wrapped: string; escrowKey: string } | null> {
    const r = await this.call<{ wrapped?: unknown; escrow_key?: unknown }>('POST', '/api/bitsign/bpics/unlock', {
      item_id: itemId,
      txid,
    });
    return typeof r?.wrapped === 'string' && typeof r.escrow_key === 'string'
      ? { wrapped: r.wrapped, escrowKey: r.escrow_key }
      : null;
  }
  report(itemId: string, reason: ReportReason, details = ''): Promise<unknown> {
    return this.call('POST', '/api/bitsign/bpics/report', { item_id: itemId, reason, details }, !!this.handle);
  }
}

export const publicClient = () => new BpicsClient(defaultHttp(isNative), loadSession());

/** A signed-in client (signs in with the wallet once if needed). */
export async function signedClient(ctx: OneSatContext): Promise<BpicsClient> {
  const c = new BpicsClient(defaultHttp(isNative), loadSession());
  if (!c.handle) saveSession(await c.signIn(walletSigner(ctx)));
  return c;
}

/** A missing endpoint or table (not deployed / migration not run) reads as "not open yet", not an error. */
export const notOpenYet = (e: unknown) => e instanceof ChatApiError && (e.status === 404 || e.status === 503);
