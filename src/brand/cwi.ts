/**
 * bWalletX extension's page-side wallet (MAIN world). vite.brand.ts swaps this in for src/cwi.ts.
 *
 * Upstream's createEventCWI sends every call as a `YoursRequest` page event, and the Yours extension
 * listens for the same event, so with both installed one request reached both wallets. bWalletX
 * instead:
 *  - sends its own `bWalletXRequest` event (only our content script listens: content.ts swap);
 *  - announces itself (brc100:announceWallet) so sites can offer it by name;
 *  - sets window.CWI only if it's empty, and answers legacy `YoursRequest` calls only while it holds
 *    window.CWI (a site that bundles upstream's event transport and has no other wallet).
 */
import type { WalletInterface } from '@bsv/sdk';
import { createCWI, CWIEventName } from '@1sat/wallet-browser';
import icon from '../../assets/bwalletx-ext/icon128.png?inline';
import { announceWallet, claimWindowCwi } from './discovery';

export { CWIEventName };

export const BWALLETX_REQUEST = 'bWalletXRequest';
const LEGACY_REQUEST = 'YoursRequest';

type Detail = { messageId: string; type: string; params: unknown };

const transport = (action: string, params: unknown) =>
  new Promise((resolve, reject) => {
    const messageId = `${action}-${Date.now()}-${Math.random()}`;
    self.addEventListener(
      messageId,
      (e) => {
        const { success, data, error } = (e as CustomEvent<{ success: boolean; data?: unknown; error?: string }>)
          .detail;
        if (success) resolve(data);
        else reject(new Error(error || 'Unknown error'));
      },
      { once: true },
    );
    self.dispatchEvent(new CustomEvent<Detail>(BWALLETX_REQUEST, { detail: { messageId, type: action, params } }));
  });

export const CWI: WalletInterface = createCWI(transport as Parameters<typeof createCWI>[0]);

if (typeof window !== 'undefined') {
  claimWindowCwi(CWI);
  // Legacy pages: answer upstream's event only while window.CWI is ours (checked per request, since
  // another wallet may inject after us).
  self.addEventListener(LEGACY_REQUEST, (e) => {
    if ((window as unknown as { CWI?: WalletInterface }).CWI !== CWI) return;
    self.dispatchEvent(new CustomEvent(BWALLETX_REQUEST, { detail: (e as CustomEvent<Detail>).detail }));
  });
  announceWallet({ name: 'bWalletX', icon, rdns: 'com.bwalletx.extension', kind: 'extension' }, CWI);
}
