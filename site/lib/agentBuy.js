// Agent purchases (owner, 28 Oct 2026): an agent discovers, quotes and buys bWalletX products from its own BRC-100
// wallet, with no person in the loop. Routes (site/api/agent-buy.js, vercel.json): GET /api/agent/products,
// POST /api/agent/quote, POST /api/agent/buy.
//
// Nothing new is sold here and nothing is granted twice: each product is the Store's own flow with shorter quotes.
//   theme   → themeBuys.js     ($1 a pack; owned packs = theme_purchases, signed Store receipt)
//   edition → themeOrders.js   ($99 a year; theme_orders)
//   branded → themeDeposits.js (from $999, by quote: the agent pays the deposit with a brief; we quote the rest)
// Quote and buy are signed by the agent's identity key like every Store call (paymail.js verifySigned) under
// their own actions, so a Store signature can't be replayed here. Quotes last 5 minutes, are single use (the row's
// status + the shared paid-txid ledger), and the claim checks the outputs pay THEME_ORDER_PAY_ADDRESS exactly the
// quoted sats with the quote's memo before broadcasting. The agent pays the network fee: no house-absorbed costs.
'use strict';
const { PACKS, PACK_LABELS } = require('./themeBuys');
const { payAddress, PRICE_USD } = require('./themeOrders');
const { depositUsd } = require('./themeDeposits');

const AGENT_QUOTE_MS = 5 * 60 * 1000;
/** Time to build, sign and send the claim after the quote's last second. Not a day, as the in-app Store allows. */
const AGENT_CLAIM_GRACE_MS = 2 * 60 * 1000;
const ACTIONS = { quote: 'agent-buy-quote', claim: 'agent-buy-claim' };
const BRANDED_FROM_USD = 999;
const PRODUCT_KINDS = new Set(['theme', 'edition', 'branded']);

/** MNEE is a dollar token (1 MNEE = $1). Quoted so an agent can budget in dollars; settlement is BSV for now. */
const mneeFor = (usd) => ({ amount: Number(usd), accepted: false, note: 'BSV only at the moment' });

/** The catalogue as agents see it. Prices come from the same tables the Store charges from. */
function listProducts(env = process.env) {
  const open = !!payAddress(env);
  const deposit = depositUsd(env);
  return {
    configured: open,
    currency: 'USD',
    pay_with: ['bsv'],
    quote_ttl_seconds: AGENT_QUOTE_MS / 1000,
    products: [
      ...Object.keys(PACKS).map((id) => ({
        product: 'theme',
        id,
        name: `${PACK_LABELS[id] || id} theme`,
        usd: PACKS[id],
        term: 'forever',
        quote_fields: { product: 'theme', pack: id },
      })),
      {
        product: 'edition',
        id: 'edition',
        name: 'Theme edition (your own theme, a page at bwalletx.com/themes/<slug>)',
        usd: PRICE_USD,
        term: '1 year',
        quote_fields: {
          product: 'edition',
          slug: '<slug>',
          name: '<name>',
          brand: '<brand>',
          isBrand: '0',
          link: '<https:// link>',
          colours: '["#rrggbb","#rrggbb"]',
          files: '<JSON list from POST /api/theme-orders/upload>',
        },
      },
      {
        product: 'branded',
        id: 'branded',
        name: 'Branded edition (by quote)',
        from_usd: BRANDED_FROM_USD,
        usd: null,
        deposit_usd: deposit || null,
        open: !!(open && deposit),
        term: 'by quote',
        note: 'Buying pays the deposit and sends your brief; we reply with the full quote. Price is from $999.',
        quote_fields: { product: 'branded', tier: 'branded', brand: '<brand>', contact: '<email or handle>' },
      },
    ],
  };
}

/**
 * Handlers: [status, body]. Deps: buy / order / deposit = handler sets built with agentHandlerOptions(), env.
 * quote fields: { product, ...the product's own fields }. buy fields: { product, quote_id, txid } + rawtx.
 */
function makeAgentBuyHandlers({ buy, order, deposit, env = process.env }) {
  const pick = (product) => ({ theme: buy, edition: order, branded: deposit })[product];
  const productOf = (body) => String(((body || {}).fields || {}).product || '');

  const products = async () => [200, listProducts(env)];

  const quote = async (body) => {
    const product = productOf(body);
    if (!PRODUCT_KINDS.has(product)) return [404, { error: 'unknown_product' }];
    if (product === 'branded' && String(body.fields.tier || '') !== 'branded') return [400, { error: 'tier: branded' }];
    const [status, out] = await pick(product).quote(body);
    if (status !== 200) return [status, out];
    return [200, { product, ...out, mnee: mneeFor(out.usd) }];
  };

  // A quote id only exists in its own product's table, so a quote bought as another product is quote_not_found.
  const claim = async (body) => {
    const product = productOf(body);
    if (!PRODUCT_KINDS.has(product)) return [404, { error: 'unknown_product' }];
    const [status, out] = await pick(product).claim(body);
    return [status, status === 200 ? { product, ...out } : out];
  };

  return { products, quote, claim };
}

/** Options for the Store handler factories when they serve agents: 5-minute quotes, agent signing actions. */
const agentHandlerOptions = () => ({
  quoteMs: AGENT_QUOTE_MS,
  claimGraceMs: AGENT_CLAIM_GRACE_MS,
  actions: { ...ACTIONS },
});

module.exports = {
  ACTIONS,
  AGENT_QUOTE_MS,
  AGENT_CLAIM_GRACE_MS,
  BRANDED_FROM_USD,
  listProducts,
  makeAgentBuyHandlers,
  agentHandlerOptions,
};
