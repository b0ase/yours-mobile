/**
 * Belt and braces for broadcasts (owner, 6 Oct 2026): a tokenblaster.lol purchase reached WhatsOnChain but not the
 * miners and sat unconfirmed until it was re-sent by hand. The wallet broadcasts through the 1Sat service and the
 * monitor never rebroadcasts (maxRebroadcastAttempts: 0), so after every broadcast we also hand the same transaction
 * (as BEEF, with its parents) straight to GorillaPool's ARC. Re-sending an already-known transaction is harmless.
 */
const ARC = 'https://arc.gorillapool.io/v1/tx';

type BeefSource = { getBeefForTxid(txid: string): Promise<{ toBinary(): number[] }> };

export async function mirrorToMiner(services: BeefSource | undefined, txid: string, f: typeof fetch = fetch) {
  if (!services) return;
  try {
    const beef = await services.getBeefForTxid(txid);
    const r = await f(ARC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(beef.toBinary()),
    });
    if (!r.ok) console.warn('[mirror] ARC', r.status, (await r.text().catch(() => '')).slice(0, 200));
  } catch (e) {
    console.warn('[mirror] could not mirror', txid, e);
  }
}
