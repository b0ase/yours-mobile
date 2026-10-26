import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { askNotifyPermissionOnce } from '../notify/engine';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useLegacyKeys } from './useLegacyKeys';
import { getPaymail } from './accountName';
import {
  PERSONAL_FEE_ESTIMATE_SATS,
  PERSONAL_NETWORK_FEE_SATS,
  deployPersonalToken,
  existingChoice,
  importExistingToken,
  openPersonalRoom,
  recoverPersonalLink,
} from './claimPersonal';
import { getFundRecord, showOnWallet } from '../tokens/indexFund';
import { FinishIndexing } from '../tokens/FinishIndexing';
import { NRT_ENABLED, PAID_FEATURES_ENABLED } from '../storeBuild';
import { DEFAULT_SUPPLY, getPersonalLink, onPersonalChange, personalTicker, validateSupply } from './personalToken';
import { getMyName } from './myName';
import { SendConfirmation } from '../../components/SendConfirmation';
import { CurvePicker } from '../curves/CurvePicker';
import { STANDARD_SUPPLY, curveProblem } from '../curves/curveChoice';
import { maxPrice, standardCurve, usd, type Curve } from '../../lib/curves';
import { useTheme } from '../../hooks/useTheme';
import { useBackClose } from '../backStack';
import { moneyNow } from '../money/money';
import {
  bsv20TakenError,
  duplicateNote,
  heldTokenNote,
  personalTokenLabel,
  type ExistingChoice,
} from './existingToken';

/**
 * "Launch your tokens" (owner, 26 Oct 2026): the personal $NAME token launcher (supply, launch curve, burn,
 * "Create $X token"), moved out of Choose your handle unchanged. Onboarding no longer shows it; it opens from the
 * "Launch your tokens" card on the wallet home (HandleOnboarding). Optional and later: a name's room is free and
 * needs no token (nameRooms.ts). Nothing is broadcast without the standard confirmation sheet.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#2b2f36';
const GRAY = '#98A2B3';

export const PersonalTokenLauncher = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const legacy = useLegacyKeys();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const paymail = getPaymail(identityAddress);
  const alias = '';
  const [busy, setBusy] = useState(false);
  const { theme } = useTheme();
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  // Store build: free paymail only, no personal token + holder room (storeBuild.ts).
  const withToken = PAID_FEATURES_ENABLED;
  const [supply, setSupply] = useState(DEFAULT_SUPPLY);
  const supplyNum = Number(String(supply).replace(/[,_\s]/g, '')) || 0;
  const [curve, setCurve] = useState<Curve>(() => standardCurve());
  const [curveOk, setCurveOk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);
  // The token is named after the claimed handle (paymail alias, else OpNS name), else what's typed.
  const claimed = (paymail ? paymail.split('@')[0] : '') || getMyName(identityAddress);
  const tokenName = claimed || alias;
  const ticker = personalTicker(tokenName);
  const supplyError = validateSupply(supply);
  // A token minted earlier whose local link was lost: find this wallet's own deploy (read-only).
  useEffect(() => {
    if (link || !claimed || !apiContext) return;
    recoverPersonalLink(apiContext, identityAddress, claimed)
      .then((l) => l && setLink(l))
      .catch(() => undefined);
  }, [apiContext, identityAddress, claimed, link]);

  // Tokens that already use this ticker: import ours, refuse a taken BSV-20 tick, note someone else's.
  const [choice, setChoice] = useState<ExistingChoice | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (link || !claimed || !apiContext || !withToken) return;
    let live = true;
    existingChoice(apiContext, claimed, undefined, legacy)
      .then((c) => live && setChoice(c))
      .catch(() => live && setChoice({ kind: 'mint' }));
    return () => {
      live = false;
    };
  }, [apiContext, claimed, link, withToken, legacy]);

  const importToken = async () => {
    if (choice?.kind !== 'import') return;
    setImporting(false);
    setBusy(true);
    setTokenMsg('');
    try {
      const { link: l, roomTicker } = await importExistingToken(
        apiContext,
        identityAddress,
        claimed,
        choice.token,
        legacy,
      );
      void showOnWallet(chromeStorageService, l.tokenId);
      setTokenMsg(
        roomTicker
          ? `$${l.ticker} is now your token and its room is open.`
          : `$${l.ticker} is now your token. Set up its room from Chat when you're ready.`,
      );
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const mintToken = async (name = tokenName) => {
    setConfirming(false);
    setBusy(true);
    setTokenMsg('');
    try {
      const l = await deployPersonalToken(apiContext, {
        identityAddress,
        name,
        supply,
        payAddress: account?.addresses?.bsvAddress,
        curve,
        avatar: account?.settings?.socialProfile?.avatar ?? account?.icon,
        ...(choice ? { choice, acceptDuplicate: choice.kind === 'mint-labelled' } : {}),
      });
      if (choice?.kind === 'mint-labelled') setTokenMsg(personalTokenLabel(name));
      // Its balance is local: show it on the Wallet tab now, not when an indexer catches up.
      void showOnWallet(chromeStorageService, l.tokenId);
      void askNotifyPermissionOnce();
      // Names, Rooms and Tickets: a token opens no room by itself; attach it to a room in You › Rooms.
      if (NRT_ENABLED) {
        setTokenMsg(`$${l.ticker} minted. Add it as a ticket to any room from You › Rooms.`);
        return;
      }
      setTokenMsg(`$${l.ticker} minted. Opening your room…`);
      // Signatures only; a fresh token may not be indexed yet. Chat retries until it is.
      openPersonalRoom(apiContext, identityAddress, l)
        .then(() => setTokenMsg(`$${l.ticker} minted and your room is open. Invite = send 1 $${l.ticker}.`))
        .catch(() =>
          setTokenMsg(`$${l.ticker} minted. Set up your room from Chat or Settings › My tokens when you're ready.`),
        );
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Token mint failed');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col overflow-y-auto"
      style={{
        background: '#0b0c0f',
        paddingTop: 'calc(env(safe-area-inset-top) + 12px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
      }}
      role="dialog"
      aria-label="Launch your tokens"
    >
      <div className="flex items-center justify-between px-4 h-12">
        <span className="text-base font-bold text-white">Launch your tokens</span>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 bg-transparent border-0">
          <X size={18} color={GRAY} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-4 pt-2">
        {!claimed && (
          <p className="text-xs" style={{ color: GRAY }}>
            Claim your $name first: your token is named after it.
          </p>
        )}
        {/* Personal token + room is bWalletX-only: the store build has no panel (or price), and none of its text. */}
        {PAID_FEATURES_ENABLED ? (
          <div
            className="flex flex-col gap-2 rounded-2xl p-4"
            style={{ background: PANEL, border: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: GRAY }}>
                Your token + room
              </span>
              <span className="text-[10px] font-semibold" style={{ color: GOLD }}>
                ~{moneyNow(PERSONAL_FEE_ESTIMATE_SATS)}
              </span>
            </div>
            {link ? (
              <p className="text-xs text-white">
                <b style={{ color: GOLD }}>${link.ticker} ✓</b> · {Number(link.supply).toLocaleString()} minted ·{' '}
                {link.roomTicker
                  ? 'room open'
                  : getFundRecord(link.tokenId)
                    ? 'room paid for, waiting for confirmation (usually 10–20 min)'
                    : 'room not set up yet'}
                .
              </p>
            ) : null}
            {link && !busy && !getFundRecord(link.tokenId) ? (
              <FinishIndexing tokenId={link.tokenId} ticker={link.ticker} compact />
            ) : null}
            {link || !PAID_FEATURES_ENABLED ? null : (
              <>
                <p className="text-[11px]" style={{ color: GRAY }}>
                  A personal token, <b className="text-white">${ticker ?? 'NAME'}</b>, all to your wallet, and a chat
                  room only holders can enter. Invite someone by sending 1 ${ticker ?? 'NAME'}. Your room's token:
                  holders get in; it trades on your curve. About {moneyNow(PERSONAL_NETWORK_FEE_SATS)} network fee. You
                  confirm it before anything is sent.
                </p>
                {withToken && (
                  <label className="text-[11px] flex items-center gap-2" style={{ color: GRAY }}>
                    Supply
                    <input
                      value={supply}
                      inputMode="numeric"
                      onChange={(e) => setSupply(e.target.value)}
                      className="flex-1 rounded-lg px-2 py-1 text-xs bg-transparent outline-none text-white"
                      style={{ border: `1px solid ${supplyError ? '#ff4444' : BORDER}` }}
                    />
                  </label>
                )}
                {withToken && claimed && (choice?.kind === 'mint' || choice?.kind === 'mint-labelled') && (
                  <CurvePicker
                    curve={curve}
                    onChange={setCurve}
                    accepted={curveOk}
                    onAccept={setCurveOk}
                    tokenSupply={supplyNum}
                    onUseStandardSupply={() => setSupply(STANDARD_SUPPLY)}
                  />
                )}
                {withToken && supplyError && (
                  <span className="text-[11px]" style={{ color: '#ff4444' }}>
                    {supplyError}
                  </span>
                )}
                {withToken && claimed && choice?.kind === 'import' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setImporting(true)}
                    className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                    style={{ background: GOLD, color: '#000' }}
                  >
                    We found the ${choice.token.sym.replace(/^\$/, '').toUpperCase()} token — sign to import it
                  </button>
                )}
                {withToken && claimed && choice?.kind === 'bsv20-taken' && (
                  <p className="text-[11px]" style={{ color: '#ff4444' }}>
                    {bsv20TakenError(choice.tick)}
                  </p>
                )}
                {withToken && claimed && choice?.kind === 'held' && (
                  <p className="text-[11px]" style={{ color: GOLD }}>
                    {heldTokenNote(choice.token.sym)}
                  </p>
                )}
                {withToken && claimed && choice?.kind === 'mint-labelled' && (
                  <p className="text-[11px]" style={{ color: GOLD }}>
                    {duplicateNote(claimed)}
                  </p>
                )}
                {withToken && claimed && (choice?.kind === 'mint' || choice?.kind === 'mint-labelled') && (
                  <button
                    type="button"
                    disabled={busy || !ticker || !!supplyError || !!curveProblem(curve, curveOk, supplyNum)}
                    onClick={() => setConfirming(true)}
                    className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                    style={{ background: GOLD, color: '#000' }}
                  >
                    Create ${ticker ?? 'NAME'} token + room
                  </button>
                )}
              </>
            )}
            {tokenMsg && (
              <p className="text-xs" style={{ color: GRAY }}>
                {tokenMsg}
              </p>
            )}
          </div>
        ) : null}
        <SendConfirmation
          show={confirming}
          theme={theme}
          lineItems={[
            // SendConfirmation truncates labels over 16 characters: keep them short.
            {
              address: `$${ticker ?? 'NAME'} + room`.slice(0, 16),
              amount: `${Number(supply || 0).toLocaleString()} tokens`,
            },
            { address: 'Curve (fixed)', amount: `${usd(curve.floorUsd)} → ${usd(maxPrice(curve))}` },
            { address: 'Network fee', amount: `~${moneyNow(PERSONAL_NETWORK_FEE_SATS)}` },
          ]}
          total={`~${moneyNow(PERSONAL_FEE_ESTIMATE_SATS)}`}
          isProcessing={busy}
          onConfirm={() => void mintToken()}
          onCancel={() => setConfirming(false)}
        />
        <SendConfirmation
          show={importing}
          theme={theme}
          lineItems={[
            {
              address: `Import $${choice?.kind === 'import' ? choice.token.sym.replace(/^\$/, '') : ''}`.slice(0, 16),
              amount: 'Signature',
            },
          ]}
          total="Free"
          isProcessing={busy}
          onConfirm={() => void importToken()}
          onCancel={() => setImporting(false)}
        />
      </div>
    </div>,
    document.body,
  );
};
