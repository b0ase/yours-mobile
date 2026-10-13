import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listOpns, sendBsv } from '@1sat/actions';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { fetchExchangeRate } from '../../utils/wallet';
import { moneyNow, usdToSats } from '../money/money';
import { ownedFromOutputs } from './accountName';
import { NODE_SCRIPT_ESTIMATE, PHONE_HASHRATE } from './GetYourName';
import {
  checkNames,
  loadBatch,
  mintParam,
  newBatch,
  OPNS_FEE_ADDRESS,
  OPNS_FEE_USD_PER_NAME,
  orderForMinting,
  parseNameList,
  planBatch,
  remaining,
  runBatch,
  saveBatch,
  serviceFeeUsd,
  summarise,
  type BatchState,
  type PlannedName,
} from './opnsBatch';
import { formatEta, mineName } from './opnsRegister';

/**
 * /opns-mint (Desktop / web: desktop.bwalletx.com/opns-mint): "Mint a list" of OpNS names from this wallet.
 * Type or upload a .txt list (or open with ?mint=a,b,c), check it live, approve ONE sheet with the total,
 * then the names are mined one after another with the normal mint path. The queue is saved, so closing
 * the window and coming back offers Resume. See opnsBatch.ts.
 */
const f = (u: string, i?: RequestInit) => fetch(u, i);

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  mining: 'Mining…',
  done: 'Minted',
  skipped: 'Skipped',
  mine: 'Already yours',
  error: 'Error',
};

export const OpnsMintPage = () => {
  const { theme } = useTheme();
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [text, setText] = useState(() => mintParam(window.location.search));
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<PlannedName[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [batch, setBatch] = useState<BatchState | null>(() => loadBatch(identityAddress));
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const abort = useRef<AbortController | null>(null);
  const ownedRef = useRef(owned);
  ownedRef.current = owned;

  const parsed = useMemo(() => parseNameList(text), [text]);
  const summary = plan ? summarise(plan, NODE_SCRIPT_ESTIMATE, PHONE_HASHRATE) : null;
  const feeUsd = summary ? serviceFeeUsd(summary.toMint) : 0;

  const refreshOwned = async () => {
    if (!apiContext) return ownedRef.current;
    try {
      const r = await listOpns.execute(apiContext, { includeTags: true, limit: 1000 });
      const s = new Set(ownedFromOutputs(r.outputs).map((o) => o.name));
      setOwned(s);
      ownedRef.current = s;
      return s;
    } catch {
      return ownedRef.current;
    }
  };
  useEffect(() => {
    void refreshOwned();
    setBatch(loadBatch(identityAddress));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiContext, identityAddress]);
  useEffect(() => () => abort.current?.abort(), []);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const body = await file.text();
    setText((t) => (t.trim() ? `${t.trim()}\n${body}` : body));
    setPlan(null);
  };

  const check = async () => {
    setChecking(true);
    setMsg('');
    try {
      const mine = await refreshOwned();
      const checks = await checkNames(f, orderForMinting(parsed.names), (n) => mine.has(n));
      setPlan(planBatch(checks));
    } catch {
      setMsg('Lookup failed. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  };

  const payFee = OPNS_FEE_ADDRESS
    ? async () => {
        const sats = usdToSats(OPNS_FEE_USD_PER_NAME, await fetchExchangeRate('main'));
        if (!sats) throw new Error("Couldn't get the BSV price for the service fee. Resume in a minute.");
        const res = await sendBsv.execute(apiContext, { requests: [{ address: OPNS_FEE_ADDRESS, satoshis: sats }] });
        if (res.error || !res.txid) throw new Error(String(res.error ?? 'Service fee payment failed'));
        return res.txid;
      }
    : undefined;

  const run = async (start: BatchState) => {
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setMsg('');
    try {
      const r = await runBatch(
        {
          fetch: f,
          mine: (name, signal) => mineName({ ctx: apiContext, fetch: f }, name, signal, () => undefined),
          payFee,
          isMine: (n) => ownedRef.current.has(n),
          save: (s) => saveBatch(identityAddress, s),
          onUpdate: setBatch,
        },
        start,
        ctl.signal,
      );
      if (r.stopped === 'error') setMsg(`Stopped: ${r.error}. Fix it, then Resume.`);
      else if (r.stopped === 'cancelled') setMsg('Paused. Characters already mined stay yours; Resume any time.');
      else setMsg('All done. New names show under Names you own once indexed.');
      void refreshOwned();
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  const approve = () => {
    if (!plan || !summary) return;
    setSheet(false);
    const b = newBatch(plan, summary.feeSats);
    saveBatch(identityAddress, b);
    setBatch(b);
    void run(b);
  };

  const fg = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const row = theme.color.global.row;
  const gold = '#FFD24D';
  const btn = 'px-3 py-1.5 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';
  const left = remaining(batch);
  const totalLabel = summary ? `${moneyNow(summary.feeSats)}${feeUsd ? ` + $${feeUsd} service fee` : ''}` : '';

  return (
    <div className="w-full max-w-2xl mx-auto p-4 flex flex-col gap-3">
      <h1 className="text-lg font-semibold m-0" style={{ color: fg }}>
        Mint a list of names
      </h1>
      <p className="text-xs m-0" style={{ color: gray }}>
        On-chain OpNS names, mined on this device and locked to this wallet. You pay network fees only
        {OPNS_FEE_ADDRESS ? ` plus a $${OPNS_FEE_USD_PER_NAME} service fee per name` : ''}.
      </p>

      {batch && batch.items.length > 0 && (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: row }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold" style={{ color: fg }}>
              {left ? `${left} of ${batch.items.length} names to go` : `${batch.items.length} names processed`}
            </span>
            <span className="flex gap-2">
              {running ? (
                <button type="button" className={btn} onClick={() => abort.current?.abort()}>
                  Pause
                </button>
              ) : left ? (
                <button
                  type="button"
                  className={btn}
                  style={{ background: gold, color: '#000' }}
                  onClick={() => void run(batch)}
                >
                  Resume
                </button>
              ) : null}
              {!running && (
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    saveBatch(identityAddress, null);
                    setBatch(null);
                  }}
                >
                  Clear
                </button>
              )}
            </span>
          </div>
          {batch.items.map((it) => (
            <div key={it.name} className="flex items-center justify-between gap-2 text-xs">
              <span style={{ color: fg }}>{it.name}</span>
              <span className="flex flex-col items-end" style={{ color: it.status === 'done' ? '#2ecc71' : gray }}>
                <span>
                  {STATUS_LABEL[it.status]}
                  {it.note ? ` · ${it.note}` : ''}
                </span>
                {it.txids.map((t) => (
                  <a
                    key={t}
                    href={`https://whatsonchain.com/tx/${t}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: gold }}
                  >
                    {t.slice(0, 10)}…
                  </a>
                ))}
              </span>
            </div>
          ))}
          <p className="text-[10px] m-0" style={{ color: gray }}>
            Keep this window open while mining. If it closes, come back here and tap Resume.
          </p>
        </div>
      )}

      {!running && (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: row }}>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPlan(null);
            }}
            rows={8}
            placeholder={'One name per line, or separated by commas\nname-one\nname-two'}
            aria-label="Names to mint"
            className="w-full rounded-lg p-2 text-xs bg-transparent outline-none font-mono"
            style={{ color: fg, border: '1px solid #3a2f0c' }}
          />
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs cursor-pointer" style={{ color: gold }}>
              Upload a .txt list
              <input
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className={btn}
              style={{ background: gold, color: '#000' }}
              disabled={checking || !parsed.names.length}
              onClick={() => void check()}
            >
              {checking ? 'Checking…' : `Check ${parsed.names.length} name${parsed.names.length === 1 ? '' : 's'}`}
            </button>
          </div>
          {parsed.invalid.length > 0 && (
            <p className="text-[11px] m-0" style={{ color: '#ff4444' }}>
              Not valid (a-z, 0-9 and - only), left out: {parsed.invalid.join(', ')}
            </p>
          )}
        </div>
      )}

      {plan && summary && !running && (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: row }}>
          {plan.map((p) => (
            <div key={p.name} className="flex items-center justify-between text-xs">
              <span style={{ color: fg }}>{p.name}</span>
              <span style={{ color: p.state === 'free' ? '#2ecc71' : gray }}>
                {p.state === 'taken'
                  ? 'Taken'
                  : p.state === 'mine'
                    ? 'Already yours'
                    : p.domain === null
                      ? 'Free, but no tree node found; try later'
                      : `Free · ${p.chars} char${p.chars === 1 ? '' : 's'} from "${p.from || '(root)'}"`}
              </span>
            </div>
          ))}
          <p className="text-xs m-0" style={{ color: fg }}>
            {summary.toMint} names · {summary.chars} transactions · ~{totalLabel} · {formatEta(summary.seconds)} of
            mining
          </p>
          <button
            type="button"
            className={`self-start ${btn}`}
            style={{ background: gold, color: '#000' }}
            disabled={!summary.toMint || !apiContext}
            onClick={() => setSheet(true)}
          >
            Mint {summary.toMint} name{summary.toMint === 1 ? '' : 's'}
          </button>
        </div>
      )}

      {msg && (
        <p className="text-xs m-0" style={{ color: gray }}>
          {msg}
        </p>
      )}

      {sheet &&
        summary &&
        plan &&
        createPortal(
          <div
            className="fixed inset-0 z-[420] flex flex-col"
            style={{
              background: CARD.bg,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <ApprovalCard
              ours
              site="bWalletX"
              siteSub="OpNS names"
              onClose={() => setSheet(false)}
              hero={
                <PayHero
                  amount={`~${moneyNow(summary.feeSats)}`}
                  sub={feeUsd ? `+ $${feeUsd} service fee` : 'network fees'}
                />
              }
              title={
                <>
                  Mint <span style={{ color: CARD.gold }}>{summary.toMint}</span> names
                </>
              }
              primary={{ label: 'Allow', onClick: approve }}
              secondary={{ label: 'Not now', onClick: () => setSheet(false) }}
            >
              <div className="flex flex-wrap gap-2">
                {plan
                  .filter((p) => p.state === 'free' && p.chars > 0)
                  .map((p) => (
                    <Chip key={p.name}>{p.name}</Chip>
                  ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip>{summary.chars} transactions</Chip>
                <Chip>{formatEta(summary.seconds)}</Chip>
                <Chip>Locked to your wallet</Chip>
              </div>
            </ApprovalCard>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default OpnsMintPage;
