import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { bavatarDataUri, onAvatarChange } from '../names/avatar';
import { pictureState, setPicture } from '../names/pictureSource';

const BavatarMintSheet = lazy(() => import('../bavatar/BavatarMintSheet'));

/**
 * Wallet › NFTs: "Your bAvatar" (owner, 13 Oct 2026). The bAvatar is kept here whether or not it is minted, so
 * replacing the card picture with an X photo or an NFT never loses it: minted, it opens its NFT page; not minted,
 * it is drawn from the identity key on this device, with "Mint it" (BavatarMintSheet). One tap puts it back.
 */
export function BavatarKeep({ mintedOutpoint, onOpen }: { mintedOutpoint?: string; onOpen: (op: string) => void }) {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress ?? '';
  const art = useMemo(() => bavatarDataUri(account?.pubKeys?.identityPubKey), [account?.pubKeys?.identityPubKey]);
  const [source, setSource] = useState(() => pictureState(id).source);
  useEffect(() => {
    setSource(pictureState(id).source);
    return onAvatarChange(() => setSource(pictureState(id).source));
  }, [id]);
  const [mint, setMint] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!art) return null;
  const btn =
    'rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F5B800] disabled:opacity-50';
  return (
    <section
      aria-label="Your bAvatar"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-2.5"
    >
      <img src={art} alt="Your bAvatar" className="h-14 w-14 shrink-0 rounded-xl" draggable={false} />
      <div className="min-w-[150px] flex-1">
        <div className="text-sm font-semibold text-white">Your bAvatar</div>
        <div className="text-xs text-[#98A2B3] overflow-hidden text-ellipsis whitespace-nowrap">
          {mintedOutpoint ? 'Minted' : 'bAvatar (not minted) · kept safe on this device'}
          {source === 'bavatar' ? ' · your picture' : ''}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1.5">
        {source !== 'bavatar' && (
          <button
            type="button"
            disabled={busy}
            className={`${btn} bg-[#17191E] text-white hover:bg-[#22252c]`}
            onClick={() => {
              setBusy(true);
              void setPicture(chromeStorageService, id, { source: 'bavatar' }).finally(() => setBusy(false));
            }}
          >
            Use as my picture
          </button>
        )}
        {mintedOutpoint ? (
          <button
            type="button"
            className={`${btn} bg-[#17191E] text-white hover:bg-[#22252c]`}
            onClick={() => onOpen(mintedOutpoint)}
          >
            Open
          </button>
        ) : (
          <button
            type="button"
            className={`${btn} bg-[#F5B800] text-[#010101] hover:bg-[#FFD24D]`}
            onClick={() => setMint(true)}
          >
            Mint it
          </button>
        )}
      </div>
      {mint && (
        <Suspense fallback={null}>
          <BavatarMintSheet onClose={() => setMint(false)} />
        </Suspense>
      )}
    </section>
  );
}
