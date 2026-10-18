// bShares client for bit-sign (/api/bitsign/bshares/*). Uses the account's bChat (bit-sign) session.
import { BCHAT_ORIGIN, ChatApiError, type ChatSession, type Http } from '../chat/api';
import type { ExcessChoice } from './minute';
import type { BsharesMe, PlacementOffer } from './placement';
import type { CompanyListing } from './company';
import type { PartnerLockState, PartnerLockAction } from './partnership/lockState';
import type { AgreementVersion, Partner } from './partnership/partnership';
import type { TransferRule } from './partnership/partnerLock';

export type PartnershipRecord = {
  roomId: string;
  ticker: string;
  constitution: string;
  notice: string;
  active: AgreementVersion | null;
  draft: AgreementVersion | null;
  converted: boolean;
};

export type NewOffer = {
  investorHandle: string;
  shares: number;
  pricePence: number;
  gbpPerBsvPence: number;
  rateDate: string;
  lockMonths: number;
  expiresAt: string;
  shareClassId?: string;
};

type Signed = { at: string; signature: string };

export class BsharesApi {
  constructor(
    private readonly http: Http,
    private readonly session: ChatSession | null,
    /** Which company (room ticker). Undefined = bCorp, as phase 1. */
    readonly company?: string,
    private readonly origin = BCHAT_ORIGIN,
  ) {}

  /** Same client, another company. */
  forCompany = (ticker: string) => new BsharesApi(this.http, this.session, ticker, this.origin);

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    base = '/api/bitsign/bshares',
  ): Promise<T> {
    if (!this.session) throw new ChatApiError('Sign in to bChatX first', 401);
    const q =
      this.company && base === '/api/bitsign/bshares' && !path.startsWith('/companies')
        ? `${path.includes('?') ? '&' : '?'}company=${encodeURIComponent(this.company)}`
        : '';
    const res = await this.http({
      method,
      url: `${this.origin}${base}${path}${q}`,
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

  // ── Companies (the room is the company) ────────────────────────────────────────────
  companies = () => this.call<{ companies: CompanyListing[] }>('GET', '/companies');
  private co = (t: string, rest: string) => `/companies/${encodeURIComponent(t)}${rest}`;
  /** Incorporate: set the token room's constitution to company (existing bChatX rule: majority holder). */
  incorporate = (ticker: string) =>
    this.call<{ ok?: boolean; error?: string }>(
      'POST',
      `/rooms/${encodeURIComponent(ticker)}/constitution`,
      { to: 'company' },
      '/api/bitsign',
    );
  setDetails = (
    t: string,
    d: {
      companyNumber: string;
      jurisdiction: string;
      authorisedShares: number | null;
      authorisedArticle: string | null;
    },
  ) => this.call<{ ok: true }>('POST', this.co(t, '/details'), d);
  addShareClass = (t: string, c: { name: string; nominalNanoPounds: number; authorised: number | null }) =>
    this.call<{ ok: true; id: string }>('POST', this.co(t, '/classes'), c);
  contributeKeys = (t: string, k: { identityKey: string; treasuryPubkey: string } & Signed) =>
    this.call<{ ok: true }>('POST', this.co(t, '/keys'), k);
  approveDirector = (t: string, a: { subject: string } & Signed) =>
    this.call<{ ok: true; signed: number; need: number; approved: boolean }>('POST', this.co(t, '/directors'), a);
  /** Appointment itself goes through bChatX's officers route (it checks the signed approvals). */
  appointDirector = (t: string, handle: string, personName: string) =>
    this.call<{ ok: true }>(
      'POST',
      `/rooms/${encodeURIComponent(t)}/officers`,
      { handle, office: 'director', person_name: personName },
      '/api/bitsign',
    );
  /** Directors only: the treasury keys in slot order (what a treasury approval signs). */
  treasuryKeys = () =>
    this.call<{ pubkeys: string[]; complete: boolean; m: number | null }>(
      'GET',
      this.co(this.company ?? 'bcorp', '/treasury'),
    );
  /**
   * 409 = the treasury was already adopted (treasury_m set, e.g. another director's signature completed it):
   * not an error for the signer, so it comes back as adopted and the caller reloads.
   */
  signTreasury = async (
    t: string,
    a: { m: number } & Signed,
  ): Promise<{ ok: true; adopted: boolean; signed: number; need: number; alreadySet?: boolean }> => {
    try {
      return await this.call<{ ok: true; adopted: boolean; signed: number; need: number }>(
        'POST',
        this.co(t, '/treasury'),
        a,
      );
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 409)
        return { ok: true, adopted: true, signed: 0, need: 0, alreadySet: true };
      throw e;
    }
  };
  createOffer = (o: NewOffer) => this.call<PlacementOffer>('POST', '/offers', o);
  accept = (id: string, investorPubKey: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/accept`, { investorPubKey });
  /** `excessChoice` is the investor's answer to the offer's overpayment term, made at payment time. */
  paid = (id: string, txid: string, excessChoice: ExcessChoice) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/paid`, { txid, excessChoice });
  /** Single-director resolution: bit-sign writes the minute (BCORP-BM-<date>-<NNN>) from the allotment data. */
  approve = (id: string, directorPubKey: string, minuteNumber: number) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/approve`, { directorPubKey, minuteNumber });
  refundExcess = (id: string, refundTxid: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/refund-excess`, { refundTxid });
  token = (id: string, outpoint: string, lockingScriptHex: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/token`, { outpoint, lockingScriptHex });
  decline = (id: string, reason: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/decline`, { reason });
  refund = (id: string, refundTxid: string) =>
    this.call<PlacementOffer>('POST', `/offers/${encodeURIComponent(id)}/refund`, { refundTxid });

  // ── Partnership shares partner lock (pending approvals mailbox; it never holds a key) ─────────────
  myPartnerships = () =>
    this.call<{ partnerships: { ticker: string; name: string; version: number }[] }>(
      'GET',
      '',
      undefined,
      '/api/bitsign/bshares/partnership',
    );
  partnerLock = (ticker: string) =>
    this.call<PartnerLockState>(
      'GET',
      `/${encodeURIComponent(ticker)}/lock`,
      undefined,
      '/api/bitsign/bshares/partnership',
    );
  /** Withdraw the open partnership draft (anyone it names, or a current partner). 404 none · 409 changed meanwhile. */
  withdrawPartnershipDraft = (ticker: string) =>
    this.call<{ ok: true; withdrawn: number }>(
      'DELETE',
      `/${encodeURIComponent(ticker)}`,
      undefined,
      '/api/bitsign/bshares/partnership',
    );
  /**
   * Report a move the wallet has ALREADY broadcast. The server reads the tx from WhatsOnChain and checks it is the
   * agreed move; "isn't visible on chain yet" (409) is retried with backoff.
   */
  reportBroadcast = async (ticker: string, id: string, txid: string, waits = [2000, 4000, 8000, 15000]) => {
    for (let i = 0; ; i++) {
      try {
        return await this.partnerLockAction(ticker, { action: 'broadcast', id, txid });
      } catch (e) {
        const notYet = e instanceof ChatApiError && e.status === 409 && /visible on chain/i.test(e.message);
        if (!notYet || i >= waits.length) throw e;
        await new Promise((r) => setTimeout(r, waits[i]));
      }
    }
  };
  /** The room's partnership: active agreement, open draft, who has signed (room members only). */
  partnership = (ticker: string) =>
    this.call<PartnershipRecord>(
      'GET',
      `/${encodeURIComponent(ticker)}`,
      undefined,
      '/api/bitsign/bshares/partnership',
    );
  /** Propose a version: the first (anyone it names) or an admission/removal (a current partner). b drafts the text. */
  proposePartnership = (ticker: string, body: { partners: Partner[]; rule: TransferRule }) =>
    this.call<{ id: string; version: number; agreement_sha256: string; agreementText: string }>(
      'POST',
      `/${encodeURIComponent(ticker)}`,
      body,
      '/api/bitsign/bshares/partnership',
    );
  /** Sign the open draft with the identity key (the server verifies the signature over signMessage()). */
  signPartnership = (ticker: string, body: { identityKey: string; at: string; signature: string }) =>
    this.call<{ ok: true; active: boolean; signed: string[]; waitingFor?: string[]; amendment?: string | null }>(
      'POST',
      `/${encodeURIComponent(ticker)}/sign`,
      body,
      '/api/bitsign/bshares/partnership',
    );
  partnerLockAction = (ticker: string, body: PartnerLockAction) =>
    this.call<{ ok: true; id?: string }>(
      'POST',
      `/${encodeURIComponent(ticker)}/lock`,
      body,
      '/api/bitsign/bshares/partnership',
    );
}
