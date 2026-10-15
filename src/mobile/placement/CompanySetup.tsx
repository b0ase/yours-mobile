/**
 * bShares › Create your company. Any company, bCorp first. The company is a bChatX token room that chooses to
 * incorporate: token → rooms → Partnership shares → Incorporate → bShares. Steps, each its own approval:
 *   1. Your token room + Incorporate (bChatX's majority rule decides who may)
 *   2. Company details (number, jurisdiction, authorised shares)
 *   3. Share classes
 *   4. Your director keys: identity key + a treasury key from your seed (one wallet approval sheet)
 *   5. Add directors by handle: you sign approval, bChatX appoints; each new director contributes their own keys
 *      in their own wallet (step 4 on their phone)
 *   6. Choose M-of-N for the treasury and sign (one approval sheet per director)
 * Public keys only, never a private key. Never in a store build (lazy, PLACEMENT_ENABLED).
 */
import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import type { BsharesApi } from './api';
import { JURISDICTIONS, defaultM, identityKey, poundsToNano, signAct, treasuryChoices, treasuryKey } from './company';
import type { BsharesMe } from './placement';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = 'rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2';
const INPUT = 'rounded-xl bg-[#0d0e11] border border-[#2b2f36] px-3 py-2 text-sm text-white';

const Btn = ({ onClick, children, busy }: { onClick: () => void; children: React.ReactNode; busy?: boolean }) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className="self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50"
    style={{ background: GOLD, color: '#1a1300' }}
  >
    {children}
  </button>
);

const Step = ({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) => (
  <div className={CARD}>
    <div className="text-white font-bold">
      {done ? '✓' : `${n}.`} {title}
    </div>
    {children}
  </div>
);

const now = () => new Date().toISOString();

/** Start: pick the token room to incorporate (or one you just made in bChatX). */
export const CreateCompany = ({ api, onOpen }: { api: BsharesApi; onOpen: (ticker: string) => void }) => {
  const { addSnackbar } = useSnackbar();
  const [ticker, setTicker] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const t = ticker.trim().replace(/^\$/, '').toLowerCase();
    if (!t) return;
    setBusy(true);
    try {
      const r = await api.incorporate(t);
      addSnackbar(r?.error ?? 'Incorporated in bChatX. Next: company details.', r?.error ? 'error' : 'success');
      onOpen(t);
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Could not incorporate', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step n={1} title="Create your company">
      <p className="m-0 text-xs" style={{ color: MUTED }}>
        Start from your token&apos;s room. Most tokens stay tokens; when the holders want a company, the majority holder
        incorporates. Recording it here files nothing: register the company with Companies House (or your registry)
        yourself.
      </p>
      <input
        className={INPUT}
        placeholder="Token room, e.g. $pepe"
        value={ticker}
        onChange={(e) => setTicker(e.target.value)}
      />
      <Btn onClick={() => void go()} busy={busy}>
        Incorporate
      </Btn>
    </Step>
  );
};

/** The setup checklist for one company (directors only). */
export const CompanySetup = ({ api, me, onDone }: { api: BsharesApi; me: BsharesMe; onDone: () => void }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const t = me.company.ticker;
  const roomId = me.company.id ?? '';
  const board = me.board ?? [];
  const myHandle = me.viewer;
  const [busy, setBusy] = useState(false);
  const [number, setNumber] = useState(me.company.companyNumber ?? '');
  const [jur, setJur] = useState(me.company.jurisdiction ?? 'GB');
  const [authorised, setAuthorised] = useState(me.company.authorised ? String(me.company.authorised) : '');
  const [cls, setCls] = useState({ name: 'Ordinary', nominal: '0.000001', authorised: '' });
  const [invitee, setInvitee] = useState({ handle: '', name: '' });
  const [m, setM] = useState(me.company.treasuryM ?? defaultM(board.length));

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      addSnackbar(label, 'success');
      onDone();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  };

  const allKeyed = board.length > 0 && board.every((b) => b.hasKeys);
  const iHaveKeys = board.some((b) => b.hasKeys && b.handle === myHandle);

  return (
    <div className="flex flex-col gap-3">
      <Step n={2} title="Company details" done={!!me.company.companyNumber}>
        <input
          className={INPUT}
          placeholder="Company number"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <select className={INPUT} value={jur} onChange={(e) => setJur(e.target.value)}>
          {JURISDICTIONS.map((j) => (
            <option key={j}>{j}</option>
          ))}
        </select>
        <input
          className={INPUT}
          placeholder="Authorised shares in your articles (blank = none)"
          inputMode="numeric"
          value={authorised}
          onChange={(e) => setAuthorised(e.target.value)}
        />
        <Btn
          busy={busy}
          onClick={() =>
            void run('Details saved', () =>
              api.setDetails(t, {
                companyNumber: number.trim(),
                jurisdiction: jur,
                authorisedShares: authorised.trim() ? Number(authorised) : null,
                authorisedArticle: null,
              }),
            )
          }
        >
          Save details
        </Btn>
      </Step>

      <Step n={3} title="Share classes" done={(me.company.shareClasses ?? []).length > 0}>
        {(me.company.shareClasses ?? []).map((c) => (
          <div key={c.id} className="text-sm text-white">
            {c.name} · {c.sharesInIssue.toLocaleString('en-GB')} in issue
          </div>
        ))}
        <input
          className={INPUT}
          placeholder="Class name"
          value={cls.name}
          onChange={(e) => setCls({ ...cls, name: e.target.value })}
        />
        <input
          className={INPUT}
          placeholder="Nominal value (£)"
          value={cls.nominal}
          onChange={(e) => setCls({ ...cls, nominal: e.target.value })}
        />
        <Btn
          busy={busy}
          onClick={() =>
            void run('Share class added', () =>
              api.addShareClass(t, {
                name: cls.name.trim(),
                nominalNanoPounds: poundsToNano(cls.nominal),
                authorised: cls.authorised.trim() ? Number(cls.authorised) : null,
              }),
            )
          }
        >
          Add class
        </Btn>
      </Step>

      <Step n={4} title="Your director keys" done={iHaveKeys}>
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          Your wallet shares two public keys: your identity key (to sign board decisions) and a treasury key made from
          your seed for this company. Your backup restores both. No private key leaves your wallet.
        </p>
        {!iHaveKeys && (
          <Btn
            busy={busy}
            onClick={() =>
              void run('Keys recorded', async () => {
                const [idKey, tKey] = await Promise.all([identityKey(apiContext), treasuryKey(apiContext, roomId)]);
                const at = now();
                const act = {
                  kind: 'keys' as const,
                  roomId,
                  ticker: t,
                  handle: myHandle ?? '',
                  treasuryPubkey: tKey,
                  at,
                };
                await api.contributeKeys(t, {
                  identityKey: idKey,
                  treasuryPubkey: tKey,
                  at,
                  signature: await signAct(apiContext, act),
                });
              })
            }
          >
            Sign and share my keys
          </Btn>
        )}
      </Step>

      <Step n={5} title="Directors">
        {board.map((b) => (
          <div key={b.id} className="text-sm text-white">
            {b.name} (${b.handle}) · {b.hasKeys ? 'keys in' : 'waiting for their keys'}
          </div>
        ))}
        <input
          className={INPUT}
          placeholder="Invite by handle"
          value={invitee.handle}
          onChange={(e) => setInvitee({ ...invitee, handle: e.target.value })}
        />
        <input
          className={INPUT}
          placeholder="Their full name"
          value={invitee.name}
          onChange={(e) => setInvitee({ ...invitee, name: e.target.value })}
        />
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          They must be in the company&apos;s room. Once the treasury is set, other directors also sign this approval.
          The new director then shares their own keys from their own wallet.
        </p>
        <Btn
          busy={busy}
          onClick={() =>
            void run('Director approved', async () => {
              const subject = invitee.handle.trim().replace(/^\$/, '').toLowerCase();
              const at = now();
              const sig = await signAct(apiContext, { kind: 'appoint-director', roomId, ticker: t, subject, at });
              const r = await api.approveDirector(t, { subject, at, signature: sig });
              if (r.approved) await api.appointDirector(t, subject, invitee.name.trim() || subject);
              else throw new Error(`Signed. ${r.signed} of ${r.need} directors so far.`);
            })
          }
        >
          Sign and appoint
        </Btn>
      </Step>

      <Step n={6} title="Treasury" done={!!me.company.treasury}>
        {me.company.treasury ? (
          <p className="m-0 text-sm text-white">
            {me.company.treasury.m}-of-{me.company.treasury.n} multisig across the directors&apos; keys.
          </p>
        ) : allKeyed ? (
          <>
            <label className="text-xs" style={{ color: MUTED }}>
              Signatures needed to spend (of {board.length} directors)
            </label>
            <select className={INPUT} value={m} onChange={(e) => setM(Number(e.target.value))}>
              {treasuryChoices(board.length).map((k) => (
                <option key={k} value={k}>
                  {k}-of-{board.length}
                </option>
              ))}
            </select>
            <Btn
              busy={busy}
              onClick={() =>
                void run('Treasury signed', async () => {
                  const at = now();
                  // Sign the exact key list the server will rebuild the message from (slot order).
                  const { pubkeys } = await api.forCompany(t).treasuryKeys();
                  const act = { kind: 'treasury' as const, roomId, ticker: t, m, pubkeys, at };
                  const r = await api.signTreasury(t, { m, at, signature: await signAct(apiContext, act) });
                  if (!r.adopted) throw new Error(`Signed. ${r.signed} of ${r.need} directors so far.`);
                })
              }
            >
              Sign {m}-of-{board.length}
            </Btn>
          </>
        ) : (
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            Waiting for every director to share their keys.
          </p>
        )}
      </Step>
    </div>
  );
};

export default CompanySetup;
