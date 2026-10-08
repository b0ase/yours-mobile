/**
 * Receive › Payments | Airdrops. The airdrop address is the account's ordinals address (addresses.ordAddress),
 * which already receives tokens and NFTs: it is the paymail's ordinals destination (names/GetYourName.tsx) and
 * History reads it (wallet/HistoryScreen.tsx). When Airdrops is on, the screen's own payment QR and copy row
 * that follow are hidden by CSS (.bw-rcv-airdrop ~ * in mobile.css).
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { QrCode } from '../../components/QrCode';
import { useAirdropAddress } from './useAirdrops';

export const ReceiveTabs = () => {
  const address = useAirdropAddress();
  const [tab, setTab] = useState<'pay' | 'airdrop'>('pay');
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <>
      <div className="flex gap-1 rounded-xl p-1 bg-[#17191E] w-full mb-4" role="tablist">
        {(
          [
            ['pay', 'Payments'],
            ['airdrop', 'Airdrops'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className="flex-1 rounded-lg py-1.5 text-xs font-semibold"
            style={{ background: tab === id ? '#2b2f36' : 'transparent', color: tab === id ? '#fff' : '#98A2B3' }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'airdrop' && (
        <div className="bw-rcv-airdrop flex flex-col items-center w-full gap-3">
          <div className="text-sm font-bold text-white self-start">Airdrop address</div>
          <QrCode address={address} onClick={copy} />
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-2 px-4 py-3 rounded-xl w-full text-left"
            style={{ background: '#17191E' }}
          >
            {copied ? <Check size={16} color="#FFD24D" /> : <Copy size={16} color="#98A2B3" />}
            <span className="text-xs font-mono flex-1 text-white overflow-hidden text-ellipsis whitespace-nowrap">
              {address}
            </span>
            <span className="text-xs text-[#98A2B3]">{copied ? 'Copied!' : 'Copy'}</span>
          </button>
          <p className="text-xs text-center m-0 max-w-[18rem] text-[#98A2B3]">
            Give this to issuers who want to airdrop you tokens or NFTs. Anything sent here unasked shows in Wallet ›
            Airdrops first. Don&apos;t use it for BSV payments.
          </p>
        </div>
      )}
    </>
  );
};
