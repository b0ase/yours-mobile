import { SiBnbchain, SiEthereum, SiSolana } from 'react-icons/si';
import metamaskLogo from '../../assets/wallets/metamask.svg';
import phantomLogo from '../../assets/wallets/phantom.svg';
import tronMark from '../../assets/wallets/tron.svg';
import tronlinkLogo from '../../assets/wallets/tronlink.png';
import { CHAIN_LABEL, type LinkChain, type LinkWallet } from './linkedWalletsApi';

/**
 * Wallet logos and chain badges for Settings › Linked wallets. The marks belong to their owners and are shown only to
 * name the wallet being linked; they are not recoloured or redrawn. Sources are listed in src/assets/wallets/README.md.
 */
const LOGO: Record<LinkWallet, { src: string; tile: boolean }> = {
  // The fox has no ground of its own, so it sits on the pack's card; Phantom and TronLink are app icons with their tile.
  metamask: { src: metamaskLogo, tile: true },
  phantom: { src: phantomLogo, tile: false },
  tronlink: { src: tronlinkLogo, tile: false },
};

export const WalletLogo = ({ wallet }: { wallet: LinkWallet }) => {
  const l = LOGO[wallet];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        ...(l.tile ? { padding: 3, background: 'var(--bw-card2)', boxShadow: 'inset 0 0 0 1px var(--bw-line)' } : {}),
      }}
    >
      <img src={l.src} alt="" width={24} height={24} className="h-full w-full object-contain" draggable={false} />
    </span>
  );
};

const ChainIcon = ({ chain }: { chain: LinkChain }) => {
  if (chain === 'eth') return <SiEthereum size={12} aria-hidden />;
  if (chain === 'bnb') return <SiBnbchain size={12} aria-hidden color="#F0B90B" />;
  if (chain === 'sol') return <SiSolana size={12} aria-hidden color="#9945FF" />;
  return <img src={tronMark} alt="" width={12} height={12} draggable={false} />;
};

export const ChainBadge = ({ chain }: { chain: LinkChain }) => (
  <span
    className="inline-flex shrink-0 items-center gap-1 rounded-full text-[11px] font-medium leading-none"
    style={{ padding: '3px 6px', color: 'var(--bw-muted)', boxShadow: 'inset 0 0 0 1px var(--bw-line)' }}
  >
    <ChainIcon chain={chain} />
    {CHAIN_LABEL[chain]}
  </span>
);
