import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { getPaymail } from '../../mobile/names/accountName';
import { getMyName } from '../../mobile/names/myName';
import type { SignedPostPrompt } from '../../promptProtocol';
import { dollarsFirst, dollarsInline, priceFrom } from '../../utils/dollarsFirst';
import { sendMessage } from '../../utils/chromeHelpers';

export type SignedPostRequestProps = { request: SignedPostPrompt; onResponse: () => void };

/**
 * The one sheet for signing a post or selected text (src/signedBadges/background.ts): the exact text, where it is,
 * the name it is signed as and the fee. Sign and record is the only approval: the wallet then signs and writes the
 * proof token without asking again.
 */
export const SignedPostRequestPage = ({ request, onResponse }: SignedPostRequestProps) => {
  const { theme } = useTheme();
  const { chromeStorageService } = useServiceContext();
  const [busy, setBusy] = useState(false);
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const paymail = getPaymail(identityAddress);
  const name = (paymail ? `$${paymail.split('@')[0]}` : '') || getMyName(identityAddress);
  const price = priceFrom(request.usdPerBsv, true);
  const fee = dollarsFirst(request.feeSats, price);
  const what = request.kind === 'post' ? 'post' : 'text';

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'SIGNED_POST_RESPONSE', requestID: request.requestID, allow, signer: name || undefined });
    onResponse();
  };

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 gap-3">
      <BadgeCheck size={32} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold text-center" style={{ color: contrast }}>
        Sign this {what}?
      </h2>
      <p className="m-0 text-xs text-center" style={{ color: gray }}>
        {request.platform === request.originator ? request.originator : `${request.platform} · ${request.originator}`}
      </p>
      <div
        data-testid="signed-post-text"
        className="w-full text-sm whitespace-pre-wrap break-words overflow-y-auto"
        style={{
          maxWidth: '20rem',
          maxHeight: '9rem',
          color: contrast,
          border: `1px solid ${theme.color.global.gray}55`,
          borderRadius: 12,
          padding: '10px 12px',
        }}
      >
        {request.content}
      </div>
      <p className="m-0 text-xs leading-relaxed text-center" style={{ color: gray, maxWidth: '20rem' }}>
        Signed as <strong style={{ color: contrast }}>{name || 'your wallet key'}</strong>. People with bWalletX or
        AuthSig will see a ✓ badge next to this {what}, with your name and the date. The text and your signature are
        public and stay on chain.
      </p>
      <p className="m-0 text-xs text-center" style={{ color: gray }}>
        Fee <strong style={{ color: contrast }}>{fee.main}</strong> ({fee.sub}, estimated)
      </p>
      <div className="flex flex-col gap-2 w-full mt-1" style={{ maxWidth: '20rem' }}>
        <Button
          theme={theme}
          type="primary"
          label={`Sign and record · ${dollarsInline(request.feeSats, price)}`}
          disabled={busy}
          onClick={() => respond(true)}
        />
        <Button theme={theme} type="secondary-outline" label="Cancel" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
