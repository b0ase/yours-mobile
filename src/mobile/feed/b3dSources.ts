import { cached } from '../market/indexer';
import { categoryOf, type NftListing } from '../market/classify';

/**
 * Feed › b3D pinned sources (owner, 15 Oct 2026): the 3D NFT platforms 3DOrdi (3dordi.io, MAP app "3D Ordi")
 * and Zoide (zoide.io, MAP app "ZoideNFT"). Their 3D collections (model/gltf-binary) are shown first in
 * the b3D feed whether or not anything is listed for sale; unlisted items open the platform's site.
 * Collection origins were looked up on GorillaPool (inscriptions search by MAP app, 15 Oct 2026).
 */
export type B3dSource = { id: string; label: string; site: string; collections: { id: string; name: string }[] };

export const B3D_SOURCES: readonly B3dSource[] = [
  {
    id: '3dordi',
    label: '3DOrdi',
    site: 'https://3dordi.io/',
    collections: [
      { id: '897a8d56745d331518d8d88541734a55bdef58409bd99425ce4b4930397d2f11_0', name: '3D Ordi Collection' },
      { id: '2c8437c8cfe0a0737647c401cab743078332a19f9190fdd29551bf5a2464b3c0_0', name: 'TREECHAT GENESIS RING' },
      { id: '22a20866f6702aa9a78013af92b47278ce4be7adff9206a827041510af3b11dc_0', name: 'BITCOIN BSV GENESIS RING' },
      { id: '05d69bed9a10b8547b32e1afb63d8cf2759a2619039398a483093d1d8663fd6c_0', name: 'Cucumber 3D | Limited' },
      { id: 'eb01b5e6f3a61b36abec965754b267af8554aec44863c1048636f344df4fbd09_0', name: 'ONE EXTRAORDINARY CUCUMBER' },
      { id: '1933f6aee9785da861670a17a9b083224d4ff10efaaafb06a6e6b3c6262292d7_0', name: 'Brawlies' },
      {
        id: '016b4d4bab7817d33a91c6d35eaf86db111c886b228417329dbbb4875694d4c0_0',
        name: 'Los 50 cientificos mas prominentes',
      },
    ],
  },
  {
    id: 'zoide',
    label: 'Zoide',
    site: 'https://zoide.io/',
    collections: [
      {
        id: '5337bdd7baf37ff1573b2937e51f5f5070ba4b245e4f90768cf355d2497c652e_0',
        name: 'n.23 Major HTML Colours (3D)',
      },
    ],
  },
];

const SEARCH = 'https://ordinals.gorillapool.io/api/inscriptions/search';

type Row = {
  outpoint?: string;
  origin?: { outpoint?: string; data?: { insc?: { file?: { type?: string } }; map?: Record<string, unknown> } };
};

/** One collection's 3D items as feed cards (not for sale: priceSats 0). Exported for tests. */
export const rowsToItems = (rows: readonly Row[], coll: { id: string; name: string }): NftListing[] =>
  rows.flatMap((r): NftListing[] => {
    const origin = r.origin?.outpoint;
    const contentType = r.origin?.data?.insc?.file?.type ?? '';
    if (!origin || !r.outpoint || categoryOf(contentType) !== '3d') return [];
    const name = r.origin?.data?.map?.name;
    return [
      {
        outpoint: r.outpoint,
        origin,
        priceSats: 0,
        priceLabel: '',
        name: typeof name === 'string' && name ? name : coll.name,
        collectionId: coll.id,
        collectionName: coll.name,
        collectionIcon: null,
        contentType,
        category: '3d',
        seller: '',
        buyable: false,
      },
    ];
  });

/** A few items from each of a source's collections (GorillaPool search by collectionId), cached 10 min. */
export const sourceItems = (src: B3dSource, perCollection = 4): Promise<NftListing[]> =>
  cached(
    `b3d:${src.id}:${perCollection}`,
    async () => {
      const lists = await Promise.all(
        src.collections.map(async (c) => {
          try {
            const res = await fetch(`${SEARCH}?limit=${perCollection}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ map: { subTypeData: { collectionId: c.id } } }),
              signal: AbortSignal.timeout(15_000),
            });
            return res.ok ? rowsToItems(((await res.json()) as Row[] | null) ?? [], c) : [];
          } catch {
            return [];
          }
        }),
      );
      return lists.flat();
    },
    10 * 60_000,
  );
