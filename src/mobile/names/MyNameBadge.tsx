import { useEffect, useState } from 'react';
import { getMyName, onMyNameChange } from './myName';

/** The account's name (set via Settings → Identity → Get your name), or nothing. */
export const useMyName = (identityAddress?: string) => {
  const [name, setName] = useState(getMyName(identityAddress));
  useEffect(() => {
    setName(getMyName(identityAddress));
    return onMyNameChange(() => setName(getMyName(identityAddress)));
  }, [identityAddress]);
  return name;
};

/** Receive screen: "Your name: satchmo" under the heading (build-time insert into BsvWallet.tsx). */
export const ReceiveName = ({ identityAddress }: { identityAddress?: string }) => {
  const name = useMyName(identityAddress);
  if (!name) return null;
  return (
    <p className="text-xs text-center w-full" style={{ color: '#9aa0a6' }}>
      Or send to <span style={{ color: '#FFD24D', fontWeight: 600 }}>{name}</span>
    </p>
  );
};
