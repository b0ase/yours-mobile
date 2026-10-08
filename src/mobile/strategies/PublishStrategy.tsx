import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { Strategy, StrategySpec } from '../agents/strategy';
import { MARKET_ENABLED } from '../storeBuild';
import { publishStrategy } from './market';
import { rememberStrategy } from './myStrategies';
import { publishProblems, sealStrategy, SPEC_LABELS, STRATEGY_DISCLAIMER } from './strategyNft';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const RISKS = ['Low', 'Medium', 'High', 'Experimental'] as const;

/**
 * Strategy › Publish & sell (SMART-WALLET-SPEC.md §7): fill in the spec and sale terms, then mint the
 * author's copy (encrypted) and register its key. Sales pay the account you publish from.
 * bWalletX only; the current account only (its keys sign the mint).
 */
export const PublishStrategy = ({ strategy, onClose }: { strategy: Strategy; onClose: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const [spec, setSpec] = useState<StrategySpec>({ ...strategy.spec });
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('5');
  const [copies, setCopies] = useState('100');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!MARKET_ENABLED) return null;
  const payTo = account?.addresses.bsvAddress ?? '';
  const sale = { priceUsd: Number(price), copies: Number(copies), payTo };
  const s: Strategy = { ...strategy, spec };

  const publish = async () => {
    const p = publishProblems(s, sale, description);
    setProblems(p);
    if (p.length || !apiContext) return;
    setBusy(true);
    try {
      const { envelope, key } = await sealStrategy(s, {
        description,
        author: { name: account?.name || '', address: payTo },
        sale,
      });
      const outpoint = await publishStrategy(apiContext, envelope, key);
      rememberStrategy(outpoint, s);
      setDone(outpoint);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border w-full';
  const style = { background: '#010101', borderColor: LINE };
  if (done)
    return (
      <div className="flex flex-col gap-2">
        <div className="text-sm font-bold" style={{ color: '#6CE9A6' }}>
          Published: it’s on Exchange › Strategies.
        </div>
        <div className="text-xs" style={{ color: MUTED }}>
          Sales pay {account?.name || 'this account'} directly. Your copy (the original) stays in this wallet.
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-bold border-0"
          style={{ background: LINE, color: '#fff' }}
        >
          Done
        </button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-bold text-white">
        Publish &amp; sell {s.name} v{s.version}
      </div>
      <div className="text-xs" style={{ color: MUTED }}>
        Buyers see the description and spec. The program itself is encrypted: only owners of a copy can open and run it.
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="Description: what it does and why"
        className={input}
        style={style}
      />
      {(Object.keys(SPEC_LABELS) as (keyof StrategySpec)[]).map((k) =>
        k === 'risk' ? (
          <label key={k} className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
            {SPEC_LABELS[k]}
            <select
              value={spec.risk ?? ''}
              onChange={(e) => setSpec({ ...spec, risk: e.target.value as StrategySpec['risk'] })}
              className={input}
              style={style}
            >
              <option value="">Choose…</option>
              {RISKS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        ) : (
          <label key={k} className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
            {SPEC_LABELS[k]}
            <input
              value={spec[k] ?? ''}
              onChange={(e) => setSpec({ ...spec, [k]: e.target.value })}
              className={input}
              style={style}
            />
          </label>
        ),
      )}
      <div className="flex gap-2">
        <label className="text-xs flex flex-col gap-1 flex-1" style={{ color: MUTED }}>
          Price (USD)
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            className={input}
            style={style}
          />
        </label>
        <label className="text-xs flex flex-col gap-1 flex-1" style={{ color: MUTED }}>
          Copies for sale
          <input
            value={copies}
            inputMode="numeric"
            onChange={(e) => setCopies(e.target.value.replace(/\D/g, ''))}
            className={input}
            style={style}
          />
        </label>
      </div>
      <div className="text-[11px]" style={{ color: MUTED }}>
        {STRATEGY_DISCLAIMER} Minting your copy costs a small network fee. Buyers pay a 1% market fee on top of your
        price.
      </div>
      {problems.length > 0 && (
        <ul className="m-0 pl-4 text-xs" style={{ color: '#FDA29B' }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void publish()}
          className="flex-1 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold border-0"
          style={{ background: GOLD, color: '#000' }}
        >
          {busy && <Loader2 size={14} className="animate-spin" />} {busy ? 'Publishing…' : 'Publish'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="flex-1 rounded-lg px-3 py-2 text-sm font-bold border-0"
          style={{ background: LINE, color: '#fff' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
