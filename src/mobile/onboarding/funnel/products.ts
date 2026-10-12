import type { FunnelProduct } from './funnel';

/** Per-product funnel copy. Calm and short: what you get, how long it takes. bMusic first; more products later. */
export const BMUSIC_FUNNEL: FunnelProduct = {
  id: 'bmusic',
  sponsor: 'VexVoid',
  wallet: {
    kicker: 'Get bWalletX',
    title: 'Hear tracks 2–6 free',
    body: 'Sponsored by VexVoid. Takes 20 seconds, and you come straight back to the album.',
    cta: 'Get bWalletX',
  },
  funds: {
    title: 'Add a little BSV',
    body: 'The rest of the album is {cost} at 1 sat a second, paid straight to the artist. Add some, and it plays on.',
    after: 'The album carries on by itself once it arrives.',
  },
};
