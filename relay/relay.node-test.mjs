import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, acceptableOrigin, clientIp, LIMITS } from './relay.mjs';

const C = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 chars
const exp = () => Math.floor(Date.now() / 1000) + 120;

async function boot(opts = {}) {
  const server = http.createServer();
  // Older tests describe the legacy (pre-26 Oct) behaviour; the claim tests below turn the window off.
  const relay = createRelay({ server, legacyUntil: Infinity, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  return { base, relay, done: () => (relay.close(), new Promise((r) => server.close(r))) };
}
const open = (url, origin) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on('error', reject);
  });
const until = async (fn, ms = 2000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('origins', () => {
  assert.equal(acceptableOrigin('https://tokenblaster.lol'), true);
  assert.equal(acceptableOrigin('http://localhost:3000'), true);
  assert.equal(acceptableOrigin('http://evil.example'), false);
  assert.equal(acceptableOrigin('https://a.b/path'), false);
  assert.equal(acceptableOrigin(undefined), false);
});

test('pairs, tells the phone the verified origin, forwards both ways', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const phone = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => phone.inbox.length && site.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://tokenblaster.lol' });
  assert.deepEqual(site.inbox[0], { t: 'relay', peer: 'joined', role: 'wallet' });
  phone.ws.send(JSON.stringify({ t: 'hello', k: '02ab' }));
  site.ws.send(JSON.stringify({ s: 1, n: 'x', d: 'y' }));
  await until(() => site.inbox.length === 2 && phone.inbox.length === 2);
  assert.deepEqual(site.inbox[1], { t: 'hello', k: '02ab' });
  assert.deepEqual(phone.inbox[1], { s: 1, n: 'x', d: 'y' });
  site.ws.close();
  phone.ws.close();
  await done();
});

test('rejects: no origin, wallet before site, origin change, expired QR', async () => {
  const { base, done } = await boot();
  await assert.rejects(open(`${base}/v1/c/${C}?role=site&e=${exp()}`), /403/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /404/);
  await assert.rejects(
    open(`${base}/v1/c/${C}?role=site&e=${Math.floor(Date.now() / 1000) - 5}`, 'https://a.lol'),
    /400/,
  );
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://evil.lol'), /403/);
  site.ws.close();
  await until(() => true);
  await done();
});

test('queues frames while the phone is away (app in background)', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  const p1 = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => p1.inbox.length);
  p1.ws.close();
  await until(() => site.inbox.some((m) => m.peer === 'left'));
  site.ws.send(JSON.stringify({ s: 2, n: 'n', d: 'queued' }));
  await new Promise((r) => setTimeout(r, 50));
  const p2 = await open(`${base}/v1/c/${C}?role=wallet`); // paired: rejoin allowed after QR expiry rules
  await until(() => p2.inbox.length === 2);
  assert.equal(p2.inbox[1].d, 'queued');
  site.ws.close();
  p2.ws.close();
  await done();
});

test('same-phone pairing: wallet joins while the site is away (Safari suspended), frames wait for the site', async () => {
  const { base, done } = await boot();
  const s1 = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  s1.ws.close();
  await new Promise((r) => setTimeout(r, 50));
  const phone = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => phone.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol' });
  phone.ws.send(JSON.stringify({ t: 'hello', k: '02cd' }));
  await new Promise((r) => setTimeout(r, 50));
  // Origin is still enforced when the site comes back.
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://evil.lol'), /403/);
  const s2 = await open(`${base}/v1/c/${C}?role=site`, 'https://a.lol');
  await until(() => s2.inbox.some((m) => m.t === 'hello'));
  assert.deepEqual(
    s2.inbox.find((m) => m.t === 'hello'),
    { t: 'hello', k: '02cd' },
  );
  s2.ws.close();
  phone.ws.close();
  await done();
});

test('unpaired wallet join still refused once the QR has expired (site away or not)', async () => {
  let clock = Date.now();
  const { base, done } = await boot({ now: () => clock });
  const s1 = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  s1.ws.close();
  clock += 10 * 60_000;
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /410/);
  await done();
});

test('a claimed wallet role admits only its claim; the owner can still reconnect', async () => {
  const { base, done } = await boot();
  const K = 'claimclaimclaimclaim_1'; // 22 chars
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${K}`);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /403/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=otherotherotherother_2`), /403/);
  const again = await open(`${base}/v1/c/${C}?role=wallet&claim=${K}`);
  await until(() => phone.ws.readyState === 3);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=bad`), /400/);
  site.ws.close();
  again.ws.close();
  await done();
});

test('an unclaimed role keeps the old behaviour (clients without a claim)', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const a = await open(`${base}/v1/c/${C}?role=wallet`);
  const b = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => a.ws.readyState === 3);
  site.ws.close();
  b.ws.close();
  await done();
});

// b-Aware 26 Oct 2026: N3-1 (site claim), N3-2 (QR-bound wallet claim), N3-obs (x-real-ip).
const SITE = 'siteclaimsiteclaim_0001';
const QRW = 'qrboundwalletclaim_0001';
const digest = (c) => createHash('sha256').update(c).digest('hex');

test('after the window a new channel needs a site claim, and only that claim can take the site socket', async () => {
  const { base, done } = await boot({ legacyUntil: 0 });
  await assert.rejects(open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol'), /403/);
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  // A stranger with the channel ID and the right Origin can't replace the site (was 4001 + lockout).
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://a.lol'), /403/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=site&claim=strangerstrangerstrang`, 'https://a.lol'), /403/);
  assert.equal(site.ws.readyState, 1);
  // The real site reconnects with its claim.
  const again = await open(`${base}/v1/c/${C}?role=site&claim=${SITE}`, 'https://a.lol');
  await until(() => site.ws.readyState === 3);
  again.ws.close();
  await done();
});

test('during the window a site claim still protects the channel it opened', async () => {
  const { base, done } = await boot({ legacyUntil: Date.now() + 60_000 });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://a.lol'), /403/);
  site.ws.close();
  await done();
});

test('QR-bound wallet claim: a squatter cannot pre-claim the wallet role, and the scanning phone evicts one', async () => {
  for (const legacyUntil of [0, Date.now() + 60_000]) {
    const { base, done } = await boot({ legacyUntil });
    const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
    if (legacyUntil === 0) {
      // After the window an unbound claim is refused outright.
      await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=squattersquattersquat1`), /403/);
      await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /403/);
    } else {
      // During the window an old wallet (random claim) may still join, but the QR-bound claim wins.
      const squat = await open(`${base}/v1/c/${C}?role=wallet&claim=squattersquattersquat1`);
      const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`);
      await until(() => squat.ws.readyState === 3);
      await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=squattersquattersquat1`), /403/);
      phone.ws.close();
    }
    const phone2 = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`);
    await until(() => phone2.inbox.length);
    assert.deepEqual(phone2.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol' });
    phone2.ws.close();
    site.ws.close();
    await done();
  }
});

test('wc is only for the site role and must be a SHA-256 hex digest', async () => {
  const { base, done } = await boot({ legacyUntil: 0 });
  await assert.rejects(open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=nothex`, 'https://a.lol'), /400/);
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&wc=${digest(QRW)}`), /400/);
  site.ws.close();
  await done();
});

// Wallet claim v2 (12 Nov 2026): the QR claim is computable from the QR, so it admits the first join only.
const SESS = 'sessionwalletclaim_0001';
const SESS2 = 'sessionwalletclaim_0002';

test('v2: the QR claim admits one join; afterwards only the session claim does, and the QR claim cannot evict', async () => {
  for (const legacyUntil of [0, Date.now() + 60_000]) {
    const { base, done } = await boot({ legacyUntil });
    const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
    const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
    await until(() => phone.inbox.length);
    assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol', wcv: 2 });
    // Someone who saw the QR computes the same QR claim: refused, and the phone stays connected.
    await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`), /403/);
    await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS2)}`), /403/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(phone.ws.readyState, 1);
    // The phone reconnects with its session claim.
    const again = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
    await until(() => phone.ws.readyState === 3);
    again.ws.close();
    site.ws.close();
    await done();
  }
});

test('v2: a site that proved its claim re-binds a re-created channel to the session claim', async () => {
  const { base, done } = await boot({ legacyUntil: 0 });
  // The relay restarted: the site re-creates the channel with the session claim digest it derived itself.
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(SESS)}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`), /403/);
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol', wcv: 2 });
  phone.ws.close();
  site.ws.close();
  await done();
});

test('v2: a site rejoin with wc moves the binding; without the site claim it changes nothing', async () => {
  const { base, done } = await boot({ legacyUntil: 0 });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  const v1 = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`); // a wallet from before v2: no nc
  await until(() => v1.inbox.length);
  assert.deepEqual(v1.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol' });
  v1.ws.close();
  // A stranger can't rejoin as the site to move the binding.
  await assert.rejects(
    open(`${base}/v1/c/${C}?role=site&claim=strangerstrangerstrang&wc=${digest(SESS2)}`, 'https://a.lol'),
    /403/,
  );
  const site2 = await open(`${base}/v1/c/${C}?role=site&claim=${SITE}&wc=${digest(SESS)}`, 'https://a.lol');
  await until(() => site.ws.readyState === 3);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`), /403/);
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}`);
  await until(() => phone.inbox.length);
  phone.ws.close();
  site2.ws.close();
  await done();
});

test('v2: a site claim pinned on this connect cannot move the binding (channel opened without a site claim)', async () => {
  const { base, done } = await boot({ legacyUntil: Date.now() + 60_000 });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&wc=${digest(QRW)}`, 'https://a.lol'); // no site claim
  const other = await open(
    `${base}/v1/c/${C}?role=site&claim=strangerstrangerstrang&wc=${digest(SESS2)}`,
    'https://a.lol',
  );
  await until(() => site.ws.readyState === 3);
  // The binding is still the QR one: a wallet with the stranger's session claim gets in only through the window,
  // unbound, and the scanning phone evicts it and binds.
  const squat = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS2}&nc=${digest(SESS2)}`);
  await until(() => squat.inbox.length);
  assert.equal(squat.inbox[0].wcv, undefined);
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  assert.equal(phone.inbox[0].wcv, 2);
  phone.ws.close();
  other.ws.close();
  await done();
});

test('v2: a squatter admitted by the window cannot bind; the QR phone still evicts it and binds', async () => {
  const { base, done } = await boot({ legacyUntil: Date.now() + 60_000 });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  const squat = await open(`${base}/v1/c/${C}?role=wallet&claim=squattersquattersquat1&nc=${digest(SESS2)}`);
  await until(() => squat.inbox.length);
  assert.equal(squat.inbox[0].wcv, undefined);
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => squat.ws.readyState === 3 && phone.inbox.length);
  assert.equal(phone.inbox[0].wcv, 2);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=squattersquattersquat1`), /403/);
  phone.ws.close();
  site.ws.close();
  await done();
});

test('v2: nc is only for the wallet role and must be a digest; enforcement refuses a wallet without it', async () => {
  const { base, done } = await boot({ legacyUntil: 0, sessionClaimsFrom: 0 });
  await assert.rejects(
    open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&nc=${digest(SESS)}`, 'https://a.lol'),
    /400/,
  );
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=nothex`), /400/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`), /403/); // a wallet from before v2
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  phone.ws.close();
  // Holding the role, the owner reconnects with the session claim alone.
  const again = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}`);
  again.ws.close();
  site.ws.close();
  await done();
});

// Review 13 Nov 2026 (round 2): a v1 session's claim can't bind nc later, because whoever saw the QR holds the same
// claim. The site re-binds it instead.
test('v1 claim on an unbound channel: a QR holder cannot bind its own nc; it only evicts, and the phone re-takes', async () => {
  const { base, done } = await boot({ legacyUntil: 0 });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol'); // no wc
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`);
  await until(() => phone.inbox.length);
  phone.ws.close();
  await new Promise((r) => setTimeout(r, 30));
  const evil = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest('EVIL')}`);
  await until(() => evil.inbox.length);
  assert.equal(evil.inbox[0].wcv, undefined);
  // The phone comes back on its claim (with or without its own nc) and the role is still its own.
  const back = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => back.inbox.length && evil.ws.readyState === 3);
  assert.equal(back.inbox[0].wcv, undefined);
  back.ws.close();
  site.ws.close();
  await done();
});

test('v1 QR claim after the QR expired: it binds nothing; the site re-binds the session claim and the phone moves to it', async () => {
  let clock = Date.now();
  const { base, done } = await boot({ legacyUntil: 0, now: () => clock });
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  const v1 = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`); // paired by a wallet from before v2
  await until(() => v1.inbox.length);
  v1.ws.close();
  clock += 10 * 60_000;
  await new Promise((r) => setTimeout(r, 30));
  const evil = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest('EVIL')}`);
  await until(() => evil.inbox.length);
  assert.equal(evil.inbox[0].wcv, undefined);
  evil.ws.close();
  await new Promise((r) => setTimeout(r, 30));
  // The site (it opened the channel with its claim) learns the session claim from the phone and re-binds on reconnect.
  const site2 = await open(`${base}/v1/c/${C}?role=site&claim=${SITE}&wc=${digest(SESS)}`, 'https://a.lol');
  await until(() => site.ws.readyState === 3);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}`), /403/);
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol', wcv: 2 });
  phone.ws.close();
  site2.ws.close();
  await done();
});

test('a site claim pinned after the channel opened holds the site role but cannot move the wallet binding', async () => {
  const { base, done } = await boot({ legacyUntil: Date.now() + 60_000 });
  // An old site/CLI opened the channel without a site claim; the phone paired v2.
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}&wc=${digest(QRW)}`, 'https://a.lol');
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  phone.ws.close();
  site.ws.close();
  await new Promise((r) => setTimeout(r, 30));
  // A stranger with the channel ID pins a site claim, then tries to re-bind the wallet role to its own digest.
  const A = 'strangerstrangerstrang';
  const s1 = await open(`${base}/v1/c/${C}?role=site&claim=${A}`, 'https://a.lol');
  s1.ws.close();
  await new Promise((r) => setTimeout(r, 30));
  const s2 = await open(
    `${base}/v1/c/${C}?role=site&claim=${A}&wc=${digest('EVILWEVILWEVILWEVILWEV')}`,
    'https://a.lol',
  );
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=EVILWEVILWEVILWEVILWEV`), /403/);
  const back = await open(`${base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
  await until(() => back.inbox.length);
  assert.equal(back.inbox[0].wcv, 2);
  back.ws.close();
  s2.ws.close();
  await done();
});

// Relay restarts (review 13 Nov 2026): paired channels come back from the state file.
const stateDir = mkdtempSync(join(tmpdir(), 'relay-state-'));
const statePath = (name) => join(stateDir, `${name}.json`);
const fileWritten = (path) =>
  until(() => {
    try {
      return Object.keys(JSON.parse(readFileSync(path, 'utf8')).channels).length > 0;
    } catch {
      return false;
    }
  });

test('restart: a paired channel keeps its origin and claims; whoever opens it first after a restart cannot take it', async () => {
  const live = statePath('restart');
  const a = await boot({ legacyUntil: 0, stateFile: live, stateWriteMs: 10 });
  const site = await open(`${a.base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  const phone = await open(`${a.base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  // Written after the change, without waiting for a clean stop: copy it as a crash would leave it.
  await fileWritten(live);
  const crashed = statePath('restart-crashed');
  copyFileSync(live, crashed);
  site.ws.close();
  phone.ws.close();
  await a.done();

  const b = await boot({ legacyUntil: 0, stateFile: crashed });
  assert.equal(b.relay.stats().channels, 1);
  // Someone who knows the channel ID gets there first: other origin, or the right one with their own claim.
  await assert.rejects(
    open(`${b.base}/v1/c/${C}?role=site&e=${exp()}&claim=strangerstrangerstrang`, 'https://evil.lol'),
    /403/,
  );
  await assert.rejects(
    open(`${b.base}/v1/c/${C}?role=site&e=${exp()}&claim=strangerstrangerstrang&wc=${digest(SESS2)}`, 'https://a.lol'),
    /403/,
  );
  await assert.rejects(open(`${b.base}/v1/c/${C}?role=wallet&claim=${QRW}&nc=${digest(SESS2)}`), /403/);
  // The real site and phone come back; the phone is told the real origin.
  const site2 = await open(
    `${b.base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(SESS)}`,
    'https://a.lol',
  );
  const phone2 = await open(`${b.base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
  await until(() => phone2.inbox.length);
  assert.deepEqual(phone2.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol', wcv: 2 });
  site2.ws.close();
  phone2.ws.close();
  await b.done();
});

test('restart: a v1 session bound before RELAY_SESSION_CLAIMS_FROM is still admitted afterwards', async () => {
  const path = statePath('enforce');
  const a = await boot({ legacyUntil: 0, stateFile: path });
  const site = await open(`${a.base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`, 'https://a.lol');
  const v1 = await open(`${a.base}/v1/c/${C}?role=wallet&claim=${QRW}`); // a wallet that never updated
  await until(() => v1.inbox.length);
  site.ws.close();
  v1.ws.close();
  await a.done(); // a clean stop writes the file too

  const b = await boot({ legacyUntil: 0, sessionClaimsFrom: 0, stateFile: path });
  const site2 = await open(`${b.base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  const back = await open(`${b.base}/v1/c/${C}?role=wallet&claim=${QRW}`);
  await until(() => back.inbox.length);
  // A channel nobody bound before still needs nc.
  const D = 'DDDDDDDDDDDDDDDDDDDDDD';
  const s3 = await open(`${b.base}/v1/c/${D}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  await assert.rejects(open(`${b.base}/v1/c/${D}?role=wallet&claim=${QRW}`), /403/);
  s3.ws.close();
  site2.ws.close();
  back.ws.close();
  await b.done();
});

test('restart: a missing or corrupt file starts empty; bad and lapsed entries are skipped', async () => {
  const missing = await boot({ legacyUntil: 0, stateFile: statePath('none') });
  assert.equal(missing.relay.stats().channels, 0);
  await missing.done();

  const corrupt = statePath('corrupt');
  writeFileSync(corrupt, '{"v":1,"channels":{"AAAA');
  const c = await boot({ legacyUntil: 0, stateFile: corrupt });
  assert.equal(c.relay.stats().channels, 0);
  const site = await open(`${c.base}/v1/c/${C}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
  site.ws.close();
  await c.done();

  const mixed = statePath('mixed');
  const at = Date.now() - 1000;
  const good = { o: 'https://a.lol', sc: digest(SITE), wl: digest(SESS), wb: digest(SESS), sb: true, at };
  writeFileSync(
    mixed,
    JSON.stringify({
      v: 1,
      channels: {
        [C]: good,
        BBBBBBBBBBBBBBBBBBBBBB: { ...good, o: 'http://evil.lol' },
        CCCCCCCCCCCCCCCCCCCCCC: { ...good, wb: 'nothex' },
        DDDDDDDDDDDDDDDDDDDDDD: { ...good, at: Date.now() - LIMITS.pairedIdleMs - 60_000 },
        EEEEEEEEEEEEEEEEEEEEEE: { ...good, sc: null }, // no site claim (old CLI): nothing to defend, not kept
        FFFFFFFFFFFFFFFFFFFFFF: { ...good, wb: null },
        short: good,
      },
    }),
  );
  const m = await boot({ legacyUntil: 0, stateFile: mixed });
  assert.equal(m.relay.stats().channels, 1);
  await assert.rejects(open(`${m.base}/v1/c/${C}?role=site&claim=${SITE}`, 'https://evil.lol'), /403/);
  await m.done();
});

test('restart: a restored site claim not marked as the opener holds the site role but cannot move the binding', async () => {
  const path = statePath('nosb');
  const at = Date.now() - 1000;
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      channels: { [C]: { o: 'https://a.lol', sc: digest(SITE), wl: digest(SESS), wb: digest(SESS), at } },
    }),
  );
  const b = await boot({ legacyUntil: 0, stateFile: path });
  const site = await open(`${b.base}/v1/c/${C}?role=site&claim=${SITE}&wc=${digest(SESS2)}`, 'https://a.lol');
  await assert.rejects(open(`${b.base}/v1/c/${C}?role=wallet&claim=${SESS2}`), /403/);
  const phone = await open(`${b.base}/v1/c/${C}?role=wallet&claim=${SESS}&nc=${digest(SESS)}`);
  await until(() => phone.inbox.length);
  assert.equal(phone.inbox[0].wcv, 2);
  phone.ws.close();
  site.ws.close();
  await b.done();
});

test('state file: only channels with a site claim and a wallet binding, capped (most recent first), mode 0600, no temp files left', async () => {
  const path = statePath('cap');
  const cap = LIMITS.stateChannels;
  LIMITS.stateChannels = 2;
  try {
    const a = await boot({ legacyUntil: 0, stateFile: path, stateWriteMs: 10 });
    const ids = ['CAP1AAAAAAAAAAAAAAAAAA', 'CAP2AAAAAAAAAAAAAAAAAA', 'CAP3AAAAAAAAAAAAAAAAAA'];
    for (const id of ids) {
      const s1 = await open(
        `${a.base}/v1/c/${id}?role=site&e=${exp()}&claim=${SITE}&wc=${digest(QRW)}`,
        'https://a.lol',
      );
      const w = await open(`${a.base}/v1/c/${id}?role=wallet&claim=${QRW}&nc=${digest(SESS)}`);
      await until(() => w.inbox.length);
      s1.ws.close();
      w.ws.close();
      await new Promise((r) => setTimeout(r, 5));
    }
    // Paired but without a wallet binding (site sent no wc): not worth keeping.
    const nb = 'NOWBAAAAAAAAAAAAAAAAAA';
    const s2 = await open(`${a.base}/v1/c/${nb}?role=site&e=${exp()}&claim=${SITE}`, 'https://a.lol');
    const w2 = await open(`${a.base}/v1/c/${nb}?role=wallet&claim=${QRW}`);
    await until(() => w2.inbox.length);
    await new Promise((r) => setTimeout(r, 80));
    const kept = Object.keys(JSON.parse(readFileSync(path, 'utf8')).channels);
    assert.deepEqual(kept.sort(), ids.slice(1).sort());
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(stateDir).filter((f) => f.endsWith('.tmp')),
      [],
    );
    s2.ws.close();
    w2.ws.close();
    await a.done();
  } finally {
    LIMITS.stateChannels = cap;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

test('x-real-ip is believed only from a trusted proxy', () => {
  const req = (remoteAddress, ip) => ({ socket: { remoteAddress }, headers: ip ? { 'x-real-ip': ip } : {} });
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('198.51.100.7', '203.0.113.9')), '198.51.100.7');
  assert.equal(clientIp(req('198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('10.0.0.2', '203.0.113.9'), ['10.0.0.2']), '203.0.113.9');
});
