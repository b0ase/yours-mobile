import { useMemo, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { setPicture } from '../names/pictureSource';
import { publishPaymailAvatar } from '../wallet/pictureReturn';
import { prepareCardImage, saveCardImage } from '../wallet/cardFrontArt';
import { saveCardDesign } from '../wallet/cardDesign';
import { qrDataUri } from './npgQr';
import { npgImageUrl, npgQrTarget, pad4, STAT_KEYS, statLabel, type NpgAvatar } from './npgAvatar';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

/**
 * NPG Avatar flip view (owner, 19 Oct 2026). Front: the circle. Back: a QR to its page, the score, the six stats
 * (sexiness shown as Style), the card number linking to ninjapunkgirls.com, and the actions passed in.
 * Tap the picture (or "Show back") to turn it over.
 */
export const NpgAvatarFlip = ({ a, size = 280, actions }: { a: NpgAvatar; size?: number; actions?: ReactNode }) => {
  const [back, setBack] = useState(false);
  const qrUri = useMemo(() => qrDataUri(npgQrTarget(a)), [a]);
  const top = Math.max(1, ...STAT_KEYS.map((k) => a.stats[k]));
  return (
    <div className="flex flex-col items-center gap-3 w-full" data-testid="npg-flip">
      <button
        type="button"
        onClick={() => setBack((b) => !b)}
        aria-pressed={back}
        aria-label={back ? `${a.name}: showing details, tap to show the picture` : `${a.name}: tap to show details`}
        className="relative rounded-[28px] border-0 p-0 cursor-pointer overflow-hidden"
        style={{ width: size, height: size, background: '#0b0c0f', boxShadow: `0 0 0 1px ${GOLD}55` }}
      >
        {!back ? (
          <img
            src={npgImageUrl(a)}
            alt={a.name}
            draggable={false}
            className="w-full h-full object-contain rounded-full"
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
            {qrUri && (
              <img src={qrUri} alt={`QR code for ${a.name}`} className="rounded-lg" style={{ width: size * 0.42 }} />
            )}
            <span className="text-[11px] font-semibold" style={{ color: MUTED }}>
              Score
            </span>
            <span className="text-3xl font-extrabold leading-none" style={{ color: GOLD }}>
              {a.score}
            </span>
          </span>
        )}
      </button>
      <div className="w-full flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-extrabold text-white truncate">{a.name}</div>
          <div className="text-xs" style={{ color: MUTED }}>
            Series {a.series} · Score {a.score}
            {a.mintNumber !== null ? ` · Mint #${a.mintNumber}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setBack((b) => !b)}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold bg-transparent cursor-pointer"
          style={{ border: `1px solid ${GOLD}`, color: GOLD }}
        >
          {back ? 'Show picture' : 'Show back'}
        </button>
      </div>
      {back && (
        <div className="w-full flex flex-col gap-3">
          <ul className="list-none m-0 p-0 grid grid-cols-2 gap-x-4 gap-y-2" aria-label="Stats">
            {STAT_KEYS.map((k) => (
              <li key={k} className="flex flex-col gap-1">
                <span className="flex justify-between text-xs">
                  <span style={{ color: MUTED }}>{statLabel(k)}</span>
                  <span className="font-bold text-white">{a.stats[k]}</span>
                </span>
                <span className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(a.stats[k] / top) * 100}%`, background: GOLD }}
                  />
                </span>
              </li>
            ))}
          </ul>
          {a.url && (
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-bold underline"
              style={{ color: GOLD }}
            >
              {a.card !== null ? `Card #${pad4(a.card)}` : 'Her card'} on ninjapunkgirls.com <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
      {actions}
    </div>
  );
};

/** "Use as profile picture" + "Add to card" for an avatar this account holds. Local, plus the signed paymail profile. */
export const NpgPictureActions = ({ a }: { a: NpgAvatar }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress ?? '';
  const key = account?.pubKeys?.identityPubKey;
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const run = async (k: string, fn: () => Promise<string>) => {
    setBusy(k);
    setMsg('');
    try {
      setMsg(await fn());
    } catch {
      setMsg('That didn’t work. Try again.');
    } finally {
      setBusy('');
    }
  };
  const applyPicture = () =>
    run('pic', async () => {
      const url = await setPicture(chromeStorageService, id, { source: 'nft', origin: a.origin, url: npgImageUrl(a) });
      // Same path as Your picture › NFT: account icon + socialProfile.avatar (read by bChatX) + paymail profile.
      void publishPaymailAvatar(apiContext, chromeStorageService, url);
      return `${a.name} is your profile picture.`;
    });
  const addToCard = () =>
    run('card', async () => {
      const r = await fetch(npgImageUrl(a));
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const uri = await prepareCardImage(new File([blob], 'npg', { type: blob.type || 'image/webp' }));
      if (!saveCardImage(key, uri)) return 'No room on this device.';
      saveCardDesign(key, null); // a picture on the card replaces a pattern/art
      return 'Done. Your card shows her.';
    });
  const btn = 'rounded-xl py-2.5 text-sm font-bold cursor-pointer disabled:opacity-50';
  return (
    <div className="w-full flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!id || !!busy}
          onClick={() => void applyPicture()}
          className={`${btn} border-0`}
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {busy === 'pic' ? 'Setting…' : 'Use as profile picture'}
        </button>
        <button
          type="button"
          disabled={!key || !!busy}
          onClick={() => void addToCard()}
          className={`${btn} bg-transparent`}
          style={{ border: `1px solid ${GOLD}`, color: GOLD }}
        >
          {busy === 'card' ? 'Adding…' : 'Add to card'}
        </button>
      </div>
      {msg && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </div>
  );
};
