import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { HdSweepScreen } from './HdSweepScreen';
import { clearSweepPrompt, getSweepPrompt } from './sweepPending';

/** Opens the sweep once the new wallet exists, after Restore › SimplyCash (sweepPending.ts). The sweep
 * tries every wallet layout itself now (6 Oct 2026), so the saved preset only says "open it". */
export const SweepPrompt = () => {
  const { chromeStorageService } = useServiceContext();
  const [preset, setPreset] = useState(getSweepPrompt);
  const hasAccount = !!chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  if (!preset || !hasAccount) return null;
  return (
    <HdSweepScreen
      onBack={() => {
        clearSweepPrompt();
        setPreset(null);
      }}
    />
  );
};
