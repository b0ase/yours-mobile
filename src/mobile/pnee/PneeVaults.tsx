import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { parseBsvAmount } from '../notes/backPnee';
import { PNEE } from './script';
import { ageText, fmtCents, fmtSats, health, mintable, ratioPct, valueCents } from './math';
import { closeConfirm, mintConfirm, topUpConfirm, type Confirm } from './confirm';
import { closePlan, closeVault, mintPnee, splitCoin, topUpVault, type Vault } from './vaults';
import type { PriceRound } from './oracle';
import { usePnee } from './usePnee';
import { Button, CARD, ConfirmSheet, GOLD, Lines, MUTED, Sheet } from './PneeSheet';
import { bsvToSats } from './copy';

const HEALTH = {
  empty: { text: 'No PNEEs minted', color: MUTED },
  ok: { text: 'Healthy', color: '#32D583' },
  near: { text: 'Near the 150% floor', color: GOLD },
  below: { text: 'Below 150%: anyone may close it', color: '#F97066' },
} as const;

type Action = { kind: 'mint' | 'topup'; v: Vault } | null;
type Pending = { c: Confirm; run: () => Promise<unknown> } | null;

/**
 * Pots & Locks › Vaults: each PNEE vault's BSV, PNEEs minted, ratio, the floor and the age of its last price round,
 * with Mint, Add BSV and Close. Plain time-lock pots stay in their own list above.
 */
export default function PneeVaults({ rate, onBack }: { rate: number; onBack: () => void }) {
  const { addSnackbar } = useSnackbar();
  const p = usePnee();
  const [round, setRound] = useState<PriceRound | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [raw, setRaw] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!p.cfg) return;
    void p
      .round()
      .then(setRound)
      .catch(() => undefined);
  }, [p.cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const px = round ? BigInt(round.median) : BigInt(Math.round(rate * 100));
  const now = Math.floor(Date.now() / 1000);

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.run();
      addSnackbar('Done. It shows here once the wallet has it.', 'success');
      setPending(null);
      setAction(null);
      setRaw('');
      await p.refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const startMint = async () => {
    if (action?.kind !== 'mint' || !p.wallet || !p.vaultBeef) return;
    const n = BigInt(Math.round((parseFloat(raw.replace(',', '.')) || 0) * 100)); // dollars → PNEEs (cents)
    try {
      const r = await p.round();
      setRound(r);
      const v = action.v;
      const price = BigInt(r.median);
      if (n <= 0n || n > mintable(v.sats, price, v.state.debt))
        throw new Error(`This vault can mint up to ${fmtCents(mintable(v.sats, price, v.state.debt))} right now.`);
      setPending({
        c: mintConfirm(v.sats, v.state.debt, n, price),
        run: () => mintPnee(p.wallet!, v, p.vaultBeef!, r, n),
      });
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const startTopUp = () => {
    if (action?.kind !== 'topup' || !p.wallet || !p.vaultBeef) return;
    const bsv = parseBsvAmount(raw);
    if (!bsv) return;
    const v = action.v;
    const add = bsvToSats(bsv);
    setPending({
      c: topUpConfirm(v.sats, v.state.debt, add, px),
      run: () => topUpVault(p.wallet!, v, p.vaultBeef!, add),
    });
  };
  const startClose = (v: Vault) => {
    if (!p.wallet || !p.vaultBeef || !p.coinBeef) return;
    const plan = closePlan(v, p.coins);
    if ('short' in plan)
      return addSnackbar(`Closing burns ${v.state.debt} PNEEs; this wallet holds ${plan.short} fewer.`, 'error');
    const beef = p.vaultBeef;
    beef.mergeBeef(p.coinBeef);
    if ('split' in plan)
      return setPending({
        c: {
          title: 'First, make the exact amount',
          lines: [
            { label: 'From a coin of', value: `${plan.split.amount} PNEEs` },
            { label: 'You make', value: `${v.state.debt} PNEEs (sent to yourself)` },
          ],
          note: 'A close burns exactly what the vault minted. This sends that amount to yourself as one coin; then Close again.',
          button: 'Make the coin',
        },
        run: () => splitCoin(p.wallet!, plan.split, p.coinBeef!, v.state.debt),
      });
    setPending({ c: closeConfirm(v.sats, v.state.debt), run: () => closeVault(p.wallet!, v, plan.burn, beef) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-bold text-white">Vaults</span>
        <button
          type="button"
          onClick={onBack}
          className="text-xs flex items-center gap-1 bg-transparent border-0"
          style={{ color: GOLD }}
        >
          <Plus size={14} /> New vault
        </button>
      </div>
      {p.error && (
        <div className="text-xs" style={{ color: MUTED }}>
          {p.error}
        </div>
      )}
      {p.vaults.length === 0 && (
        <div className="rounded-xl p-3 text-xs" style={{ background: CARD, color: MUTED }}>
          No PNEE vaults yet. A vault holds BSV you lock to back PNEEs; you can mint up to a tenth of its value.
        </div>
      )}
      {p.vaults.map((v) => {
        const h = health(v.sats, px, v.state.debt);
        const r = ratioPct(v.sats, px, v.state.debt);
        return (
          <div key={v.outpoint} className="rounded-xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-white">{fmtSats(v.sats)}</span>
              <span className="text-xs font-bold" style={{ color: HEALTH[h].color }}>
                {HEALTH[h].text}
              </span>
            </div>
            <Lines
              lines={[
                { label: 'Worth now', value: px > 0n ? fmtCents(valueCents(v.sats, px)) : '—' },
                {
                  label: 'PNEEs minted',
                  value: `${v.state.debt.toLocaleString('en-US')} (${fmtCents(v.state.debt * PNEE.unitCents)})`,
                },
                {
                  label: 'Ratio',
                  value: r == null ? '—' : `${r.toLocaleString('en-US')}% (floor ${PNEE.liqRatioPct}%)`,
                },
                { label: 'Can still mint', value: px > 0n ? fmtCents(mintable(v.sats, px, v.state.debt)) : '—' },
                {
                  label: 'Price',
                  value: round ? `${fmtCents(px)} · round ${ageText(now - round.ts)} old` : 'from the wallet rate',
                },
                { label: 'Last price round used', value: `${ageText(now - Number(v.state.lastTs))} ago` },
              ]}
            />
            <div className="grid grid-cols-3 gap-2">
              <Button ghost onClick={() => (setRaw(''), setAction({ kind: 'mint', v }))}>
                Mint
              </Button>
              <Button ghost onClick={() => (setRaw(''), setAction({ kind: 'topup', v }))}>
                Add BSV
              </Button>
              <Button ghost onClick={() => startClose(v)}>
                Close
              </Button>
            </div>
          </div>
        );
      })}
      {action && !pending && (
        <Sheet title={action.kind === 'mint' ? 'Mint PNEEs' : 'Add BSV'} onClose={() => setAction(null)}>
          <label className="rounded-xl p-3 flex items-center gap-2" style={{ background: CARD }}>
            <input
              inputMode="decimal"
              autoFocus
              placeholder="0.00"
              aria-label={action.kind === 'mint' ? 'Amount in dollars' : 'Amount in BSV'}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-2xl font-bold text-white"
            />
            <span className="text-sm font-bold" style={{ color: GOLD }}>
              {action.kind === 'mint' ? 'USD' : 'BSV'}
            </span>
          </label>
          {action.kind === 'mint' && px > 0n && (
            <div className="text-xs" style={{ color: MUTED }}>
              Up to {fmtCents(mintable(action.v.sats, px, action.v.state.debt))} at {fmtCents(px)} per BSV.
            </div>
          )}
          <Button onClick={() => void (action.kind === 'mint' ? startMint() : startTopUp())}>Continue</Button>
        </Sheet>
      )}
      {pending && (
        <ConfirmSheet confirm={pending.c} busy={busy} onConfirm={() => void run()} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
