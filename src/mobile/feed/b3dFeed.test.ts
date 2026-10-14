import { describe, expect, it } from 'bun:test';
import { b3dItems } from './b3dItems';
import type { NftListing } from '../market/classify';

const item = (o: Partial<NftListing>): NftListing => ({
  outpoint: 'a_0',
  origin: 'a_0',
  priceSats: 1000,
  priceLabel: '0.00001 BSV',
  name: 'x',
  collectionId: null,
  collectionName: null,
  collectionIcon: null,
  contentType: 'model/gltf-binary',
  category: '3d',
  seller: '',
  buyable: true,
  ...o,
});

describe('b3D feed', () => {
  it('shows only the 3D listings the Exchange 3D filter shows, minus blocked ones', () => {
    const items = [
      item({ outpoint: 'g_0', name: 'Glider' }),
      item({ outpoint: 'p_0', category: 'images', contentType: 'image/png' }),
      item({ outpoint: 'b_0', name: 'blocked' }),
    ];
    expect(b3dItems(items, (n) => n.name !== 'blocked').map((n) => n.outpoint)).toEqual(['g_0']);
  });
});
