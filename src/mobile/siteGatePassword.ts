/**
 * The site gate's last fallback (owner, 30 Oct 2026: "never skip silently"): when the phone has no Face ID /
 * fingerprint AND no passcode, or its prompt fails, the wallet password is asked before a site signs or pays.
 *
 * A plain DOM sheet so it works over any screen (the in-frame bApp, the full-screen browser). The password is checked
 * against this device's encrypted keys by the storage service and never leaves the page.
 */
import { ChromeStorageService } from '../services/ChromeStorage.service';

export const askWalletPassword = (reason: string, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(false);
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6);font:15px -apple-system,system-ui,sans-serif';
    const card = document.createElement('form');
    card.style.cssText =
      'width:100%;max-width:420px;background:#0b0b0d;color:#f4f4f5;border-radius:16px 16px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom))';
    const h = document.createElement('div');
    h.textContent = reason;
    h.style.cssText = 'font-weight:600;font-size:17px';
    const sub = document.createElement('div');
    sub.textContent = `${host} · enter your wallet password`;
    sub.style.cssText = 'color:#a1a1aa;font-size:13px;margin:4px 0 12px';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.setAttribute('aria-label', 'Wallet password');
    input.style.cssText =
      'width:100%;box-sizing:border-box;height:46px;border-radius:10px;border:1px solid #3f3f46;background:#18181b;color:#fff;padding:0 12px;font-size:16px';
    const err = document.createElement('div');
    err.style.cssText = 'color:#fca5a5;font-size:13px;min-height:18px;margin-top:6px';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText =
      'flex:1;height:46px;border-radius:10px;border:1px solid #3f3f46;background:transparent;color:#e4e4e7';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'Confirm';
    ok.style.cssText =
      'flex:1;height:46px;border-radius:10px;border:0;background:#ebb828;color:#0b0b0d;font-weight:600';
    row.append(cancel, ok);
    card.append(h, sub, input, err, row);
    wrap.append(card);
    const close = (v: boolean) => {
      wrap.remove();
      resolve(v);
    };
    cancel.onclick = () => close(false);
    let tries = 0;
    card.onsubmit = async (e) => {
      e.preventDefault();
      ok.disabled = true;
      const cs = new ChromeStorageService();
      const good = await cs
        .getAndSetStorage()
        .then(() => cs.verifyPassword(input.value))
        .catch(() => false);
      ok.disabled = false;
      if (good) return close(true);
      tries += 1;
      input.value = '';
      err.textContent = tries >= 5 ? 'Too many tries.' : 'Wrong password.';
      if (tries >= 5) close(false);
    };
    document.body.append(wrap);
    input.focus();
  });
