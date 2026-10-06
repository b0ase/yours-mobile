import { APP_NAME } from '../storeBuild';

/** Offer the new password to the browser's password manager, where it allows that (best effort). */
export const saveWalletPassword = async (name: string, password: string) => {
  const W = window as unknown as {
    PasswordCredential?: new (d: { id: string; password: string; name?: string }) => Credential;
  };
  try {
    if (W.PasswordCredential && navigator.credentials?.store) {
      await navigator.credentials.store(new W.PasswordCredential({ id: name || APP_NAME, password, name: APP_NAME }));
    }
  } catch {
    /* not offered here (e.g. extension pages); the user can copy it */
  }
};
