import { UNOFFICIAL_NOTICE as TEXT } from './brandText';

/**
 * "Unofficial" notice on the welcome screen: no one should mistake this
 * build for an official Yours release.
 */

export const initDisclaimer = () => {
  let el: HTMLDivElement | undefined;
  const update = () => {
    const text = document.body?.innerText ?? '';
    const onWelcome = text.includes('Create New Wallet') && text.includes('Restore Wallet');
    if (onWelcome && !el) {
      el = document.createElement('div');
      el.className = 'yours-disclaimer';
      el.textContent = TEXT;
      document.body.appendChild(el);
    } else if (!onWelcome && el) {
      el.remove();
      el = undefined;
    }
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
};
