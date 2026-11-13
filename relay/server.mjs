import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRelay, DEFAULT_TRUSTED_PROXIES, LEGACY_CLAIMS_UNTIL, SESSION_CLAIMS_FROM } from './relay.mjs';

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
// RELAY_SESSION_CLAIMS_FROM: ISO date from which a wallet taking an empty role must bring a session claim (`nc`).
// RELAY_TRUSTED_PROXIES: comma-separated socket addresses whose x-real-ip header is believed (default loopback).
// RELAY_STATE_FILE: where paired channels' origins and claim digests are kept across restarts (default
// relay-state.json next to this file; empty turns it off). One relay process per file.
const legacyEnv = process.env.RELAY_LEGACY_CLAIMS_UNTIL ? Date.parse(process.env.RELAY_LEGACY_CLAIMS_UNTIL) : NaN;
const sessionEnv = process.env.RELAY_SESSION_CLAIMS_FROM ? Date.parse(process.env.RELAY_SESSION_CLAIMS_FROM) : NaN;
const relay = createRelay({
  server,
  legacyUntil: Number.isFinite(legacyEnv) ? legacyEnv : LEGACY_CLAIMS_UNTIL,
  sessionClaimsFrom: Number.isFinite(sessionEnv) ? sessionEnv : SESSION_CLAIMS_FROM,
  trustedProxies: process.env.RELAY_TRUSTED_PROXIES
    ? process.env.RELAY_TRUSTED_PROXIES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_TRUSTED_PROXIES,
  stateFile: process.env.RELAY_STATE_FILE ?? fileURLToPath(new URL('./relay-state.json', import.meta.url)),
});
// Save the last changes on a normal stop (pm2/systemd send SIGTERM); otherwise the file is written about a second after
// changes settle.
for (const sig of ['SIGTERM', 'SIGINT'])
  process.once(sig, () => {
    relay.flush();
    process.exit(0);
  });
server.listen(PORT, HOST, () => console.log(`bwallet pair relay on ${HOST}:${PORT}`));
// Counts only, never frame contents.
setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), ...relay.stats() })), 10 * 60_000).unref();
