import React, { useEffect, useState } from 'react';
import { markSiteConnected } from '../../mobile/theme/connectSiteTheme';
import { motion } from 'framer-motion';
import { LogIn, Loader2 } from 'lucide-react';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { sendMessage } from '../../utils/chromeHelpers';
import { protocolLabel } from '../../utils/protocols';
import { isReservedProtocol } from '../../services/reservedProtocols';
import type {
  GroupedPermissionRequest as GroupedPermissionRequestType,
  GroupedPermissions,
} from '@bsv/wallet-toolbox-client';
import { useServiceContext } from '../../hooks/useServiceContext';
import { confirmUsbForApproval } from '../../services/usbPresence';
import { SiteThemeOffer } from '../../mobile/theme/SiteThemeOffer';
import { familySite } from '../../mobile/theme/themeSites';
import { accountNamesFor } from '../../mobile/names/accountNames';
import { basketDisplayName } from '../../services/reservedBaskets';

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
  const themeAccount = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const { permissions } = request;

  // One plain sentence and one button (owner, 28 Oct 2026: "USERS WANT CLARITY! NOT TINY CHECKBOXES"). Signing in
  // grants a fixed default bundle: the site's own (non-reserved) protocols and baskets. Certificates and a spending
  // allowance are never in it; the site asks for those later, each on its own sheet. Reserved protocols stay refused.
  const account = chromeStorageService.getCurrentAccountObject().account;
  const rawHandle = accountNamesFor(account?.addresses?.identityAddress, account?.name ?? '').payable?.trim() ?? '';
  const handle = rawHandle ? (rawHandle.startsWith('$') ? rawHandle : `$${rawHandle}`) : '';
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  const buildGranted = (): Partial<GroupedPermissions> => {
    const granted: Partial<GroupedPermissions> = {};
    const protocols = (permissions.protocolPermissions ?? []).filter((p) => !isReservedProtocol(p.protocolID));
    if (protocols.length > 0) granted.protocolPermissions = protocols;
    if (permissions.basketAccess?.length) granted.basketAccess = permissions.basketAccess;
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
      markSiteConnected(request.originator); // its sheets may now wear its theme (docs/SITE-THEME.md)
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

  const protos = (permissions.protocolPermissions ?? []).filter((p) => !isReservedProtocol(p.protocolID));
  const host = request.originator.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
  const title = `${host} wants to sign you in${handle ? ` as ${handle}` : ''}`;
  const included = [
    ...protos.map((p) => `Use your keys for “${protocolLabel(p.protocolID)}”`),
    ...(permissions.basketAccess ?? []).map((b) => `See its own items in “${basketDisplayName(b.basket)}”`),
  ];

  return (
    <motion.div
      className="flex flex-col w-full px-4 pt-5 pb-4 overflow-y-auto"
      style={{ maxHeight: '100vh' }}
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', damping: 24, stiffness: 260 }}
    >
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
        style={{ background: 'rgba(161,255,139,0.12)' }}
      >
        <LogIn size={22} style={{ color: '#A1FF8B' }} />
      </div>
      <h1
        className="text-xl font-bold leading-snug text-center break-words"
        style={{ color: theme.color.global.contrast }}
        data-testid="connect-title"
      >
        {title}
      </h1>
      <p className="text-xs mt-2 text-center break-all" style={{ color: theme.color.global.gray }}>
        Request from{' '}
        <span className="font-semibold" style={{ color: theme.color.global.contrast }}>
          {request.originator}
        </span>
      </p>
      <p className="text-sm mt-4 text-center leading-relaxed" style={{ color: theme.color.global.gray }}>
        Nothing is spent. If {host} later wants anything more, bWalletX will ask you then.
      </p>

      {/* A family site may offer its colours (mobile/theme/siteTheme.ts): a separate tap, never part of the grant. */}
      <SiteThemeOffer site={familySite(request.originator)} account={themeAccount} style={{ marginTop: 12 }} />

      <Show when={included.length > 0}>
        <button
          type="button"
          className="text-xs mt-4 underline self-center"
          style={{ color: theme.color.global.gray, background: 'transparent' }}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Hide details' : 'What does signing in allow?'}
        </button>
        <Show when={showDetails}>
          <ul className="text-xs mt-2 leading-relaxed list-disc pl-5" style={{ color: theme.color.global.gray }}>
            {included.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Show>
      </Show>

      <div className="flex flex-col gap-3 mt-6">
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
          whileTap={{ scale: isProcessing ? 1 : 0.97 }}
          data-testid="connect-sign-in"
        >
          {isProcessing && <Loader2 size={14} className="animate-spin" />}
          Sign in
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
          whileTap={{ scale: isProcessing ? 1 : 0.97 }}
        >
          Cancel
        </motion.button>
      </div>
    </motion.div>
  );
};
