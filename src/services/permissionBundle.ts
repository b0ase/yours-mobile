/**
 * One sheet per action (docs/ONE-SHEET-PERMISSIONS.md §3a/§3b).
 *
 * The permissions manager raises one callback per permission (protocol, basket,
 * certificate, spending). Instead of one prompt each, the background feeds them
 * into this bundler: requests from the same site inside a short merge window
 * become one bundle, shown as one sheet. Requests that arrive while that sheet
 * is open join it. The user's answer is a yes/no per request; the background
 * still resolves each one through the manager's own grantPermission /
 * denyPermission, so what is stored and checked does not change.
 *
 * Pure (no chrome APIs, timers injected) so it can be unit tested.
 */

/** The fields of a toolbox PermissionRequest this module reads. */
export interface BundleRequest {
  requestID: string;
  type: 'protocol' | 'basket' | 'certificate' | 'spending';
  originator: string;
  displayOriginator?: string;
  privileged?: boolean;
  protocolID?: [number, string] | (string | number)[];
  counterparty?: string;
  basket?: string;
  certificate?: { verifier: string; certType: string; fields: string[] };
  spending?: { satoshis: number; lineItems?: { type: string; description: string; satoshis: number }[] };
  reason?: string;
}

export type BundleState = 'collecting' | 'shown';

export interface PermissionBundle<R extends BundleRequest = BundleRequest> {
  id: string;
  originator: string;
  state: BundleState;
  items: R[];
  createdAt: number;
}

export interface BundlerOptions<R extends BundleRequest> {
  /** Merge window in ms, counted from the first request of a bundle. */
  windowMs?: number;
  /** The bundle is ready to show (merge window over, or flushed). */
  onReady: (bundle: PermissionBundle<R>) => void;
  /** A request joined a bundle whose sheet is already open. */
  onUpdate?: (bundle: PermissionBundle<R>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  newId?: () => string;
}

export const DEFAULT_MERGE_WINDOW_MS = 400;

let idCounter = 0;
const defaultId = () => `bundle-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export class PermissionBundler<R extends BundleRequest = BundleRequest> {
  private bundles = new Map<string, PermissionBundle<R>>();
  private timers = new Map<string, unknown>();
  private readonly windowMs: number;
  private readonly opts: BundlerOptions<R>;

  constructor(opts: BundlerOptions<R>) {
    this.opts = opts;
    this.windowMs = opts.windowMs ?? DEFAULT_MERGE_WINDOW_MS;
  }

  private setTimer(fn: () => void, ms: number) {
    return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown) {
    (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  /** The open bundle for a site (collecting or shown), if any. */
  private openFor(originator: string): PermissionBundle<R> | undefined {
    for (const b of this.bundles.values()) if (b.originator === originator) return b;
    return undefined;
  }

  /** Add a request. Returns the bundle it joined. */
  add(request: R): PermissionBundle<R> {
    const existing = this.openFor(request.originator);
    if (existing) {
      if (!existing.items.some((i) => i.requestID === request.requestID)) existing.items.push(request);
      if (existing.state === 'shown') this.opts.onUpdate?.(existing);
      return existing;
    }
    const bundle: PermissionBundle<R> = {
      id: (this.opts.newId ?? defaultId)(),
      originator: request.originator,
      state: 'collecting',
      items: [request],
      createdAt: (this.opts.now ?? Date.now)(),
    };
    this.bundles.set(bundle.id, bundle);
    this.timers.set(
      bundle.id,
      this.setTimer(() => this.flush(bundle.id), this.windowMs),
    );
    return bundle;
  }

  /** End the merge window now and show the bundle. No-op if already shown or gone. */
  flush(id: string): PermissionBundle<R> | undefined {
    const bundle = this.bundles.get(id);
    if (!bundle) return undefined;
    const t = this.timers.get(id);
    if (t !== undefined) {
      this.clearTimer(t);
      this.timers.delete(id);
    }
    if (bundle.state === 'collecting') {
      bundle.state = 'shown';
      this.opts.onReady(bundle);
    }
    return bundle;
  }

  get(id: string): PermissionBundle<R> | undefined {
    return this.bundles.get(id);
  }

  /** The bundle holding a request, if any. */
  findByRequest(requestID: string): PermissionBundle<R> | undefined {
    for (const b of this.bundles.values()) if (b.items.some((i) => i.requestID === requestID)) return b;
    return undefined;
  }

  /** Bundles in arrival order. */
  list(): PermissionBundle<R>[] {
    return [...this.bundles.values()];
  }

  /**
   * Apply the user's answer. `decisions` maps requestID → granted. Requests the
   * sheet never showed (they joined after the user's view was built, so they are
   * missing from `decisions`) are not decided here: they move to a new bundle
   * that is shown at once, so nothing is approved unseen.
   */
  resolve(
    id: string,
    decisions: Record<string, boolean>,
  ): { granted: R[]; denied: R[]; carried?: PermissionBundle<R> } | undefined {
    const bundle = this.bundles.get(id);
    if (!bundle) return undefined;
    this.drop(id);
    const granted: R[] = [];
    const denied: R[] = [];
    const unseen: R[] = [];
    for (const item of bundle.items) {
      if (!(item.requestID in decisions)) unseen.push(item);
      else if (decisions[item.requestID] === true) granted.push(item);
      else denied.push(item);
    }
    let carried: PermissionBundle<R> | undefined;
    if (unseen.length > 0) {
      carried = {
        id: (this.opts.newId ?? defaultId)(),
        originator: bundle.originator,
        state: 'collecting',
        items: unseen,
        createdAt: (this.opts.now ?? Date.now)(),
      };
      this.bundles.set(carried.id, carried);
      this.flush(carried.id);
    }
    return { granted, denied, carried };
  }

  /** Remove one request (e.g. it was answered or failed elsewhere). Empty bundles go too. */
  removeRequest(requestID: string): void {
    const bundle = this.findByRequest(requestID);
    if (!bundle) return;
    bundle.items = bundle.items.filter((i) => i.requestID !== requestID);
    if (bundle.items.length === 0) this.drop(bundle.id);
  }

  /** Forget a bundle without deciding (the caller denies its requests). */
  drop(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(id);
    this.bundles.delete(id);
  }

  clear(): void {
    for (const id of [...this.bundles.keys()]) this.drop(id);
  }
}

// ─── The sheet model: plain words, ticks and risk ─────────────────────

/** Default allowance per app: $5 a month (owner, 9 Oct 2026). */
export const DEFAULT_ALLOWANCE_USD = 5;
/** Choices offered by [change] on the allowance line. 0 = none (every payment asks). */
export const ALLOWANCE_CHOICES_USD = [0, 1, 5, 20] as const;

const PRIVATE_CERT_FIELDS = /e-?mail|phone|mobile|kyc|passport|licen[cs]e|birth|dob|address|ssn|national|tax|id_?number/i;

export interface SheetLine {
  requestID: string;
  /** Plain-English line shown by default. */
  text: string;
  /** Protocol IDs, baskets, counterparties, raw sats: shown under Details. */
  detail: string;
  /** Risky lines are never pre-ticked and are drawn in red. */
  risky: boolean;
  /** Initial tick. */
  checked: boolean;
}

export interface SheetPayment {
  requestID: string;
  satoshis: number;
  /** What the app says it is for (first line item or reason). */
  description?: string;
  detail: string;
}

export interface SheetModel {
  originator: string;
  lines: SheetLine[];
  payment?: SheetPayment;
  /** Title verb for the header and the main button. */
  mode: 'connect' | 'pay' | 'connectAndPay';
}

const protoName = (r: BundleRequest) => String(r.protocolID?.[1] ?? 'unknown');
const protoLevel = (r: BundleRequest) => Number(r.protocolID?.[0] ?? 0);

/** True when a request should never be pre-ticked (plan §3c). */
export const isRiskyRequest = (r: BundleRequest): boolean => {
  if (r.privileged) return true;
  if (r.type === 'protocol' && r.counterparty === 'anyone') return true;
  if (r.type === 'certificate' && (r.certificate?.fields ?? []).some((f) => PRIVATE_CERT_FIELDS.test(f))) return true;
  return false;
};

const lineText = (r: BundleRequest): string => {
  switch (r.type) {
    case 'protocol': {
      if (r.counterparty === 'anyone') return 'Sign and decrypt for anyone, not just this app';
      if (protoLevel(r) === 2 && r.counterparty && r.counterparty !== 'self')
        return 'Sign and share keys with one named person or service';
      return 'Sign in and sign its messages';
    }
    case 'basket':
      return 'Keep its tickets and tokens in your wallet';
    case 'certificate': {
      const fields = r.certificate?.fields ?? [];
      return fields.length ? `See your certificate details (${fields.join(', ')})` : 'See your certificates';
    }
    default:
      return 'Spend from your wallet';
  }
};

const lineDetail = (r: BundleRequest): string => {
  const parts: string[] = [];
  switch (r.type) {
    case 'protocol':
      parts.push(`protocol "${protoName(r)}" level ${protoLevel(r)}`);
      if (r.counterparty) parts.push(`counterparty ${r.counterparty}`);
      break;
    case 'basket':
      parts.push(`basket "${r.basket ?? ''}"`);
      break;
    case 'certificate':
      parts.push(`certificate ${r.certificate?.certType ?? ''}`, `verifier ${r.certificate?.verifier ?? ''}`);
      break;
    case 'spending':
      parts.push(`${r.spending?.satoshis ?? 0} sats`);
      break;
  }
  if (r.privileged) parts.push('privileged');
  if (r.reason) parts.push(`reason: ${r.reason}`);
  return parts.join(' · ');
};

/** Build the one sheet for a bundle. Spending requests become the "Pay now" section. */
export const buildSheetModel = (bundle: Pick<PermissionBundle, 'originator' | 'items'>): SheetModel => {
  const lines: SheetLine[] = [];
  let payment: SheetPayment | undefined;
  for (const r of bundle.items) {
    if (r.type === 'spending') {
      const sats = r.spending?.satoshis ?? 0;
      if (!payment) {
        payment = {
          requestID: r.requestID,
          satoshis: sats,
          description: r.spending?.lineItems?.find((l) => l.description)?.description ?? r.reason,
          detail: lineDetail(r),
        };
      } else {
        // A second spend in the same bundle: shown as its own line, never pre-ticked.
        lines.push({
          requestID: r.requestID,
          text: `Also pay ${sats.toLocaleString()} sats`,
          detail: lineDetail(r),
          risky: true,
          checked: false,
        });
      }
      continue;
    }
    const risky = isRiskyRequest(r);
    lines.push({ requestID: r.requestID, text: lineText(r), detail: lineDetail(r), risky, checked: !risky });
  }
  const mode: SheetModel['mode'] = payment ? (lines.length ? 'connectAndPay' : 'pay') : 'connect';
  return { originator: bundle.originator, lines, payment, mode };
};

/** Convert a dollar allowance to satoshis at a USD-per-BSV rate. 0 or no rate → 0. */
export const allowanceSats = (usd: number, usdPerBsv: number | undefined): number => {
  if (!usd || !usdPerBsv || usdPerBsv <= 0 || !Number.isFinite(usdPerBsv)) return 0;
  return Math.floor((usd / usdPerBsv) * 1e8);
};
