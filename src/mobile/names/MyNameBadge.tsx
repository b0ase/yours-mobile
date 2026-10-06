import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useAccountNames } from './accountNames';
import { bareName } from './names';

/**
 * Receive screen (build-time insert into BsvWallet.tsx). The one place the FULL paymail is shown,
 * because other wallets need the domain: "alice@bwallet.space [copy] · Use the full address in other wallets".
 */
export const ReceiveName = ({ identityAddress }: { identityAddress?: string }) => {
  const { displayName, handle, paymail } = useAccountNames(identityAddress, '', '', false);
  const [copied, setCopied] = useState(false);
  const payable = paymail || handle;
  if (!payable) return null;
  const copy = () =>
    navigator.clipboard
      ?.writeText(payable)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  return (
    <div className="flex flex-col items-center gap-1 w-full text-xs text-center" style={{ color: '#9aa0a6' }}>
      <div className="flex items-center justify-center gap-1.5">
        {displayName && displayName.toLowerCase() !== bareName(payable).toLowerCase() ? `${displayName} · ` : ''}Or send
        to <span style={{ color: '#FFD24D', fontWeight: 600 }}>{payable}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${payable}`}
          className="p-1 bg-transparent border-0 cursor-pointer"
          style={{ color: copied ? '#2ecc71' : '#FFD24D' }}
        >
          <Copy size={13} />
        </button>
      </div>
      {paymail && <span>Use the full address in other wallets</span>}
      {paymail && handle && <span>OpNS name: {handle}</span>}
    </div>
  );
};
