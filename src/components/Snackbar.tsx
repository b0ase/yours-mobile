import { SnackbarType } from '../contexts/SnackbarContext';
import { Theme } from '../theme.types';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ErrorActions } from '../mobile/errors/ErrorActions';

export type SnackbarProps = {
  /** The message that should be displayed on the snackbar */
  message: string;
  /** The type of snackbar. success | error | info */
  type: SnackbarType | null;
  theme: Theme;
  duration?: number;
  /** Pointer is over it: the auto-dismiss is paused. */
  held?: boolean;
  onHold?: () => void;
  onRelease?: () => void;
  onDismiss?: () => void;
};

const getSnackbarConfig = (type: SnackbarType | null, theme: Theme) => {
  switch (type) {
    case 'error':
      return {
        bg: theme.color.component.snackbarError,
        textColor: theme.color.component.snackbarErrorText,
        Icon: AlertCircle,
      };
    case 'info':
      return {
        bg: theme.color.component.snackbarWarning,
        textColor: theme.color.component.snackbarWarningText,
        Icon: Info,
      };
    case 'success':
    default:
      return {
        bg: theme.color.component.snackbarSuccess,
        textColor: theme.color.component.snackbarSuccessText,
        Icon: CheckCircle2,
      };
  }
};

export const Snackbar = (props: SnackbarProps) => {
  const { message, type, theme, duration = 2500, held, onHold, onRelease, onDismiss } = props;
  const { bg, textColor, Icon } = getSnackbarConfig(type, theme);

  return (
    <motion.div
      initial={{ y: 20, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 12, opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      className="flex flex-wrap items-center gap-2.5 w-[90%] absolute bottom-0 mb-4 mx-auto left-0 right-0 rounded-xl px-4 py-3 z-[9999]"
      style={{ backgroundColor: bg }}
      onMouseEnter={onHold}
      onMouseLeave={onRelease}
      onFocus={onHold}
      role={type === 'error' ? 'alert' : 'status'}
    >
      <Icon size={18} style={{ color: textColor, flexShrink: 0 }} />
      {/* Selectable on purpose (owner, 10 Oct 2026: errors couldn't be copied). */}
      <span
        className="text-sm font-medium leading-snug flex-1 select-text cursor-text"
        style={{ color: textColor, wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {message}
      </span>
      {type === 'error' && <ErrorActions message={message} color={textColor} onAsk={onDismiss} />}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 grid place-items-center w-6 h-6 rounded-md border-0 bg-transparent cursor-pointer select-none"
        >
          <X size={14} style={{ color: textColor }} />
        </button>
      )}

      {/* Auto-dismiss progress bar */}
      <motion.div
        className="absolute bottom-0 left-0 h-0.5 rounded-b-xl"
        style={{ backgroundColor: textColor + '60', originX: 0 }}
        initial={{ scaleX: 1 }}
        animate={{ scaleX: held ? 1 : 0 }}
        transition={{ duration: held ? 0.2 : duration / 1000, ease: 'linear' }}
      />
    </motion.div>
  );
};
