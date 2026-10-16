import { useEffect, useState } from 'react';
import { loadBWeb, onBWebChange, saveBWeb, type BWebSettings } from './bweb';

/** bWeb settings (bweb.ts), live across screens. */
export const useBWeb = (): [BWebSettings, (patch: Partial<BWebSettings>) => void] => {
  const [s, setS] = useState<BWebSettings>(loadBWeb);
  useEffect(() => onBWebChange(() => setS(loadBWeb())), []);
  return [s, (patch) => setS(saveBWeb(patch))];
};
