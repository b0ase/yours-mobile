/**
 * Partnership shares: set up, sign, admit, pay. The agreement half of the Lock page › Vault › Partnership shares
 * section (the lock half is PartnershipShares.tsx). b drafts the agreement on bit-sign from the standard template;
 * each partner reviews it here and signs with their own wallet, and the wallet refuses to sign any text that is
 * not exactly the standard agreement for those partners. Never in a store build (lazy, via VaultSection,
 * PLACEMENT_ENABLED).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { loadSession } from '../../chat/api';
import type { BsharesApi, PartnershipRecord } from '../api';
import { payPartnership, signAgreement } from './actions';
import { RULE_WARNING, defaultRule, type TransferRule } from './partnerLock';
import {
  admitPartner,
  agreementProblem,
  bpsToPct,
  normHandle,
  pctToBps,
  splitPayment,
  splitProblem,
  type Partner,
} from './partnership';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const btn = 'self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50';
const field = 'rounded-lg bg-[#101216] text-white text-sm px-2 py-1 border border-[#2b2f36] min-w-0';
const primary = { background: GOLD, color: '#1a1300' };
const plain = { background: '#2b2f36', color: '#fff' };

const useRunner = (after: () => Promise<void>) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = (f: () => Promise<string | void>) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg((await f()) || null);
      await after();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, run };
};

const Note = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-xs" style={{ color: MUTED }}>
    {children}
  </p>
);

/** The split as a line: "$fred 30% · $joe 30% · $you 40%". */
const splitLine = (ps: Partner[]) => ps.map((p) => `$${p.handle} ${bpsToPct(p.shareBps)}`).join(' · ');

type Row = { handle: string; name: string; pct: string };

/** "Set up a partnership": name the partners by $handle with their split; b drafts the agreement. */
export function PartnershipSetup({ api, onProposed }: { api: BsharesApi; onProposed: (ticker: string) => void }) {
  const me = loadSession()?.handle ?? '';
  const [ticker, setTicker] = useState('');
  const [rows, setRows] = useState<Row[]>([
    { handle: me, name: '', pct: '' },
    { handle: '', name: '', pct: '' },
  ]);
  const [unanimous, setUnanimous] = useState(false);
  const { busy, msg, run } = useRunner(async () => {});
  const partners: Partner[] = rows.map((r) => ({
    handle: normHandle(r.handle),
    name: r.name.trim(),
    shareBps: pctToBps(r.pct) ?? 0,
  }));
  const rule: TransferRule = unanimous ? { kind: 'unanimous' } : defaultRule(partners.length);
  const problem = splitProblem(partners, rule);
  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const propose = run(async () => {
    const t = ticker.trim().replace(/^\$/, '').toUpperCase();
    if (!t) throw new Error('Which token room is this partnership for?');
    if (problem) throw new Error(problem);
    await api.proposePartnership(t, { partners, rule });
    onProposed(t);
    return 'b has drafted your agreement. Each partner reviews it and signs with their own wallet.';
  });

  return (
    <div className="flex flex-col gap-2 border-t border-[#2b2f36] pt-2">
      <span className="text-white font-bold">Set up a partnership</span>
      <Note>
        For a token room you and your partners share. Name each partner by $handle and their share; b drafts the
        agreement for everyone to sign. Partnership shares are private: never offered to the public.
      </Note>
      <input
        value={ticker}
        onChange={(e) => setTicker(e.target.value)}
        placeholder="$TOKEN room"
        aria-label="Token room"
        className={field}
      />
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_4.5rem] gap-1">
          <input
            value={r.handle}
            onChange={(e) => set(i, 'handle', e.target.value)}
            placeholder="$handle"
            aria-label={`Partner ${i + 1} handle`}
            className={field}
          />
          <input
            value={r.name}
            onChange={(e) => set(i, 'name', e.target.value)}
            placeholder="Full name"
            aria-label={`Partner ${i + 1} full name`}
            className={field}
          />
          <input
            value={r.pct}
            onChange={(e) => set(i, 'pct', e.target.value)}
            inputMode="decimal"
            placeholder="%"
            aria-label={`Partner ${i + 1} share`}
            className={field}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className={btn}
          style={plain}
          onClick={() => setRows([...rows, { handle: '', name: '', pct: '' }])}
        >
          Add partner
        </button>
        {rows.length > 2 && (
          <button type="button" className={btn} style={plain} onClick={() => setRows(rows.slice(0, -1))}>
            Remove last
          </button>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
        <input type="checkbox" checked={unanimous} onChange={(e) => setUnanimous(e.target.checked)} />
        Every partner must sign moves (unanimous)
      </label>
      <Note>{RULE_WARNING[rule.kind]}</Note>
      {problem && <Note>{problem}</Note>}
      <button type="button" disabled={busy || !!problem} onClick={propose} className={btn} style={primary}>
        Ask b to draft the agreement
      </button>
      {msg && <Note>{msg}</Note>}
    </div>
  );
}

/** One room's agreement: read, sign, admit a partner, pay the partnership. */
export function PartnershipAgreement({ api, ticker }: { api: BsharesApi; ticker: string }) {
  const { apiContext: ctx } = useServiceContext();
  const me = normHandle(loadSession()?.handle ?? '');
  const [rec, setRec] = useState<PartnershipRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [joiner, setJoiner] = useState({ handle: '', name: '', pct: '' });
  const [paySats, setPaySats] = useState('');
  const reload = useCallback(async () => setRec(await api.partnership(ticker).catch(() => null)), [api, ticker]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const { busy, msg, run } = useRunner(reload);
  if (!rec) return null;

  const { active, draft } = rec;
  const draftProblem = draft ? agreementProblem(draft) : null;
  const iSigned = !!draft?.signed.includes(me);
  const mayAmend = !!active?.partners.some((p) => p.handle === me);
  const newBps = pctToBps(joiner.pct);
  let preview: Partner[] | null = null;
  let previewError: string | null = null;
  if (active && joiner.handle && newBps) {
    try {
      preview = admitPartner(active.partners, { handle: joiner.handle, name: joiner.name }, newBps);
    } catch (e) {
      previewError = e instanceof Error ? e.message : String(e);
    }
  }
  const sats = /^\d+$/.test(paySats) ? Number(paySats) : 0;

  const sign = run(async () => {
    if (!draft) return;
    const s = await signAgreement(ctx, { roomId: rec.roomId, handle: me, draft });
    const r = await api.signPartnership(ticker, s);
    if (r.active) return 'Signed by everyone: the agreement is in force.';
    return `Signed. Waiting for ${(r.waitingFor ?? []).map((h) => `$${h}`).join(', ') || 'the other partners'}.${
      r.amendment ? ` ${r.amendment}` : ''
    }`;
  });

  const withdraw = run(async () => {
    await api.withdrawPartnershipDraft(ticker);
    return 'Draft withdrawn.';
  });

  const admit = run(async () => {
    if (!active || !preview) throw new Error(previewError ?? 'Name the new partner and their share');
    await api.proposePartnership(ticker, { partners: preview, rule: active.rule });
    setJoiner({ handle: '', name: '', pct: '' });
    return 'b has drafted the new version. It takes effect when the partners sign it.';
  });

  const pay = run(async () => {
    if (!active) return;
    const r = await payPartnership(ctx, { ticker, totalSats: sats, partners: active.partners });
    setPaySats('');
    return `Paid and split ${r.charges.length} ways (${r.txid.slice(0, 12)}…).`;
  });

  return (
    <div className="flex flex-col gap-2">
      {active && (
        <>
          <Note>
            Agreement v{active.version} in force · {splitLine(active.partners)}
          </Note>
          <Note>{rec.notice}</Note>
        </>
      )}
      {draft && (
        <div className="rounded-xl bg-[#101216] p-3 flex flex-col gap-2">
          <span className="text-sm text-white">
            {active ? `New version v${draft.version}` : `Agreement v${draft.version}`} · {splitLine(draft.partners)}
          </span>
          <Note>
            Signed by {draft.signed.length ? draft.signed.map((h) => `$${h}`).join(', ') : 'nobody yet'}. Fingerprint{' '}
            {draft.agreementSha256.slice(0, 16)}…
          </Note>
          <button type="button" className={btn} style={plain} onClick={() => setOpen(!open)}>
            {open ? 'Hide agreement' : 'Read the agreement'}
          </button>
          {open && (
            <pre className="m-0 whitespace-pre-wrap text-[11px] leading-snug text-[#d0d5dd] max-h-80 overflow-y-auto">
              {draft.agreementText}
            </pre>
          )}
          <Note>b is not a lawyer. Read it all; take advice for bigger stakes.</Note>
          {draftProblem && <Note>Can’t sign: {draftProblem}</Note>}
          {!iSigned && (
            <button type="button" disabled={busy || !!draftProblem} onClick={sign} className={btn} style={primary}>
              Sign with my wallet
            </button>
          )}
          <button type="button" disabled={busy} onClick={withdraw} className={btn} style={plain}>
            Withdraw draft
          </button>
        </div>
      )}
      {active && mayAmend && !draft && (
        <div className="flex flex-col gap-1">
          <span className="text-sm text-white">Admit a partner</span>
          <div className="grid grid-cols-[1fr_1.4fr_4.5rem] gap-1">
            <input
              value={joiner.handle}
              onChange={(e) => setJoiner({ ...joiner, handle: e.target.value })}
              placeholder="$handle"
              aria-label="New partner handle"
              className={field}
            />
            <input
              value={joiner.name}
              onChange={(e) => setJoiner({ ...joiner, name: e.target.value })}
              placeholder="Full name"
              aria-label="New partner full name"
              className={field}
            />
            <input
              value={joiner.pct}
              onChange={(e) => setJoiner({ ...joiner, pct: e.target.value })}
              inputMode="decimal"
              placeholder="%"
              aria-label="New partner share"
              className={field}
            />
          </div>
          {preview && <Note>New split: {splitLine(preview)}. Everyone else gives up the same fraction.</Note>}
          {previewError && <Note>{previewError}</Note>}
          <button type="button" disabled={busy || !preview} onClick={admit} className={btn} style={plain}>
            Propose new version
          </button>
        </div>
      )}
      {active && (
        <div className="flex flex-col gap-1">
          <span className="text-sm text-white">Pay the partnership</span>
          <Note>One payment, split by share straight to each partner’s wallet.</Note>
          <div className="flex gap-2 items-center">
            <input
              value={paySats}
              onChange={(e) => setPaySats(e.target.value.trim())}
              inputMode="numeric"
              placeholder="sats"
              aria-label="Amount in sats"
              className={`${field} w-28`}
            />
            <button type="button" disabled={busy || sats <= 0} onClick={pay} className={btn} style={plain}>
              Pay
            </button>
          </div>
          {sats > 0 && (
            <Note>
              {splitPayment(sats, active.partners)
                .map((p) => `$${p.handle} ${p.sats.toLocaleString('en-GB')}`)
                .join(' · ')}
            </Note>
          )}
        </div>
      )}
      {msg && <Note>{msg}</Note>}
    </div>
  );
}
