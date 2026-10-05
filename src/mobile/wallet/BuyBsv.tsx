import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, CreditCard, ExternalLink, Users, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { openDappBrowser } from '../dappBrowser';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/** Live BSV price for the bar (re-read every minute while shown). */
const useLivePrice = () => {
  const [rate, setRate] = useState(cachedExchangeRate);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetchExchangeRate('main')
        .then((r) => live && r > 0 && setRate(r))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return rate;
};

/**
 * Wallet: BSV price feed + Buy BSV, where the "Missing assets?" banner was (owner, 6 Oct 2026: a Buy button on the BSV
 * card would cover the balance; getting BSV is the biggest onboarding problem).
 */
export const BsvPriceBar = ({ onReceive }: { onReceive: () => void }) => {
  const rate = useLivePrice();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className="flex items-center justify-between gap-2 w-[92%] mb-4 px-4 py-2 rounded-xl"
        style={{ background: '#17191E', border: '1px solid #ffffff10' }}
      >
        <span className="text-xs" style={{ color: MUTED }}>
          BSV{' '}
          <b className="text-sm" style={{ color: '#fff' }}>
            {rate > 0 ? `$${rate.toFixed(2)}` : '…'}
          </b>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
          style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
        >
          Buy BSV
        </button>
      </div>
      {open && (
        <BuyBsvSheet
          onClose={() => setOpen(false)}
          onReceive={() => {
            setOpen(false);
            onReceive();
          }}
        />
      )}
    </>
  );
};

/**
 * Third-party services that sell BSV for card / bank payments (from the BSVRadar list parked on 2 Oct 2026).
 * They run their own checks (KYC) and set their own fees; the wallet only opens them. Buying inside the app with
 * one integrated provider (as HandCash does) is the next step and needs a provider agreement.
 */
const PROVIDERS: { name: string; url: string; desc: string }[] = [
  // Ramp lists BSV (BSV_BSV) with Apple Pay / Google Pay / card / bank (docs/BUY-BSV-ONRAMP.md, 6 Oct 2026). A partner
  // key (owner to apply) lets us embed it with the address prefilled; until then, its hosted page.
  { name: 'Ramp', url: 'https://app.ramp.network/?swapAsset=BSV_BSV&hostAppName=bWalletX', desc: 'Apple Pay, Google Pay, card or bank' },
  { name: 'BSV Association', url: 'https://ramp.bsvblockchain.tech/', desc: 'Buy page run by the BSV Association' },
  { name: 'Guardarian', url: 'https://guardarian.com/buy-bsv', desc: 'Card or bank transfer' },
  { name: 'ChangeNOW', url: 'https://changenow.io/currencies/bitcoin-sv?from=eur&to=bsv&fiatMode=true&amount=100', desc: 'Card, many currencies' },
  { name: 'Alchemy Pay', url: 'https://ramp.alchemypay.org/?crypto=BCHSV&fiat=EUR&network=BCHSV#/index', desc: 'Card, Apple Pay, Google Pay' },
  { name: 'Onramper', url: 'https://www.onramper.com/buy', desc: 'Compares several card providers' },
  { name: 'cex.io', url: 'https://cex.io/buysell', desc: 'Card; exchange account' },
];

const Row = ({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-3 w-full p-3 rounded-xl text-left border-0 cursor-pointer"
    style={{ background: '#17191E', color: '#fff' }}
  >
    <span style={{ color: GOLD }}>{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-bold">{title}</span>
      <span className="block text-xs" style={{ color: MUTED }}>
        {sub}
      </span>
    </span>
  </button>
);

const BuyBsvSheet = ({ onClose, onReceive }: { onClose: () => void; onReceive: () => void }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="flex-1 text-base font-bold text-white">Get BSV</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <Row
          icon={<ArrowDownToLine size={18} />}
          title="From an exchange or another wallet"
          sub="Show your BSV address or QR code to receive"
          onClick={onReceive}
        />
        <Row
          icon={<Users size={18} />}
          title="From a friend"
          sub="Share your $name or paymail and they send it in seconds"
          onClick={onReceive}
        />
        <div className="text-xs font-semibold uppercase tracking-wide mt-1" style={{ color: MUTED }}>
          Buy with a card or bank
        </div>
        {PROVIDERS.map((p) => (
          <Row
            key={p.name}
            icon={<CreditCard size={18} />}
            title={p.name}
            sub={p.desc}
            onClick={() => void openDappBrowser(p.url)}
          />
        ))}
        <p className="m-0 text-[11px] leading-relaxed" style={{ color: MUTED }}>
          These are independent services, not bWalletX. They check your identity and set their own fees and limits. Copy
          your BSV address from Receive and paste it there. <ExternalLink size={10} className="inline" /> Opens in the
          wallet browser.
        </p>
      </div>
    </div>,
    document.body,
  );
};
