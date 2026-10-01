import { useEffect, useState } from 'react';
import { getSnapshot, subscribe } from './store';

/** The live call controller state, for components. */
export const useCalls = () => {
  const [s, setS] = useState(getSnapshot);
  useEffect(() => subscribe(setS), []);
  return s;
};
