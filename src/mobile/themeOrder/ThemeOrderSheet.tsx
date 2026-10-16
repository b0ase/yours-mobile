import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink, ImagePlus, Plus, X } from 'lucide-react';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { listPaymails, type WalletName } from '../names/paymail';
import {
  getQuote,
  getRenewQuote,
  isNotConfigured,
  myOrders,
  payQuote,
  quoteFields,
  uploadFile,
  type Quote,
} from './api';
import {
  editionsFrom,
  fileError,
  MAX_FILES,
  PRICE_USD,
  previewUrl,
  STATUS_LABEL,
  toSlug,
  validateForm,
  type MyOrder,
  type OrderForm,
} from './form';

/**
 * Get your own theme (tier 1, $99 a year; owner 16 Oct 2026; matches bwalletx.com/themes/custom). Settings ›
 * Appearance › "Get your own edition" and the Theme page link open this sheet: a short form, then ONE approval
 * sheet to pay (the quote from the server), then My editions with status, Preview and Renew.
 * bWalletX only (THEME_ORDERS_ENABLED): this file is a lazy chunk and never in a store build.
 */

type Tab = 'order' | 'mine';
type Pay =
  | { k: 'idle' }
  | { k: 'quoting'; step: string }
  | { k: 'ready'; quote: Quote; label: string }
  | { k: 'paying'; quote: Quote; label: string }
  | { k: 'done'; order: MyOrder }
  | { k: 'error'; msg: string; quote?: Quote; label?: string };

const f: typeof fetch = (u, i) => fetch(u, i);

const EMPTY: OrderForm = {
  name: '',
  slug: '',
  brand: '',
  isBrand: false,
  link: '',
  colours: ['#f5c542', '#0b0b0d'],
  files: [],
  note: '',
  proof: '',
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const Field = ({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) => (
  <label className="block mb-4">
    <span className="block text-[13px] font-semibold text-white mb-1.5">{label}</span>
    {children}
    {hint && !error && <span className="block mt-1 text-[12px] text-gray-400">{hint}</span>}
    {error && <span className="block mt-1 text-[12px] text-red-400">{error}</span>}
  </label>
);

const inputCls =
  'w-full rounded-xl bg-[#17191E] border border-white/10 px-3 py-2.5 text-[15px] text-white outline-none focus:border-[var(--bw-accent)]';

export default function ThemeOrderSheet({ onClose, initialTab = 'order' }: { onClose: () => void; initialTab?: Tab }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityKey = account?.pubKeys?.identityPubKey ?? '';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [form, setForm] = useState<OrderForm>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [tried, setTried] = useState(false);
  const [names, setNames] = useState<WalletName[]>([]);
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [pay, setPay] = useState<Pay>({ k: 'idle' });
  const [details, setDetails] = useState(false);

  // Above the Theme sheet (z 1000) when opened from its link.
  useBackClose(true, pay.k === 'ready' || pay.k === 'error' ? () => setPay({ k: 'idle' }) : onClose);

  const loadMine = async () => {
    try {
      const r = await myOrders(f, apiContext.wallet);
      setOrders(r.orders);
      setClosed(!r.configured);
      setLoadErr('');
    } catch (e) {
      if (isNotConfigured(e)) setClosed(true);
      else setLoadErr(e instanceof Error ? e.message : 'Could not load your editions');
      setOrders([]);
    }
  };

  useEffect(() => {
    void loadMine();
    if (identityKey)
      void listPaymails(f, identityKey)
        .then(setNames)
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  const set = <K extends keyof OrderForm>(k: K, v: OrderForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  const errors = useMemo(() => validateForm(form), [form]);
  const show = (k: keyof OrderForm) => (tried ? errors[k] : undefined);
  const editions = useMemo(() => editionsFrom(orders ?? []), [orders]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)].slice(0, MAX_FILES);
    setFiles(next);
    set(
      'files',
      next.map((x) => ({ name: x.name, type: x.type, size: x.size })),
    );
  };
  const removeFile = (i: number) => {
    const next = files.filter((_, j) => j !== i);
    setFiles(next);
    set(
      'files',
      next.map((x) => ({ name: x.name, type: x.type, size: x.size })),
    );
  };

  const fail = (e: unknown) => {
    if (isNotConfigured(e)) {
      setClosed(true);
      setPay({ k: 'idle' });
      return;
    }
    setPay({ k: 'error', msg: e instanceof Error ? e.message : 'Something went wrong' });
  };

  const startOrder = async () => {
    setTried(true);
    if (Object.keys(errors).length || closed) return;
    try {
      const uploaded = [];
      for (let i = 0; i < files.length; i++) {
        setPay({ k: 'quoting', step: `Uploading ${i + 1} of ${files.length}…` });
        uploaded.push(await uploadFile(f, apiContext.wallet, files[i]));
      }
      setPay({ k: 'quoting', step: 'Getting the price…' });
      const quote = await getQuote(f, apiContext.wallet, quoteFields(form, uploaded));
      setPay({ k: 'ready', quote, label: form.name.trim() });
    } catch (e) {
      fail(e);
    }
  };

  const startRenew = async (slug: string, name: string) => {
    try {
      setPay({ k: 'quoting', step: 'Getting the price…' });
      const quote = await getRenewQuote(f, apiContext.wallet, slug);
      setPay({ k: 'ready', quote, label: `${name} · renew` });
    } catch (e) {
      fail(e);
    }
  };

  const confirmPay = async () => {
    if (pay.k !== 'ready') return;
    const { quote, label } = pay;
    setPay({ k: 'paying', quote, label });
    try {
      const order = await payQuote(apiContext, f, quote);
      setPay({ k: 'done', order });
      setForm(EMPTY);
      setFiles([]);
      setTried(false);
      setSlugTouched(false);
      void loadMine();
    } catch (e) {
      setPay({ k: 'error', msg: e instanceof Error ? e.message : 'Payment failed', quote, label });
    }
  };

  // ONE approval sheet: the quote, one Pay button. Pressing Pay pays; nothing else pops up.
  if (pay.k === 'ready' || pay.k === 'paying' || (pay.k === 'error' && pay.quote)) {
    const quote = pay.quote!;
    const busy = pay.k === 'paying';
    return createPortal(
      <div
        className="fixed inset-0 z-[1110] flex flex-col"
        style={{
          background: CARD.bg,
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <ApprovalCard
          ours
          site="bWalletX"
          siteSub="Your own theme"
          onClose={() => setPay({ k: 'idle' })}
          closeLabel="Close"
          closeDisabled={busy}
          hero={<PayHero amount={`$${quote.usd}`} sub={`${quote.sats.toLocaleString()} sats · 1 year`} />}
          title={
            <>
              Pay for <span style={{ color: CARD.gold }}>{pay.label}</span>
            </>
          }
          primary={{
            label: busy ? 'Paying…' : `Pay $${quote.usd}`,
            onClick: () => void confirmPay(),
            disabled: busy,
            busy,
          }}
          secondary={{ label: 'Not now', onClick: () => setPay({ k: 'idle' }), disabled: busy }}
          details={
            <span>
              {quote.sats.toLocaleString()} sats to bWalletX for one year of your edition, with an order reference on
              chain. The price holds until {new Date(quote.expires_at).toLocaleTimeString()}. If we decline an order
              (impersonation, someone else&apos;s brand), we refund it by hand.
            </span>
          }
          detailsOpen={details}
          onToggleDetails={() => setDetails(!details)}
          error={pay.k === 'error' ? pay.msg : undefined}
        >
          <div className="flex flex-wrap" style={{ gap: 8 }}>
            <Chip>1 year</Chip>
            <Chip>Powered by bWalletX</Chip>
            <Chip>Paid in BSV</Chip>
          </div>
        </ApprovalCard>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex flex-col bg-[#0B0B0D] text-white"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center gap-2 px-3 py-3 border-b border-white/10">
        <button type="button" aria-label="Back" onClick={onClose} className="p-2 bg-transparent border-0 text-white">
          <ArrowLeft size={20} />
        </button>
        <span className="text-[17px] font-bold">Get your own edition</span>
      </div>
      <div className="flex gap-2 px-4 pt-3">
        {(
          [
            ['order', 'Order'],
            ['mine', 'My editions'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className="rounded-full px-4 py-2 text-[14px] font-semibold border-0"
            style={{
              background: tab === id ? 'var(--bw-accent)' : '#17191E',
              color: tab === id ? '#0B0B0D' : '#fff',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-24">
        {closed && (
          <div
            className="rounded-xl p-3 mb-4 text-[14px]"
            style={{ background: '#17191E', border: '1px solid var(--bw-accent)' }}
          >
            <b>Orders open soon.</b> You can fill this in now; paying opens when we&apos;re ready.
          </div>
        )}
        {pay.k === 'done' && (
          <div
            className="rounded-xl p-3 mb-4 text-[14px]"
            style={{ background: '#17191E', border: '1px solid #2E7D4F' }}
          >
            <b>Paid. Thank you.</b> {pay.order.slug} is in the queue; we&apos;ll build it and it shows here as it moves
            to Live.
          </div>
        )}
        {pay.k === 'error' && !pay.quote && (
          <div className="rounded-xl p-3 mb-4 text-[14px] text-red-300" style={{ background: '#2A1414' }}>
            {pay.msg}
          </div>
        )}

        {tab === 'order' ? (
          <>
            <p className="m-0 mb-4 text-[14px] text-gray-300">
              Your own bWalletX theme: your colours and art, at bwalletx.com/themes/your-name, for{' '}
              <b>${PRICE_USD} a year</b>.
            </p>
            <Field label="Edition name" error={show('name')}>
              <input
                className={inputCls}
                value={form.name}
                maxLength={40}
                placeholder="Vex Void"
                onChange={(e) => {
                  set('name', e.target.value);
                  if (!slugTouched) set('slug', toSlug(e.target.value));
                }}
              />
            </Field>
            <Field label="Web address" error={show('slug')} hint={form.slug ? previewUrl(form.slug) : undefined}>
              <input
                className={inputCls}
                value={form.slug}
                maxLength={32}
                placeholder="vex-void"
                autoCapitalize="none"
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                }}
              />
            </Field>
            <Field label="Artist or brand name" error={show('brand')}>
              <input
                className={inputCls}
                value={form.brand}
                maxLength={60}
                onChange={(e) => set('brand', e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 mb-4 text-[14px]">
              <input type="checkbox" checked={form.isBrand} onChange={(e) => set('isBrand', e.target.checked)} />
              This is a brand or company
            </label>
            <Field label="Website or social link" error={show('link')}>
              <input
                className={inputCls}
                value={form.link}
                inputMode="url"
                autoCapitalize="none"
                placeholder="https://x.com/yourname"
                onChange={(e) => set('link', e.target.value)}
              />
            </Field>
            <Field label="Colours (2 or 3)" error={show('colours')}>
              <div className="flex items-center gap-3">
                {form.colours.map((c, i) => (
                  <span key={i} className="relative">
                    <input
                      type="color"
                      aria-label={`Colour ${i + 1}`}
                      value={c}
                      onChange={(e) =>
                        set(
                          'colours',
                          form.colours.map((x, j) => (j === i ? e.target.value : x)),
                        )
                      }
                      className="h-11 w-11 rounded-xl border border-white/20 bg-transparent p-0"
                    />
                    {form.colours.length > 2 && i === 2 && (
                      <button
                        type="button"
                        aria-label="Remove colour"
                        onClick={() => set('colours', form.colours.slice(0, 2))}
                        className="absolute -top-2 -right-2 rounded-full bg-black border border-white/20 p-0.5 text-white"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {form.colours.length < 3 && (
                  <button
                    type="button"
                    aria-label="Add a colour"
                    onClick={() => set('colours', [...form.colours, '#ffffff'])}
                    className="h-11 w-11 rounded-xl border border-dashed border-white/30 bg-transparent text-white flex items-center justify-center"
                  >
                    <Plus size={18} />
                  </button>
                )}
              </div>
            </Field>
            <Field label="Logo or art (PNG, JPG or SVG; 2 MB each; up to 4)" error={show('files')}>
              <div className="flex flex-wrap gap-2">
                {files.map((x, i) => (
                  <span
                    key={`${x.name}-${i}`}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px]"
                    style={{ background: '#17191E', color: fileError(x) ? '#f87171' : '#fff' }}
                  >
                    {x.name.slice(0, 24)}
                    <button
                      type="button"
                      aria-label={`Remove ${x.name}`}
                      onClick={() => removeFile(i)}
                      className="bg-transparent border-0 text-white p-0"
                    >
                      <X size={14} />
                    </button>
                  </span>
                ))}
                {files.length < MAX_FILES && (
                  <span className="relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] border border-dashed border-white/30">
                    <ImagePlus size={14} /> Add files
                    <input
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,image/svg+xml"
                      aria-label="Add logo or art files"
                      className="absolute inset-0 opacity-0"
                      onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </span>
                )}
              </div>
            </Field>
            <Field
              label={form.isBrand ? 'Brand ownership proof' : 'Verified identity (optional)'}
              error={show('proof')}
              hint="One of your verified names: signed in with X (name.x) or your handle."
            >
              <select className={inputCls} value={form.proof} onChange={(e) => set('proof', e.target.value)}>
                <option value="">{names.length ? 'Pick one…' : 'No verified names on this wallet yet'}</option>
                {names
                  .filter((n) => n.kind !== 'gmail')
                  .map((n) => {
                    const alias = n.paymail.split('@')[0];
                    return (
                      <option key={n.paymail} value={alias}>
                        {n.kind === 'x' ? `${alias} · signed in with X` : `$${alias} · your handle`}
                      </option>
                    );
                  })}
              </select>
            </Field>
            <Field label="Note (optional)" error={show('note')}>
              <textarea
                className={inputCls}
                rows={3}
                maxLength={500}
                value={form.note}
                onChange={(e) => set('note', e.target.value)}
                placeholder="Anything we should know"
              />
            </Field>

            <div className="rounded-xl p-3 mb-4 text-[13px] text-gray-300" style={{ background: '#17191E' }}>
              <b className="text-white">Rules</b>
              <ul className="m-0 mt-1 pl-4">
                <li>Brand owner only: order a brand only if it&apos;s yours.</li>
                <li>Every edition says &quot;Powered by bWalletX&quot;.</li>
                <li>We may decline impersonation or anyone else&apos;s brand.</li>
                <li>Declined orders are refunded by hand, in BSV, to this wallet.</li>
              </ul>
            </div>

            <button
              type="button"
              onClick={() => void startOrder()}
              disabled={pay.k === 'quoting' || closed}
              className="w-full rounded-full py-3.5 text-[16px] font-bold border-0"
              style={{
                background: 'var(--bw-accent)',
                color: '#0B0B0D',
                opacity: pay.k === 'quoting' || closed ? 0.6 : 1,
              }}
            >
              {closed ? 'Orders open soon' : pay.k === 'quoting' ? pay.step : `Continue · $${PRICE_USD} a year`}
            </button>
          </>
        ) : (
          <>
            {orders === null && <p className="text-gray-400 text-[14px]">Loading…</p>}
            {loadErr && <p className="text-red-300 text-[14px]">{loadErr}</p>}
            {orders !== null && !editions.length && !loadErr && (
              <p className="text-gray-400 text-[14px]">No editions yet. Order one on the Order tab.</p>
            )}
            {editions.map((e) => (
              <div key={e.slug} className="rounded-xl p-3 mb-3" style={{ background: '#17191E' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-semibold">{e.name}</span>
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: e.status === 'live' ? '#4ADE80' : 'var(--bw-accent)' }}
                  >
                    {STATUS_LABEL[e.status]}
                  </span>
                </div>
                <div className="text-[12px] text-gray-400 mt-0.5">
                  bwalletx.com/themes/{e.slug}
                  {e.expires ? ` · until ${fmtDate(e.expires)}` : ''}
                </div>
                <div className="flex gap-2 mt-2.5">
                  {e.status === 'live' && (
                    <a
                      href={previewUrl(e.slug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold no-underline"
                      style={{ background: 'var(--bw-accent)', color: '#0B0B0D' }}
                    >
                      Preview <ExternalLink size={12} />
                    </a>
                  )}
                  {e.status !== 'declined' && (
                    <button
                      type="button"
                      disabled={closed || pay.k === 'quoting'}
                      onClick={() => void startRenew(e.slug, e.name)}
                      className="rounded-full px-3 py-1.5 text-[13px] font-semibold border border-white/20 bg-transparent text-white"
                    >
                      Renew · ${PRICE_USD}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
