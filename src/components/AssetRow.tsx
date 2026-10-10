import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTheme } from '../hooks/useTheme';
import { formatLargeNumber, formatUSD } from '../utils/format';
import { Show } from './Show';
import { BSV_DECIMAL_CONVERSION } from '../utils/constants';

/** `icon`: render as a compact round icon button with `label` as aria-label and tooltip (PNEEs' lock, 10 Oct 2026). */
type Action = { label: string; onClick: () => void; icon?: ReactNode };

const IconButton = ({ action }: { action: Action }) => (
  <button
    type="button"
    aria-label={action.label}
    title={action.label}
    onClick={(e) => {
      e.stopPropagation();
      action.onClick();
    }}
    className="flex-shrink-0 w-10 h-10 mr-2 max-[379px]:mr-1.5 rounded-full border flex items-center justify-center bg-transparent cursor-pointer"
    style={{ borderColor: '#F5B800', color: '#F5B800' }}
  >
    {action.icon}
  </button>
);

// Yours' "Get MNEE" button: same size, inset and centring (owner, 6 Oct 2026). Outlined for the secondary action.
const GradientButton = ({
  action,
  theme,
  outlined = false,
}: {
  action: Action;
  theme: ReturnType<typeof useTheme>['theme'];
  outlined?: boolean;
}) => (
  <motion.button
    type="button"
    whileHover={{ scale: 1.03 }}
    whileTap={{ scale: 0.97 }}
    onClick={(e) => {
      e.stopPropagation();
      action.onClick();
    }}
    className={`text-xs font-bold px-4 py-2 rounded-xl cursor-pointer outline-none ${outlined ? 'border bg-transparent' : 'border-0 min-w-[7rem] max-[379px]:min-w-0 max-[379px]:px-3'}`}
    style={
      outlined
        ? { borderColor: '#F5B80088', color: '#F5B800' }
        : { background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: theme.color.global.row }
    }
  >
    {action.label}
  </motion.button>
);

export type AssetRowProps = {
  icon: string;
  ticker: string;
  balance: number;
  usdBalance: number;
  showPointer: boolean;
  isMNEE?: boolean;
  animate?: boolean;
  isLock?: boolean;
  nextUnlock?: number;
  /** Decimal places for balance display. Defaults to 3. */
  decimals?: number;
  onGetMneeClick?: () => void;
  onClick?: () => void;
  /** Extra line under "Balance" (e.g. the token's issuer badge). */
  subline?: ReactNode;
  /** Gold button on the right (Get MNEE, Get PNEEs): in place of the balance at zero, under it otherwise. */
  action?: Action;
  /** An outlined button beside `action`, on its left (Back PNEEs next to Get PNEEs). */
  secondaryAction?: Action;
};

export const AssetRow = (props: AssetRowProps) => {
  const {
    icon,
    ticker,
    balance,
    usdBalance,
    isLock,
    nextUnlock,
    onClick,
    isMNEE,
    showPointer,
    onGetMneeClick,
    animate = false,
    decimals,
    subline,
    action,
    secondaryAction,
  } = props;
  // "Get MNEE", worded and placed as in Yours (owner, 6 Oct 2026).
  const button = action ?? (isMNEE && onGetMneeClick ? { label: 'Get MNEE', onClick: onGetMneeClick } : undefined);
  const { theme } = useTheme();
  const isDisplaySat = isLock && balance < 0.0001;
  const displayDecimals = decimals ?? (isDisplaySat ? 0 : 3);
  // At zero the buttons replace the balance, centred like Yours' Get MNEE.
  const showButtonsOnly = !!button && balance === 0;
  // An icon secondary action sits on its own between the name and the right column, so it never covers the name.
  const iconAction = secondaryAction?.icon ? secondaryAction : undefined;
  const textSecondary = iconAction ? undefined : secondaryAction;

  return (
    <motion.div
      whileHover={animate ? { scale: 1.015, x: 2 } : {}}
      whileTap={showPointer ? { scale: 0.985 } : {}}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="flex flex-wrap items-center justify-between w-[92%] mx-auto rounded-xl px-0 py-3 mb-1.5"
      style={{
        backgroundColor: theme.color.global.row,
        cursor: showPointer ? 'pointer' : 'default',
        border: `1px solid ${theme.color.global.gray}14`,
      }}
      onClick={onClick}
    >
      {/* Left: icon + name */}
      <div className="flex items-center flex-1 min-w-0 ml-3">
        <Show when={!!icon && icon.length > 0}>
          <img src={icon} className="w-9 h-9 rounded-full object-cover flex-shrink-0" alt={ticker} />
        </Show>
        <div className="flex flex-col items-start ml-3 min-w-0">
          <span className="text-sm font-semibold leading-tight max-w-full truncate" style={{ color: theme.color.global.contrast }}>
            {ticker}
          </span>
          {/* One line under the name on every card (issuer badge replaces "Balance"), so cards match in height. */}
          {subline ?? (
            <span className="text-xs mt-0.5" style={{ color: theme.color.global.gray }}>
              {isLock ? 'Next unlock' : 'Balance'}
            </span>
          )}
        </div>
      </div>

      {iconAction && <IconButton action={iconAction} />}

      {/* Right: balance */}
      <Show
        when={showButtonsOnly}
        whenFalseContent={
          <div className="flex flex-col items-end mr-3 min-w-0 max-w-[45%]">
            <span
              className="text-sm font-semibold text-right leading-tight"
              style={{ color: theme.color.global.contrast }}
            >
              {`${formatLargeNumber(
                isDisplaySat ? balance * BSV_DECIMAL_CONVERSION : balance,
                displayDecimals,
              )}${isLock ? (isDisplaySat ? `${balance === 0.00000001 ? ' SAT' : ' SATS'}` : ' BSV') : ''}`}
            </span>
            {button ? (
              <div className="flex items-center gap-1.5 mt-1">
                {textSecondary && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      textSecondary.onClick();
                    }}
                    className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border cursor-pointer bg-transparent"
                    style={{ borderColor: '#F5B80088', color: '#F5B800' }}
                  >
                    {textSecondary.label}
                  </button>
                )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  button.onClick();
                }}
                className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border-0 cursor-pointer"
                style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
              >
                {button.label}
              </button>
              </div>
            ) : (
              <span className="text-xs mt-0.5 text-right" style={{ color: theme.color.global.gray }}>
                {isLock ? `Block ${nextUnlock}` : formatUSD(usdBalance)}
              </span>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-2 mr-3">
          {textSecondary && <GradientButton action={textSecondary} theme={theme} outlined />}
          {button && <GradientButton action={button} theme={theme} />}
        </div>
      </Show>
    </motion.div>
  );
};
