/**
 * Desktop sidebar › Money › Tickets (/m/tickets). On the phone this was a Wallet view
 * (walletKind.ts) that the Tokens | NFTs | Friends switch no longer shows (KindSwitch.tsx), so the sidebar item set a
 * kind nothing rendered. Here it is its own page around the same phone component.
 */
import { TicketsSection } from '../wallet/TicketsSection';
import { WalletTabs } from '../nfts/WalletTabs';
import { NamesSection } from '../wallet/NamesSection';

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

/** Desktop Wallet › Names (/m/my-names): the phone's Names view as its own page. */
export const MyNamesPage = () => (
  <div className="bs-spaces min-h-full flex flex-col overflow-y-auto pb-10" style={{ color: '#fff' }}>
    <WalletTabs active="names" />
    <Intro>
      Names this wallet holds: your $handle paymail and your OpNS names. Bind a name to your identity, sell it or give
      it away.
    </Intro>
    <NamesSection />
  </div>
);
