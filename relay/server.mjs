import http from 'node:http';
import { createRelay, DEFAULT_TRUSTED_PROXIES, LEGACY_CLAIMS_UNTIL } from './relay.mjs';

const PORT = Number(process.env.PORT ?? 8095);
const HOST = process.env.HOST ?? '127.0.0.1';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...relay.stats() }));
  }
  res.writeHead(404).end();
});
// RELAY_LEGACY_CLAIMS_UNTIL: ISO date ending the window for clients without claims (relay.mjs LEGACY_CLAIMS_UNTIL).
// RELAY_TRUSTED_PROXIES: comma-separated socket addresses whose x-real-ip header is believed (default loopback).
const legacyEnv = process.env.RELAY_LEGACY_CLAIMS_UNTIL ? Date.parse(process.env.RELAY_LEGACY_CLAIMS_UNTIL) : NaN;
const relay = createRelay({
  server,
  legacyUntil: Number.isFinite(legacyEnv) ? legacyEnv : LEGACY_CLAIMS_UNTIL,
  trustedProxies: process.env.RELAY_TRUSTED_PROXIES
    ? process.env.RELAY_TRUSTED_PROXIES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_TRUSTED_PROXIES,
});
server.listen(PORT, HOST, () => console.log(`bwallet pair relay on ${HOST}:${PORT}`));
// Counts only, never frame contents.
setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), ...relay.stats() })), 10 * 60_000).unref();
