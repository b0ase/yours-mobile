import * as qr from 'qrcode';
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { formatUSD } from '../../utils/format';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AccountAvatar, useAvatar } from '../names/AccountAvatar';
import { HandleFlow } from '../names/HandleFlow';
import { useAccountNames } from '../names/MyNameBadge';
import { identityRowText } from '../names/identityText';
import bGlyph from '../brand/bwallet-glyph.svg';
import type { BalanceView } from './balanceLoad';
import { cardSats, memberSince, shortAddr } from './walletCardText';

export type WalletCardProps = {
  /** Total in US dollars (BSV at the current rate, plus MNEE when enabled). */
  usd: number;
  /** BSV balance in satoshis. */
  sats: number;
  /** From balanceView(): spinner while loading, unknown when no balance is known yet. */
  view: BalanceView;
  syncing: boolean;
  failed: boolean;
  onRetry: () => void;
  receiveAddress: string;
};

/**
 * Wallet home balance as a premium membership card (not a payment card: no card number, chip, date
 * or network logo). Front: b mark, dollars first with sats below, the $handle where a cardholder name
 * would go. Tap to flip: receive QR, and a signature strip with the identity key fingerprint.
 * Replaces WalletIdentity + the "Total balance" header. Styles in src/mobile/mobile.css (.bw-wcard*).
 */
export const WalletCard = ({ usd, sats, view, syncing, failed, onRetry, receiveAddress }: WalletCardProps) => {
  const { chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [flipped, setFlipped] = useState(false);
  const [handleOpen, setHandleOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());
  const t = identityRowText(names.displayName, names.paymail, names.handle);
  // No account creation time is stored today; memberSince() returns '' and the line is omitted.
  const since = memberSince((account as { createdAt?: number } | undefined)?.createdAt);

  useEffect(() => {
    if (!flipped || !receiveAddress) return;
    qr.toDataURL(
      receiveAddress,
      { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } },
      (err, url) => {
        if (!err) setQrUrl(url);
      },
    );
  }, [flipped, receiveAddress]);

  const copy = (text: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => addSnackbar('Copied', 'success'))
      .catch(() => undefined);
  };
  const flip = () => setFlipped((f) => !f);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div className="bw-wcard-wrap">
      <div
        className={`bw-wcard${flipped ? ' is-flipped' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show card front' : 'Show receive QR and identity'}
        onClick={flip}
        onKeyDown={onKey}
      >
        {/* ── Front ── */}
        <div className="bw-wcard-face bw-wcard-front" aria-hidden={flipped}>
          <div className="bw-wcard-top">
            <img src={bGlyph} alt="bWallet" className="bw-wcard-mark" />
            <span className="bw-wcard-brand">bWallet · Just b.</span>
          </div>
          <div className="bw-wcard-centre">
            {view === 'spinner' ? (
              <Loader2 size={28} className="animate-spin" color="#8e8e89" />
            ) : view === 'unknown' ? (
              <span className="bw-wcard-usd" title="Balance unavailable" style={{ color: '#8e8e89' }}>
                —
              </span>
            ) : (
              <>
                <span className="bw-wcard-usd" title={syncing ? 'Syncing…' : 'Balance'}>
                  {formatUSD(usd)}
                  {syncing && <Loader2 size={16} className="animate-spin bw-wcard-sync" color="#8e8e89" />}
                </span>
                <span className="bw-wcard-sats">{cardSats(sats)}</span>
              </>
            )}
            {failed && (
              <button
                type="button"
                className="bw-wcard-retry"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                Couldn't refresh. Tap to retry.
              </button>
            )}
          </div>
          <div className="bw-wcard-bottom">
            <div className="bw-wcard-holder">
              <AccountAvatar src={avatar} size={22} />
              {t.tag ? (
                <>
                  <span className="bw-wcard-handle">{t.tag}</span>
                  {verified && (
                    <span aria-label="Verified identity" title="Verified identity" style={{ color: '#2ecc71' }}>
                      <Check size={13} strokeWidth={3} />
                    </span>
                  )}
                  <button type="button" onClick={copy(t.copy)} aria-label={`Copy ${t.copy}`} className="bw-wcard-icon">
                    <Copy size={15} color="#98A2B3" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="bw-wcard-getname"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHandleOpen(true);
                  }}
                >
                  Get your $name
                </button>
              )}
            </div>
            {since && (
              <div className="bw-wcard-since">
                <span>MEMBER SINCE</span>
                <b>{since}</b>
              </div>
            )}
          </div>
        </div>

        {/* ── Back ── */}
        <div className="bw-wcard-face bw-wcard-back" aria-hidden={!flipped}>
          <div className="bw-wcard-stripe" />
          <div className="bw-wcard-backbody">
            <div className="bw-wcard-qr" onClick={stop}>
              {qrUrl ? <img src={qrUrl} alt="Receive QR code" /> : <div className="bw-wcard-qr-empty" />}
            </div>
            <div className="bw-wcard-backinfo">
              <span className="bw-wcard-label">Receive BSV</span>
              <button
                type="button"
                className="bw-wcard-addr"
                onClick={copy(receiveAddress)}
                aria-label="Copy receive address"
              >
                <span>{shortAddr(receiveAddress)}</span>
                <Copy size={13} color="#98A2B3" />
              </button>
              <div className="bw-wcard-sig">
                <span className="bw-wcard-sig-name">{t.tag || account?.name || ''}</span>
              </div>
              <span className="bw-wcard-sig-line">Signed by identity key</span>
              <span className="bw-wcard-sig-line" title={id}>
                {shortAddr(id ?? '')}
              </span>
            </div>
          </div>
        </div>
      </div>
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
    </div>
  );
};
