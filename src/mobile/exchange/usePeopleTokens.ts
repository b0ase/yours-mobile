import { useEffect, useState } from 'react';
import { fetchPeopleTokens, type PersonToken } from './people';

/** Everyone's personal tokens (cached per session); null while loading. */
export const usePeopleTokens = (): PersonToken[] | null => {
  const [list, setList] = useState<PersonToken[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetchPeopleTokens().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
};
