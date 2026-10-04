import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';

/**
 * Receive: the wallet's ordinals address (owner, 4 Oct 2026). NFTs, 1Sat ordinals and BSV-21 tokens
 * sent here land in this wallet; sites like pixel-fox markets ask for it. Separate from the BSV
 * deposit address above, which changes per payment.
 */
export const OrdinalsAddress = () => {
  const { chromeStorageService } = useServiceContext();
  const ord = chromeStorageService.getCurrentAccountObject().account?.addresses?.ordAddress ?? '';
  const [copied, setCopied] = useState(false);
  if (!ord) return null;
  const copy = async () => {
    await navigator.clipboard?.writeText(ord).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="w-full mt-6 rounded-2xl p-4" style={{ background: '#17191E' }}>
      <div className="text-xs font-semibold text-white">Ordinals address</div>
      <div className="text-[11px] mt-0.5 mb-2" style={{ color: '#98A2B3' }}>
        For NFTs, ordinals and tokens. Different from the BSV address above.
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2 border-0 text-left"
        style={{ background: '#0b0c0f' }}
      >
        <span className="font-mono text-[11px] break-all" style={{ color: '#D0D5DD' }}>
          {ord}
        </span>
        {copied ? <Check size={14} color="#2ecc71" /> : <Copy size={14} color="#98A2B3" />}
      </button>
    </div>
  );
};
