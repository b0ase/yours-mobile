import npgBanner from '../wallet/art/npg/npg-1.webp';
import npgLogo from '../../web/themes/icon-npg-192.png';
import npgxLogo from '../../web/themes/icon-npgx-192.png';
import vexArt from '../media/featured/vexvoid-cover.jpg';

/**
 * Shops in the Store mall (owner, 17 Oct 2026): every item sits in one shop and one department, so people can
 * browse by shop (NPG, VexVoid…) or by department (Themes…). Shops are ours to start; anyone can open one later,
 * after b reviews it. Other brands (Zoide, Twetch, Treechat) only with their say-so: we hold the name, they claim it.
 */
export interface Shop {
  id: string;
  name: string;
  owner: string;
  blurb: string;
  logo: string;
  /** Banner picture, or a solid colour when there is none. */
  banner?: string;
  /** A CSS background for the banner (wins over `banner`), e.g. the logo on a pattern. */
  bannerCss?: string;
  colour: string;
  /** Theme pack ids this shop sells (Store › Themes lists the same items). */
  themes: readonly string[];
}

export const SHOPS: readonly Shop[] = [
  {
    id: 'npg',
    name: 'Ninja Punk Girls',
    owner: 'bWalletX',
    blurb: 'Themes and art from the NPG universe',
    logo: npgLogo,
    banner: npgBanner,
    colour: '#FF2E93',
    themes: ['npg'],
  },
  {
    id: 'npgx',
    name: 'NPGX',
    owner: 'bWalletX',
    blurb: 'Black and red',
    logo: npgxLogo,
    // The NPGX logo on the theme's red grid.
    bannerCss: `center / contain no-repeat url(${npgxLogo}), linear-gradient(rgba(255,0,64,.22) 1px, transparent 1px) 0 0 / 16px 16px, linear-gradient(90deg, rgba(255,0,64,.22) 1px, transparent 1px) 0 0 / 16px 16px, #000`,
    colour: '#FF2D3A',
    themes: ['npgx'],
  },
  {
    id: 'vexvoid',
    name: 'VexVoid',
    owner: 'bWalletX',
    blurb: 'White ink on true black',
    logo: vexArt,
    banner: vexArt,
    colour: '#000000',
    themes: ['vexvoid'],
  },
];

export const shopById = (id: string) => SHOPS.find((s) => s.id === id);
