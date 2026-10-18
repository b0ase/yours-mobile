import { useContext, useEffect, useSyncExternalStore } from 'react';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { startPotCreate } from '../agents/agentCreate';
import { sheetOverBrowser } from '../dappBrowser';
import { AppSubscribeSheet } from './AppSubscribeSheet';
import { installExtensionSubscribe } from './siteSubscribe';
import { answerSubscribeAsk, currentSubscribeAsk, watchSubscribeAsk } from './subscribeAsk';

/**
 * Renders the shared subscribe sheet (subscribeAsk.ts) for every entry point. Mounted once, app-wide, by
 * BappFrameHost (above <Router>, so it selects tabs through the context, never useNavigate). While it is up the
 * native in-app browser steps aside so the sheet is visible. The caller gates it on SUBSCRIPTIONS_ENABLED.
 */
export const AppSubscribeHost = () => {
  const req = useSyncExternalStore(watchSubscribeAsk, currentSubscribeAsk);
  const handleSelect = useContext(BottomMenuContext)?.handleSelect ?? (() => {});
  useEffect(installExtensionSubscribe, []);
  useEffect(() => {
    if (!req) return;
    sheetOverBrowser(true);
    return () => sheetOverBrowser(false);
  }, [req]);
  if (!req) return null;
  return (
    <AppSubscribeSheet
      req={req}
      onAnswer={answerSubscribeAsk}
      onCreatePot={(name) => {
        answerSubscribeAsk(null);
        startPotCreate(name);
        handleSelect('settings', 'create-account');
      }}
    />
  );
};
