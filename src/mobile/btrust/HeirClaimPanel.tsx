/**
 * bTrust heir claim: an heir opens the plan file the owner gave them, sees whether the chain would accept a
 * claim yet and which seat is theirs. The heir's key is derived from their own seed (BTRUST_PROTOCOL, keyID
 * 'heir'); no server is involved. The live lock is found from the plan's owner key (derive.ts findPlanLock).
 *
 * Lead heir alone: sign, verify locally, send. Two heirs: one heir starts the claim (unsigned hex + their
 * signature), the other pastes it, adds theirs, and the finished claim is verified before sending.
 */
import { useEffect, useState } from 'react';
import { Transaction, Utils } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BTRUST_PROTOCOL, type InheritancePlan } from './inheritance';
import { claimPath, countdown, heirIndex, parsePlan } from './checkin';
import { broadcast, findPlanLock, wocChain } from './derive';
import { buildHeirsClaim, finishHeirsClaim, heirSignature, heirSigner, signLeadClaim, verifySpend } from './sign';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const INPUT = 'w-full rounded-xl bg-[#0f1115] border border-[#2b2f36] p-2 text-white text-sm';
const BTN = 'rounded-xl px-3 py-2 font-bold border-0 cursor-pointer';

/** What one heir hands the other for a two-heir claim. */
type ClaimRequest = { v: 1; tx: string; source: string; seat: number; sig: string };

export const HeirClaimPanel = ({ height }: { height: number }) => {
  const { apiContext } = useServiceContext();
  const [myKey, setMyKey] = useState('');
  const [plan, setPlan] = useState<InheritancePlan | null>(null);
  const [payTo, setPayTo] = useState('');
  const [request, setRequest] = useState('');
  const [out, setOut] = useState('');
  const [ready, setReady] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiContext.wallet
      .getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID: 'heir', counterparty: 'self' })
      .then((r) => setMyKey(r.publicKey))
      .catch(() => setMyKey(''));
  }, [apiContext]);

  const onFile = async (f: File | undefined) => {
    setError('');
    setPlan(null);
    if (!f) return;
    try {
      setPlan(parsePlan(await f.text()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that plan');
    }
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const liveLock = async (p: InheritancePlan) => {
    const lock = await findPlanLock(p, wocChain());
    if (!lock) throw new Error('No live lock found for this plan. It may have been checked in or claimed.');
    return lock;
  };

  const claimAlone = (p: InheritancePlan) =>
    run(async () => {
      const lock = await liveLock(p);
      const tx = await signLeadClaim({
        lockTx: lock.tx,
        vout: lock.vout,
        plan: p,
        lead: await heirSigner(apiContext.wallet),
        payTo: payTo.trim(),
        height,
      });
      setReady(tx);
      setOut(`Signed and verified on this device. Pays ${tx.outputs[0].satoshis?.toLocaleString('en-GB')} sats.`);
    });

  const startTogether = (p: InheritancePlan) =>
    run(async () => {
      const lock = await liveLock(p);
      const tx = buildHeirsClaim({ lockTx: lock.tx, vout: lock.vout, plan: p, payTo: payTo.trim(), height });
      const mine = await heirSignature(tx, p, await heirSigner(apiContext.wallet));
      const req: ClaimRequest = {
        v: 1,
        tx: tx.toHex(),
        source: lock.tx.toHex(),
        seat: mine.seat,
        sig: Utils.toHex(mine.sig),
      };
      setOut(JSON.stringify(req));
    });

  const finishTogether = (p: InheritancePlan) =>
    run(async () => {
      const req = JSON.parse(request) as ClaimRequest;
      if (req.v !== 1) throw new Error('That is not a bTrust claim request');
      const tx = Transaction.fromHex(req.tx);
      tx.inputs[0].sourceTransaction = Transaction.fromHex(req.source);
      const mine = await heirSignature(tx, p, await heirSigner(apiContext.wallet));
      // finishHeirsClaim checks both signatures against this exact transaction and runs the script.
      const done = await finishHeirsClaim(tx, p, [{ seat: req.seat, sig: Utils.toArray(req.sig, 'hex') }, mine]);
      setReady(done);
      const pkh = done.outputs[0].lockingScript.chunks[2]?.data;
      const to = pkh ? Utils.toBase58Check(pkh, [0]) : 'a script';
      setOut(`Both signatures verified. Pays ${done.outputs[0].satoshis?.toLocaleString('en-GB')} sats to ${to}.`);
    });

  const send = () =>
    run(async () => {
      if (!ready || !verifySpend(ready)) throw new Error('That claim did not verify, so it was not sent.');
      setOut(`Claimed. Transaction ${await broadcast(ready)}`);
      setReady(null);
    });

  const seat = plan && myKey ? heirIndex(plan, myKey) : -1;
  const path = plan ? claimPath(plan, height) : 'none';
  const c = plan ? countdown(plan, height) : null;
  const status = !plan
    ? ''
    : path === 'none'
      ? `Not yet. Any two heirs can claim in about ${c?.heirsDays} days if the owner does not check in.`
      : path === 'heirs'
        ? 'Any two heirs can claim together now. You will need one other heir to sign with you.'
        : `${plan.heirs[0].name} can now claim alone, or any two heirs together.`;

  return (
    <div className="flex flex-col gap-2 text-sm text-white" aria-label="Heir claim">
      <p className="m-0" style={{ color: MUTED }}>
        Named as an heir? Give the owner your heir key below. When the time comes, open the plan file they gave you.
      </p>
      <label className="flex flex-col gap-1">
        Your heir key
        <input readOnly className={INPUT} value={myKey || 'Loading…'} spellCheck={false} aria-label="Your heir key" />
      </label>
      <label>
        Open a plan file <input type="file" accept=".json" onChange={(e) => void onFile(e.target.files?.[0])} />
      </label>
      {error && (
        <p role="alert" className="m-0" style={{ color: '#F97066' }}>
          {error}
        </p>
      )}
      {plan && (
        <div className="flex flex-col gap-1">
          <span>{status}</span>
          <span style={{ color: MUTED }}>
            {seat >= 0
              ? `You are ${seat === 0 ? 'the lead heir' : `heir ${seat + 1}`} (${plan.heirs[seat].name}).`
              : 'Your heir key is not in this plan.'}
          </span>
          {seat >= 0 && path !== 'none' && (
            <>
              <label className="flex flex-col gap-1">
                Send the coins to (a BSV address)
                <input className={INPUT} value={payTo} onChange={(e) => setPayTo(e.target.value)} spellCheck={false} />
              </label>
              {path === 'lead' && seat === 0 && (
                <button
                  type="button"
                  className={BTN}
                  style={{ background: GOLD }}
                  disabled={busy || !payTo}
                  onClick={() => void claimAlone(plan)}
                >
                  Claim alone
                </button>
              )}
              <button
                type="button"
                className={BTN}
                style={{ background: GOLD }}
                disabled={busy || !payTo}
                onClick={() => void startTogether(plan)}
              >
                Start a claim with another heir
              </button>
              <label className="flex flex-col gap-1">
                Or paste the claim another heir sent you
                <textarea className={INPUT} rows={3} value={request} onChange={(e) => setRequest(e.target.value)} />
              </label>
              <button
                type="button"
                className={BTN}
                style={{ background: GOLD }}
                disabled={busy || !request}
                onClick={() => void finishTogether(plan)}
              >
                Add my signature
              </button>
            </>
          )}
          {out && <textarea readOnly className={INPUT} rows={3} value={out} aria-label="Claim output" />}
          {ready && (
            <button
              type="button"
              className={BTN}
              style={{ background: GOLD }}
              disabled={busy}
              onClick={() => void send()}
            >
              Send claim
            </button>
          )}
        </div>
      )}
    </div>
  );
};
