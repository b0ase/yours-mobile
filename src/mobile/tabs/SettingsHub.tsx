import { useEffect, useState } from 'react';
import { Github } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { UNOFFICIAL_NOTICE } from '../brandText';
import { openDappBrowser } from '../dappBrowser';
import { CREDITS_TERMS } from '../credits/credits';

declare const __MOBILE_VERSION__: string;
import { AppsAndTools } from '../../pages/AppsAndTools';
import { Settings } from '../../pages/Settings';
import { useBottomMenu } from '../../hooks/useBottomMenu';

/**
 * Settings tab: upstream Settings, plus upstream Tools (locks, sweep, decoder,
 * sponsor…) and About (version, source code). Opened from the account drawer;
 * 'tools' deep-links (handleSelect('tools')) land on Tools.
 */
type Section = 'settings' | 'tools' | 'about';

const SettingsHub = () => {
  const { selected, query } = useBottomMenu();
  const { theme } = useTheme();
  const [section, setSection] = useState<Section>(selected === 'tools' ? 'tools' : 'settings');
  // Drawer deep links (create / restore account) are Settings pages.
  useEffect(() => {
    if (query) setSection('settings');
  }, [query]);

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
          {pill('about', 'About')}
        </div>
      </div>
      <div className="w-full h-full flex flex-col items-center" style={{ paddingTop: '2.75rem' }}>
        {section === 'settings' && <Settings />}
        {section === 'tools' && <AppsAndTools />}
        {section === 'about' && (
          <div className="w-full px-4 pt-20 flex flex-col gap-3">
            <div className="rounded-xl bg-[#17191E] px-4 py-3">
              <div className="text-sm font-semibold text-white">{theme.settings.displayName}</div>
              <div className="text-[11px] text-[#98A2B3]">Version {__MOBILE_VERSION__}</div>
            </div>
            <button
              onClick={() => void openDappBrowser(theme.settings.repo)}
              className="flex items-center gap-3 rounded-xl bg-[#17191E] px-4 py-3 text-left"
            >
              <Github size={18} color="#98A2B3" />
              <div>
                <div className="text-sm font-semibold text-white">Source code</div>
                <div className="text-[11px] text-[#98A2B3]">{theme.settings.repo.replace('https://', '')}</div>
              </div>
            </button>
            <div className="rounded-xl bg-[#17191E] px-4 py-3">
              <div className="text-sm font-semibold text-white">Credits</div>
              <div className="text-[11px] text-[#98A2B3]">{CREDITS_TERMS}</div>
            </div>
            <p className="text-[10px] leading-relaxed text-[#667085] text-center px-2">{UNOFFICIAL_NOTICE}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsHub;
