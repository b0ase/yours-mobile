import { useEffect, useState } from 'react';
import { onUgcChange, termsAccepted } from './ugc';

/** Whether this device agreed to the current terms (ugc.ts), re-rendered when it changes. */
export const useTermsAccepted = () => {
  const [ok, setOk] = useState(termsAccepted);
  useEffect(() => onUgcChange(() => setOk(termsAccepted())), []);
  return ok;
};
