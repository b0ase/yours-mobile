import { Users } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { BSPACES_ENABLED, PEOPLE_LABEL } from '../storeBuild';

/** People / bPeople (bWalletX: a phonebook of people with BSV $names; Release B, docs/PHONE-LAYOUT-PLAN.md §9). A placeholder in Release A. */
const PeopleScreen = () => (
  <div
    className="relative w-full h-full flex flex-col items-center justify-center gap-3 px-8 text-center"
    style={{ background: 'var(--bw-bg)' }}
  >
    <TopNav />
    <span className="h-16 w-16 rounded-3xl flex items-center justify-center bg-[var(--bw-surface)] border border-[#2b2f36]">
      <Users size={28} color="var(--bw-accent-hi)" />
    </span>
    <h1 className="text-lg font-bold text-white">{PEOPLE_LABEL}</h1>
    {BSPACES_ENABLED && <p className="text-sm text-white">Everyone you can pay by name: a phonebook of BSV $names.</p>}
    <p className="text-sm text-[#98A2B3]">
      Coming soon: the people you chat with and follow, their tokens, apps and posts.
    </p>
  </div>
);

export default PeopleScreen;
