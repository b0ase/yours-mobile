import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { resizeAvatar, resolveAvatarUrl, toAvatarUri } from './avatar';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * New-account avatar (Create / Restore / Import), in place of upstream's "Icon URL" box: upload a
 * photo from the phone (resized to ~256 px and kept as the account icon), or, under "Use an NFT or
 * a link", paste an NFT's ID (`<txid>_<n>`, an on-chain image) or an image link.
 */
export const AccountIconField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const input = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const preview = value ? resolveAvatarUrl(value) : '';

  const pick = async (file?: File) => {
    if (!file) return;
    try {
      onChange(await resizeAvatar(file));
      setError('');
    } catch {
      setError('Couldn’t read that image. Try another.');
    }
  };

  return (
    <div className="flex w-[80%] flex-col items-center gap-2 py-1">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-2 text-left w-full"
      >
        {preview ? (
          <img src={preview} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#2b2f36]">
            <Camera size={18} color="#98A2B3" />
          </span>
        )}
        <span className="text-sm text-white">{preview ? 'Change photo' : 'Add a photo'}</span>
        <span className="ml-auto text-[11px] text-[#667085]">optional</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setText('');
            setTyping(false);
            if (input.current) input.current.value = '';
          }}
          className="text-[11px] text-[#F97066] underline"
        >
          Remove photo
        </button>
      )}
      {typing ? (
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(toAvatarUri(e.target.value));
          }}
          placeholder="NFT ID (txid_0) or image link"
          autoCapitalize="off"
          autoCorrect="off"
          className="w-full rounded-xl bg-[#17191E] px-3 py-2 text-sm text-white outline-none"
        />
      ) : (
        <button type="button" onClick={() => setTyping(true)} className="text-[11px] text-[#98A2B3] underline">
          Use an NFT or a link
        </button>
      )}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-[#F97066]">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
    </div>
  );
};
