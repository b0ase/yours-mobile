import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { openBapp, setBappFrameVisible } from './bappFrame';
import { resolveBappLink } from './bappLink';
import { openDappBrowser } from '../dappBrowser';

/**
 * /bapp/<slug>?to=<path> (public, publicUrl.ts): opens our bApp at that path inside the wallet frame. Reached
 * after unlock or onboarding too (UrlSync keeps the start URL). A real page: if the frame can't open, it offers
 * the site in a tab instead.
 */
const BappLinkPage = () => {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const link = resolveBappLink(slug, params.get('to'));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!link) return;
    setBappFrameVisible(true);
    openBapp(link.name, link.url).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => setBappFrameVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.url]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center text-[#F2F2F0]">
      {link ? (
        <>
          <p className="text-lg font-bold">Opening {link.name}…</p>
          {error && <p className="text-sm text-[#98A2B3]">{error}</p>}
          <button
            type="button"
            onClick={() => void openDappBrowser(link.url)}
            className="rounded-xl px-5 py-3 text-sm font-bold"
            style={{ background: '#F5B800', color: '#000' }}
          >
            Open {link.name} in a new tab
          </button>
        </>
      ) : (
        <>
          <p className="text-lg font-bold">App not found</p>
          <Link to="/m/apps" className="text-sm underline text-[#98A2B3]">
            See all apps
          </Link>
        </>
      )}
    </div>
  );
};

export default BappLinkPage;
