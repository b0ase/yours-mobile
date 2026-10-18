import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { createChainReader, createTxCache } from '../../sweep/chainReads';
import { buildCancel, listingState, readListingTx, type CancelPlan } from '../../sweep/relayxListing';
import type { Found } from '../../sweep/relayxRecover';
import { broadcastRaw } from '../pots/potSend';

const BLUE = '#2669FF';
const INK = '#F2F4F7';
const MUTED = '#98A2B3';
const LINE = 'rgb(255 255 255 / 0.08)';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Phase =
  | { k: 'checking' }
  /** Shown as listed, with no cancel: why, in plain words. */
  | { k: 'no'; why: string }
  | { k: 'ready'; plan: CancelPlan }
  | { k: 'sending'; plan: CancelPlan }
  | { k: 'sent'; txid: string }
  | { k: 'error'; plan: CancelPlan; msg: string };

/**
 * Cancel a RelayX listing: bring the NFT back to the user's own address (sweep/relayxListing.ts). The cancel is
 * built and signed on this phone from public chain data, checked against the order's script, and shown (what
 * moves, the fee) before anything is sent; it is broadcast only on the explicit tap. Anything that doesn't check
 * out leaves it listed, with the reason.
 */
export function RelayxListedCancel({ f, wif }: { f: Found; wif: string }) {
  const [p, setP] = useState<Phase>({ k: 'checking' });

  useEffect(() => {
    let gone = false;
    const set = (x: Phase) => !gone && setP(x);
    void (async () => {
      const l0 = f.listed;
      if (!l0) return set({ k: 'no', why: 'This one isn’t listed.' });
      if (l0.problem) return set({ k: 'no', why: l0.problem });
      // Only collections whose RelayX code was checked by hand (NPG: "class COL extends RelayNFT {}").
      if (f.n === undefined)
        return set({
          k: 'no',
          why: 'Cancelling is open for Ninja Punk Girls, whose RelayX code we’ve checked. This one stays listed: nobody can take it without paying the asking price to the seller’s address.',
        });
      try {
        const reader = createChainReader({ cache: createTxCache(null) });
        const tx = await reader.getTx(l0.listing);
        const l = readListingTx(tx);
        if (!l) return set({ k: 'no', why: 'Its listing couldn’t be read again.' });
        if (l.problem) return set({ k: 'no', why: l.problem });
        if (l.batonAddress !== f.address) return set({ k: 'no', why: 'Its cancel output isn’t at this address.' });
        const s = await listingState(l, reader.getTx);
        if ('problem' in s) return set({ k: 'no', why: s.problem });
        set({ k: 'ready', plan: await buildCancel(l, tx, s.state, wif) });
      } catch (e) {
        set({ k: 'no', why: (e as Error).message });
      }
    })();
    return () => {
      gone = true;
    };
  }, [f, wif]);

  const send = async (plan: CancelPlan) => {
    setP({ k: 'sending', plan });
    try {
      await broadcastRaw(plan.tx.toHex());
      setP({ k: 'sent', txid: plan.tx.id('hex') });
    } catch (e) {
      setP({ k: 'error', plan, msg: (e as Error).message });
    }
  };

  if (p.k === 'checking')
    return (
      <p className="m-0 text-[13px]" style={{ color: MUTED }} role="status">
        Checking the listing…
      </p>
    );
  if (p.k === 'no')
    return (
      <p
        className="m-0 rounded-xl px-3 py-3 text-[13px]"
        style={{ color: MUTED, boxShadow: `inset 0 0 0 1px ${LINE}` }}
      >
        Can’t cancel this one here: {p.why}
      </p>
    );
  if (p.k === 'sent')
    return (
      <div className="flex flex-col gap-1 rounded-xl px-3 py-3" style={{ boxShadow: `inset 0 0 0 1px ${LINE}` }}>
        <span className="text-[14px] font-medium" style={{ color: INK }}>
          Cancelled. It’s on its way back to your address.
        </span>
        <a
          href={`https://whatsonchain.com/tx/${p.txid}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[13px] underline-offset-2 hover:underline"
          style={{ color: MUTED }}
        >
          {p.txid.slice(0, 8)}… <ExternalLink size={12} />
        </a>
      </div>
    );
  const { plan } = p;
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-1.5 rounded-xl px-3 py-3 text-[13px]"
        style={{ color: MUTED, boxShadow: `inset 0 0 0 1px ${LINE}` }}
      >
        <span style={{ color: INK }}>Cancel the listing and bring it back</span>
        <span>NFT → {short(plan.to)} (your RelayX address)</span>
        <span>
          {plan.change.toLocaleString()} sats back to the same address · network fee {plan.fee.toLocaleString()} sats
        </span>
        <span>Paid from the listing’s own sats; nothing else in your wallet is spent.</span>
      </div>
      {p.k === 'error' && (
        <p className="m-0 text-[13px]" style={{ color: '#FDA29B' }}>
          Not sent: {p.msg}
        </p>
      )}
      <button
        type="button"
        onClick={() => void send(plan)}
        disabled={p.k === 'sending'}
        className="h-12 w-full rounded-xl border-0 text-[15px] font-semibold cursor-pointer disabled:opacity-60"
        style={{ background: BLUE, color: '#fff' }}
      >
        {p.k === 'sending' ? 'Sending…' : 'Cancel the listing'}
      </button>
    </div>
  );
}
