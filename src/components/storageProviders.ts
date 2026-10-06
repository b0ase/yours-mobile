import { DEFAULT_ACCOUNT_URL, DEFAULT_STORAGE_REMOTE_URL } from '../utils/constants';

// Known providers only need identity + URLs. Pricing comes from the account service.
export interface StorageProvider {
  id: string;
  name: string;
  url: string;
  /** Base URL of the provider's account service (`/account/status`). */
  accountUrl: string;
  description: string;
}

// TODO: Move to a JSON file in the repo so providers can add themselves via PR
export const KNOWN_PROVIDERS: StorageProvider[] = [
  {
    id: 'a3e8c1d2-7f4b-4e9a-b6d0-1c5f8e2a9b3d',
    name: '1Sat Storage',
    url: DEFAULT_STORAGE_REMOTE_URL,
    accountUrl: DEFAULT_ACCOUNT_URL,
    description: 'Official storage partner of Yours Wallet.',
  },
];
