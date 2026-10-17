import { useEffect, useState } from 'react';
import { Transaction } from '@bsv/sdk';
import { BadgeCheck, ShieldAlert } from 'lucide-react';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { checkStoreReceipt, fetchStoreKey, type ReceiptCheck } from './receipt';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/**
 * NFT detail › "Verified receipt ✓" (owner 17 Oct 2026). Reads the transaction holding the receipt and checks it
 * (storeReceipt/receipt.ts checkStoreReceipt): the Store's signature, its published key, the payment and the order.
 */
export function ReceiptBadge({ txid }: { txid: string }) {
  const [res, setRes] = useState<ReceiptCheck | null | 'error'>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [hex, key] = await Promise.all([
          fetch(`${WOC}/tx/${txid}/hex`).then((r) => (r.ok ? r.text() : Promise.reject(new Error('tx')))),
          fetchStoreKey(BWALLET_PAYMAIL_API),
        ]);
        if (live) setRes(checkStoreReceipt(Transaction.fromHex(hex.trim()), key));
      } catch {
        if (live) setRes('error');
      }
    })();
    return () => {
      live = false;
    };
  }, [txid]);
  if (res === null) return <p className="m-0 text-xs text-[#98A2B3]">Checking receipt…</p>;
  if (res === 'error' || !res.receipt)
    return <p className="m-0 text-xs text-[#98A2B3]">Receipt: couldn&apos;t check it right now.</p>;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-[var(--bw-surface)] p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-sm font-semibold"
        style={{ color: res.verified ? '#F5B800' : '#98A2B3' }}
      >
        {res.verified ? <BadgeCheck size={18} /> : <ShieldAlert size={18} />}
        {res.verified ? 'Verified receipt ✓' : 'Receipt not verified'}
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {res.checks.map((c) => (
            <li key={c.label} className="text-xs" style={{ color: c.ok ? '#A1FF8B' : '#F97066' }}>
              {c.ok ? '✓' : '✗'} {c.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
