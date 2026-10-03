import http from 'node:http';
import { createRelay } from './relay.mjs';

const PORT = Number(process.env.PORT ?? 8095);
const HOST = process.env.HOST ?? '127.0.0.1';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...relay.stats() }));
  }
  res.writeHead(404).end();
});
const relay = createRelay({ server });
server.listen(PORT, HOST, () => console.log(`bwallet pair relay on ${HOST}:${PORT}`));
// Counts only, never frame contents.
setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), ...relay.stats() })), 10 * 60_000).unref();
