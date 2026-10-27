import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../../components/Button';
import { useTheme } from '../../hooks/useTheme';
import type { TwetchPrompt } from '../../promptProtocol';
import { sendMessage } from '../../utils/chromeHelpers';
import { sheetText } from '../../mobile/twetch/twetchCalls';

export type TwetchRequestProps = {
  request: TwetchPrompt;
  onResponse: () => void;
};

/**
 * The extension's Twetch sheet (services/twetchSite.ts): "Sign in to Twetch as @name?" the first time per site,
 * "Post on Twetch as @name?" with the text and network fee for every post. Same words as the phone's TwetchHost.
 */
export const TwetchRequestPage = ({ request, onResponse }: TwetchRequestProps) => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const t = sheetText(request);
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'TWETCH_RESPONSE', requestID: request.requestID, allow });
    onResponse();
  };

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center gap-3">
      <Send size={36} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold" style={{ color: contrast }}>
        {t.title}
      </h2>
      {request.kind === 'post' && (
        <p
          className="m-0 text-sm leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: contrast, maxWidth: '18rem' }}
          data-testid="twetch-preview"
        >
          {request.preview}
        </p>
      )}
      <p className="m-0 text-xs leading-relaxed" style={{ color: gray, maxWidth: '18rem' }}>
        {t.body}
      </p>
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '18rem' }}>
        <Button theme={theme} type="primary" label={t.approve} disabled={busy} onClick={() => respond(true)} />
        <Button theme={theme} type="secondary-outline" label="Decline" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
