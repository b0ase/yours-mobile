import { useState } from 'react';
import { AppsAndTools } from '../../pages/AppsAndTools';
import { Settings } from '../../pages/Settings';
import { useBottomMenu } from '../../hooks/useBottomMenu';

/**
 * Settings tab: upstream Settings, plus upstream Tools (locks, sweep, decoder,
 * sponsor…) as a second section. 'tools' deep-links (handleSelect('tools')) land here.
 */
type Section = 'settings' | 'tools';

const SettingsHub = () => {
  const { selected } = useBottomMenu();
  const [section, setSection] = useState<Section>(selected === 'tools' ? 'tools' : 'settings');

  const pill = (id: Section, label: string) => (
    <button
      key={id}
      onClick={() => setSection(id)}
      className="flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors"
      style={{
        background: section === id ? '#2b2f36' : 'transparent',
        color: section === id ? '#FFFFFF' : '#98A2B3',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="relative w-full h-full">
      <div
        className="fixed left-0 right-0 z-[11] px-4 pb-2"
        style={{ top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)', background: '#010101' }}
      >
        <div className="flex gap-1 rounded-xl p-1 bg-[#17191E]">
          {pill('settings', 'Settings')}
          {pill('tools', 'Tools')}
        </div>
      </div>
      <div className="w-full h-full flex flex-col items-center" style={{ paddingTop: '2.75rem' }}>
        {section === 'settings' ? <Settings /> : <AppsAndTools />}
      </div>
    </div>
  );
};

export default SettingsHub;
