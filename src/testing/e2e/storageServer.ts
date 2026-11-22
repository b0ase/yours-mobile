/**
 * Test support only (src/testing/e2e/spendableFirst.e2e.test.ts, BWX_STORAGE_E2E=1): the REAL bwalletx-storage server (createStorageServer, feat/spendable-first-server) on an embedded Postgres,
 * SPENDABLE_SNAPSHOT on, small page limits. A control port lets the client test register block headers (height → merkle
 * root) so the server's own proof checks run against the same one-tx blocks. Prints one JSON line {url, ctl} when ready.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const REPO = process.env.BWX_STORAGE_REPO ?? '/Volumes/2026/Projects/bwalletx-storage';
const req = createRequire(join(REPO, 'package.json'));
const EmbeddedPostgres = req('embedded-postgres').default ?? req('embedded-postgres');
const { PrivateKey, Utils } = req('@bsv/sdk');
const { createStorageServer } = req(join(REPO, 'server/src/create.ts'));
const { testKnex } = req(join(REPO, 'server/test/fixtures.ts'));

const headers = new Map<number, string>();
let tip = 900_000;
const header = (h: number) => {
  const root = headers.get(h);
  if (!root) throw new Error(`no header at ${h}`);
  return [1, 0, 0, 0, ...new Array(32).fill(0), ...Utils.toArray(root, 'hex').reverse(), ...new Array(12).fill(0)];
};
const tracker = {
  isValidRootForHeight: async (root: string, height: number) => headers.get(height) === root,
  currentHeight: async () => tip,
};
const services: Record<string, unknown> = {
  chain: 'main',
  getChainTracker: async () => tracker,
  getHeaderForHeight: async (h: number) => header(h),
  getHeight: async () => tip,
};

async function main() {
  const port = Number(process.env.PG_PORT ?? 54391);
  const dir = join(tmpdir(), `bwx-e2e-pg-${port}`);
  rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'bwxtest',
    password: 'bwx-test-local-only',
    port,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  process.env.PG_TEST_URL = `postgres://bwxtest:bwx-test-local-only@127.0.0.1:${port}/postgres`;
  const { knex, databaseName, kind } = await testKnex('e2e76');
  const server = await createStorageServer({
    knex,
    databaseName,
    serverPrivateKeyHex: PrivateKey.fromRandom().toHex(),
    port: 0,
    host: '127.0.0.1',
    services,
    beefMaxDepth: 100,
    feeModel: { model: 'sat/kb', value: 100 },
    requestLogs: false,
    preAuthRateLimitPerMin: 1_000_000,
    spendableSnapshot: {
      leanPageMax: 3,
      fullPageMax: 2,
      beefPerMin: 100_000,
      leanPerMin: 100_000,
      fullPerMin: 100_000,
    },
  });
  const ctl = createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', async () => {
      try {
        if (rq.url === '/header') {
          const { height, root } = JSON.parse(body);
          headers.set(height, root);
          tip = Math.max(tip, height);
          rs.end('{}');
        } else if (rq.url === '/sql') {
          const { sql } = JSON.parse(body);
          const r = await server.storage.knex.raw(sql);
          rs.end(JSON.stringify(r.rows ?? r));
        } else rs.end('{}');
      } catch (e) {
        rs.statusCode = 500;
        rs.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => ctl.listen(0, '127.0.0.1', () => r()));
  const ctlPort = (ctl.address() as { port: number }).port;
  console.log(
    JSON.stringify({ url: server.url, ctl: `http://127.0.0.1:${ctlPort}`, db: kind, sik: server.storageIdentityKey }),
  );
  const stop = async () => {
    try {
      await server.close();
    } catch {
      // already stopped
    }
    try {
      await knex.destroy();
    } catch {
      // already stopped
    }
    try {
      await pg.stop();
    } catch {
      // already stopped
    }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
