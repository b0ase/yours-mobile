import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Loader2, Shield } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { confirmUsbForApproval } from '../../services/usbPresence';
import {
  ALLOWANCE_CHOICES_USD,
  buildSheetModel,
  DEFAULT_ALLOWANCE_USD,
  sheetCanTrust,
  type BundleRequest,
} from '../../services/permissionBundle';

/**
 * One sheet per action (docs/ONE-SHEET-PERMISSIONS.md §3c): everything a site asks for in one action,
 * in plain words, ticked by default (risky lines never are), with one button. Used in the side panel,
 * the prompt window, the in-page sheet and the phone overlay alike: all of them load prompt.html.
 */
export type BundlePayload = { bundleID: string; originator: string; items: BundleRequest[] };

type Allowance = { usdPerBsv?: number; existingSats?: number; defaultUsd: number };

const RED = '#F04438';
const GREEN = '#A1FF8B';

const fmtUsd = (usd: number) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);
const fmtSats = (sats: number) => (sats >= 1e8 ? `${(sats / 1e8).toFixed(8)} BSV` : `${sats.toLocaleString()} sats`);

export const BundleSheet = (props: {
  request: BundlePayload;
  onResponse: () => void;
  /** In-page sheet: buttons stay off until the sheet is confirmed visible (clickjacking guard). */
  armed?: boolean;
}) => {
  const { request, onResponse, armed = true } = props;
  const { theme } = useTheme();
  const { handleSelect, hideMenu } = useBottomMenu();
  const { addSnackbar } = useSnackbar();
  const { chromeStorageService } = useServiceContext();
  const model = useMemo(() => buildSheetModel(request), [request]);

  // Ticks keyed by requestID so lines that join mid-sheet get their default without resetting the rest.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const firstCount = useRef(request.items.length);
  const added = Math.max(0, request.items.length - firstCount.current);
  const isChecked = (id: string, dflt: boolean) => checked[id] ?? dflt;

  const [allowance, setAllowance] = useState<Allowance | undefined>();
  const [allowanceUsd, setAllowanceUsd] = useState<number>(DEFAULT_ALLOWANCE_USD);
  const [allowanceOn, setAllowanceOn] = useState(true);
  const [remember, setRemember] = useState(true);
  // "Don't ask again": later sign-in, signing and basket requests from this site need no sheet.
  const canTrust = useMemo(() => sheetCanTrust(request), [request]);
  const [trustSite, setTrustSite] = useState(true);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usbError, setUsbError] = useState('');

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  useEffect(() => {
    sendMessageAsync<{ success: boolean; data?: Allowance }>({
      action: 'GET_BUNDLE_ALLOWANCE',
      originator: request.originator,
    })
      .then((res) => {
        if (!res?.success || !res.data) return;
        setAllowance(res.data);
        setAllowanceUsd(res.data.defaultUsd);
      })
      .catch(() => undefined);
  }, [request.originator]);

  // The allowance line shows when the price is known and the site has none yet.
  const showAllowance = !!allowance?.usdPerBsv && allowance.existingSats === undefined;
  const payUsd = model.payment && allowance?.usdPerBsv ? (model.payment.satoshis / 1e8) * allowance.usdPerBsv : undefined;

  const send = async (approve: boolean) => {
    setBusy(true);
    setUsbError('');
    try {
      if (approve) {
        const usb = await confirmUsbForApproval(chromeStorageService);
        if (!usb.ok) {
          setUsbError(usb.message);
          setBusy(false);
          return;
        }
      }
      const decisions: Record<string, boolean> = {};
      for (const l of model.lines) decisions[l.requestID] = approve && isChecked(l.requestID, l.checked);
      if (model.payment) decisions[model.payment.requestID] = approve;
      await sendMessageAsync({
        action: 'BUNDLE_PERMISSION_RESPONSE',
        bundleID: request.bundleID,
        decisions,
        allowanceUsd: approve && showAllowance && allowanceOn ? allowanceUsd : 0,
        remember,
        trustSite: approve && remember && canTrust && trustSite,
      });
      onResponse();
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : String(error), 'error');
      setBusy(false);
    }
  };

  const title = model.mode === 'pay' ? 'asks you to pay' : 'wants to connect';
  const many = model.lines.length + (model.payment ? 1 : 0) > 1;
  const primary =
    model.mode === 'pay'
      ? 'Pay'
      : model.mode === 'connectAndPay'
        ? many
          ? 'Allow all & pay'
          : 'Connect & pay'
        : many
          ? 'Allow all'
          : 'Connect';
  const nextAllowance = () => {
    const i = ALLOWANCE_CHOICES_USD.indexOf(allowanceUsd as (typeof ALLOWANCE_CHOICES_USD)[number]);
    const next = ALLOWANCE_CHOICES_USD[(i + 1) % ALLOWANCE_CHOICES_USD.length];
    setAllowanceUsd(next);
    setAllowanceOn(next > 0);
  };
  const disabled = busy || !armed;
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;

  return (
    <motion.div
      className="flex flex-col w-full px-4 pt-5 pb-4 overflow-y-auto"
      style={{ maxHeight: '100vh' }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', damping: 24, stiffness: 260 }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(161,255,139,0.12)' }}
        >
          <Shield size={18} style={{ color: GREEN }} />
        </div>
        <p className="text-sm leading-snug m-0" style={{ color: gray }}>
          <span className="font-bold" style={{ color: contrast }}>
            {request.originator}
          </span>{' '}
          {title}
        </p>
      </div>

      {added > 0 && (
        <p className="text-xs mb-2 m-0" style={{ color: GREEN }}>
          +{added} more added while this was open
        </p>
      )}

      <div
        className="w-full rounded-2xl px-3 py-1 mb-3"
        style={{ background: theme.color.global.row, border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {model.lines.map((l) => (
          <label key={l.requestID} className="flex items-start gap-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isChecked(l.requestID, l.checked)}
              onChange={() => setChecked((c) => ({ ...c, [l.requestID]: !isChecked(l.requestID, l.checked) }))}
              className="mt-0.5 accent-green-400"
            />
            <span className="text-xs" style={{ color: l.risky ? RED : contrast }}>
              {l.text}
            </span>
          </label>
        ))}
        {showAllowance && (
          <div className="flex items-start gap-3 py-2">
            <input
              type="checkbox"
              checked={allowanceOn && allowanceUsd > 0}
              onChange={() => {
                if (allowanceUsd === 0) setAllowanceUsd(DEFAULT_ALLOWANCE_USD);
                setAllowanceOn(!(allowanceOn && allowanceUsd > 0));
              }}
              className="mt-0.5 accent-green-400"
              aria-label="Monthly allowance"
            />
            <span className="text-xs flex-1" style={{ color: contrast }}>
              {allowanceUsd > 0 ? `Spend up to ${fmtUsd(allowanceUsd)} a month without asking` : 'Ask me before every payment'}
            </span>
            <button
              type="button"
              className="text-xs border-0 bg-transparent p-0 underline"
              style={{ color: gray }}
              onClick={nextAllowance}
            >
              change
            </button>
          </div>
        )}
      </div>

      {model.payment && (
        <div
          className="w-full rounded-2xl px-3 py-2 mb-3"
          style={{ background: 'rgba(161,255,139,0.06)', border: '1px solid rgba(161,255,139,0.2)' }}
        >
          <p className="text-xs font-bold uppercase tracking-wider m-0 pb-1" style={{ color: gray }}>
            Pay now
          </p>
          <p className="text-sm font-semibold m-0" style={{ color: GREEN }}>
            {payUsd !== undefined ? fmtUsd(payUsd) : fmtSats(model.payment.satoshis)}{' '}
            <span className="font-normal" style={{ color: contrast }}>
              to {request.originator}
            </span>
          </p>
          {model.payment.description && (
            <p className="text-xs m-0 mt-0.5" style={{ color: gray }}>
              &ldquo;{model.payment.description}&rdquo;
            </p>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 mb-3 cursor-pointer">
        <input type="checkbox" checked={remember} onChange={() => setRemember(!remember)} className="accent-green-400" />
        <span className="text-xs" style={{ color: gray }}>
          Remember this site
        </span>
      </label>
      {canTrust && remember && (
        <label className="flex items-start gap-2 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={trustSite}
            onChange={() => setTrustSite(!trustSite)}
            className="mt-0.5 accent-green-400"
          />
          <span className="text-xs" style={{ color: gray }}>
            Don&apos;t ask again on {request.originator} for sign-in and signing. Payments stay within the allowance;
            your personal details always ask.
          </span>
        </label>
      )}

      {usbError && (
        <p className="text-xs text-center m-0 mb-2" style={{ color: RED }}>
          {usbError}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          className="flex-1 py-3 rounded-xl font-semibold text-sm"
          style={{ background: 'transparent', color: gray, border: '1px solid rgba(255,255,255,0.1)' }}
          disabled={disabled}
          onClick={() => void send(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="flex-[2] py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
          style={{
            background: 'linear-gradient(135deg, #A1FF8B 0%, #34D399 100%)',
            color: '#010101',
            opacity: disabled ? 0.6 : 1,
          }}
          disabled={disabled}
          onClick={() => void send(true)}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {primary}
        </button>
      </div>

      <button
        type="button"
        className="flex items-center gap-1 mt-3 text-xs border-0 bg-transparent p-0"
        style={{ color: gray }}
        onClick={() => setDetails(!details)}
      >
        {details ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Details
      </button>
      {details && (
        <ul className="text-[11px] mt-1 pl-4 break-all" style={{ color: gray }}>
          {model.payment && <li>pay: {model.payment.detail}</li>}
          {model.lines.map((l) => (
            <li key={l.requestID}>{l.detail}</li>
          ))}
          {showAllowance && allowanceOn && allowanceUsd > 0 && (
            <li>allowance: monthly spending cap for {request.originator}</li>
          )}
        </ul>
      )}
    </motion.div>
  );
};
