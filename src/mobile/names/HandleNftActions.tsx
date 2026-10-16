import { useEffect, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { useTheme } from '../../hooks/useTheme';
import { NameInput } from './NameInput';
import type { Resolved } from './names';
import type { NameFee, WalletName } from './paymail';
import { handleNftFee, handleSendTarget, mintHandleNft, sendHandleNft } from './handleNft';

/**
 * Wallet › Names › a handle: "Make this handle an NFT" and, once it is one, "Send handle".
 * Real flows only (docs/HANDLE-NFTS.md): each step is one wallet approval after the user confirms here.
 */
const f = (u: string, i?: RequestInit) => fetch(u, i);
const btn =
  'rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
const shortTx = (t: string) => `${t.slice(0, 8)}…${t.slice(-6)}`;

type Mode = 'idle' | 'mint' | 'send' | 'working' | 'done';

export const HandleNftActions = (p: { ctx: OneSatContext | undefined; name: WalletName; onChanged: () => void }) => {
  const { theme } = useTheme();
  const alias = p.name.paymail.split('@')[0].toLowerCase();
  const [mode, setMode] = useState<Mode>('idle');
  const [fee, setFee] = useState<NameFee | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [to, setTo] = useState('');
  const [resolved, setResolved] = useState<Resolved | undefined>();
  const [boxStatus, setBoxStatus] = useState<'empty' | 'typing' | 'loading' | 'error' | 'ready'>('empty');
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (mode !== 'mint' || fee !== undefined) return;
    handleNftFee(f)
      .then(setFee)
      .catch(() => setFee(null));
  }, [mode, fee]);

  // Plain names only; the main name moves only after another is made main (the server refuses otherwise).
  if (p.name.kind !== 'plain') return null;
  const origin = p.name.nftOrigin;
  const target = resolved && boxStatus === 'ready' ? handleSendTarget(resolved) : null;

  const run = async (work: () => Promise<string>) => {
    if (!p.ctx) return;
    setMode('working');
    setErr('');
    try {
      setMsg(await work());
      setMode('done');
      p.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMode('idle');
    }
  };

  const mint = () =>
    run(async () => {
      const o = await mintHandleNft(f, p.ctx as OneSatContext, alias, fee ?? null);
      return `$${alias} is now an NFT (${shortTx(o)}). Whoever holds it holds the handle.`;
    });

  const send = () =>
    run(async () => {
      if (!target?.ok || !origin) throw new Error('Choose who to send it to');
      const txid = await sendHandleNft(f, p.ctx as OneSatContext, { alias, origin }, target);
      return `Sent $${alias} to ${resolved?.input ?? 'them'} (${shortTx(txid)}).`;
    });

  const muted = { color: 'var(--bw-muted)' };
  const gold = { background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' };

  return (
    <div className="flex flex-col gap-2 px-1">
      {mode === 'idle' && (
        <div className="flex items-center gap-2 flex-wrap">
          {!origin && (
            <button type="button" className={btn} style={gold} disabled={!p.ctx} onClick={() => setMode('mint')}>
              Make this handle an NFT
            </button>
          )}
          {origin && !p.name.main && (
            <button type="button" className={btn} style={gold} disabled={!p.ctx} onClick={() => setMode('send')}>
              Send handle
            </button>
          )}
          {origin && p.name.main && (
            <span className="text-xs" style={muted}>
              NFT · make another name main to send this one
            </span>
          )}
          {origin && p.name.nftUnbound && (
            <span className="text-xs" role="alert" style={{ color: 'var(--bw-danger, #ff5a5a)' }}>
              This handle's NFT moved without a binding. It receives nothing until its holder claims it.
            </span>
          )}
        </div>
      )}

      {mode === 'mint' && (
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: 'var(--bw-surface)' }}>
          <p className="m-0 text-sm font-bold" style={{ color: 'var(--bw-text)' }}>
            Make ${alias} an NFT?
          </p>
          <p className="m-0 text-xs" style={muted}>
            We inscribe a 1-sat ordinal for {p.name.paymail} and keep it in this wallet. From then on, whoever holds the
            NFT holds the handle and receives its payments. You can send it, or sell it, like any NFT.
          </p>
          <p className="m-0 text-xs font-bold" style={{ color: 'var(--bw-text)' }}>
            {fee === undefined
              ? 'Checking the fee…'
              : fee
                ? `Fee: ${fee.usd < 1 ? `${Math.round(fee.usd * 100)}¢` : `$${fee.usd.toFixed(2)}`} plus a tiny network fee`
                : 'Fee: a tiny network fee only'}
          </p>
          <div className="flex gap-2">
            <button type="button" className={btn} style={gold} disabled={fee === undefined} onClick={mint}>
              Make NFT
            </button>
            <button type="button" className={`${btn} bg-transparent`} style={muted} onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'send' && (
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: 'var(--bw-surface)' }}>
          <p className="m-0 text-sm font-bold" style={{ color: 'var(--bw-text)' }}>
            Send ${alias} to…
          </p>
          <NameInput
            theme={theme}
            value={to}
            asset="token"
            autoConfirm
            placeholder="$handle or name@domain"
            onStatus={(st, r) => {
              setBoxStatus(st);
              setResolved(r);
            }}
            onChange={(v) => setTo(v)}
            style={{ width: '100%', margin: 0 }}
          />
          {target && !target.ok && (
            <p className="m-0 text-xs" role="alert" style={{ color: 'var(--bw-danger, #ff5a5a)' }}>
              {target.error}
            </p>
          )}
          {target?.ok && (
            <>
              <p className="m-0 text-xs font-bold" role="alert" style={{ color: 'var(--bw-danger, #ff5a5a)' }}>
                {resolved?.input} will receive every payment sent to {p.name.paymail} from now on, and you will not.
                This can't be undone unless they send it back.
              </p>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--bw-text)' }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand
              </label>
            </>
          )}
          <div className="flex gap-2">
            <button type="button" className={btn} style={gold} disabled={!target?.ok || !ack} onClick={send}>
              Send handle
            </button>
            <button type="button" className={`${btn} bg-transparent`} style={muted} onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'working' && (
        <p className="m-0 text-xs" style={muted}>
          Working… approve in your wallet.
        </p>
      )}
      {mode === 'done' && (
        <p className="m-0 text-xs" style={{ color: 'var(--bw-success)' }}>
          {msg}
        </p>
      )}
      {err && (
        <p className="m-0 text-xs" role="alert" style={{ color: 'var(--bw-danger, #ff5a5a)' }}>
          {err}
        </p>
      )}
    </div>
  );
};
