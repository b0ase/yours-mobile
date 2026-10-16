import { type ComponentType, type ReactNode } from 'react';
import { Eye, LayoutGrid, Puzzle, Rss, UserRound } from 'lucide-react';
import { BAPPS as DOCK_APPS } from '../wide/BappsDock';
import { BAPPS as WALLET_BAPPS } from '../bapps';
import { STORE_BUILD } from '../storeBuild';
import { ADD_ONS, ADD_ON_PRICE_NOTE, toggleIn } from './bweb';
import { useBWeb } from './useBWeb';

type RowProps = {
  icon: ReactNode;
  label: string;
  description?: string;
  right?: ReactNode;
  onClick?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
};
type ToggleProps = { on: boolean; onChange: (v: boolean) => void; label: string };
type Kit = {
  Section: ComponentType<{ title: string; children: ReactNode }>;
  Row: ComponentType<RowProps>;
  Divider: ComponentType;
  Toggle: ComponentType<ToggleProps>;
};

/** Ask b add-ons: on/off per skill. Shown in Settings › Ask b and in bWeb. */
export const AddOnsSection = ({ Section, Row, Divider, Toggle }: Kit) => {
  const [s, set] = useBWeb();
  return (
    <Section title="Ask b add-ons">
      {ADD_ONS.map((a, i) => (
        <div key={a.id}>
          {i > 0 && <Divider />}
          <Row
            icon={<Puzzle size={16} />}
            label={a.label}
            description={`${a.description}. ${ADD_ON_PRICE_NOTE}.`}
            isFirst={i === 0}
            isLast={i === ADD_ONS.length - 1}
            right={
              <Toggle
                label={a.label}
                on={s.addOns[a.id]}
                onChange={(v) => set({ addOns: { ...s.addOns, [a.id]: v } })}
              />
            }
          />
        </div>
      ))}
    </Section>
  );
};

/**
 * Settings › bWeb (bwalletx.com/bweb): your dock, your Feed's bApps, what b may see, Ask b add-ons and
 * your linked identities. Stored on this device only (bweb.ts).
 */
export const BWebSettings = ({ onIdentities, ...kit }: Kit & { onIdentities: () => void }) => {
  const { Section, Row, Divider, Toggle } = kit;
  const [s, set] = useBWeb();
  const feedApps = WALLET_BAPPS.filter((a) => !(STORE_BUILD && a.privateOnly));
  return (
    <>
      <Section title="Dock (desktop)">
        {DOCK_APPS.map((a, i) => (
          <div key={a.id}>
            {i > 0 && <Divider />}
            <Row
              icon={<LayoutGrid size={16} />}
              label={a.name}
              isFirst={i === 0}
              isLast={i === DOCK_APPS.length - 1}
              right={
                <Toggle
                  label={`Show ${a.name} in the dock`}
                  on={!s.dockHidden.includes(a.id)}
                  onChange={(v) => set({ dockHidden: toggleIn(s.dockHidden, a.id, !v) })}
                />
              }
            />
          </div>
        ))}
      </Section>
      <Section title="Feed › bApps">
        {feedApps.map((a, i) => (
          <div key={a.name}>
            {i > 0 && <Divider />}
            <Row
              icon={<Rss size={16} />}
              label={a.name}
              isFirst={i === 0}
              isLast={i === feedApps.length - 1}
              right={
                <Toggle
                  label={`Show ${a.name} in the Feed`}
                  on={!s.feedHidden.includes(a.name)}
                  onChange={(v) => set({ feedHidden: toggleIn(s.feedHidden, a.name, !v) })}
                />
              }
            />
          </div>
        ))}
      </Section>
      <Section title="What b can see">
        <Row
          icon={<Eye size={16} />}
          label="The screen you're on"
          description="Ask b is told which screen you asked from"
          isFirst
          right={
            <Toggle
              label="Tell b the screen you're on"
              on={s.privacy.shareScreen}
              onChange={(v) => set({ privacy: { ...s.privacy, shareScreen: v } })}
            />
          }
        />
        <Divider />
        <Row
          icon={<Eye size={16} />}
          label="Your bWeb setup"
          description="Ask b is told which bApps you hid"
          isLast
          right={
            <Toggle
              label="Tell b your bWeb setup"
              on={s.privacy.shareSetup}
              onChange={(v) => set({ privacy: { ...s.privacy, shareSetup: v } })}
            />
          }
        />
      </Section>
      <AddOnsSection {...kit} />
      <Section title="Linked identities">
        <Row
          icon={<UserRound size={16} />}
          label="Identity map"
          description="Your handle, names and the sign-ins linked to them"
          onClick={onIdentities}
          isFirst
          isLast
        />
      </Section>
      <p className="px-4 pb-6 text-xs" style={{ color: '#98A2B3' }}>
        Kept on this phone only. Apps never see these settings. Which sites can use your wallet is in Settings ›
        Permissions.
      </p>
    </>
  );
};
