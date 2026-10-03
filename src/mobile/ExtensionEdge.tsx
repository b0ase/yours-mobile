import { useEffect, useState } from 'react';
import { IS_EXTENSION } from './extension';

/**
 * bWalletX extension: a bold gold strip down the left edge of the side panel. Click (or drag it
 * left) to open the wallet full screen in a browser tab, instead of adding a button to the app.
 * Hidden when the wallet is already in a tab or a prompt window.
 */
export default function ExtensionEdge() {
  const [inPanel, setInPanel] = useState(false);

  useEffect(() => {
    if (!IS_EXTENSION || location.pathname.endsWith('prompt.html')) return;
    // The side panel isn't a tab; a full-screen copy is.
    chrome.tabs.getCurrent((tab) => setInPanel(!tab));
  }, []);

  if (!inPanel) return null;

  const openFull = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    window.close();
  };

  return (
    <button
      type="button"
      aria-label="Open bWalletX full screen"
      title="Open full screen"
      onClick={openFull}
      onPointerDown={(e) => {
        const x0 = e.clientX;
        const up = (u: PointerEvent) => {
          window.removeEventListener('pointerup', up);
          if (x0 - u.clientX > 24) openFull();
        };
        window.addEventListener('pointerup', up);
      }}
      className="fixed left-0 top-0 bottom-0 z-[1000] w-[6px] cursor-ew-resize p-0 border-0 hover:w-[10px] transition-[width]"
      style={{ background: 'linear-gradient(#FFE58A, #F5B800 50%, #C98F00)' }}
    />
  );
}
