import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useBackClose } from '../backStack';
import { appIconFor, type useUserApps } from './userApps';

/** Apps › Add app: paste any website; it joins Your apps, saved to this wallet (restores with the 12 words). */
export const AddAppSheet = ({ store, onClose }: { store: ReturnType<typeof useUserApps>; onClose: () => void }) => {
  useBackClose(true, onClose);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const field = 'w-full rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2.5 text-sm text-white outline-none';

  const submit = () => {
    const err = store.add(url, name);
    if (err) return setMsg(err);
    setUrl('');
    setName('');
    setMsg('Added to Your apps.');
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button type="button" onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Add app</span>
      </div>
      <div className="flex flex-col gap-3 px-4 pb-10 overflow-y-auto">
        <p className="text-sm m-0" style={{ color: '#98A2B3' }}>
          Add any website as an app. Your apps are saved to this wallet, so restoring it with your 12 words brings them
          back.
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Website, e.g. zanaadu.com"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            className={field}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className={field}
          />
          <button
            type="submit"
            disabled={!url.trim()}
            className="rounded-xl py-2.5 text-sm font-bold border-0"
            style={{ background: '#F5B800', color: '#000', opacity: url.trim() ? 1 : 0.4 }}
          >
            Add app
          </button>
        </form>
        {(msg || store.error) && (
          <p className="text-xs m-0" style={{ color: store.error ? '#FDA29B' : '#98A2B3' }}>
            {store.error || msg}
          </p>
        )}
        {store.apps.length > 0 && (
          <ul className="m-0 p-0 list-none flex flex-col gap-1 mt-2">
            {store.apps.map((a) => (
              <li
                key={a.url}
                className="flex items-center gap-3 rounded-xl px-3 py-2"
                style={{ background: '#17191E' }}
              >
                <img src={appIconFor(a.url)} alt="" width={28} height={28} className="rounded-md bg-black" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-white">{a.name}</span>
                  <span
                    className="block text-[11px] overflow-hidden text-ellipsis whitespace-nowrap"
                    style={{ color: '#98A2B3' }}
                  >
                    {a.url}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => store.remove(a.url)}
                  aria-label={`Remove ${a.name}`}
                  className="p-2 bg-transparent border-0"
                >
                  <Trash2 size={16} color="#98A2B3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
};
