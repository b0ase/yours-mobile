import { useNavigate } from 'react-router-dom';
import BrowserPage from '../BrowserPage';
import { HomeHeader } from './HomeHeader';
import { requestWalletAction, type WalletAction } from './walletAction';

const HomeScreen = () => {
  const navigate = useNavigate();
  const onAction = (a: WalletAction) => {
    navigate('/bsv-wallet', { replace: true });
    requestWalletAction(a);
  };
  return <BrowserPage only="home" header={<HomeHeader onAction={onAction} />} />;
};

export default HomeScreen;
