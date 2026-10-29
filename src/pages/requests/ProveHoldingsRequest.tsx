import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { useTheme } from '../../hooks/useTheme';
import type { ProveHoldingsPrompt } from '../../promptProtocol';
import { sendMessage } from '../../utils/chromeHelpers';

export type ProveHoldingsRequestProps = {
  request: ProveHoldingsPrompt;
  onResponse: () => void;
};

/**
 * The extension's link-addresses sheet (services/proveHoldingsSite.ts). Shown once per site per account; Allow is
 * remembered so bChatX can relink on every sign-in. Signatures only: nothing is spent.
 */
export const ProveHoldingsRequestPage = ({ request, onResponse }: ProveHoldingsRequestProps) => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'PROVE_HOLDINGS_RESPONSE', requestID: request.requestID, allow });
    onResponse();
  };

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center gap-3">
      <Link2 size={36} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold" style={{ color: contrast }}>
        Show your tokens in bChatX?
      </h2>
      <p className="m-0 text-xs leading-relaxed" style={{ color: gray, maxWidth: '18rem' }}>
        {request.originator} can then see which wallet addresses hold your tokens, so your rooms and swaps work. Your
        wallet signs a message for each one. Nothing is spent.
      </p>
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '18rem' }}>
        <Button theme={theme} type="primary" label="Allow" disabled={busy} onClick={() => respond(true)} />
        <Button theme={theme} type="secondary-outline" label="Decline" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
