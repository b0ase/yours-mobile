import { Users } from 'lucide-react';
import { TopNav } from '../../components/TopNav';

/** People (Release B, docs/PHONE-LAYOUT-PLAN.md §9). A placeholder in Release A. */
const PeopleScreen = () => (
  <div
    className="relative w-full h-full flex flex-col items-center justify-center gap-3 px-8 text-center"
    style={{ background: '#010101' }}
  >
    <TopNav />
    <span className="h-16 w-16 rounded-3xl flex items-center justify-center bg-[#17191E] border border-[#2b2f36]">
      <Users size={28} color="#FFD24D" />
    </span>
    <h1 className="text-lg font-bold text-white">People</h1>
    <p className="text-sm text-[#98A2B3]">
      Coming soon: the people you chat with and follow, their tokens, apps and posts.
    </p>
  </div>
);

export default PeopleScreen;
