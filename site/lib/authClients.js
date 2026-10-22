// Sign in with bWalletX: the apps allowed to ask (docs/SIGN-IN-WITH-BWALLETX.md).
// A static allowlist for now. Every client is a PUBLIC client (no secret): PKCE S256 is required instead.
// To add an app: give it a short id, the name and site the wallet shows, and its exact redirect URIs
// (exact string match, no wildcards). Ship it in a PR; there is no self-serve registration yet.
'use strict';

/** @type {Record<string, { name: string, site: string, redirectUris: string[] }>} */
const CLIENTS = {
  bchatx: {
    name: 'bChatX',
    site: 'bchatx.com',
    redirectUris: ['https://bchatx.com/auth/bwalletx/callback', 'https://www.bchatx.com/auth/bwalletx/callback'],
  },
  'bit-sign': {
    name: 'bit-sign',
    site: 'bit-sign.online',
    redirectUris: [
      'https://bit-sign.online/auth/bwalletx/callback',
      'https://www.bit-sign.online/auth/bwalletx/callback',
    ],
  },
  dnsdex: {
    name: 'DNS DEX',
    site: 'dns-dex.com',
    redirectUris: [
      'https://www.dns-dex.com/api/auth/callback/bwalletx',
      'https://dns-dex.com/api/auth/callback/bwalletx',
    ],
  },
  clawdex: {
    name: 'CLAW DEX',
    site: 'claw-dex.com',
    redirectUris: [
      'https://claw-dex.com/api/auth/callback/bwalletx',
      'https://www.claw-dex.com/api/auth/callback/bwalletx',
    ],
  },
  // For developers trying the flow on their own machine. Redirects only ever land on the user's own localhost.
  'local-dev': {
    name: 'Local test app',
    site: 'localhost',
    redirectUris: ['http://localhost:3000/callback', 'http://127.0.0.1:3000/callback'],
  },
};

module.exports = { CLIENTS };
