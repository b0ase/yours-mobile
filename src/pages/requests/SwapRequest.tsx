import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '../../components/Button';
import { useTheme } from '../../hooks/useTheme';
import type { SwapPrompt } from '../../promptProtocol';
import { sendMessage } from '../../utils/chromeHelpers';
import { swapSheetRows } from './swapSheetText';

export type SwapRequestProps = { request: SwapPrompt; onResponse: () => void };

/** The one approval for a bChatX contract swap (services/swapSite.ts): every amount in BSV and USD, with the rate source. */
export const SwapRequestPage = ({ request, onResponse }: SwapRequestProps) => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const t = swapSheetRows(request);
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'SWAP_RESPONSE', requestID: request.requestID, allow });
    onResponse();
  };
  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 gap-3">
      <ArrowLeftRight size={32} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold text-center" style={{ color: contrast }}>
        {t.title}
      </h2>
      <div className="flex flex-col gap-1.5 w-full" style={{ maxWidth: '20rem' }} data-testid="swap-rows">
        {t.rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <span style={{ color: gray }}>{k}</span>
            <span className="text-right break-all" style={{ color: contrast }}>
              {v}
            </span>
          </div>
        ))}
      </div>
      <p className="m-0 text-xs leading-relaxed text-center" style={{ color: gray, maxWidth: '20rem' }}>
        {t.note}
      </p>
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '20rem' }}>
        <Button theme={theme} type="primary" label={t.action} disabled={busy} onClick={() => respond(true)} />
        <Button theme={theme} type="secondary-outline" label="Decline" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
