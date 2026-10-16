import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { P2PKH } from '@bsv/sdk';
import { sendBsv, sendBsv21 } from '@1sat/actions';
import { ArrowLeft, Download, Gift, RotateCcw } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { SendConfirmation, type SendLineItem } from '../../components/SendConfirmation';
import { normalize } from '../../utils/format';
import { getErrorMessage } from '../../utils/tools';
import { useBackClose } from '../backStack';
import { NoteField } from '../airdrops/NoteField';
import { cleanNote, noteOutput, withExtraOutput } from '../airdrops/note';
import { saveTextFile } from '../agents/saveText';
import { maxOverlayFee, withTokenSendGuard } from '../wallet/send/tokenFee';
import {
  DEFAULT_BATCH,
  MAX_BATCH,
  allocateFixed,
  allocateProRata,
  fetchHolders,
  filterHolders,
  formatUnits,
  interruptedBatch,
  isDone,
  makePlan,
  nextBatch,
  normTokenId,
  parsePlan,
  previewDrop,
  receiptCsv,
  recordBatch,
  sentCount,
  serializePlan,
  startBatch,
  type DropAsset,
  type DropPlan,
  type Holder,
  type SnapshotResult,
} from './holderDrop';

const STORE_KEY = 'bwx.holderdrop.';
const loadPlan = (account: string) => {
  try {
    return parsePlan(localStorage.getItem(STORE_KEY + account));
  } catch {
    return null;
  }
};
const savePlan = (account: string, plan: DropPlan | null) => {
  try {
    if (plan) localStorage.setItem(STORE_KEY + account, serializePlan(plan));
    else localStorage.removeItem(STORE_KEY + account);
  } catch {
    /* storage blocked: progress lives only in memory this session */
  }
};

const toAtomic = (input: string, dec: number): bigint | null => {
  const t = input.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  try {
    const v = BigInt(normalize(t, dec));
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const muted = '#98A2B3';
const card = { background: 'var(--bw-surface)', border: '1px solid #2b2f36' };
const input =
  'w-full min-w-0 rounded-lg bg-[#101114] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none';

/**
 * Airdrop to holders (issuer tools on the token page; bWalletX only, HOLDER_DROP_ENABLED). Snapshot a token's
 * holders, choose a fixed or pro-rata amount of this token or BSV, preview, then send in batches: one approval
 * sheet and one transaction per batch. Progress is kept on the device so an interrupted drop resumes.
 */
export default function HolderDropSheet({
  token,
  heldRaw,
  onClose,
}: {
  token: { id: string; dec: number; symbol: string };
  heldRaw: bigint;
  onClose: () => void;
}) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  useBackClose(true, onClose);
  const addrs = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const account = addrs?.identityAddress ?? 'default';

  const [snapshotId, setSnapshotId] = useState(token.id);
  const [assetKind, setAssetKind] = useState<'token' | 'bsv'>('token');
  const [mode, setMode] = useState<'fixed' | 'prorata'>('fixed');
  const [amountIn, setAmountIn] = useState('');
  const [minIn, setMinIn] = useState('');
  const [batchSize, setBatchSize] = useState(String(DEFAULT_BATCH));
  const [note, setNote] = useState('');
  const [snap, setSnap] = useState<{ id: string; raw: Holder[]; dec: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [feePerOutput, setFeePerOutput] = useState<{ address?: string; sats: number }>({ sats: 0 });
  const [plan, setPlan] = useState<DropPlan | null>(() => loadPlan(account));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ index: number; lineItems: SendLineItem[]; total: string } | null>(null);

  const asset: DropAsset = assetKind === 'bsv' ? { kind: 'bsv' } : { kind: 'token', tokenId: token.id, ...token };
  const assetDec = assetKind === 'bsv' ? 8 : token.dec;
  const unit = assetKind === 'bsv' ? 'BSV' : token.symbol;
  const satsPerKb = chromeStorageService.getCustomFeeRate();

  // The indexer's per-output fee for token drops (sendBsv21 pays it in every batch).
  useEffect(() => {
    const bsv21 = apiContext.services?.bsv21;
    if (!bsv21) return;
    bsv21
      .getTokenDetails(token.id, { fresh: true })
      .then((d) => setFeePerOutput({ address: d.status?.fee_address, sats: d.status?.fee_per_output ?? 0 }))
      .catch(() => undefined);
  }, [apiContext.services, token.id]);

  const takeSnapshot = async () => {
    const id = normTokenId(snapshotId);
    if (!id) return setMsg('Enter a BSV-21 token ID (txid_vout), not a ticker.');
    setLoading(true);
    setMsg('');
    try {
      const raw = await fetchHolders((u) => fetch(u), id);
      let dec = token.dec;
      if (id !== normTokenId(token.id)) {
        const r = await fetch(`https://ordinals.gorillapool.io/api/bsv20/id/${id}`);
        const j = r.ok ? ((await r.json()) as { dec?: number }) : {};
        dec = typeof j.dec === 'number' ? j.dec : 0;
      }
      setSnap({ id, raw, dec });
    } catch (e) {
      setMsg(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const filtered: SnapshotResult | null = useMemo(() => {
    if (!snap) return null;
    const minHolding = minIn.trim() ? (toAtomic(minIn, snap.dec) ?? undefined) : undefined;
    return filterHolders(snap.raw, {
      exclude: [addrs?.ordAddress, addrs?.bsvAddress, addrs?.identityAddress].filter((a): a is string => !!a),
      minHolding,
    });
  }, [snap, minIn, addrs?.ordAddress, addrs?.bsvAddress, addrs?.identityAddress]);

  const amount = toAtomic(amountIn, assetDec);
  const size = Math.max(1, Math.min(MAX_BATCH, parseInt(batchSize, 10) || DEFAULT_BATCH));
  const draft = useMemo(() => {
    if (!filtered || !amount) return null;
    try {
      const recipients =
        mode === 'fixed' ? allocateFixed(filtered.holders, amount) : allocateProRata(filtered.holders, amount, 1n);
      const preview = previewDrop(recipients, asset, { batchSize: size, satsPerKb, feePerOutput: feePerOutput.sats });
      return { recipients, preview };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, amount, mode, assetKind, size, satsPerKb, feePerOutput.sats]);

  const overBalance = !!draft && assetKind === 'token' && draft.preview.total > heldRaw;
  const noteBad = !!note.trim() && !cleanNote(note);

  const startDrop = () => {
    if (!draft || !snap || !draft.recipients.length) return;
    const text = cleanNote(note) ?? undefined;
    const p = makePlan({
      id: `${Date.now()}`,
      createdAt: Date.now(),
      snapshotTokenId: snap.id,
      asset,
      mode,
      note: text,
      recipients: draft.recipients,
      batchSize: size,
    });
    setPlan(p);
    savePlan(account, p);
  };

  const update = (p: DropPlan) => {
    setPlan(p);
    savePlan(account, p);
  };

  // Open the approval sheet for the next batch.
  const reviewNext = () => {
    if (!plan) return;
    const i = nextBatch(plan);
    if (i < 0) return;
    const b = plan.batches[i];
    const dec = plan.asset.kind === 'bsv' ? 8 : plan.asset.dec;
    const u = plan.asset.kind === 'bsv' ? 'BSV' : plan.asset.symbol;
    const lineItems: SendLineItem[] = b.recipients.map((r) => ({
      address: r.address,
      amount: `${formatUnits(r.amount, dec)} ${u}`,
    }));
    const fee =
      plan.asset.kind === 'token' ? maxOverlayFee(feePerOutput.address, feePerOutput.sats, b.recipients.length) : null;
    if (fee) lineItems.push({ address: fee.address, amount: `up to ${fee.sats} sats (indexer fee)` });
    const total = b.recipients.reduce((s, r) => s + r.amount, 0n);
    setConfirm({
      index: i,
      lineItems,
      total: `Batch ${i + 1} of ${plan.batches.length}: ${formatUnits(total, dec)} ${u}`,
    });
  };

  const sendBatch = async (i: number) => {
    if (!plan) return;
    setConfirm(null);
    setBusy(true);
    const b = plan.batches[i];
    let p = startBatch(plan, i);
    update(p);
    try {
      let res: { txid?: string; error?: string };
      if (p.asset.kind === 'token') {
        const fee = maxOverlayFee(feePerOutput.address, feePerOutput.sats, b.recipients.length);
        const guarded = withTokenSendGuard(
          apiContext.wallet,
          fee ? { feeScript: new P2PKH().lock(fee.address).toHex(), maxSats: fee.sats } : null,
        );
        const wallet = p.note ? withExtraOutput(guarded, noteOutput(p.note, p.asset.tokenId)) : guarded;
        res = await sendBsv21.execute(
          { ...apiContext, wallet },
          {
            tokenId: p.asset.tokenId,
            recipients: b.recipients.map((r) => ({ amount: r.amount, destination: { address: r.address } })),
          },
        );
      } else {
        const wallet = p.note ? withExtraOutput(apiContext.wallet, noteOutput(p.note)) : apiContext.wallet;
        res = await sendBsv.execute(
          { ...apiContext, wallet },
          { requests: b.recipients.map((r) => ({ address: r.address, satoshis: Number(r.amount) })) },
        );
      }
      p =
        res.txid && !res.error
          ? recordBatch(p, i, { txid: res.txid })
          : recordBatch(p, i, { error: getErrorMessage(res.error) });
    } catch (e) {
      // A throw can come after the broadcast: leave it marked as started so the issuer checks History first.
      setMsg(`Batch ${i + 1}: ${getErrorMessage(e)} It may have been sent; check History before sending it again.`);
      setBusy(false);
      return;
    }
    update(p);
    setBusy(false);
  };

  const exportCsv = () =>
    plan &&
    void saveTextFile(
      `bwalletx-airdrop-${plan.snapshotTokenId.slice(0, 8)}-${new Date(plan.createdAt).toISOString().slice(0, 10)}.csv`,
      receiptCsv(plan, snap?.id === plan.snapshotTokenId ? snap.dec : token.dec),
      'text/csv;charset=utf-8',
    );

  const stuck = plan ? interruptedBatch(plan) : -1;
  const planDec = plan?.asset.kind === 'bsv' ? 8 : (plan?.asset.dec ?? 0);
  const planUnit = plan?.asset.kind === 'bsv' ? 'BSV' : (plan?.asset.symbol ?? '');
  const planTotal = plan ? plan.batches.reduce((s, b) => s + b.recipients.reduce((t, r) => t + r.amount, 0n), 0n) : 0n;
  const planCount = plan ? plan.batches.reduce((n, b) => n + b.recipients.length, 0) : 0;

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col overflow-y-auto" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={onClose} className="bg-transparent border-0 p-1 cursor-pointer text-white">
          <ArrowLeft size={20} />
        </button>
        <Gift size={18} style={{ color: 'var(--bw-accent)' }} />
        <h2 className="text-base font-bold m-0 text-white">Airdrop to holders</h2>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-10">
        {plan ? (
          <div className="flex flex-col gap-3 rounded-2xl p-4" style={card}>
            <p className="text-sm text-white m-0">
              {formatUnits(planTotal, planDec)} {planUnit} to {planCount} holders of {short(plan.snapshotTokenId)} in{' '}
              {plan.batches.length} batch{plan.batches.length === 1 ? '' : 'es'}.
            </p>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: '#2b2f36' }}>
              <div
                className="h-full"
                style={{
                  width: `${(sentCount(plan) / Math.max(1, planCount)) * 100}%`,
                  background: 'var(--bw-accent)',
                }}
              />
            </div>
            <p className="text-xs m-0" style={{ color: muted }}>
              Sent to {sentCount(plan)} of {planCount}.
            </p>
            {plan.batches.map((b, i) => (
              <div key={i} className="flex items-center justify-between text-xs" style={{ color: muted }}>
                <span>
                  Batch {i + 1} · {b.recipients.length} holders
                </span>
                <span style={{ color: b.txid ? '#75E0A7' : b.error || b.started ? '#FDA29B' : muted }}>
                  {b.txid ? short(b.txid) : b.started ? 'interrupted' : b.error ? 'failed' : 'waiting'}
                </span>
              </div>
            ))}
            {stuck >= 0 && !busy && (
              <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: '#2a1414' }}>
                <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                  Batch {stuck + 1} was interrupted and may have been sent. Check History before you send it again.
                </p>
                <button
                  type="button"
                  className="self-start rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
                  style={{ background: '#3a1f1f', color: '#FDA29B' }}
                  onClick={() => update(recordBatch(plan, stuck, { error: 'Interrupted' }))}
                >
                  It was not sent, let me retry
                </button>
              </div>
            )}
            {msg && (
              <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                {msg}
              </p>
            )}
            {!isDone(plan) && stuck < 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={reviewNext}
                className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer"
                style={{ background: 'var(--bw-accent)', color: '#000', opacity: busy ? 0.5 : 1 }}
              >
                {busy ? 'Sending…' : sentCount(plan) ? `Resume: batch ${nextBatch(plan) + 1}` : 'Review batch 1'}
              </button>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportCsv}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
              >
                <Download size={14} /> Receipt (CSV)
              </button>
              {(isDone(plan) || !sentCount(plan)) && !busy && stuck < 0 && (
                <button
                  type="button"
                  onClick={() => {
                    savePlan(account, null);
                    setPlan(null);
                    setMsg('');
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                  style={{ background: '#1d2026', color: muted }}
                >
                  <RotateCcw size={14} /> {isDone(plan) ? 'New airdrop' : 'Discard'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-2xl p-4" style={card}>
              <label className="text-xs" style={{ color: muted }}>
                Holders of (token ID)
              </label>
              <input
                className={input}
                value={snapshotId}
                onChange={(e) => {
                  setSnapshotId(e.target.value);
                  setSnap(null);
                }}
                spellCheck={false}
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => void takeSnapshot()}
                className="rounded-lg py-2 text-sm font-bold border-0 cursor-pointer"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
              >
                {loading ? 'Loading holders…' : snap ? 'Refresh holders' : 'Load holders'}
              </button>
              {filtered && (
                <p className="text-xs m-0" style={{ color: muted }}>
                  {filtered.holders.length} holders. Left out: you ({filtered.skipped.sender}), burn addresses (
                  {filtered.skipped.burn}), below the minimum ({filtered.skipped.belowMin}), unreadable (
                  {filtered.skipped.invalid + filtered.skipped.empty}).
                </p>
              )}
              <label className="text-xs" style={{ color: muted }}>
                Minimum holding (optional)
              </label>
              <input className={input} inputMode="decimal" value={minIn} onChange={(e) => setMinIn(e.target.value)} />
            </div>

            <div className="flex flex-col gap-2 rounded-2xl p-4" style={card}>
              <div className="flex gap-2">
                {(
                  [
                    ['token', `Send ${token.symbol}`],
                    ['bsv', 'Send BSV'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setAssetKind(k)}
                    className="flex-1 rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
                    style={
                      assetKind === k
                        ? { background: 'var(--bw-accent)', color: '#000' }
                        : { background: '#1d2026', color: muted }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {(
                  [
                    ['fixed', 'Same amount each'],
                    ['prorata', 'Split by holdings'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMode(k)}
                    className="flex-1 rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
                    style={
                      mode === k
                        ? { background: 'var(--bw-accent)', color: '#000' }
                        : { background: '#1d2026', color: muted }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="text-xs" style={{ color: muted }}>
                {mode === 'fixed' ? `${unit} each` : `Total ${unit} to split`}
              </label>
              <input
                className={input}
                inputMode="decimal"
                value={amountIn}
                onChange={(e) => setAmountIn(e.target.value)}
              />
              <label className="text-xs" style={{ color: muted }}>
                Holders per transaction (1–{MAX_BATCH})
              </label>
              <input
                className={input}
                inputMode="numeric"
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
              />
              <NoteField value={note} onChange={setNote} />
            </div>

            {draft && (
              <div className="flex flex-col gap-1 rounded-2xl p-4" style={card}>
                <p className="text-sm text-white m-0">
                  {formatUnits(draft.preview.total, assetDec)} {unit} to {draft.preview.holders} holders
                </p>
                <p className="text-xs m-0" style={{ color: muted }}>
                  {draft.preview.batches} transaction{draft.preview.batches === 1 ? '' : 's'} · network fee about{' '}
                  {draft.preview.minerFee} sats
                  {draft.preview.indexerFee ? ` · indexer fee up to ${draft.preview.indexerFee} sats` : ''}
                </p>
                <p className="text-xs m-0" style={{ color: muted }}>
                  Total leaving your wallet:{' '}
                  {assetKind === 'token' ? `${formatUnits(draft.preview.total, assetDec)} ${unit} + ` : ''}
                  {formatUnits(draft.preview.satsOut, 8)} BSV
                </p>
                {overBalance && (
                  <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                    You hold {formatUnits(heldRaw, token.dec)} {token.symbol}, less than this airdrop.
                  </p>
                )}
                {mode === 'prorata' && filtered && draft.preview.holders < filtered.holders.length && (
                  <p className="text-xs m-0" style={{ color: muted }}>
                    {filtered.holders.length - draft.preview.holders} small holders would get less than 1 unit and are
                    left out.
                  </p>
                )}
              </div>
            )}
            {msg && (
              <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                {msg}
              </p>
            )}
            <button
              type="button"
              disabled={!draft || !draft.recipients.length || overBalance || noteBad}
              onClick={startDrop}
              className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
              style={{ background: 'var(--bw-accent)', color: '#000' }}
            >
              Continue
            </button>
          </>
        )}
      </div>

      <SendConfirmation
        show={!!confirm}
        theme={theme}
        lineItems={confirm?.lineItems ?? []}
        total={confirm?.total}
        isProcessing={busy}
        onConfirm={() => confirm && void sendBatch(confirm.index)}
        onCancel={() => setConfirm(null)}
      />
    </div>,
    document.body,
  );
}
