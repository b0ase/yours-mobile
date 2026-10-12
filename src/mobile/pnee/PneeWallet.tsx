import { useEffect, useState } from 'react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { PNEE_ICON } from '../notes/pnee';
import { fmtCents } from './math';
import { sendConfirm, type Confirm } from './confirm';
import { acceptInbox, PNEE_LABEL, pneeBalance, sendPnee } from './vaults';
import { usePnee } from './usePnee';
import { Button, CARD, ConfirmSheet, GOLD, Lines, MUTED, Sheet } from './PneeSheet';

type Row = { txid: string; description: string; labels: string[] };
const KIND: Record<string, string> = {
  'pnee-lock': 'Vault opened',
  'pnee-topup': 'BSV added to a vault',
  'pnee-mint': 'Minted',
  'pnee-send': 'Sent',
  'pnee-receive': 'Received',
  'pnee-close': 'Vault closed',
};

/** Wallet › PNEEs: the PNEEs minted from vaults that this wallet holds, their history, Send, and incoming sends. */
export default function PneeWallet({ onClose, onVaults }: { onClose: () => void; onVaults: () => void }) {
  const { addSnackbar } = useSnackbar();
  const p = usePnee();
  const [history, setHistory] = useState<Row[]>([]);
  const [to, setTo] = useState('');
  const [raw, setRaw] = useState('');
  const [pending, setPending] = useState<{ c: Confirm; amount: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = pneeBalance(p.coins);

  useEffect(() => {
    if (!p.wallet || !p.identity) return;
    const w = p.wallet;
    void acceptInbox(w, p.identity, new Set(p.coins.map((c) => c.outpoint)))
      .then((n) => {
        if (n > 0) void p.refresh();
      })
      .catch(() => undefined);
    void w
      .listActions({ labels: [PNEE_LABEL], includeLabels: true, limit: 50 })
      .then((r) =>
        setHistory(r.actions.map((a) => ({ txid: a.txid, description: a.description, labels: a.labels ?? [] }))),
      )
      .catch(() => undefined);
  }, [p.wallet, p.identity]); // eslint-disable-line react-hooks/exhaustive-deps

  const startSend = () => {
    const amount = BigInt(Math.round((parseFloat(raw.replace(',', '.')) || 0) * 100));
    if (amount <= 0n) return;
    if (!/^0[23][0-9a-f]{64}$/.test(to.trim())) return addSnackbar('Paste their bWalletX identity key.', 'error');
    setPending({ c: sendConfirm(amount, to.trim()), amount });
  };
  const send = async () => {
    if (!pending || !p.wallet || !p.coinBeef) return;
    setBusy(true);
    try {
      await sendPnee(p.wallet, p.coins, p.coinBeef, to.trim(), p.identity, pending.amount);
      addSnackbar('Sent.', 'success');
      setPending(null);
      setRaw('');
      await p.refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet title="PNEEs" icon={<img src={PNEE_ICON} alt="" className="w-8 h-8" />} onClose={onClose}>
        <div className="text-2xl font-bold text-white">{fmtCents(balance)}</div>
        <div className="text-xs" style={{ color: MUTED }}>
          {balance.toLocaleString('en-US')} PNEEs from vaults, in {p.coins.length} coin{p.coins.length === 1 ? '' : 's'}
          . 1 PNEE = 1¢.
        </div>
        <Button ghost onClick={onVaults}>
          Vaults
        </Button>
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Send</div>
          <input
            placeholder="Their identity key (02… or 03…)"
            aria-label="Recipient identity key"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg p-2 text-xs bg-transparent text-white outline-none"
            style={{ border: '1px solid #2a2d33' }}
          />
          <label className="flex items-center gap-2">
            <input
              inputMode="decimal"
              placeholder="0.00"
              aria-label="Amount in dollars"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-xl font-bold text-white"
            />
            <span className="text-sm font-bold" style={{ color: GOLD }}>
              USD
            </span>
          </label>
          <Button disabled={balance === 0n} onClick={startSend}>
            Continue
          </Button>
        </div>
        <div className="text-sm font-bold text-white">History</div>
        {history.length === 0 ? (
          <div className="text-xs" style={{ color: MUTED }}>
            Nothing yet.
          </div>
        ) : (
          <Lines
            lines={history.map((h) => ({
              label: KIND[h.labels.find((l) => KIND[l]) ?? ''] ?? 'PNEEs',
              value: `${h.description.slice(0, 48)} · ${h.txid.slice(0, 8)}`,
            }))}
          />
        )}
      </Sheet>
      {pending && (
        <ConfirmSheet confirm={pending.c} busy={busy} onConfirm={() => void send()} onClose={() => setPending(null)} />
      )}
    </>
  );
}
