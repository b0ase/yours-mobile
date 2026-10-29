import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Button } from '../../components/Button';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { wearSiteTheme } from '../../mobile/theme/accent';
import type { ThemeOfferResult } from '../../mobile/theme/themeOffer';
import type { ThemeOfferPrompt } from '../../promptProtocol';
import { sendMessage } from '../../utils/chromeHelpers';

export type ThemeOfferRequestProps = { request: ThemeOfferPrompt; onResponse: () => void };

/**
 * The one sheet for `window.CWI.theme.offer` (services/themeOfferSite.ts): "Use the FWUIT look?" with a swatch and a
 * card preview drawn from the offered colours only. Use saves it as a site theme (Settings › Theme › From sites, where
 * the user switches back); Not now asks again next session; Never for this site stops this site's offers.
 */
export const ThemeOfferRequestPage = ({ request, onResponse }: ThemeOfferRequestProps) => {
  const { theme } = useTheme();
  const { chromeStorageService } = useServiceContext();
  const [busy, setBusy] = useState(false);
  const { pack, originator } = request;
  const l = pack.look;
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const respond = (answer: ThemeOfferResult) => {
    if (busy) return;
    setBusy(true);
    if (answer === 'used') {
      const account = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
      wearSiteTheme(account, pack);
    }
    sendMessage({ action: 'THEME_OFFER_RESPONSE', requestID: request.requestID, answer });
    onResponse();
  };
  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 gap-3">
      <Palette size={32} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold text-center" style={{ color: contrast }}>
        Use the {pack.label} look?
      </h2>
      <p className="m-0 text-xs text-center" style={{ color: gray }}>
        Offered by <strong style={{ color: contrast }}>{originator}</strong>
      </p>
      <div
        data-testid="theme-offer-card"
        aria-hidden="true"
        style={{
          width: '100%',
          maxWidth: '20rem',
          aspectRatio: '1.586',
          borderRadius: 16,
          background: `linear-gradient(135deg, ${l.surface}, ${l.bg})`,
          border: `2px solid ${l.accent}`,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ display: 'flex', gap: 4 }}>
          {[l.accent, l.hi, l.lo, l.success, l.danger].map((c, i) => (
            <i key={i} style={{ width: 18, height: 18, borderRadius: 999, background: c, display: 'block' }} />
          ))}
        </span>
        <span style={{ color: l.text, fontWeight: 800, fontSize: 18 }}>{pack.label}</span>
        <span
          style={{
            alignSelf: 'flex-start',
            background: l.accent,
            color: l.on,
            borderRadius: 999,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          $0.00
        </span>
      </div>
      <p className="m-0 text-xs leading-relaxed text-center" style={{ color: gray, maxWidth: '20rem' }}>
        Colours only. Switch back any time in Settings › Theme.
      </p>
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '20rem' }}>
        <Button theme={theme} type="primary" label="Use it" disabled={busy} onClick={() => respond('used')} />
        <Button
          theme={theme}
          type="secondary-outline"
          label="Not now"
          disabled={busy}
          onClick={() => respond('declined')}
        />
        <Button
          theme={theme}
          type="secondary"
          label="Never for this site"
          disabled={busy}
          onClick={() => respond('never')}
        />
      </div>
    </div>
  );
};
