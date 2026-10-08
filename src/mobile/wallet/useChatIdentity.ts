import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BchatClient, defaultHttp, loadSession, SESSION_EVENT, type ChatSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { isNative } from '../native';
import { chatIdentityMismatch } from './identityLine';

/**
 * This account's chat identity for the wallet card: its bChat session (per account, chat/api.ts),
 * the account's identity key, and whether the session really belongs to this account. The server
 * check (whoami) runs once per session token; failures leave the line as it is and never warn.
 */
export const useChatIdentity = (account: string | undefined) => {
  const { apiContext } = useServiceContext();
  const [session, setSession] = useState<ChatSession | null>(() => loadSession());
  const [identityKey, setIdentityKey] = useState('');
  const [expectedAddress, setExpectedAddress] = useState<string | null>(null);
  const [server, setServer] = useState<{ token: string; handle: string; addressLinked: boolean | null } | null>(null);

  useEffect(() => {
    const read = () => setSession(loadSession());
    read();
    window.addEventListener(SESSION_EVENT, read);
    return () => window.removeEventListener(SESSION_EVENT, read);
  }, [account]);

  useEffect(() => {
    let live = true;
    setIdentityKey('');
    setExpectedAddress(null);
    if (!apiContext?.wallet) return;
    void (async () => {
      try {
        const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
        if (live) setIdentityKey(publicKey.toLowerCase());
      } catch {
        /* locked or unavailable: the line shows without a key */
      }
      try {
        const a = await walletSigner(apiContext).address();
        if (live) setExpectedAddress(a);
      } catch {
        /* unknown: no address comparison */
      }
    })();
    return () => {
      live = false;
    };
  }, [apiContext, account]);

  useEffect(() => {
    if (!session || !expectedAddress || server?.token === session.token) return;
    let live = true;
    new BchatClient(defaultHttp(isNative), session)
      .whoami(expectedAddress)
      .then((w) => live && setServer({ token: session.token, handle: w.handle, addressLinked: w.addressLinked }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session, expectedAddress, server?.token]);

  const checked = server && session && server.token === session.token ? server : null;
  const mismatch = chatIdentityMismatch({
    account,
    session,
    expectedAddress,
    serverHandle: checked?.handle,
    addressLinked: checked?.addressLinked,
  });
  return { handle: session?.handle ?? null, identityKey, mismatch };
};
