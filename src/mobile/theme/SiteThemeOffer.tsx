import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { wearSiteTheme } from './accent';
import { fetchSiteTheme, notNowSiteTheme, shouldOfferSiteTheme } from './siteTheme';
import type { ThemePack } from './themePack';
import type { ThemeSite } from './themeSites';

/**
 * "Wear DNS DEX colours?" One compact row offering a family site's theme (siteTheme.ts). Shows nothing while it
 * loads, when the site has no theme file, or when the offer was turned down in the last 30 days. Never applies a
 * theme without the tap. Styled inline so it reads the same on the sign-in sheet, the connect page and the browser.
 */
export function SiteThemeOffer({
  site,
  account,
  style,
}: {
  site: ThemeSite | null;
  /** The open account's identity key (themes are kept per account). */
  account: string;
  style?: React.CSSProperties;
}) {
  const [pack, setPack] = useState<ThemePack | null>(null);
  const [worn, setWorn] = useState(false);

  useEffect(() => {
    setPack(null);
    setWorn(false);
    if (!site || !shouldOfferSiteTheme(site.id)) return;
    let off = false;
    void fetchSiteTheme(site).then((p) => !off && setPack(p));
    return () => {
      off = true;
    };
  }, [site]);

  // The "Wearing …" note clears itself after a few seconds.
  useEffect(() => {
    if (!worn) return;
    const t = setTimeout(() => setPack(null), 4000);
    return () => clearTimeout(t);
  }, [worn]);

  if (!site || !pack) return null;
  const l = pack.look;
  if (worn)
    return (
      <div role="status" style={{ ...row(l.bg, l.accent, l.text), ...style }}>
        <Check size={14} aria-hidden="true" style={{ color: l.accent }} />
        <span style={{ flex: 1, fontSize: 13 }}>Wearing {pack.label} colours. Switch back in Settings › Theme.</span>
      </div>
    );
  return (
    <div role="group" aria-label={`${pack.label} theme`} style={{ ...row(l.bg, l.accent, l.text), ...style }}>
      <span aria-hidden="true" style={{ display: 'flex', gap: 3 }}>
        {[l.accent, l.hi, l.surface].map((c, i) => (
          <i key={i} style={{ width: 12, height: 24, borderRadius: 4, background: c, display: 'block' }} />
        ))}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700 }}>Wear {pack.label} colours?</span>
      <button
        type="button"
        onClick={() => {
          wearSiteTheme(account, pack);
          setWorn(true);
        }}
        style={chip(l.accent, l.on, true)}
      >
        Wear it
      </button>
      <button
        type="button"
        onClick={() => {
          notNowSiteTheme(site.id);
          setPack(null);
        }}
        style={chip(l.accent, l.text, false)}
      >
        Not now
      </button>
    </div>
  );
}

const row = (bg: string, accent: string, text: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 12,
  background: bg,
  color: text,
  border: `1px solid ${accent}`,
});

const chip = (accent: string, ink: string, solid: boolean): React.CSSProperties => ({
  minHeight: 30,
  padding: '0 10px',
  borderRadius: 999,
  border: `1px solid ${accent}`,
  background: solid ? accent : 'transparent',
  color: ink,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  flexShrink: 0,
});
