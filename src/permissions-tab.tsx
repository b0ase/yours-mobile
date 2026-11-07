import './utils/abortSignalPolyfill'; // AbortSignal.timeout / any on iOS 15 (utils/abortTimeout.ts): before anything else
import { installWocLimiter } from './services/wocLimiter';
import ReactDOM from 'react-dom/client';
import { PermissionsTab } from './mobile/permissions/PermissionsTab';

// WhatsOnChain requests share the app's one ~3/s budget (services/wocLimiter.ts).
installWocLimiter();
const root = document.getElementById('root');
if (!root) throw new Error('Root element');
ReactDOM.createRoot(root).render(<PermissionsTab />);
