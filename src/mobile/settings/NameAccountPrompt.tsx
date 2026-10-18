import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ACCOUNT_NAME_MAX, accountNameError, cleanAccountName, needsAccountName } from '../../utils/accountNameRules';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const dismissKey = (id: string) => `bw-name-account-dismissed:${id}`;

/**
 * Accounts made before names were required (blank or still "Account N"): a gentle, skippable nudge on Settings to
 * name it, which also names its backup files (owner, 18 Oct 2026). Never blocks anything.
 */
export const NameAccountPrompt = () => {
  const { chromeStorageService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const id = account?.addresses?.identityAddress ?? '';
  const [dismissed, setDismissed] = useState(() => {
    try {
      return !!id && localStorage.getItem(dismissKey(id)) === '1';
    } catch {
      return false;
    }
  });
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  if (!account || !id || dismissed || (!saved && !needsAccountName(account.name))) return null;
  if (saved)
    return (
      <p className="m-0 mt-1 px-1 text-xs" style={{ color: MUTED }} role="status">
        Saved. This account is now called {saved}.
      </p>
    );

  const others = chromeStorageService
    .getAllAccounts()
    .filter((a) => a.addresses?.identityAddress !== id)
    .map((a) => a.name ?? '');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = accountNameError(value, others);
    setError(bad);
    if (bad) return;
    const name = cleanAccountName(value);
    await chromeStorageService.updateNested('accounts', { [id]: { ...account, name } });
    setSaved(name);
  };
  const later = () => {
    try {
      localStorage.setItem(dismissKey(id), '1');
    } catch {
      /* private mode: just hide for now */
    }
    setDismissed(true);
  };

  return (
    <form
      onSubmit={(e) => void save(e)}
      data-testid="name-account-prompt"
      className="mt-2 rounded-xl px-3 py-2.5"
      style={{ background: 'var(--bw-surface)', border: `1px dashed color-mix(in srgb, ${GOLD} 40%, transparent)` }}
    >
      <label htmlFor="name-this-account" className="block text-sm font-semibold text-white">
        Name this account
      </label>
      <p className="m-0 mt-0.5 text-xs" style={{ color: MUTED }}>
        A name helps you tell accounts apart and labels its backup files.
        {account.name ? ` It's currently "${account.name}".` : ''}
      </p>
      <div className="mt-2 flex gap-2">
        <input
          id="name-this-account"
          className="min-w-0 flex-1 h-9 px-3 rounded-xl border text-sm outline-none text-white bg-[#101114] border-[#98A2B340]"
          placeholder="e.g. Savings"
          maxLength={ACCOUNT_NAME_MAX}
          autoComplete="off"
          value={value}
          aria-invalid={!!error}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
        />
        <button type="submit" className="h-9 px-3 rounded-xl border-0 text-sm font-bold" style={{ background: GOLD }}>
          Save
        </button>
      </div>
      {error && (
        <p role="alert" className="m-0 mt-1 text-xs" style={{ color: '#F97066' }}>
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={later}
        className="mt-1 bg-transparent border-0 p-0 text-xs"
        style={{ color: MUTED }}
      >
        Not now
      </button>
    </form>
  );
};
