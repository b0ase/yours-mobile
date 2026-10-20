import { useCallback, useState } from 'react';

/**
 * Collapsible home panels (owner, 20 Oct 2026): the Store showcase and the BSV price chart can be folded away with a
 * small toggle so they do not annoy anyone. The choice is kept per device, never sent anywhere.
 */
const PREFIX = 'bwx.home.collapsed.';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (private window): the panel simply opens each time
  }
};

/** True when the user folded this panel away. Anything unreadable means "open". */
export const readCollapsed = (key: string, store: Store | null = defaultStore()): boolean => {
  try {
    return store?.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
};

export const writeCollapsed = (key: string, collapsed: boolean, store: Store | null = defaultStore()): void => {
  try {
    store?.setItem(PREFIX + key, collapsed ? '1' : '0');
  } catch {
    /* quota or blocked storage: the choice just is not remembered */
  }
};

export const useCollapsed = (key: string): [boolean, () => void] => {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      writeCollapsed(key, !c);
      return !c;
    });
  }, [key]);
  return [collapsed, toggle];
};
