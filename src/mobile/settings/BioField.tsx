import { useEffect, useState } from 'react';
import { BchatClient, ChatApiError, defaultHttp, type ChatSession } from '../chat/api';
import { isNative } from '../native';
import { useSnackbar } from '../../hooks/useSnackbar';

export const BIO_MAX = 160;

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

/**
 * My public bio (bit-sign /api/bitsign/me/bio, PR #270), shown on my contact card as "says …".
 * Until the endpoint is live (404, or any load failure) the field stays hidden: no pretend saves.
 */
export const BioField = ({ session }: { session: ChatSession }) => {
  const { addSnackbar } = useSnackbar();
  const [bio, setBio] = useState<string | null>(null);
  const [stored, setStored] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBio(null);
    new BchatClient(defaultHttp(isNative), session)
      .getBio()
      .then((b) => {
        if (!live) return;
        setBio(b ?? '');
        setStored(b ?? '');
      })
      .catch(() => live && setBio(null));
    return () => {
      live = false;
    };
  }, [session]);

  if (bio === null) return null;

  const save = async () => {
    setBusy(true);
    try {
      const b = (await new BchatClient(defaultHttp(isNative), session).setBio(bio.slice(0, BIO_MAX))) ?? '';
      setBio(b);
      setStored(b);
      addSnackbar(b ? 'Bio saved' : 'Bio cleared', 'success');
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 404) setBio(null);
      else addSnackbar(e instanceof Error ? e.message : 'Could not save your bio', 'error');
    } finally {
      setBusy(false);
    }
  };

  const changed = bio.trim() !== stored.trim();
  return (
    <div className="mt-2">
      <label htmlFor="bchatx-bio" className="text-xs font-semibold text-white">
        Bio
      </label>
      <textarea
        id="bchatx-bio"
        rows={2}
        maxLength={BIO_MAX}
        value={bio}
        disabled={busy}
        onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
        placeholder="A line about you, shown on your card"
        className="mt-1 w-full rounded-xl px-3 py-1.5 text-sm text-white"
        style={{ background: '#0B0B0C', border: '1px solid #ffffff22', resize: 'none' }}
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ color: MUTED }}>
          {bio.length}/{BIO_MAX} · public
        </span>
        <button
          type="button"
          disabled={busy || !changed}
          onClick={() => void save()}
          className="ml-auto rounded-full px-3 py-1 text-xs font-bold border-0"
          style={{ background: GOLD, color: '#0B0B0C', opacity: busy || !changed ? 0.5 : 1 }}
        >
          Save
        </button>
      </div>
    </div>
  );
};
