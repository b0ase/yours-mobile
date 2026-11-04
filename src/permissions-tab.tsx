import './utils/abortSignalPolyfill'; // AbortSignal.timeout / any on iOS 15 (utils/abortTimeout.ts): before anything else
import ReactDOM from 'react-dom/client';
import { PermissionsTab } from './mobile/permissions/PermissionsTab';

const root = document.getElementById('root');
if (!root) throw new Error('Root element');
ReactDOM.createRoot(root).render(<PermissionsTab />);
