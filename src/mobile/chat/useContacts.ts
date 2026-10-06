import { useEffect, useMemo, useState } from 'react';
import { isNative } from '../native';
import { loadFollows } from '../feed/store';
import { getFriends, onFriends, refreshFriends } from '../calls/friends';
import { BchatClient, defaultHttp, loadSession } from './api';
import { mergeContacts, type BchatContact } from './contacts';

/**
 * The unified contact list outside the DMs page (Calls): Calls friends + Feed follows, plus
 * bChat contacts when a bChat session already exists (never prompts a sign-in here).
 */
export const useContacts = () => {
  const [friends, setFriends] = useState(getFriends());
  const [bchat, setBchat] = useState<BchatContact[]>([]);
  const session = loadSession();
  useEffect(() => {
    const off = onFriends(setFriends);
    void refreshFriends().catch(() => undefined);
    return off;
  }, []);
  useEffect(() => {
    if (!session) return;
    void new BchatClient(defaultHttp(isNative), session)
      .contacts()
      .then(setBchat)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.handle]);
  return useMemo(
    () => mergeContacts(bchat, friends, loadFollows(), session?.handle),
    [bchat, friends, session?.handle],
  );
};
