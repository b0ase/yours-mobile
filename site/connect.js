/*!
 * bWalletX Connect — drop-in "Connect with bWalletX" for any website.
 * https://bwalletx.com/developers
 *
 *   <script src="https://bwalletx.com/connect.js"></script>
 *   const { wallet, info } = await bWalletX.connect();   // BRC-100 WalletInterface
 *
 * Finds bWalletX by BRC-100 discovery (brc100:requestWallet → brc100:announceWallet, rdns
 * com.bwalletx.extension), so it is chosen by name even when another wallet (e.g. Yours) also
 * sits on window.CWI. No keys or data pass through bwalletx.com.
 */
(function () {
  'use strict';
  var RDNS = 'com.bwalletx.extension';
  var INSTALL = 'https://bwalletx.com/extension';
  var found = {}; // rdns -> { info, wallet }

  window.addEventListener('brc100:announceWallet', function (e) {
    var d = e.detail;
    if (d && d.info && d.info.rdns && d.wallet) found[d.info.rdns] = d;
  });

  /** Every BRC-100 wallet that answered, after waiting `ms` for replies. */
  function discover(ms) {
    window.dispatchEvent(new Event('brc100:requestWallet'));
    return new Promise(function (r) {
      setTimeout(function () {
        r(Object.keys(found).map(function (k) { return found[k]; }));
      }, ms == null ? 400 : ms);
    });
  }

  /**
   * bWalletX's wallet, authenticated. Rejects with code 'NOT_INSTALLED' if bWalletX isn't there.
   * opts.timeout: ms to wait for the wallet to announce (default 1500).
   */
  function connect(opts) {
    opts = opts || {};
    var deadline = Date.now() + (opts.timeout || 1500);
    return (function poll() {
      return discover(250).then(function () {
        var d = found[RDNS];
        if (d) {
          return d.wallet.waitForAuthentication({}).then(function () {
            return d.wallet.getPublicKey({ identityKey: true }).then(function (r) {
              return { wallet: d.wallet, info: d.info, identityKey: r.publicKey };
            });
          });
        }
        if (Date.now() < deadline) return poll();
        var err = new Error('bWalletX is not installed');
        err.code = 'NOT_INSTALLED';
        err.installUrl = INSTALL;
        throw err;
      });
    })();
  }

  /** Turn any element into a Connect button. onConnect gets { wallet, info, identityKey }. */
  function button(el, onConnect, onError) {
    if (typeof el === 'string') el = document.querySelector(el);
    el.addEventListener('click', function () {
      connect().then(onConnect, function (e) {
        if (e.code === 'NOT_INSTALLED') window.open(INSTALL, '_blank', 'noopener');
        if (onError) onError(e);
      });
    });
    return el;
  }

  window.bWalletX = { connect: connect, discover: discover, button: button, RDNS: RDNS, INSTALL_URL: INSTALL };
})();
