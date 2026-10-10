import { describe, expect, test } from 'bun:test';
import * as bip39 from 'bip39';
import { KeysService } from '../../services/Keys.service';
import { derivePassKey } from '../../services/passKey';
import { decrypt, encrypt } from '../../utils/crypto';
import { getKeys } from '../../utils/keys';
import { AccountExistsError } from '../../services/accountErrors';
import { normalizePhrase, phraseProblem, restoreErrorMessage } from './restoreHelpers';

/**
 * Add account › Restore › Twetch (owner, 10 Oct 2026: "neither a new password nor my wallet password works").
 * A wallet with several accounts, one salt, one password: adding a phrase with the right password must work,
 * whichever account is selected; the real cause must be named when it doesn't.
 */
const PASSWORD = 'correct horse battery';
const SALT = 'a1b2c3d4e5f6';

type Acct = { addresses: { identityAddress: string }; encryptedKeys: string; name: string };

const makeStore = async (count: number) => {
  const passKey = await derivePassKey(PASSWORD, SALT, undefined);
  const accounts: Record<string, Acct> = {};
  for (let i = 0; i < count; i++) {
    const k = getKeys();
    accounts[k.identityAddress] = {
      addresses: { identityAddress: k.identityAddress },
      encryptedKeys: await encrypt(JSON.stringify(k), passKey),
      name: `Account ${i + 1}`,
    };
  }
  const ids = Object.keys(accounts);
  let session: string | undefined;
  const state: { selectedAccount: string; salt: string; accounts: Record<string, Acct> } = {
    selectedAccount: ids[ids.length - 1],
    salt: SALT,
    accounts,
  };
  const store = {
    state,
    getCurrentAccountObject: () => ({ selectedAccount: state.selectedAccount, account: state.accounts[state.selectedAccount], salt: state.salt }),
    getAllAccounts: () => Object.values(state.accounts),
    getUsbSecurity: () => undefined,
    verifyPassword: async (pw: string) => {
      try {
        const key = await derivePassKey(pw, state.salt, undefined);
        JSON.parse(await decrypt(state.accounts[state.selectedAccount].encryptedKeys, key));
        session = key;
        return true;
      } catch {
        return false;
      }
    },
    getPassKey: async () => session,
    setPassKey: async (k: string) => {
      session = k;
    },
    getAndSetStorage: async () => state,
    update: async (u: Partial<typeof state>) => Object.assign(state, u),
    updateNested: async (_k: string, u: Record<string, Acct>) => Object.assign(state.accounts, u),
  };
  return store;
};

const TWETCH = bip39.generateMnemonic();

describe('Add account › restore a Twetch phrase into a wallet with several accounts', () => {
  test('the wallet password works, whichever account is selected', async () => {
    const store = await makeStore(3);
    const keys = new KeysService(store as never);
    const out = await keys.generateSeedAndStoreEncrypted(PASSWORD, false, TWETCH, null, null, null, 'twetch');
    expect(out.mnemonic).toBe(TWETCH);
    expect(Object.keys(store.state.accounts)).toHaveLength(4);
  });

  test('a wrong password is named as the password, not a generic failure', async () => {
    const store = await makeStore(2);
    const err = await new KeysService(store as never)
      .generateSeedAndStoreEncrypted('not it at all', false, TWETCH, null, null, null, 'twetch')
      .catch((e) => e);
    expect(restoreErrorMessage(err)).toMatch(/^Wrong password: use the password you unlock .+ with \(one for all accounts\)\.$/);
  });

  test('adding the same phrase twice is refused, not silently overwritten', async () => {
    const store = await makeStore(1);
    const keys = new KeysService(store as never);
    await keys.generateSeedAndStoreEncrypted(PASSWORD, false, TWETCH, null, null, null, 'twetch');
    const err = await keys.generateSeedAndStoreEncrypted(PASSWORD, false, TWETCH, null, null, null, 'twetch').catch((e) => e);
    expect(err).toBeInstanceOf(AccountExistsError);
    expect(restoreErrorMessage(err)).toBe('That account is already in bWalletX.');
  });

  test('a pasted phrase with numbering, capitals and line breaks is cleaned before it is checked', async () => {
    const messy = TWETCH.split(' ')
      .map((w, i) => `${i + 1}. ${i % 2 ? w.toUpperCase() : w}`)
      .join('\n');
    expect(bip39.validateMnemonic(messy)).toBe(false); // what used to fail AFTER the password step
    expect(normalizePhrase(messy)).toBe(TWETCH);
    expect(phraseProblem(messy)).toBeNull();
  });

  test('a bad phrase is caught before the password step, with the real reason', () => {
    expect(phraseProblem('one two three')).toContain('12 or 24 words');
    expect(phraseProblem(['notaword', ...TWETCH.split(' ').slice(1)].join(' '))).toContain('valid recovery phrase');
    expect(phraseProblem('')).toBe('Enter your recovery words.');
  });
});
