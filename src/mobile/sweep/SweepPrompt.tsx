import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { HdSweepScreen } from './HdSweepScreen';
import { clearSweepPrompt, getSweepPrompt } from './sweepPending';

/** Opens the sweep once the new wallet exists, after Restore › SimplyCash (sweepPending.ts). */
export const SweepPrompt = () => {
  const { chromeStorageService } = useServiceContext();
  const [preset, setPreset] = useState(getSweepPrompt);
  const hasAccount = !!chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  if (!preset || !hasAccount) return null;
  return (
    <HdSweepScreen
      initialPreset={preset}
      onBack={() => {
        clearSweepPrompt();
        setPreset(null);
      }}
    />
  );
};
