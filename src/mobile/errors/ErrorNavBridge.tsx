import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { registerErrorNavigator } from './errorReport';

/** Inside the router: lets errors shown outside it (the snackbar) open b and know which screen they came from. */
export const ErrorNavBridge = () => {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    const query = new URLSearchParams(location.search).get('page') || '';
    return registerErrorNavigator(
      (to) => navigate(to),
      () => (query ? `${path} › ${query}` : path),
    );
  }, [navigate, location.pathname, location.search]);
  return null;
};
