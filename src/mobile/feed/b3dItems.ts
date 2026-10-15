import { listingsIn, type NftListing } from '../market/classify';
import { safety } from '../market/safety';

const safe = (n: NftListing) =>
  !safety().check({ ids: [n.outpoint, n.origin], collectionId: n.collectionId, texts: [n.name, n.collectionName] })
    .blocked;

/** Feed › b3D: the listings Exchange › 3D shows (model/* on the 1Sat order book), safety-filtered. */
export const b3dItems = (items: readonly NftListing[], isSafe: (n: NftListing) => boolean = safe): NftListing[] =>
  listingsIn(items, '3d').filter(isSafe);
