import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { BchatClient, defaultHttp, loadSession, saveSession, SESSION_EVENT } from '../chat/api';
import { isNative } from '../native';
import { useAccountNames } from '../names/accountNames';
import { ErrorActions } from '../errors/ErrorActions';
import {
  aliasOf,
  loadBchatPref,
  loadFollowStatus,
  saveBchatPref,
  type BchatPref,
  type FollowStatus,
} from '../wallet/bchatFollow';
import { followBchat } from '../wallet/useBchatFollow';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const RED = '#F97066';

/**
 * Settings › bChatX for this account (owner, 10 Oct 2026): by default bChatX uses this account's own
 * name; choice ("a different name") and privacy ("don't connect") live here, never on the wallet card.
 */
export const BchatAccountSettings = () => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
  const id = selectedAccount ?? '';
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const alias = aliasOf(names.paymail);
  const [pref, setPref] = useState<BchatPref>(() => loadBchatPref(id));
  const [status, setStatus] = useState<FollowStatus | null>(() => loadFollowStatus(id));
  const [session, setSession] = useState(() => loadSession());
  const [wanted, setWanted] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = () => {
      setSession(loadSession());
      setStatus(loadFollowStatus(id));
    };
    window.addEventListener(SESSION_EVENT, read);
    return () => window.removeEventListener(SESSION_EVENT, read);
  }, [id]);

  const choose = async (next: BchatPref) => {
    if (!id) return;
    saveBchatPref(id, next);
    setPref(next);
    if (next.mode === 'off') {
      saveSession(null);
      addSnackbar('This account is no longer connected to bChatX', 'info');
      return;
    }
    if (!apiContext?.wallet) return;
    setBusy(true);
    try {
      const s = await followBchat(
        apiContext,
        id,
        names.paymail,
        { handle: loadSession()?.handle ?? null, mismatch: false },
        true,
      );
      if (s) setStatus(s);
    } finally {
      setBusy(false);
    }
  };

  const applyOtherName = async () => {
    const name = wanted.trim().replace(/^[$@]/, '');
    if (!name || !session) return;
    setBusy(true);
    try {
      const client = new BchatClient(defaultHttp(isNative), session);
      const check = await client.checkHandle(name);
      if (!check.available) {
        addSnackbar(check.error || `@${name} isn't available`, 'error');
        return;
      }
      saveSession(await client.changeHandle(name));
      saveBchatPref(id, { mode: 'custom' });
      setPref({ mode: 'custom' });
      setWanted('');
      addSnackbar(`bChatX now calls you @${name}`, 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Could not change your bChatX name', 'error');
    } finally {
      setBusy(false);
    }
  };

  // One compact row of three choices (owner, 11 Oct 2026: the long radio list looked out of place).
  const option = (mode: BchatPref['mode'], title: string, note: string) => {
    const on = pref.mode === mode;
    return (
      <label
        title={note}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-semibold cursor-pointer"
        style={{
          background: on ? `color-mix(in srgb, ${GOLD} 13%, transparent)` : 'transparent',
          border: `1px solid ${on ? GOLD : '#ffffff22'}`,
          color: on ? GOLD : '#fff',
        }}
      >
        <input
          type="radio"
          name="bchatx-pref"
          id={`bchatx-pref-${mode}`}
          checked={on}
          disabled={busy}
          onChange={() => void choose({ mode })}
          className="sr-only"
        />
        <span className="truncate">{title}</span>
      </label>
    );
  };

  const failed = status && !status.ok && pref.mode !== 'off';
  return (
    <div
      className="mt-2 rounded-xl px-3 py-2.5"
      style={{ background: 'var(--bw-surface)' }}
      data-testid="bchatx-settings"
    >
      <div className="flex items-center gap-2">
        <MessageCircle size={16} color={GOLD} aria-hidden="true" />
        <span className="text-sm font-bold text-white">bChatX</span>
        <span className="ml-auto text-xs" style={{ color: MUTED }}>
          {pref.mode === 'off' ? 'Not connected' : session ? `Signed in as @${session.handle}` : 'Not signed in yet'}
        </span>
      </div>
      <div className="mt-2 flex gap-2" role="radiogroup" aria-label="bChatX for this account">
        {option('account', alias ? `@${alias}` : 'This name', "Use this account's name on bChatX (default)")}
        {option('custom', 'Other name', 'This account, under a name you choose')}
        {option('off', 'Off', 'Never sign in to bChatX with this account')}
      </div>
      {pref.mode === 'custom' && session && (
        <div className="mt-2 flex gap-2">
          <input
            id="bchatx-other-name"
            value={wanted}
            onChange={(e) => setWanted(e.target.value)}
            placeholder={`@${session.handle}`}
            className="min-w-0 flex-1 rounded-full px-3 py-1.5 text-sm text-white"
            style={{ background: '#0B0B0C', border: '1px solid #ffffff22' }}
          />
          <button
            type="button"
            disabled={busy || !wanted.trim()}
            onClick={() => void applyOtherName()}
            className="rounded-full px-3 py-1.5 text-sm font-bold border-0"
            style={{ background: GOLD, color: '#0B0B0C', opacity: busy || !wanted.trim() ? 0.5 : 1 }}
          >
            Use it
          </button>
        </div>
      )}
      {failed && (
        <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: RED }}>
          <span className="min-w-0 flex-1 select-text">Couldn't sign in to bChatX: {status.error}</span>
          <ErrorActions message={`bChatX sign-in failed: ${status.error}`} color={RED} />
        </div>
      )}
    </div>
  );
};
