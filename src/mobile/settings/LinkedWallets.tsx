import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBackClose } from '../backStack';
import { BchatClient, defaultHttp, loadSession, SESSION_EVENT } from '../chat/api';
import { isNative } from '../native';
import {
  BCHATX_ACCOUNT_URL,
  CHAIN_LABEL,
  inPlaceChains,
  linkDate,
  linkInPlace,
  listLinks,
  PRIVATE_NOTE,
  providersOf,
  shortAddress,
  signerFor,
  unlink,
  type LinkChain,
  type LinkedWallet,
  type Requester,
} from './linkedWalletsApi';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

/**
 * Settings › Identity › Linked wallets: ETH / BNB / SOL / TRON addresses proven by a signed message (no spend).
 * Web and desktop sign in place with the injected wallet; the extension popup and the phone open bChatX's Link
 * card in the browser and refresh the list on return.
 */
export const LinkedWallets = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { addSnackbar } = useSnackbar();
  const [session, setSession] = useState(() => loadSession());
  const [links, setLinks] = useState<LinkedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const providers = useMemo(() => providersOf(typeof window === 'undefined' ? undefined : window), []);
  const chains = inPlaceChains(providers);

  const req: Requester | null = useMemo(() => {
    if (!session) return null;
    const c = new BchatClient(defaultHttp(isNative), session);
    return (m, p, b) => c.request(m, p, b);
  }, [session]);

  const refresh = useCallback(() => {
    if (!req) return;
    listLinks(req)
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [req]);

  useEffect(() => {
    const s = () => setSession(loadSession());
    window.addEventListener(SESSION_EVENT, s);
    return () => window.removeEventListener(SESSION_EVENT, s);
  }, []);

  // Refresh on mount and whenever the user comes back from the browser.
  useEffect(() => {
    refresh();
    const onVis = () => document.visibilityState === 'visible' && refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  const link = async (chain: LinkChain) => {
    const signer = signerFor(chain, providers);
    if (!req || !signer) return;
    setBusy(chain);
    try {
      await linkInPlace(req, chain, signer);
      addSnackbar(`${CHAIN_LABEL[chain]} wallet linked`, 'success');
      refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Could not link the wallet', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (l: LinkedWallet) => {
    if (!req) return;
    setBusy(l.id);
    try {
      await unlink(req, l.id);
      setLinks((x) => x?.filter((y) => y.id !== l.id) ?? null);
      addSnackbar('Unlinked', 'info');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Could not unlink', 'error');
    } finally {
      setBusy(null);
    }
  };

  const btn = 'rounded-full px-4 py-2 text-sm font-semibold border-0';

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Linked wallets</span>
      </div>
      <div className="flex flex-col px-5 pb-10 overflow-y-auto gap-3">
        <p className="text-sm mt-2" style={{ color: MUTED }}>
          Prove you own a wallet on Ethereum, BNB Chain, Solana or TRON by signing a message. Nothing is moved or held,
          and no fee is paid.
        </p>
        {!session && (
          <p className="text-sm" style={{ color: MUTED }}>
            Connect this account to bChatX (Settings › Chat) to see and link wallets.
          </p>
        )}
        {session && links === null && (
          <p className="text-sm" style={{ color: MUTED }}>
            Loading…
          </p>
        )}
        {links?.length === 0 && (
          <p className="text-sm" style={{ color: MUTED }}>
            No linked wallets yet.
          </p>
        )}
        {links?.map((l) => (
          <div
            key={l.id}
            className="rounded-xl p-3 flex flex-col gap-1"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-white text-sm font-semibold" title={l.address}>
                {shortAddress(l.address)}
              </span>
              <button
                className={btn}
                style={{ background: 'transparent', color: '#F97066' }}
                disabled={busy === l.id}
                onClick={() => void remove(l)}
              >
                Unlink
              </button>
            </div>
            <span className="text-xs" style={{ color: MUTED }}>
              {CHAIN_LABEL[l.chain]}
              {linkDate(l.verifiedAt) ? ` · linked ${linkDate(l.verifiedAt)}` : ''}
            </span>
            <span className="text-xs flex items-center gap-1" style={{ color: MUTED }}>
              <Lock size={12} /> {PRIVATE_NOTE}
            </span>
          </div>
        ))}
        {session && (
          <div className="flex flex-col gap-2 mt-2">
            <span className="text-white text-sm font-semibold">Link a wallet</span>
            {chains.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {chains.map((c) => (
                  <button
                    key={c}
                    className={btn}
                    style={{ background: GOLD, color: '#000' }}
                    disabled={!!busy}
                    onClick={() => void link(c)}
                  >
                    {busy === c ? 'Waiting for your wallet…' : CHAIN_LABEL[c]}
                  </button>
                ))}
              </div>
            ) : (
              <button
                className={btn}
                style={{ background: GOLD, color: '#000', alignSelf: 'flex-start' }}
                onClick={() => window.open(BCHATX_ACCOUNT_URL, '_blank', 'noopener')}
              >
                Link on bChatX
              </button>
            )}
            {chains.length === 0 && (
              <span className="text-xs" style={{ color: MUTED }}>
                MetaMask, Phantom and TronLink live in your browser, so linking opens bChatX there. Come back here when
                you're done.
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
