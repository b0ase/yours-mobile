import { ReactNode, useRef, useState } from 'react';
import { Snackbar } from '../../components/Snackbar';
import { useTheme } from '../../hooks/useTheme';
import { SNACKBAR_TIMEOUT } from '../../utils/constants';
import { SnackbarContext, SnackbarType } from '../SnackbarContext';
import { snackbarDuration } from './snackbarTiming';

interface SnackbarProviderProps {
  children: ReactNode;
}

export const SnackbarProvider = (props: SnackbarProviderProps) => {
  const { children } = props;
  const { theme } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(SNACKBAR_TIMEOUT);
  const [snackBarType, setSnackBarType] = useState<SnackbarType | null>(null);
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    setMessage(null);
    setSnackBarType(null);
    setDuration(SNACKBAR_TIMEOUT);
    setHeld(false);
  };
  const schedule = (ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(clear, ms);
  };

  const addSnackbar = (msg: string, type: SnackbarType, dur?: number) => {
    const ms = snackbarDuration(type, dur, SNACKBAR_TIMEOUT);
    setMessage(msg);
    setSnackBarType(type);
    setDuration(ms);
    setHeld(false);
    schedule(ms);
  };

  // Pointer over the snackbar: keep it up so its text can be read, selected and copied.
  const hold = () => {
    if (timer.current) clearTimeout(timer.current);
    setHeld(true);
  };
  const release = () => {
    setHeld(false);
    schedule(3000);
  };

  return (
    <SnackbarContext.Provider value={{ message, snackBarType, addSnackbar }}>
      {message && (
        <Snackbar
          theme={theme}
          message={message}
          type={snackBarType}
          duration={duration}
          held={held}
          onHold={hold}
          onRelease={release}
          onDismiss={() => {
            if (timer.current) clearTimeout(timer.current);
            clear();
          }}
        />
      )}
      {children}
    </SnackbarContext.Provider>
  );
};
