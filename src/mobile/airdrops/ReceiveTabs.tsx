/**
 * Receive › Money | NFTs & names. The second tab is the account's ordinals address (addresses.ordAddress), which
 * receives NFTs, OpNS names, BSV-21 tokens and airdrops: it is the paymail's ordinals destination
 * (names/GetYourName.tsx) and History reads it (wallet/HistoryScreen.tsx). When it is on, the screen's own payment
 * QR and copy row that follow are hidden by CSS (.bw-rcv-airdrop ~ * in mobile.css).
 *
 * Owner, 13 Oct 2026: the tab used to say "Airdrops", so the ordinals address looked like a footnote and people
 * could send an NFT to the money address (where the wallet may spend it as change). Now the two tabs name what
 * goes where, and an agent account also shows its pay address, the one `bwalletx` and agents fund.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { QrCode } from '../../components/QrCode';
import { useAirdropAddress } from './useAirdrops';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isAgentAccount } from '../agents/agentAccounts';

const CopyRow = ({ address, copied, onCopy }: { address: string; copied: boolean; onCopy: () => void }) => (
  <button
    type="button"
    onClick={onCopy}
    className="flex items-center gap-2 px-4 py-3 rounded-xl w-full text-left"
    style={{ background: 'var(--bw-surface)' }}
  >
    {copied ? <Check size={16} color="var(--bw-accent-hi)" /> : <Copy size={16} color="#98A2B3" />}
    <span className="text-xs font-mono flex-1 text-white overflow-hidden text-ellipsis whitespace-nowrap">
      {address}
    </span>
    <span className="text-xs text-[#98A2B3]">{copied ? 'Copied!' : 'Copy'}</span>
  </button>
);

export const ReceiveTabs = () => {
  const address = useAirdropAddress();
  const { chromeStorageService } = useServiceContext();
  const acct = chromeStorageService.getCurrentAccountObject().account;
  const agentPay = isAgentAccount(acct?.addresses?.identityAddress) ? (acct?.addresses?.bsvAddress ?? '') : '';
  const [tab, setTab] = useState<'pay' | 'airdrop'>('pay');
  const [copied, setCopied] = useState<'ord' | 'agent' | null>(null);
  if (!address) return null;
  const copy = (which: 'ord' | 'agent', value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <>
      <div className="flex gap-1 rounded-xl p-1 bg-[var(--bw-surface)] w-full mb-4" role="tablist">
        {(
          [
            ['pay', 'Money'],
            ['airdrop', 'NFTs & names'],
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
      {tab === 'pay' && agentPay && (
        <div className="flex flex-col w-full gap-1.5 mb-4">
          <div className="text-xs font-semibold text-white">Agent pay address</div>
          <CopyRow address={agentPay} copied={copied === 'agent'} onCopy={() => copy('agent', agentPay)} />
          <p className="text-[11px] m-0 text-[#98A2B3]">
            The address <span className="font-mono">bwalletx</span> and your agents spend from. Fund it here, or use the
            address below: both land in this account.
          </p>
        </div>
      )}
      {tab === 'airdrop' && (
        <div className="bw-rcv-airdrop flex flex-col items-center w-full gap-3">
          <div className="text-sm font-bold text-white self-start">NFTs &amp; names address</div>
          <QrCode address={address} onClick={() => copy('ord', address)} />
          <CopyRow address={address} copied={copied === 'ord'} onCopy={() => copy('ord', address)} />
          <p className="text-xs text-center m-0 max-w-[18rem] text-[#98A2B3]">
            For NFTs, names, tokens and airdrops. Anything sent here unasked shows in Wallet › Airdrops first.
            Don&apos;t send BSV here: use Money.
          </p>
        </div>
      )}
    </>
  );
};
