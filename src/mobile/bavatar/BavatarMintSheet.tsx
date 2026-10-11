import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { BavatarMine } from '../chat/api';
import { svgDataUri } from '../wallet/cardBackQr';
import { bavatarClient, bavatarLabel, bavatarMintSvg, FOUNDING, mintBavatar, mintOffer } from './mintBavatar';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const PANEL = '#17191E';

type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'ready'; mine: BavatarMine }
  | { k: 'minting'; mine: BavatarMine }
  | { k: 'done'; mine: BavatarMine; txid: string };

/**
 * "Mint my bAvatar" (owner, 11 Oct 2026). One sheet: the preview, what it is, what it costs, one Mint
 * button. This sheet is the confirmation (one-sheet rule): pressing Mint inscribes, nothing else pops up.
 * Founding 1,000 (#1–#1,000): bWalletX pays the network fee. After that: the user pays it, ~4,000 sats.
 */
export default function BavatarMintSheet({ onClose }: { onClose: () => void }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityKey = account?.pubKeys?.identityPubKey ?? '';
  const payAddress = account?.addresses?.bsvAddress ?? '';
  const [state, setState] = useState<State>({ k: 'loading' });

  useBackClose(true, onClose);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mine = await (await bavatarClient(apiContext)).bavatarMine();
        if (!live) return;
        setState(mine.minted ? { k: 'done', mine, txid: mine.minted.txid } : { k: 'ready', mine });
      } catch (e) {
        if (live) setState({ k: 'error', msg: e instanceof Error ? e.message : 'Could not load your number' });
      }
    })();
    return () => {
      live = false;
    };
  }, [apiContext]);

  const mine = state.k === 'ready' || state.k === 'minting' || state.k === 'done' ? state.mine : null;
  const preview = useMemo(
    () => (mine ? svgDataUri(bavatarMintSvg(identityKey, mine.handle, mine.number)) : ''),
    [mine, identityKey],
  );
  const offer = mine ? mintOffer(mine) : null;

  const mint = async () => {
    if (state.k !== 'ready') return;
    const m = state.mine;
    setState({ k: 'minting', mine: m });
    try {
      const txid = await mintBavatar(apiContext, { identityKey, payAddress, mine: m });
      setState({ k: 'done', mine: m, txid });
    } catch (e) {
      setState({ k: 'error', msg: e instanceof Error ? e.message : 'Mint failed' });
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[420] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button
          onClick={onClose}
          aria-label="Back"
          className="w-11 h-11 flex items-center justify-center bg-transparent border-0"
        >
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-white font-bold text-[17px]">Mint my bAvatar</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-8 flex flex-col items-center gap-4">
        {state.k === 'loading' && <p style={{ color: MUTED }}>Looking up your number…</p>}
        {state.k === 'error' && (
          <p className="text-sm text-center" style={{ color: '#ff8a8a' }}>
            {state.msg}
          </p>
        )}
        {mine && (
          <>
            {preview ? (
              <img
                src={preview}
                alt={bavatarLabel(mine.handle, mine.number)}
                className="w-full rounded-2xl"
                style={{ maxWidth: 320, boxShadow: '0 0 0 1px #f5b80055, 0 18px 50px #000' }}
              />
            ) : (
              <p className="text-sm" style={{ color: MUTED }}>
                Claim a $name first: your bAvatar carries it.
              </p>
            )}
            <div className="text-center">
              <div className="text-white font-bold text-[17px]">{bavatarLabel(mine.handle, mine.number)}</div>
              {mine.founding && mine.number <= FOUNDING && (
                <div className="text-xs font-bold tracking-[0.18em] mt-1" style={{ color: GOLD }}>
                  FOUNDING 1,000
                </div>
              )}
            </div>
            <div className="w-full rounded-2xl p-4 text-sm" style={{ background: PANEL, color: '#D0D5DD', maxWidth: 420 }}>
              Your bAvatar art, your name and your number, inscribed as a 1-sat ordinal in this wallet. The QR opens
              your paymail. Send it on and the art and number go with it; your account stays yours.
              <div className="mt-3 font-semibold text-white">
                {offer?.kind === 'free'
                  ? 'Free: bWalletX pays the network fee.'
                  : offer?.kind === 'paid'
                    ? 'Network fee: about 4,000 sats.'
                    : ''}
              </div>
            </div>
            {state.k === 'done' ? (
              <a
                href={`https://whatsonchain.com/tx/${state.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 font-bold"
                style={{ color: GOLD }}
              >
                Minted <ExternalLink size={14} />
              </a>
            ) : (
              <button
                type="button"
                disabled={state.k === 'minting' || !preview}
                onClick={mint}
                className="w-full rounded-full py-3 font-bold border-0"
                style={{ maxWidth: 420, background: GOLD, color: '#010101', opacity: state.k === 'minting' || !preview ? 0.6 : 1 }}
              >
                {state.k === 'minting' ? 'Minting…' : 'Mint'}
              </button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
