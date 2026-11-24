import { APP_NAME } from '../storeBuild';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { AvatarPicker } from '../names/AvatarPicker';
import { useTokenIcon } from './tokenIcon';
import { useIssuer } from '../issuer/useIssuer';
import { useTheme } from '../../hooks/useTheme';
import { useIdentity } from '../../hooks/useIdentity';
import { SendConfirmation } from '../../components/SendConfirmation';
import { txFeeSats } from '../mint/mint';
import { moneyNow } from '../money/money';
import { publishIconOverride, resolveIconOverride } from './iconOverride';

/**
 * Token page header icon. Your own personal token gets "Change icon": the icon is your profile
 * picture, so changing one changes the other. The on-chain icon can't change (BSV-21), so it's
 * shown small underneath whenever the profile picture is used.
 */
export const TokenIconHeader = ({
  tokenId,
  ticker,
  onchain,
}: {
  tokenId?: string;
  ticker: string;
  onchain: string;
}) => {
  const icon = useTokenIcon(tokenId, ticker, onchain);
  const issuer = useIssuer(icon.fromProfile && !icon.own ? tokenId : null);
  const [editing, setEditing] = useState(false);
  const [issuerEditing, setIssuerEditing] = useState(false);
  const isIssuer = useIsIssuer(icon.own ? undefined : tokenId);
  if (!icon.url && !icon.own) return null;
  return (
    <div className="flex flex-col items-center gap-1.5 mb-3">
      {icon.url ? (
        <img
          src={icon.url}
          alt=""
          className="w-16 h-16 rounded-full object-cover"
          style={{ border: '2px solid rgb(var(--bw-accent-rgb)/0.33)' }}
        />
      ) : (
        <div
          className="w-16 h-16 rounded-full"
          style={{ background: 'var(--bw-surface)', border: '2px dashed rgb(var(--bw-accent-rgb)/0.33)' }}
        />
      )}
      {icon.fromProfile && (
        <span className="text-[11px]" style={{ color: '#98A2B3' }}>
          {icon.own ? 'Icon from your profile picture' : `Icon from ${issuer?.handle ?? 'its creator'}'s profile`}
        </span>
      )}
      {icon.own && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-semibold bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: 'var(--bw-accent)' }}
        >
          Change icon
        </button>
      )}
      {isIssuer && (
        <button
          type="button"
          onClick={() => setIssuerEditing(true)}
          className="text-xs font-semibold bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: 'var(--bw-accent)' }}
        >
          Change icon
        </button>
      )}
      {icon.fromOverride && onchain && (
        <span className="flex items-center gap-1 text-[10px]" style={{ color: '#667085' }}>
          Icon updated by its issuer. Original{' '}
          <img src={onchain} alt="" className="w-3.5 h-3.5 rounded-full object-cover" /> stays on chain; other wallets
          may still show it
        </span>
      )}
      {icon.fromProfile && onchain && (
        <span className="flex items-center gap-1 text-[10px]" style={{ color: '#667085' }}>
          On-chain icon <img src={onchain} alt="" className="w-3.5 h-3.5 rounded-full object-cover" /> (permanent; other
          wallets show this)
        </span>
      )}
      {editing && <ChangeIconSheet onClose={() => setEditing(false)} />}
      {issuerEditing && tokenId && <IssuerIconSheet tokenId={tokenId} onClose={() => setIssuerEditing(false)} />}
    </div>
  );
};

/** Is this wallet's identity key the verified issuer of the token? Only then "Change icon" is offered. */
const useIsIssuer = (tokenId: string | undefined): boolean => {
  const { apiContext } = useServiceContext();
  const issuer = useIssuer(tokenId);
  const [mine, setMine] = useState('');
  useEffect(() => {
    let live = true;
    void apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then((r) => live && setMine(r.publicKey.toLowerCase()))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext.wallet]);
  return !!tokenId && issuer?.status === 'verified' && !!issuer.identityKey && issuer.identityKey === mine;
};

/** Network cost on top of the image inscription: the ~300 byte statement transaction. */
const STATEMENT_TX_SATS = 60;

/**
 * Issuer tool: pick an image, inscribe it, publish a signed icon update. Other wallets that read the
 * update show it; the original icon stays on chain. One approval sheet shows the cost.
 */
const IssuerIconSheet = ({ tokenId, onClose }: { tokenId: string; onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const identity = useIdentity(apiContext, chromeStorageService);
  const input = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<{ base64: string; mime: string; bytes: number } | null>(null);
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cost = img ? txFeeSats(img.bytes, chromeStorageService.getCustomFeeRate()) + STATEMENT_TX_SATS : 0;

  const pick = async (file?: File) => {
    if (!file) return;
    try {
      const p = await identity.prepareAvatar(file);
      setImg({ base64: p.base64, mime: p.mimeType, bytes: p.byteSize });
      setMsg('');
    } catch (e) {
      setImg(null);
      setMsg(e instanceof Error ? e.message : "Couldn't read that image.");
    }
  };

  const publish = async () => {
    if (!img) return;
    setBusy(true);
    setMsg('');
    try {
      const ins = await identity.inscribeAvatar(img.base64, img.mime);
      if (!ins.url) throw new Error(ins.error || 'Inscription failed');
      const icon = `${ins.url.slice('1sat://'.length).replace('.', '_')}`;
      const res = await publishIconOverride(apiContext, tokenId, icon);
      if (!res.txid) throw new Error(res.error || 'Publish failed');
      const key = (await apiContext.wallet.getPublicKey({ identityKey: true })).publicKey;
      await resolveIconOverride(tokenId, key, fetch, Date.now(), [res.txid]);
      setMsg('Published. Wallets that read icon updates will show it.');
      setImg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Change icon</span>
      </div>
      <div className="flex flex-col items-center gap-3 px-5 pb-10 overflow-y-auto">
        <p className="text-sm text-center mt-2" style={{ color: '#98A2B3' }}>
          You issued this token, so you can sign a new icon for it. The original icon stays on chain, and a wallet that
          doesn't read icon updates will keep showing it.
        </p>
        {img && (
          <img src={`data:${img.mime};base64,${img.base64}`} alt="" className="w-24 h-24 rounded-full object-cover" />
        )}
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="text-sm font-semibold bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: 'var(--bw-accent)' }}
        >
          {img ? 'Pick a different image' : 'Pick an image'}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {img && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="text-sm font-semibold rounded-lg px-4 py-2 border-0 cursor-pointer disabled:opacity-40"
            style={{ background: 'var(--bw-accent-hi)', color: '#000' }}
          >
            Publish new icon (~{moneyNow(cost)})
          </button>
        )}
        {msg && (
          <span className="text-xs text-center" style={{ color: '#98A2B3' }}>
            {msg}
          </span>
        )}
      </div>
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: 'New icon (on-chain)', amount: `${Math.ceil((img?.bytes ?? 0) / 1024)} KB` },
          { address: 'Network fee', amount: `~${moneyNow(cost)}` },
        ]}
        total={`~${moneyNow(cost)}`}
        isProcessing={busy}
        onConfirm={() => void publish()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>,
    document.body,
  );
};

const ChangeIconSheet = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { chromeStorageService } = useServiceContext();
  const name = chromeStorageService.getCurrentAccountObject().account?.name ?? '';
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Change icon</span>
      </div>
      <div className="flex flex-col items-center px-5 pb-10 overflow-y-auto">
        <p className="text-sm text-center mt-2 mb-4" style={{ color: '#98A2B3' }}>
          Your token's icon in {APP_NAME} is your profile picture. Pick a photo; publish it so other {APP_NAME} users
          see it too.
        </p>
        <AvatarPicker displayName={name} />
      </div>
    </div>,
    document.body,
  );
};
