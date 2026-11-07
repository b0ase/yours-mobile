import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink, Lock } from 'lucide-react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBackClose } from '../backStack';
import { BchatClient, defaultHttp, loadSession, SESSION_EVENT } from '../chat/api';
import { isNative } from '../native';
import { ChainBadge, WalletLogo } from './LinkWalletMarks';
import {
  BCHATX_ACCOUNT_URL,
  CHAIN_LABEL,
  CHAIN_WALLET,
  inPlaceChains,
  LINK_CHAINS,
  linkDate,
  linkInPlace,
  listLinks,
  PRIVATE_NOTE,
  providersOf,
  shortAddress,
  signerFor,
  unlink,
  WALLET_NAME,
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
            style={{ background: 'var(--bw-surface)', boxShadow: 'inset 0 0 0 1px var(--bw-line)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <WalletLogo wallet={CHAIN_WALLET[l.chain]} />
                <span className="text-white text-sm font-semibold" title={l.address}>
                  {shortAddress(l.address)}
                </span>
                <ChainBadge chain={l.chain} />
              </span>
              <button
                className={btn}
                style={{ background: 'transparent', color: '#F97066', minHeight: 44, flexShrink: 0 }}
                disabled={busy === l.id}
                onClick={() => void remove(l)}
              >
                Unlink
              </button>
            </div>
            <span className="text-xs" style={{ color: MUTED }}>
              {WALLET_NAME[CHAIN_WALLET[l.chain]]}
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
            {/* Signs in place where the browser wallet is injected; elsewhere every row opens bChatX's Link card. */}
            <div className="flex flex-col gap-2">
              {(chains.length > 0 ? chains : LINK_CHAINS).map((c) => {
                const inPlace = chains.length > 0;
                const name = WALLET_NAME[CHAIN_WALLET[c]];
                return (
                  <button
                    key={c}
                    className="flex w-full items-center gap-3 rounded-xl border-0 px-3 py-2 text-left"
                    style={{
                      minHeight: 52,
                      background: 'var(--bw-surface)',
                      boxShadow: 'inset 0 0 0 1px var(--bw-line)',
                      opacity: busy && busy !== c ? 0.5 : 1,
                    }}
                    disabled={!!busy}
                    aria-label={inPlace ? `Link ${name} on ${CHAIN_LABEL[c]}` : `Link ${name} on bChatX`}
                    onClick={() => (inPlace ? void link(c) : window.open(BCHATX_ACCOUNT_URL, '_blank', 'noopener'))}
                  >
                    <WalletLogo wallet={CHAIN_WALLET[c]} />
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold" style={{ color: 'var(--bw-text)' }}>
                        {name}
                      </span>
                      <ChainBadge chain={c} />
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-sm font-semibold" style={{ color: GOLD }}>
                      {busy === c ? 'Waiting…' : inPlace ? 'Link' : 'bChatX'}
                      {!inPlace && <ExternalLink size={14} aria-hidden />}
                    </span>
                  </button>
                );
              })}
            </div>
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
