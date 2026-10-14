import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { linkLabel } from '../twetch/twetch';
import { linkTwetch, twetchCrosspostEnabled, twetchLinkOf, unlinkTwetch } from '../twetch/twetchPost';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const RED = '#F87171';

/**
 * Settings › Identity: "Twetch: linked as @handle (#id)" with Unlink, or Link for an account restored from
 * Twetch's 12 words. Linking looks the account's keys up on Twetch and only links on an exact key match.
 */
export const TwetchLinkRow = () => {
  const { chromeStorageService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [link, setLink] = useState(() => (id ? twetchLinkOf(chromeStorageService, id) : null));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!id || !twetchCrosspostEnabled()) return null;

  const doLink = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await linkTwetch(chromeStorageService, id);
      if (r.ok) setLink(r.link);
      else setMsg(r.message);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not reach Twetch');
    } finally {
      setBusy(false);
    }
  };
  const doUnlink = async () => {
    setBusy(true);
    try {
      await unlinkTwetch(chromeStorageService, id);
      setLink(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not unlink');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3" data-testid="twetch-link">
      <div className="flex items-center gap-3">
        <Link2 size={16} color={GOLD} />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">{link ? linkLabel(link) : 'Twetch'}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {link
              ? 'Your Feed posts can also go to Twetch, signed on this device with your Twetch key'
              : 'Restored this account from Twetch? Link it to post there too'}
          </div>
        </div>
        <button
          onClick={() => void (link ? doUnlink() : doLink())}
          disabled={busy}
          className="text-xs font-bold rounded-full px-3 py-1.5 disabled:opacity-40"
          style={link ? { color: RED, border: `1px solid ${RED}55` } : { background: GOLD, color: '#1a1300' }}
        >
          {busy ? '…' : link ? 'Unlink' : 'Link'}
        </button>
      </div>
      {msg && (
        <p className="text-xs mt-2" style={{ color: RED }}>
          {msg}
        </p>
      )}
    </div>
  );
};
