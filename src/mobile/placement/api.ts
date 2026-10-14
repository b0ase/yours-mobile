// bShares client for bit-sign (/api/bitsign/bshares/*). Uses the account's bChat (bit-sign) session.
import { BCHAT_ORIGIN, ChatApiError, type ChatSession, type Http } from '../chat/api';
import type { BsharesMe, PlacementOffer } from './placement';

export type NewOffer = {
  investorHandle: string;
  shares: number;
  pricePence: number;
  gbpPerBsvPence: number;
  rateDate: string;
  lockMonths: number;
  expiresAt: string;
};

export class BsharesApi {
  constructor(
    private readonly http: Http,
    private readonly session: ChatSession | null,
    private readonly origin = BCHAT_ORIGIN,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.session) throw new ChatApiError('Sign in to bChatX first', 401);
    const res = await this.http({
      method,
      url: `${this.origin}/api/bitsign/bshares${path}`,
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.session.token}` },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      const d = res.data as { error?: string } | null;
      throw new ChatApiError(d?.error ?? `bShares error ${res.status}`, res.status, res.data);
    }
    return res.data as T;
  }

  me = () => this.call<BsharesMe>('GET', '/me');
  createOffer = (o: NewOffer) => this.call<PlacementOffer>('POST', '/offers', o);
  accept = (id: string, investorPubKey: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/accept`, { investorPubKey });
  paid = (id: string, txid: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/paid`, { txid });
  approve = (id: string, directorPubKey: string, boardMinute: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/approve`, { directorPubKey, boardMinute });
  token = (id: string, outpoint: string, lockingScriptHex: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/token`, { outpoint, lockingScriptHex });
  decline = (id: string, reason: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/decline`, { reason });
  refund = (id: string, refundTxid: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/refund`, { refundTxid });
}
