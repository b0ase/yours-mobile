import { useState } from 'react';
import { Check, Copy, Eye, EyeOff, Wand2 } from 'lucide-react';

/**
 * Create Account password (owner, 4 Oct 2026): a strong generated password, an eye to show it, and
 * the standard autocomplete hints so the phone / browser offers its own strong password and saves it
 * (iOS: iCloud Keychain via webcredentials:www.bwallet.space). See saveWalletPassword.
 */
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=';

/** 20 characters from a 64-symbol alphabet (~120 bits), no look-alikes (0/O, 1/l/I). */
export const strongPassword = (len = 20): string => {
  const out: string[] = [];
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 256 - (256 % CHARS.length) && out.length < len) out.push(CHARS[b % CHARS.length]);
  }
  return out.join('');
};

/** Offer the new password to the browser's password manager, where it allows that (best effort). */
export const saveWalletPassword = async (name: string, password: string) => {
  const W = window as unknown as { PasswordCredential?: new (d: { id: string; password: string; name?: string }) => Credential };
  try {
    if (W.PasswordCredential && navigator.credentials?.store) {
      await navigator.credentials.store(new W.PasswordCredential({ id: name || 'bWalletX', password, name: 'bWalletX' }));
    }
  } catch {
    /* not offered here (e.g. extension pages); the user can copy it */
  }
};

const field =
  'w-full h-9 pl-4 pr-10 rounded-xl border text-sm outline-none bg-[#17191E] text-white border-[#98A2B340]';

export const PasswordFields = ({
  newWallet,
  username,
  password,
  confirm,
  setPassword,
  setConfirm,
  askSaved = false,
  confirmAlways = false,
}: {
  /** Ask twice also when adding an account to an existing wallet (owner, 6 Oct 2026). */
  confirmAlways?: boolean;
  /** Create Account: a required "I've saved it" tick, so nobody moves on without a copy. */
  askSaved?: boolean;
  newWallet: boolean;
  username: string;
  password: string;
  confirm: string;
  setPassword: (v: string) => void;
  setConfirm: (v: string) => void;
}) => {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  // Suggestion box under the empty field on focus, like a browser's own "Use strong password".
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const generate = (p = strongPassword()) => {
    setPassword(p);
    setConfirm(p);
    setShow(true);
    setSuggestion(null);
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(password).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const type = show ? 'text' : 'password';
  return (
    <div className="w-[85%] flex flex-col gap-2 my-1">
      {/* Username for password managers: they file the password under it. */}
      <input type="text" name="username" autoComplete="username" value={username || 'bWalletX'} readOnly hidden />
      <div className="relative">
        <input
          className={field}
          type={type}
          name="new-password"
          autoComplete={newWallet ? 'new-password' : 'current-password'}
          placeholder={newWallet ? 'Password' : 'Your wallet password'}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setSuggestion(null);
          }}
          onFocus={() => newWallet && !password && setSuggestion(strongPassword())}
          onBlur={() => setTimeout(() => setSuggestion(null), 200)}
        />
        {suggestion && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => generate(suggestion)}
            className="absolute left-0 right-0 top-full mt-1 z-10 flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left border-0"
            style={{ background: '#22252B', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: '#F5B800' }}>
              <Wand2 size={13} /> Use a strong password
            </span>
            <span className="text-[11px] font-mono" style={{ color: '#D0D5DD' }}>
              {suggestion}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 bg-transparent border-0"
          style={{ color: '#98A2B3' }}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {(newWallet || confirmAlways) && (
        <input
          className={field}
          type={type}
          name="confirm-password"
          autoComplete="new-password"
          placeholder={newWallet ? 'Confirm password' : 'Your wallet password again'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      )}
      {newWallet && (
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => generate()}
            className="flex items-center gap-1 bg-transparent border-0 p-0 font-semibold"
            style={{ color: '#F5B800' }}
          >
            <Wand2 size={13} /> Generate a strong password
          </button>
          {password && show && (
            <button
              type="button"
              onClick={() => void copy()}
              className="flex items-center gap-1 bg-transparent border-0 p-0"
              style={{ color: '#98A2B3' }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
      {askSaved && newWallet && (
        <label className="flex items-start gap-2 mt-1 text-xs" style={{ color: '#D0D5DD' }}>
          <input type="checkbox" required className="mt-0.5" />
          <span>
            I've saved this password somewhere safe. bWalletX can't show it again; only your recovery phrase can reset
            it.
          </span>
        </label>
      )}
    </div>
  );
};
