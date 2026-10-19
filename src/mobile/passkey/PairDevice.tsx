import { useEffect, useState } from 'react';
import * as qr from 'qrcode';
import { Copy, Smartphone, Monitor } from 'lucide-react';
import { copyText, onPhone, pairRestoreUrl } from './passkeyUi';

/**
 * "Put this wallet on your phone" (owner, 19 Oct 2026: "we make them pair their phone"). A QR to the restore page;
 * the passkey is already on the phone when it uses the same Apple / Google account, and the locked backup is in the
 * bWalletX backup store. Phones get the reverse ("Add on your computer") with the address to type.
 */
export const PairDevicePanel = ({ onLater, title }: { onLater?: () => void; title?: string }) => {
  const url = pairRestoreUrl();
  const phone = onPhone();
  const [img, setImg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void qr.toDataURL(url, { margin: 1, width: 220 }).then(setImg, () => setImg(''));
  }, [url]);
  return (
    <div className="w-full flex flex-col items-center text-center gap-3 px-4" data-testid="pair-device">
      {phone ? <Monitor size={36} color="#F5C542" /> : <Smartphone size={36} color="#F5C542" />}
      <h2 className="m-0 text-xl font-bold text-white">
        {title ?? (phone ? 'Add on your computer' : 'Put this wallet on your phone')}
      </h2>
      <p className="m-0 text-sm" style={{ color: '#E4E7EC' }}>
        Same Apple or Google account → your passkey is already on your {phone ? 'computer' : 'phone'}.
      </p>
      {!phone && img && (
        <img src={img} alt="QR code to open bWalletX on your phone" width={220} height={220} className="rounded-xl" />
      )}
      <p className="m-0 text-sm" style={{ color: '#98A2B3' }}>
        {phone
          ? 'On your computer, open this address and choose "Restore with a passkey":'
          : 'Scan with your phone camera, then tap "Restore with a passkey".'}
      </p>
      <button
        type="button"
        onClick={() => void copyText(url).then(() => setCopied(true))}
        className="flex items-center gap-2 rounded-lg px-3 py-2 border-0 cursor-pointer font-mono text-xs"
        style={{ background: '#16181D', color: '#fff' }}
        data-testid="pair-url"
      >
        {url.replace(/^https?:\/\//, '')} <Copy size={12} /> {copied ? 'Copied' : ''}
      </button>
      {onLater && (
        <button
          type="button"
          onClick={onLater}
          className="mt-2 w-full rounded-xl h-11 text-sm font-bold border bg-transparent cursor-pointer"
          style={{ color: '#fff', borderColor: '#F5C54288' }}
        >
          Later
        </button>
      )}
    </div>
  );
};
