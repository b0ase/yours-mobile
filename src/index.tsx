import { Buffer } from 'buffer';
import process from 'process';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { RootErrorBoundary } from './RootErrorBoundary';
import { ServiceProvider } from './contexts/providers/ServiceProvider';
import { ThemeProvider } from './contexts/providers/ThemeProvider';
import './index.css';
import { applyBootAccent } from './mobile/theme/accent';
import { nameFailedFetch } from './utils/nameFailedFetch';
global.Buffer = Buffer;
global.process = process;
window.Buffer = Buffer;
// "Couldn't reach <host>" instead of a bare "Load failed" (utils/nameFailedFetch.ts).
nameFailedFetch();
// App accent (Theme → App colours) before the first paint: the extension popup/side panel and the web edition.
applyBootAccent();

// After a web deploy, an open tab asks for old chunk/CSS hashes that no longer exist ("Refused to apply style …
// MIME type text/plain"). Reload once to pick up the new build; a session flag stops a reload loop.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('bwallet.reloadedForDeploy')) return;
    sessionStorage.setItem('bwallet.reloadedForDeploy', '1');
  } catch {
    return;
  }
  e.preventDefault();
  window.location.reload();
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element');
const rootDiv = ReactDOM.createRoot(root);
rootDiv.render(
  <RootErrorBoundary>
    <ServiceProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ServiceProvider>
  </RootErrorBoundary>,
);
