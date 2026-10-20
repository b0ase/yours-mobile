import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, Loader2 } from 'lucide-react';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { sendMessage } from '../../utils/chromeHelpers';
import { joinPhrases, protocolLabel, readOnlyProtocolPhrase, spendAmount } from '../../utils/protocols';
import { cachedExchangeRate } from '../../utils/exchangeRate';
import { isReservedProtocol } from '../../services/reservedProtocols';
import type {
  GroupedPermissionRequest as GroupedPermissionRequestType,
  GroupedPermissions,
} from '@bsv/wallet-toolbox-client';
import { useServiceContext } from '../../hooks/useServiceContext';
import { confirmUsbForApproval } from '../../services/usbPresence';

export type GroupedPermissionRequestProps = {
  request: GroupedPermissionRequestType;
  onResponse: () => void;
};

export const GroupedPermissionRequestPage = (props: GroupedPermissionRequestProps) => {
  const { request, onResponse } = props;
  const { theme } = useTheme();
  const { handleSelect, hideMenu } = useBottomMenu();
  const { addSnackbar } = useSnackbar();
  const [isProcessing, setIsProcessing] = useState(false);
  const [usbError, setUsbError] = useState('');
  const { chromeStorageService } = useServiceContext();
  const { permissions } = request;

  // Protocol access lets the app sign with keys derived from your wallet: never pre-ticked (audit C1).
  const [protocolChecked, setProtocolChecked] = useState<boolean[]>(() =>
    (permissions.protocolPermissions ?? []).map(() => false),
  );
  const [basketChecked, setBasketChecked] = useState<boolean[]>(() => (permissions.basketAccess ?? []).map(() => true));
  const [certChecked, setCertChecked] = useState<boolean[]>(() =>
    (permissions.certificateAccess ?? []).map(() => true),
  );
  // Ticked by default (owner, 9 Oct 2026): connecting sets the app's allowance in the same tap.
  const [spendingChecked, setSpendingChecked] = useState(true);

  const [showDetails, setShowDetails] = useState(false);

  // Ordinary, read-only request (today: just the public ID): one sentence and one button, no checkboxes.
  // The wording comes from the wallet's own table, never from the site (utils/protocols.ts).
  const protocolList = permissions.protocolPermissions ?? [];
  const readPhrases = protocolList.map((p) => readOnlyProtocolPhrase(p.protocolID));
  const simple =
    protocolList.length > 0 &&
    readPhrases.every(Boolean) &&
    protocolList.every((p) => !isReservedProtocol(p.protocolID)) &&
    !permissions.spendingAuthorization &&
    !permissions.basketAccess?.length &&
    !permissions.certificateAccess?.length;

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  const buildGranted = (): Partial<GroupedPermissions> => {
    const granted: Partial<GroupedPermissions> = {};
    const checkedProtocols = (permissions.protocolPermissions ?? []).filter(
      (p, i) => (simple || protocolChecked[i]) && !isReservedProtocol(p.protocolID),
    );
    if (checkedProtocols.length > 0) granted.protocolPermissions = checkedProtocols;
    const checkedBaskets = (permissions.basketAccess ?? []).filter((_, i) => basketChecked[i]);
    if (checkedBaskets.length > 0) granted.basketAccess = checkedBaskets;
    const checkedCerts = (permissions.certificateAccess ?? []).filter((_, i) => certChecked[i]);
    if (checkedCerts.length > 0) granted.certificateAccess = checkedCerts;
    if (spendingChecked && permissions.spendingAuthorization) {
      granted.spendingAuthorization = permissions.spendingAuthorization;
    }
    return granted;
  };

  const handleGrant = async () => {
    setIsProcessing(true);
    setUsbError('');
    try {
      const usb = await confirmUsbForApproval(chromeStorageService);
      if (!usb.ok) {
        setUsbError(usb.message);
        setIsProcessing(false);
        return;
      }
      sendMessage({
        action: 'GROUPED_PERMISSION_RESPONSE',
        requestID: request.requestID,
        granted: buildGranted(),
      });
      onResponse();
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : String(error), 'error');
      setIsProcessing(false);
    }
  };

  const handleDeny = async () => {
    setIsProcessing(true);
    sendMessage({
      action: 'GROUPED_PERMISSION_RESPONSE',
      requestID: request.requestID,
      granted: null,
    });
    onResponse();
  };

  const toggleProtocol = (i: number) => setProtocolChecked((prev) => prev.map((v, j) => (j === i ? !v : v)));
  const toggleBasket = (i: number) => setBasketChecked((prev) => prev.map((v, j) => (j === i ? !v : v)));
  const toggleCert = (i: number) => setCertChecked((prev) => prev.map((v, j) => (j === i ? !v : v)));

  if (simple) {
    return (
      <motion.div
        className="flex flex-col items-center w-full px-5 pt-8 pb-5 overflow-y-auto text-center"
        style={{ maxHeight: '100vh' }}
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', damping: 24, stiffness: 260 }}
      >
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 text-2xl font-extrabold"
          style={{ background: 'rgba(245,184,0,0.14)', color: '#F5B800', border: '1px solid rgba(245,184,0,0.35)' }}
          aria-hidden="true"
        >
          {request.originator
            .replace(/^www\./, '')
            .charAt(0)
            .toUpperCase()}
        </div>
        <h1 className="text-lg font-bold leading-snug mb-2" style={{ color: theme.color.global.contrast }}>
          {request.originator} wants to {joinPhrases(readPhrases as string[])}
        </h1>
        <p className="text-sm mb-1" style={{ color: theme.color.global.gray }}>
          It can&rsquo;t spend anything.
        </p>
        <p
          className="text-xs font-semibold px-3 py-1 rounded-full mb-6"
          style={{ background: 'rgba(161,255,139,0.12)', color: '#A1FF8B' }}
        >
          Read only
        </p>
        {usbError && (
          <p className="text-xs m-0 mb-2" style={{ color: '#ef4444' }}>
            {usbError}
          </p>
        )}
        <motion.button
          className="w-full py-4 rounded-2xl font-bold text-base flex items-center justify-center gap-2 mb-3"
          style={{
            background: 'linear-gradient(135deg, #F5B800 0%, #FFD24D 100%)',
            color: '#050505',
            opacity: isProcessing ? 0.6 : 1,
          }}
          disabled={isProcessing}
          onClick={handleGrant}
          whileTap={{ scale: isProcessing ? 1 : 0.97 }}
          transition={{ type: 'spring', damping: 20, stiffness: 400 }}
        >
          {isProcessing && <Loader2 size={14} className="animate-spin" />}
          Allow
        </motion.button>
        <button
          className="w-full py-3 rounded-xl text-sm"
          style={{ background: 'transparent', color: theme.color.global.gray, opacity: isProcessing ? 0.5 : 1 }}
          disabled={isProcessing}
          onClick={handleDeny}
        >
          Deny
        </button>
        <button
          className="text-xs mt-4 underline"
          style={{ color: theme.color.global.gray, background: 'transparent' }}
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
        >
          {showDetails ? 'Hide details' : 'Details'}
        </button>
        <Show when={showDetails}>
          <div
            className="w-full rounded-xl px-4 py-3 mt-3 text-left text-xs leading-relaxed"
            style={{ background: theme.color.global.row, color: theme.color.global.gray }}
          >
            {protocolList.map((p, i) => (
              <p key={`detail-${i}`} className="m-0 mb-2">
                Protocol &ldquo;{protocolLabel(p.protocolID)}&rdquo; (level {p.protocolID[0]}). Any app that asks for
                this protocol gets the same keys.
                {p.description ? ` App says: \u201C${p.description}\u201D` : ''}
              </p>
            ))}
            {permissions.description && <p className="m-0">App says: &ldquo;{permissions.description}&rdquo;</p>}
          </div>
        </Show>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="flex flex-col w-full px-4 pt-5 pb-4 overflow-y-auto"
      style={{ maxHeight: '100vh' }}
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', damping: 24, stiffness: 260 }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(161,255,139,0.12)' }}
        >
          <Shield size={18} style={{ color: '#A1FF8B' }} />
        </div>
        <div>
          <h1 className="text-base font-bold leading-tight" style={{ color: theme.color.global.contrast }}>
            Permission Request
          </h1>
          <p className="text-xs mt-0.5" style={{ color: theme.color.global.gray }}>
            <span className="font-semibold" style={{ color: theme.color.global.contrast }}>
              {request.originator}
            </span>{' '}
            is requesting the following permissions
          </p>
        </div>
      </div>

      {/* Description */}
      <Show when={!!permissions.description}>
        <p className="text-xs mb-3 leading-relaxed" style={{ color: theme.color.global.gray }}>
          {permissions.description}
        </p>
      </Show>

      {/* Spending authorization — shown separately above the list, ticked by default */}
      <Show when={!!permissions.spendingAuthorization}>
        <motion.div
          className="w-full rounded-2xl px-4 py-3 mb-3"
          style={{
            background: 'rgba(247,144,9,0.08)',
            border: '1px solid rgba(247,144,9,0.2)',
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
        >
          <p className="text-xs font-bold uppercase tracking-wider pb-1" style={{ color: '#F79009' }}>
            Spending Authorization
          </p>
          <label className="flex items-start gap-3 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={spendingChecked}
              onChange={() => setSpendingChecked(!spendingChecked)}
              className="mt-0.5 accent-orange-400"
            />
            <div className="flex flex-col min-w-0">
              <span className="flex flex-col">
                <span className="text-xs font-semibold" style={{ color: '#F79009' }}>
                  This app wants to spend up to
                </span>
                <span className="text-2xl font-extrabold leading-tight" style={{ color: '#F79009' }}>
                  {spendAmount(permissions.spendingAuthorization?.amount ?? 0, cachedExchangeRate()).primary}
                </span>
                {spendAmount(permissions.spendingAuthorization?.amount ?? 0, cachedExchangeRate()).secondary && (
                  <span className="text-xs opacity-80" style={{ color: '#F79009' }}>
                    {spendAmount(permissions.spendingAuthorization?.amount ?? 0, cachedExchangeRate()).secondary}
                  </span>
                )}
              </span>
              {permissions.spendingAuthorization?.description && (
                <span className="text-xs mt-1 opacity-70" style={{ color: theme.color.global.contrast }}>
                  App says: &ldquo;{permissions.spendingAuthorization.description}&rdquo;
                </span>
              )}
            </div>
          </label>
        </motion.div>
      </Show>

      {/* Permissions list */}
      <motion.div
        className="w-full rounded-2xl px-4 py-2 mb-5"
        style={{
          background: theme.color.global.row,
          border: '1px solid rgba(255,255,255,0.06)',
          maxHeight: '16rem',
          overflowY: 'auto',
        }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
      >
        {/* Protocols */}
        <Show when={!!permissions.protocolPermissions?.length}>
          <p
            className="text-xs font-bold uppercase tracking-wider pt-3 pb-1"
            style={{ color: theme.color.global.gray }}
          >
            Protocols
          </p>
          {permissions.protocolPermissions?.map((p, i) =>
            isReservedProtocol(p.protocolID) ? (
              <p key={`proto-${i}`} className="text-xs py-2" style={{ color: theme.color.global.gray }}>
                Refused: “{p.protocolID[1]}” is used only by bWalletX itself.
              </p>
            ) : (
              <label
                key={`proto-${i}`}
                className="flex items-start gap-3 py-2 cursor-pointer"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <input
                  type="checkbox"
                  checked={protocolChecked[i]}
                  onChange={() => toggleProtocol(i)}
                  className="mt-0.5 accent-green-400"
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium" style={{ color: theme.color.global.contrast }}>
                    Let this app sign and encrypt with your keys for “{protocolLabel(p.protocolID)}”
                    {p.counterparty ? ` (shared with ${p.counterparty.slice(0, 10)}…)` : ''}
                  </span>
                  <span className="text-xs mt-0.5 opacity-60" style={{ color: theme.color.global.contrast }}>
                    Any app that asks for this protocol gets the same keys (level {p.protocolID[0]}).
                  </span>
                  {p.description && (
                    <span className="text-xs mt-0.5 opacity-60" style={{ color: theme.color.global.contrast }}>
                      {p.description}
                    </span>
                  )}
                </div>
              </label>
            ),
          )}
        </Show>

        {/* Baskets */}
        <Show when={!!permissions.basketAccess?.length}>
          <p
            className="text-xs font-bold uppercase tracking-wider pt-3 pb-1"
            style={{ color: theme.color.global.gray }}
          >
            Baskets
          </p>
          {permissions.basketAccess?.map((b, i) => (
            <label
              key={`basket-${i}`}
              className="flex items-start gap-3 py-2 cursor-pointer"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
            >
              <input
                type="checkbox"
                checked={basketChecked[i]}
                onChange={() => toggleBasket(i)}
                className="mt-0.5 accent-green-400"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium" style={{ color: theme.color.global.contrast }}>
                  {b.basket}
                </span>
                {b.description && (
                  <span className="text-xs mt-0.5 opacity-60" style={{ color: theme.color.global.contrast }}>
                    {b.description}
                  </span>
                )}
              </div>
            </label>
          ))}
        </Show>

        {/* Certificates */}
        <Show when={!!permissions.certificateAccess?.length}>
          <p
            className="text-xs font-bold uppercase tracking-wider pt-3 pb-1"
            style={{ color: theme.color.global.gray }}
          >
            Certificates
          </p>
          {permissions.certificateAccess?.map((c, i) => (
            <label
              key={`cert-${i}`}
              className="flex items-start gap-3 py-2 cursor-pointer"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
            >
              <input
                type="checkbox"
                checked={certChecked[i]}
                onChange={() => toggleCert(i)}
                className="mt-0.5 accent-green-400"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium" style={{ color: theme.color.global.contrast }}>
                  {c.type}
                </span>
                <span className="text-xs mt-0.5 opacity-60" style={{ color: theme.color.global.contrast }}>
                  {c.description} — fields: {c.fields.join(', ')}
                </span>
              </div>
            </label>
          ))}
        </Show>
      </motion.div>

      {/* Actions */}
      <div className="flex flex-col gap-3">
        {usbError && (
          <p className="text-xs text-center m-0" style={{ color: '#ef4444' }}>
            {usbError}
          </p>
        )}
        <motion.button
          className="w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
          style={{
            background: 'linear-gradient(135deg, #A1FF8B 0%, #34D399 100%)',
            color: '#010101',
            opacity: isProcessing ? 0.6 : 1,
          }}
          disabled={isProcessing}
          onClick={handleGrant}
          whileHover={{ scale: isProcessing ? 1 : 1.02 }}
          whileTap={{ scale: isProcessing ? 1 : 0.97 }}
          transition={{ type: 'spring', damping: 20, stiffness: 400 }}
        >
          {isProcessing && <Loader2 size={14} className="animate-spin" />}
          Allow Selected
        </motion.button>

        <motion.button
          className="w-full py-3.5 rounded-xl font-semibold text-sm"
          style={{
            background: 'transparent',
            color: theme.color.global.gray,
            border: '1px solid rgba(255,255,255,0.1)',
            opacity: isProcessing ? 0.5 : 1,
          }}
          disabled={isProcessing}
          onClick={handleDeny}
          whileHover={{ scale: isProcessing ? 1 : 1.02 }}
          whileTap={{ scale: isProcessing ? 1 : 0.97 }}
          transition={{ type: 'spring', damping: 20, stiffness: 400 }}
        >
          Deny All
        </motion.button>
      </div>
    </motion.div>
  );
};
