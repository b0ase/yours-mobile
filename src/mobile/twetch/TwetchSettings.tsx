import { useMemo, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { twetchHandle, twetchKeyFrom, twetchStoreFor, verifyTwetchKey, type TwetchLink } from './twetchLink';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const PANEL = '#17191E';
const RED = '#F97066';

/**
 * Settings › Twetch: keep your Twetch key in bWalletX as a signing key, so bChatX can post to Twetch for you (each
 * post asks here first). The words are only used on this phone to find the key; only the key is kept, encrypted
 * with your wallet password. Nothing is sent anywhere except the public key, to look up your Twetch account.
 */
export function TwetchSettings() {
  const { chromeStorageService } = useServiceContext();
  const store = useMemo(() => twetchStoreFor(chromeStorageService), [chromeStorageService]);
  const [link, setLink] = useState<TwetchLink | undefined>(() => store.link());
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const linkWith = async (getSecret: () => Promise<string | undefined>) => {
    setBusy(true);
    setError('');
    try {
      const secret = await getSecret();
      if (!secret) throw new Error('This account has no recovery phrase. Enter your Twetch 12 words.');
      const key = twetchKeyFrom(secret);
      const found = await verifyTwetchKey(key);
      if (typeof found === 'string') throw new Error(found);
      await store.save(found, key);
      setWords('');
      setLink(store.link());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (link)
    return (
      <div className="flex flex-col gap-3 text-sm" style={{ color: MUTED }}>
        <p className="text-base font-bold text-white">Linked as {twetchHandle(link)}</p>
        <p>
          bChatX can sign you in to Twetch and post for you. Every post asks you here first and shows the network fee.
          Nothing is paid to Twetch.
        </p>
        <p className="break-all text-xs">Twetch key {link.address}</p>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await store.forget();
              setLink(undefined);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-xl py-3 font-semibold text-white"
          style={{ background: PANEL }}
        >
          Remove Twetch key
        </button>
        {error && <p style={{ color: RED }}>{error}</p>}
      </div>
    );

  return (
    <div className="flex flex-col gap-3 text-sm" style={{ color: MUTED }}>
      <p>
        Keep your Twetch key in bWalletX so bChatX can post to Twetch for you. Your words stay on this phone; the key is
        kept encrypted with your wallet password and is never shown to sites.
      </p>
      <textarea
        value={words}
        onChange={(e) => setWords(e.target.value)}
        placeholder="Twetch 12 words"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        rows={3}
        className="w-full rounded-xl p-3 text-white outline-none"
        style={{ background: PANEL }}
      />
      <button
        disabled={busy || !words.trim()}
        onClick={() => linkWith(async () => words)}
        className="rounded-xl py-3 font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#000' }}
      >
        {busy ? 'Checking…' : 'Link Twetch'}
      </button>
      <button
        disabled={busy}
        onClick={() => linkWith(() => store.accountWords())}
        className="rounded-xl py-3 font-semibold text-white disabled:opacity-50"
        style={{ background: PANEL }}
      >
        This account was restored from Twetch
      </button>
      {error && <p style={{ color: RED }}>{error}</p>}
    </div>
  );
}

export default TwetchSettings;
