import { APP_NAME } from '../storeBuild';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { AvatarPicker } from '../names/AvatarPicker';
import { useTokenIcon } from './tokenIcon';
import { useIssuer } from '../issuer/IssuerBadge';

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
  if (!icon.url && !icon.own) return null;
  return (
    <div className="flex flex-col items-center gap-1.5 mb-3">
      {icon.url ? (
        <img
          src={icon.url}
          alt=""
          className="w-16 h-16 rounded-full object-cover"
          style={{ border: '2px solid #F5B80055' }}
        />
      ) : (
        <div className="w-16 h-16 rounded-full" style={{ background: '#17191E', border: '2px dashed #F5B80055' }} />
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
          style={{ color: '#F5B800' }}
        >
          Change icon
        </button>
      )}
      {icon.fromProfile && onchain && (
        <span className="flex items-center gap-1 text-[10px]" style={{ color: '#667085' }}>
          On-chain icon <img src={onchain} alt="" className="w-3.5 h-3.5 rounded-full object-cover" /> (permanent; other
          wallets show this)
        </span>
      )}
      {editing && <ChangeIconSheet onClose={() => setEditing(false)} />}
    </div>
  );
};

const ChangeIconSheet = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { chromeStorageService } = useServiceContext();
  const name = chromeStorageService.getCurrentAccountObject().account?.name ?? '';
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
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
