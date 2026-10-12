import { useEffect, useState } from 'react';
import { loadRegistry, type Registry } from './registry';

/** The Exchange registry, loaded on first use (null until then). */
export const useRegistry = (): Registry | null => {
  const [r, setR] = useState<Registry | null>(null);
  useEffect(() => {
    let live = true;
    void loadRegistry()
      .then((x) => live && setR(x))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return r;
};
