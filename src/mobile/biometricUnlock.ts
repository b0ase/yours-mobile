/* eslint-disable @typescript-eslint/no-explicit-any */
import { decrypt } from '../utils/crypto';
import type { PlatformHooks } from '../platform';
import { YoursNative, isNative, type BiometryType } from './native';

/**
 * Face ID / Touch ID / fingerprint unlock, layered on upstream's own unlock
 * semantics (unlocked = session passKey + fresh lastActiveTime, then
 * WALLET_UNLOCKED). Plugs into upstream's platform hooks (src/platform.ts):
 * `quickUnlock` for the lock-screen button, `onWalletReady` for enrolment.
 *
 * - Enrol: once the wallet home screen shows with a passKey in storage.session
 *   (i.e. after a password unlock or wallet creation), offer once to seal it
 *   behind biometrics (per account).
 * - Unlock: read the sealed passKey, prove it decrypts the account keystore,
 *   then hand it to storage.session exactly as a password unlock would.
 */

const LABELS: Record<BiometryType, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  opticId: 'Optic ID',
  fingerprint: 'fingerprint',
  none: 'biometrics',
};
const ENROLLED = (account: string) => `bio:enrolled:${account}`;
const DECLINED = 'bio:declined';
const SEALED = (account: string) => `passKey:${account}`;

let biometry: BiometryType = 'none';
let chromeApi: any;
let offeredThisSession = false;

const label = () => LABELS[biometry];

const flag = {
  get: async (key: string) => (await YoursNative.secureGet({ key })).value === '1',
  set: (key: string) => YoursNative.secureSet({ key, value: '1' }),
  clear: (key: string) => YoursNative.secureRemove({ key }),
};

const selectedAccount = async (): Promise<{ id?: string; encryptedKeys?: string }> => {
  const { selectedAccount: id, accounts } = await chromeApi.storage.local.get(['selectedAccount', 'accounts']);
  return { id, encryptedKeys: id ? accounts?.[id]?.encryptedKeys : undefined };
};

// UI ------------------------------------------------------------------------

const sheet = (title: string, body: string, primary: string, secondary: string): Promise<boolean> =>
  new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'yours-sheet-backdrop';
    el.innerHTML = `<div class="yours-sheet" role="dialog" aria-modal="true">
        <h2></h2><p></p>
        <button type="button" class="yours-sheet-primary"></button>
        <button type="button" class="yours-sheet-secondary"></button>
      </div>`;
    el.querySelector('h2')!.textContent = title;
    el.querySelector('p')!.textContent = body;
    const [yes, no] = el.querySelectorAll('button');
    yes.textContent = primary;
    no.textContent = secondary;
    const done = (value: boolean) => {
      el.remove();
      resolve(value);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    document.body.appendChild(el);
  });

const toast = (text: string) => {
  const el = document.createElement('div');
  el.className = 'yours-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

// Enrolment -----------------------------------------------------------------

const offerEnrolment = async () => {
  if (offeredThisSession || document.querySelector('.yours-overlay, .yours-sheet-backdrop')) return;
  offeredThisSession = true;
  const { passKey } = await chromeApi.storage.session.get('passKey');
  if (typeof passKey !== 'string') return;
  const { id, encryptedKeys } = await selectedAccount();
  if (!id || !encryptedKeys) return;
  if ((await flag.get(ENROLLED(id))) || (await flag.get(DECLINED))) return;
  const yes = await sheet(
    `Unlock with ${label()}?`,
    `Use ${label()} instead of your password to unlock your wallet on this device. Your password still works and is still needed for backups and sensitive settings.`,
    `Use ${label()}`,
    'Not now',
  );
  if (!yes) return void (await flag.set(DECLINED));
  try {
    await YoursNative.biometricSet({ key: SEALED(id), value: passKey });
    await flag.set(ENROLLED(id));
    toast(`${label()} unlock is on`);
  } catch (error: any) {
    if (error?.code !== 'cancelled') toast(`Couldn't turn on ${label()}`);
  }
};

const disable = async () => {
  const { id } = await selectedAccount();
  await YoursNative.biometricRemove({ key: id ? SEALED(id) : '' });
  if (id) await flag.clear(ENROLLED(id));
  await flag.set(DECLINED);
};

// Unlock --------------------------------------------------------------------

const unlock = async (): Promise<boolean> => {
  const { id, encryptedKeys } = await selectedAccount();
  if (!id || !encryptedKeys) return false;
  let passKey: string | null;
  try {
    passKey = (await YoursNative.biometricGet({ key: SEALED(id), reason: 'Unlock your wallet' })).value;
  } catch (error: any) {
    if (error?.code !== 'cancelled') toast(`${label()} didn't work. Use your password.`);
    return false;
  }
  const valid =
    !!passKey &&
    (await decrypt(encryptedKeys, passKey)
      .then((plain) => (JSON.parse(plain), true))
      .catch(() => false));
  if (!valid) {
    // Password changed, or biometrics re-enrolled: the sealed key is useless now.
    await YoursNative.biometricRemove({ key: SEALED(id) });
    await flag.clear(ENROLLED(id));
    toast(`Enter your password to turn ${label()} back on`);
    return false;
  }
  offeredThisSession = true;
  await chromeApi.storage.session.set({ passKey });
  await chromeApi.storage.local.set({ lastActiveTime: Date.now() });
  await chromeApi.runtime.sendMessage({ action: 'WALLET_UNLOCKED' }).catch(() => undefined);
  return true;
};

// Platform hooks -------------------------------------------------------------

const isEnrolled = async () => {
  const { id } = await selectedAccount();
  return !!id && (await flag.get(ENROLLED(id)));
};

/**
 * Returns the hooks for src/platform.ts, or {} when biometrics aren't
 * available on this device.
 */
export const initBiometricUnlock = async (chrome: any): Promise<PlatformHooks> => {
  if (!isNative) return {};
  chromeApi = chrome;
  const status = await YoursNative.biometricStatus().catch(() => ({ available: false, biometryType: 'none' as const }));
  if (!status.available) return {};
  biometry = status.biometryType;

  chrome.storage.onChanged.addListener((changes: any, area: string) => {
    // Wallet reset / sign-out: nothing sealed should outlive the accounts.
    if (area === 'local' && 'accounts' in changes && changes.accounts.newValue === undefined) {
      void YoursNative.biometricRemove({ key: '' });
    }
  });

  return {
    quickUnlock: {
      label: `Unlock with ${label()}`,
      disableLabel: `Stop using ${label()}`,
      isAvailable: isEnrolled,
      unlock,
      disable,
      autoPrompt: true,
    },
    onWalletReady: () => void offerEnrolment(),
  };
};
