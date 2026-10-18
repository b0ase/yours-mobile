/** Copy with a "Copied ✓" confirmation. Slices go through copySecret (sensitive, wiped after 60 s). */
import { useState } from 'react';
import { copySecret } from '../secretClipboard';

export const CopyButton = ({ text, secret, label = 'Copy' }: { text: string; secret?: boolean; label?: string }) => {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      if (secret) await copySecret(text);
      else await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      className="rounded-xl px-3 py-2 text-sm font-bold border cursor-pointer shrink-0"
      style={{ background: 'transparent', color: '#F5B800', borderColor: '#F5B800' }}
      onClick={() => void copy()}
      disabled={!text}
    >
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
};
