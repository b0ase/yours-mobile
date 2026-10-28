/**
 * Page side of `window.CWI.swap` (services/swapSite.ts): two non-standard methods for bChatX contract swaps.
 *
 *   await wallet.swap.offer({ terms })          → { offer }   (seller: signs its half, broadcasts nothing)
 *   await wallet.swap.accept({ terms, offer })  → { txid }    (buyer: checks, signs and broadcasts the one tx)
 *   await wallet.swap.release({ ref })          → { released } (seller: the room voided the offer; tokens back)
 *
 * Both open the wallet's own approval sheet. The wallet takes the origin from the browser and answers bChatX only.
 */
import { SWAP_ACCEPT_ACTION, SWAP_OFFER_ACTION, SWAP_RELEASE_ACTION } from './services/swapAction';

export const attachSwap = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.swap = Object.freeze({
    offer: (args: unknown) => transport(SWAP_OFFER_ACTION, args ?? {}),
    accept: (args: unknown) => transport(SWAP_ACCEPT_ACTION, args ?? {}),
    release: (args: unknown) => transport(SWAP_RELEASE_ACTION, args ?? {}),
  });
};
