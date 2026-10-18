/**
 * bTrust (/m/btrust): shared keys, passing on, important papers. Everything here runs on the device:
 * no key material is logged, stored by us or sent to a server. See slices.ts, inheritance.ts, papers.ts.
 *
 * Step 1 Recovery slices: protect a secret (e.g. your recovery phrase) as 2-of-3 (or n-of-m) cards.
 * Step 2 Passing on: build a timelocked inheritance plan (owner any time, 2 of 3 heirs later, lead heir later still).
 * Step 3 Important papers: seal documents with the same trust key, so heirs open them with the slices.
 */
import { useEffect, useState } from 'react';
import * as qr from 'qrcode';
import type { PrivateKey } from '@bsv/sdk';
import { Utils } from '@bsv/sdk';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { makeSlices, restoreKey, restoreSecret, slicesForKey, type SliceCard } from './slices';
import { openPaper, parsePaper, sealPaper } from './papers';
import {
  BTRUST_PROTOCOL,
  blocksForMonths,
  inheritanceLock,
  planStatus,
  validatePlan,
  type InheritancePlan,
} from './inheritance';
import { BTRUST_CHECKLIST } from './checklist';
import { CheckInPanel } from './CheckInPanel';
import { HeirClaimPanel } from './HeirClaimPanel';
import { FundPanel } from './FundPanel';
import { CopyButton } from './CopyButton';
import { RestoreBoxes } from './RestoreBoxes';
import { planFileName, planJson, planLabel } from './planFile';
import { btrustTestMode, TEST_BANNER } from './testMode';
import { nextOwnerSlot } from './fund';
import { wocChain } from './derive';

const GOLD = '#F5B800';
const TEST_TIMINGS = btrustTestMode();
const MUTED = '#98A2B3';
const CARD = 'rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2';
const INPUT = 'w-full rounded-xl bg-[#0f1115] border border-[#2b2f36] p-2 text-white text-sm';
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold border-0 cursor-pointer';

const download = (name: string, text: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const SliceView = ({ card }: { card: SliceCard }) => {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void qr.toDataURL(card.text, { errorCorrectionLevel: 'M', margin: 1, width: 240 }).then(setSrc, () => setSrc(''));
  }, [card.text]);
  return (
    <div className={CARD} style={{ borderColor: GOLD }}>
      <div className="text-white font-bold">
        bTrust slice {card.index} of {card.total} · set {card.setId}
      </div>
      <p className="m-0 text-xs" style={{ color: MUTED }}>
        Any {card.threshold} slices restore it. Give this one to one person. On its own it reveals nothing.
      </p>
      {src ? (
        <img src={src} alt={`QR for slice ${card.index}`} className="self-center bg-white rounded-lg" width={200} />
      ) : (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          This slice is too long for one QR code. Use Copy or Save instead.
        </p>
      )}
      <textarea readOnly className={INPUT} rows={3} value={card.text} aria-label={`Slice ${card.index} text`} />
      <div className="flex gap-2 flex-wrap">
        <CopyButton text={card.text} secret />
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button
            type="button"
            className="rounded-xl px-3 py-2 text-sm font-bold border cursor-pointer"
            style={{ background: 'transparent', color: GOLD, borderColor: GOLD }}
            onClick={() =>
              void navigator
                .share({ title: `bTrust slice ${card.index} of ${card.total}`, text: card.text })
                .catch(() => undefined)
            }
          >
            Share
          </button>
        )}
        <button
          type="button"
          className={BTN + ' flex-1'}
          style={{ background: GOLD }}
          onClick={() => download(`btrust-slice-${card.setId}-${card.index}.txt`, card.text, 'text/plain')}
        >
          Save slice {card.index}
        </button>
      </div>
    </div>
  );
};

const Step = ({ n, title, children, id }: { n: number; title: string; children: React.ReactNode; id?: string }) => (
  <section className={CARD} id={id}>
    <h2 className="m-0 text-white text-base">
      <span style={{ color: GOLD }}>{n}.</span> {title}
    </h2>
    {children}
  </section>
);

export const TestBanner = () => (
  <div
    role="alert"
    className="rounded-2xl p-4 text-center text-lg font-extrabold text-white"
    style={{ background: '#D92D20' }}
  >
    {TEST_BANNER}
  </div>
);

export const BTrustPage = () => {
  const { apiContext } = useServiceContext();
  const [secret, setSecret] = useState('');
  const [threshold, setThreshold] = useState(2);
  const [total, setTotal] = useState(3);
  const [cards, setCards] = useState<SliceCard[]>([]);
  const [trustKey, setTrustKey] = useState<PrivateKey | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState('');
  const [error, setError] = useState('');

  const [height, setHeight] = useState(0);
  const [ownerPub, setOwnerPub] = useState('');
  const [heirs, setHeirs] = useState([0, 1, 2].map(() => ({ name: '', paymail: '', pubKey: '' })));
  const [months, setMonths] = useState(12);
  const [plan, setPlan] = useState<InheritancePlan | null>(null);
  const [slot, setSlot] = useState(0);
  const [paperMsg, setPaperMsg] = useState('');

  useEffect(() => {
    void apiContext.services?.chaintracks
      .currentHeight()
      .then(setHeight)
      .catch(() => setHeight(0));
    // Seed-derived owner key: the same seed always gives the same key, so no server copy is needed.
    void apiContext.wallet
      .getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID: 'owner', counterparty: 'self' })
      .then((r) => setOwnerPub(r.publicKey))
      .catch(() => setOwnerPub(''));
  }, [apiContext]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong');

  const makeCards = () => {
    setError('');
    try {
      const bytes = Utils.toArray(secret, 'utf8');
      if (trustKey) setCards(slicesForKey(trustKey, bytes, threshold, total));
      else {
        const r = makeSlices(bytes, threshold, total);
        setCards(r.cards);
        setTrustKey(r.trustKey);
      }
      setSecret('');
    } catch (e) {
      fail(e);
    }
  };

  const doRestore = (texts: string[]) => {
    setError('');
    try {
      setRestored(Utils.toUTF8(restoreSecret(texts)));
      setTrustKey(restoreKey(texts).trustKey);
    } catch (e) {
      fail(e);
    }
  };

  const buildPlan = async () => {
    setError('');
    try {
      if (!ownerPub) throw new Error('Your wallet key is not ready yet');
      if (!height) throw new Error('Waiting for the current block height');
      // Each lock gets its own owner key: the next slot the seed-only scan has not seen (derive.ts).
      const next = await nextOwnerSlot(apiContext.wallet, wocChain());
      // ?btrust-test: tiny real-money test timings (heirs after 3 blocks, lead heir 3 blocks later).
      const heirsHeight = TEST_TIMINGS ? height + 3 : height + blocksForMonths(months);
      const p = validatePlan({
        v: 1,
        ownerPubKey: next.ownerPubKey,
        heirs: heirs.map((h) => ({
          name: h.name.trim(),
          pubKey: h.pubKey.trim(),
          ...(h.paymail.trim() ? { paymail: h.paymail.trim() } : {}),
        })),
        heirsHeight,
        leadHeight: heirsHeight + (TEST_TIMINGS ? 3 : blocksForMonths(6)),
        ...(TEST_TIMINGS ? { test: true as const } : {}),
      });
      inheritanceLock(p);
      setSlot(next.slot);
      setPlan(p);
    } catch (e) {
      fail(e);
    }
  };

  const onPaper = async (f: File | undefined, mode: 'seal' | 'open') => {
    setError('');
    setPaperMsg('');
    if (!f) return;
    try {
      if (!trustKey) throw new Error('Make or restore slices first: papers use the same key');
      if (mode === 'seal') {
        const sealed = sealPaper(trustKey, {
          name: f.name,
          type: f.type,
          bytes: new Uint8Array(await f.arrayBuffer()),
        });
        download(`${f.name}.btrust.json`, JSON.stringify(sealed));
        setPaperMsg(`Sealed. Fingerprint (SHA-256): ${sealed.sha256}`);
      } else {
        const paper = parsePaper(await f.text());
        const bytes = openPaper(trustKey, paper);
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: paper.type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = paper.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setPaperMsg(`Opened ${paper.name}.`);
      }
    } catch (e) {
      fail(e);
    }
  };

  return (
    // Own scroll container inside the app shell (as StockPage): the document never scrolls, so the tab bar stays
    // put. Top padding = the fixed TopNav (h-14); bottom = the tab bar / dock (--dock-h), as BMailPage.
    <div
      className="w-full h-full overflow-y-auto"
      style={{ paddingTop: '3.5rem', paddingBottom: 'calc(var(--dock-h, 3.75rem) + 1.5rem)' }}
    >
      <TopNav />
      <div className="w-full max-w-2xl mx-auto px-4 pt-3 flex flex-col gap-3">
        {TEST_TIMINGS && <TestBanner />}
        <header className="flex flex-col gap-1">
          <h1 className="m-0 text-white text-xl">bTrust</h1>
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Shared keys, passing on, important papers. Everything stays on this device. We never hold a copy.
          </p>
        </header>
        <button
          type="button"
          className="w-full rounded-2xl px-4 py-4 text-base font-extrabold border-0 cursor-pointer"
          style={{ background: GOLD }}
          onClick={() =>
            document.getElementById('btrust-claim')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          Claim an inheritance
        </button>
        {error && (
          <p role="alert" className="m-0 text-sm" style={{ color: '#F97066' }}>
            {error}
          </p>
        )}

        <Step n={1} title="Recovery slices">
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Type a secret you never want to lose, such as your recovery phrase. We lock it and cut the key into slices.
            Give each slice to a different person. Any {threshold} of them bring it back.
          </p>
          <textarea
            className={INPUT}
            rows={3}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Your secret"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2 items-center text-sm text-white">
            Need
            <input
              type="number"
              className={INPUT}
              style={{ width: 64 }}
              min={2}
              max={total}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              aria-label="Slices needed"
            />
            of
            <input
              type="number"
              className={INPUT}
              style={{ width: 64 }}
              min={threshold}
              max={16}
              value={total}
              onChange={(e) => setTotal(Number(e.target.value))}
              aria-label="Total slices"
            />
          </div>
          <button type="button" className={BTN} style={{ background: GOLD }} disabled={!secret} onClick={makeCards}>
            Make slices
          </button>
          {cards.map((c) => (
            <SliceView key={`${c.setId}-${c.index}`} card={c} />
          ))}
          <button
            type="button"
            className="w-full rounded-xl px-3 py-3 text-base font-bold border cursor-pointer flex items-center justify-center gap-2"
            style={{ background: 'transparent', color: GOLD, borderColor: GOLD }}
            aria-expanded={restoring}
            onClick={() => setRestoring(!restoring)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
            {restoring ? 'Close restore' : 'Restore from slices'}
          </button>
          {restoring && <RestoreBoxes onRestore={doRestore} />}
          {restored && (
            <div className="flex flex-col gap-1">
              <textarea readOnly className={INPUT} rows={3} value={restored} aria-label="Restored secret" />
              <CopyButton text={restored} secret />
            </div>
          )}
        </Step>

        <Step n={2} title="Passing on">
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Name three people. The coins stay yours and you can move them any time. If you have not checked in by the
            date you pick, any two of them can claim together. Six months later the first person can claim alone.
          </p>
          {heirs.map((h, i) => (
            <div key={i} className="flex flex-col gap-1">
              <input
                className={INPUT}
                placeholder={i === 0 ? 'Lead heir name' : `Heir ${i + 1} name`}
                value={h.name}
                onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className={INPUT}
                placeholder="Paymail (optional)"
                value={h.paymail}
                onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, paymail: e.target.value } : x)))}
              />
              <input
                className={INPUT}
                placeholder="Their public key (02… or 03…)"
                value={h.pubKey}
                spellCheck={false}
                onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, pubKey: e.target.value } : x)))}
              />
            </div>
          ))}
          <label className="text-sm text-white flex gap-2 items-center">
            Heirs can claim after
            <input
              type="number"
              className={INPUT}
              min={1}
              max={120}
              value={months}
              disabled={TEST_TIMINGS}
              style={{ width: 72, opacity: TEST_TIMINGS ? 0.4 : 1 }}
              onChange={(e) => setMonths(Number(e.target.value))}
            />
            {TEST_TIMINGS ? 'months (test mode: 3 blocks, about 30 min)' : 'months without a check-in'}
          </label>
          <button type="button" className={BTN} style={{ background: GOLD }} onClick={() => void buildPlan()}>
            Build plan
          </button>
          {plan && (
            <div className="flex flex-col gap-1 text-sm text-white">
              <span className="font-bold" style={{ color: GOLD }}>
                {planLabel(plan)}
              </span>
              <span>{planStatus(plan, height)}</span>
              <span style={{ color: MUTED }}>
                Heirs from block {plan.heirsHeight.toLocaleString('en-GB')}, lead heir alone from block{' '}
                {plan.leadHeight.toLocaleString('en-GB')}.
              </span>
              <button
                type="button"
                className={BTN}
                style={{ background: GOLD }}
                onClick={() => download(planFileName(plan), planJson(plan))}
              >
                Save plan (give a copy to each heir)
              </button>
              <FundPanel plan={plan} slot={slot} height={height} download={download} onFunded={setPlan} />
            </div>
          )}
        </Step>

        <Step n={3} title="Important papers">
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Seal a will, deeds or instructions with the same key as your slices. Keep the sealed file anywhere. Your
            heirs open it with their slices.
          </p>
          <label className="text-sm text-white">
            Seal a paper <input type="file" onChange={(e) => void onPaper(e.target.files?.[0], 'seal')} />
          </label>
          <label className="text-sm text-white">
            Open a sealed paper{' '}
            <input type="file" accept=".json" onChange={(e) => void onPaper(e.target.files?.[0], 'open')} />
          </label>
          {paperMsg && (
            <p className="m-0 text-xs break-all" style={{ color: MUTED }}>
              {paperMsg}
            </p>
          )}
        </Step>

        <Step n={4} title="Check in">
          {plan ? (
            <CheckInPanel plan={plan} height={height} months={months} onPreview={setPlan} />
          ) : (
            <p className="m-0 text-sm" style={{ color: MUTED }}>
              Build a plan in step 2 first. Then check in now and then to keep the coins yours.
            </p>
          )}
        </Step>

        <Step n={5} title="For heirs: claim" id="btrust-claim">
          <HeirClaimPanel height={height} />
        </Step>

        <section className={CARD} aria-label="Status">
          <h2 className="m-0 text-white text-base">Status</h2>
          <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
            {BTRUST_CHECKLIST.map((c) => (
              <li key={c.label} style={{ color: c.live ? '#fff' : MUTED }}>
                {c.live ? '✓ Live' : '○ Coming'} · {c.label}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

export default BTrustPage;
