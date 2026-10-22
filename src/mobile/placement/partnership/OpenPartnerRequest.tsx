import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PARTNER_REQUEST_EVENT, partnerRequestWaiting } from './openRequest';

/** Inside the router (MobileRoutes): a tapped partner request push opens the Lock page (Vault › Partnership shares). */
export const OpenPartnerRequest = () => {
  const navigate = useNavigate();
  const onLock = useLocation().pathname.startsWith('/m/lock');
  useEffect(() => {
    const go = () => {
      if (partnerRequestWaiting() && !onLock) navigate('/m/lock');
    };
    go();
    window.addEventListener(PARTNER_REQUEST_EVENT, go);
    return () => window.removeEventListener(PARTNER_REQUEST_EVENT, go);
  }, [navigate, onLock]);
  return null;
};
