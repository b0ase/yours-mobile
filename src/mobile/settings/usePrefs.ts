import { useEffect, useState } from 'react';
import { loadPrefs, onPrefsChange, savePrefs, type Prefs } from './prefs';

/** Live prefs: re-reads when any screen saves. */
export const usePrefs = (): [Prefs, (patch: Partial<Prefs>) => void] => {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => onPrefsChange(() => setPrefs(loadPrefs())), []);
  return [prefs, (patch) => setPrefs(savePrefs(patch))];
};
