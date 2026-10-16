import { useEffect, useState } from 'react';
import { handcashHandle, onHandCashChange } from './handcashLogin';

/** The signed-in HandCash handle ('' when not signed in), live. */
export const useHandCashHandle = () => {
  const [h, setH] = useState(handcashHandle);
  useEffect(() => onHandCashChange(() => setH(handcashHandle())), []);
  return h;
};
