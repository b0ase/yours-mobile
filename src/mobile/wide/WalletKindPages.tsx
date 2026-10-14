/**
 * Desktop sidebar › Money › Tickets and Credits (/m/tickets, /m/credits). On the phone these were Wallet views
 * (walletKind.ts) that the Tokens | NFTs | Friends switch no longer shows (KindSwitch.tsx), so the sidebar items set a
 * kind nothing rendered. Here each is its own page around the same phone component.
 */
import { TicketsSection } from '../wallet/TicketsSection';
import { CreditsRow } from '../credits/CreditsRow';
import { BCREDITS_ENABLED } from '../storeBuild';
import { WideEmpty } from './WidePage';
import { WalletTabs } from '../nfts/WalletTabs';

const Intro = ({ children }: { children: React.ReactNode }) => (
  <p className="px-[4%] pt-5 pb-3 m-0 text-sm" style={{ color: '#a3a9b3' }}>
    {children}
  </p>
);

export const TicketsPage = () => (
  <div className="bs-spaces min-h-full flex flex-col overflow-y-auto pb-10" style={{ color: '#fff' }}>
    <WalletTabs active="tickets" />
    <Intro>
      Tickets are tokens that get you into a room: chatroom tickets you minted or were given, room tokens, and your own
      personal token. Holding one lets you open its room (and join that room’s Space); you can also list them for sale.
    </Intro>
    <TicketsSection />
  </div>
);

export const CreditsPage = () =>
  BCREDITS_ENABLED ? (
    <div className="bs-spaces min-h-full flex flex-col overflow-y-auto pb-10" style={{ color: '#fff' }}>
      <WalletTabs active="credits" />
      <Intro>
        bCredits pay for b, the bWalletX agent. Top up sends a little BSV from this wallet with one approval; your
        balance, history and terms show here. Top-ups pay for b. Keep it small.
      </Intro>
      <CreditsRow />
    </div>
  ) : (
    <WideEmpty title="Credits" body="Credits are not part of this edition." />
  );
