import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { isNative } from '../native';
import { defaultHttp, loadSession, SESSION_EVENT } from '../chat/api';
import { useContacts } from '../chat/useContacts';
import { signedInClient } from '../kyc/kycWallet';
import { ReportSheet } from '../ugc/UgcSheets';
import { blockLocal, isBlocked, onUgcChange } from '../ugc/ugc';
import {
  BpositiveApi,
  buildCheckin,
  buildCreate,
  buildPledge,
  buildVisibility,
  PUBLIC_WARNING,
  readAuth,
  buildWitness,
  canCheckInToday,
  currentDay,
  hasSigned,
  JOURNEY_KINDS,
  KIND_LABEL,
  NOTE_MAX,
  normHandle,
  openMilestoneDays,
  outcomeText,
  progress,
  satsLabel,
  signPayload,
  todayIso,
  WITNESS_COUNT,
  type AnyPayload,
  type Journey,
  type JourneyKind,
  type JourneyView,
  type SignedBody,
} from './protocol';
import './bpositive.css';

/**
 * bPositive (/m/bpositive, site /bpositive; bWalletX only, BPOSITIVE_ENABLED). Start a journey with three
 * witnesses, check in daily, see friends' pledges (promises, no money moves), confirm milestones and outcomes
 * as a witness. Private by default. Calm wording: no streak resets, no auto-fail, no shaming.
 */

const ADULT_KEY = 'bwallet.bpositive.adult';
const PROMISE = 'A promise, no money moves';
const readAdult = () => {
  try {
    return localStorage.getItem(ADULT_KEY) === '1';
  } catch {
    return false;
  }
};

type Tab = 'mine' | 'witness';

const Ring = ({ value, label, sub }: { value: number; label: string; sub: string }) => {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="bp-ring" role="img" aria-label={`${label} ${sub}`}>
      <svg viewBox="0 0 120 120" width="132" height="132">
        <circle cx="60" cy="60" r={r} className="bp-ring-track" />
        <circle
          cx="60"
          cy="60"
          r={r}
          className="bp-ring-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="bp-ring-text">
        <strong>{label}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
};

export const BPositivePage = () => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  // Reads use the bChatX session; a signed read is the fallback (rate-limited, so no polling).
  const api = useMemo(
    () =>
      new BpositiveApi(
        defaultHttp(isNative),
        readAuth(loadSession, apiContext.wallet, () => loadSession()?.handle ?? null),
      ),
    [apiContext],
  );
  const [adult, setAdult] = useState(readAdult);
  const [handle, setHandle] = useState<string | null>(() => loadSession()?.handle ?? null);
  const [tab, setTab] = useState<Tab>('mine');
  const [mine, setMine] = useState<Journey[]>([]);
  const [asWitness, setAsWitness] = useState<Journey[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setBlockTick] = useState(0);

  useEffect(() => {
    const sync = () => setHandle(loadSession()?.handle ?? null);
    window.addEventListener(SESSION_EVENT, sync);
    const off = onUgcChange(() => setBlockTick((n) => n + 1));
    return () => {
      window.removeEventListener(SESSION_EVENT, sync);
      off();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!handle) return;
    try {
      const [m, w] = await Promise.all([api.list({ owner: handle }), api.list({ witness: handle })]);
      setMine(m);
      setAsWitness(w);
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  }, [api, handle, addSnackbar]);
  // Cached in state; refreshed on open, on returning to the app and after an action. Never polled.
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);

  const signIn = async () => {
    setBusy(true);
    try {
      const c = await signedInClient(apiContext);
      setHandle(c.current?.handle ?? loadSession()?.handle ?? null);
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Sign a payload with the wallet's identity key and send it. */
  const send = useCallback(
    async <P extends AnyPayload>(payload: P, post: (b: SignedBody<P>) => Promise<unknown>, ok: string) => {
      setBusy(true);
      try {
        await post(await signPayload(apiContext.wallet, payload));
        addSnackbar(ok, 'success');
        return true;
      } catch (e) {
        addSnackbar(e instanceof Error ? e.message : String(e), 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apiContext, addSnackbar],
  );

  if (!adult) {
    return (
      <div className="bp-page">
        <h1>bPositive</h1>
        <p className="bp-muted">Journeys you take with three friends who have your back.</p>
        <div className="bp-card">
          <h3>18+ only</h3>
          <p className="bp-muted">People who start journeys, witnesses and anyone who pledges must be adults.</p>
          <button
            className="bp-btn"
            onClick={() => {
              try {
                localStorage.setItem(ADULT_KEY, '1');
              } catch {
                /* storage unavailable: ask again next time */
              }
              setAdult(true);
            }}
          >
            I'm 18 or over
          </button>
        </div>
      </div>
    );
  }

  if (!handle) {
    return (
      <div className="bp-page">
        <h1>bPositive</h1>
        <div className="bp-card">
          <p className="bp-muted">bPositive uses your bChat handle so your witnesses can find your journey.</p>
          <button className="bp-btn" disabled={busy} onClick={signIn}>
            {busy ? 'Signing in…' : 'Continue with my wallet'}
          </button>
        </div>
      </div>
    );
  }

  if (openId) {
    return (
      <JourneyScreen
        id={openId}
        me={handle}
        api={api}
        busy={busy}
        send={send}
        onBack={() => {
          setOpenId(null);
          void refresh();
        }}
      />
    );
  }

  if (creating) {
    return (
      <CreateJourney
        me={handle}
        busy={busy}
        onCancel={() => setCreating(false)}
        onCreate={async (f) => {
          let payload;
          try {
            payload = buildCreate({ handle }, f);
          } catch (e) {
            addSnackbar(e instanceof Error ? e.message : String(e), 'error');
            return;
          }
          if (await send(payload, api.create, 'Journey started. Your witnesses can see it now.')) {
            setCreating(false);
            void refresh();
          }
        }}
      />
    );
  }

  const list = (tab === 'mine' ? mine : asWitness).filter((j) => tab === 'mine' || !isBlocked(j.owner_handle));
  return (
    <div className="bp-page">
      <h1>bPositive</h1>
      <p className="bp-muted">One day at a time, with three friends who have your back. Private by default.</p>
      <div className="bp-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'on' : ''}
          onClick={() => setTab('mine')}
        >
          My journeys
        </button>
        <button
          role="tab"
          aria-selected={tab === 'witness'}
          className={tab === 'witness' ? 'on' : ''}
          onClick={() => setTab('witness')}
        >
          Witness inbox
          {asWitness.filter((j) => j.status === 'active').length
            ? ` · ${asWitness.filter((j) => j.status === 'active').length}`
            : ''}
        </button>
      </div>
      {tab === 'mine' && (
        <button className="bp-btn" onClick={() => setCreating(true)}>
          Start a journey
        </button>
      )}
      {list.length === 0 && (
        <p className="bp-muted">
          {tab === 'mine'
            ? 'No journeys yet. Start one whenever you are ready.'
            : 'When a friend asks you to witness their journey, it shows up here.'}
        </p>
      )}
      {list.map((j) => (
        <button key={j.id} className="bp-card bp-row" onClick={() => setOpenId(j.id)}>
          <div>
            <strong>{j.title}</strong>
            <div className="bp-muted bp-small">
              {KIND_LABEL[j.kind] ?? j.kind} · {tab === 'witness' ? `$${j.owner_handle} · ` : ''}
              {j.status === 'active'
                ? `day ${currentDay(j)} of ${j.goal_days}`
                : j.status === 'succeeded'
                  ? 'goal reached'
                  : 'closed'}
            </div>
          </div>
          <span className="bp-gold">›</span>
        </button>
      ))}
      <p className="bp-muted bp-small">
        Pledges are promises between friends: no money moves in bPositive. Witnesses decide milestones and the outcome;
        the app never ends a journey on its own.
      </p>
    </div>
  );
};

const CreateJourney = ({
  me,
  busy,
  onCancel,
  onCreate,
}: {
  me: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (f: { kind: JourneyKind; title: string; goalDays: number; startDate: string; witnesses: string[] }) => void;
}) => {
  const contacts = useContacts();
  const [kind, setKind] = useState<JourneyKind>('habit');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('30');
  const [start, setStart] = useState(todayIso());
  const [picked, setPicked] = useState<string[]>([]);
  const [manual, setManual] = useState('');
  const pickable = contacts
    .map((c) => c.handle)
    .filter((h): h is string => !!h && normHandle(h) !== normHandle(me) && !isBlocked(h));
  const toggle = (h: string) =>
    setPicked((p) => (p.includes(h) ? p.filter((x) => x !== h) : p.length < WITNESS_COUNT ? [...p, h] : p));
  return (
    <div className="bp-page">
      <button className="bp-link" onClick={onCancel}>
        ‹ Back
      </button>
      <h1>Start a journey</h1>
      <label className="bp-field">
        <span>What kind?</span>
        <div className="bp-chips">
          {JOURNEY_KINDS.map((k) => (
            <button key={k} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </label>
      <label className="bp-field">
        <span>Title</span>
        <input
          value={title}
          maxLength={120}
          placeholder="e.g. 90 days alcohol-free"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="bp-two">
        <label className="bp-field">
          <span>Goal (days)</span>
          <input inputMode="numeric" value={goal} onChange={(e) => setGoal(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="bp-field">
          <span>Start</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
      </div>
      <div className="bp-field">
        <span>
          Choose {WITNESS_COUNT} witnesses ({picked.length}/{WITNESS_COUNT})
        </span>
        <p className="bp-muted bp-small">
          Witnesses are friends who confirm your milestones and, at the end, the outcome. Two of three decide.
        </p>
        <div className="bp-chips">
          {[...new Set([...pickable, ...picked])].map((h) => (
            <button key={h} className={picked.includes(h) ? 'on' : ''} onClick={() => toggle(h)}>
              ${h}
            </button>
          ))}
        </div>
        <div className="bp-two">
          <input
            placeholder="$handle not in your contacts"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            className="bp-btn ghost"
            disabled={!normHandle(manual) || picked.length >= WITNESS_COUNT}
            onClick={() => {
              toggle(normHandle(manual));
              setManual('');
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="bp-card">
        <strong>Private</strong>
        <p className="bp-muted bp-small">
          Only you, your three witnesses and friends who pledge can see this journey. You can change this later.
        </p>
      </div>
      <button
        className="bp-btn"
        disabled={busy || picked.length !== WITNESS_COUNT || !title.trim()}
        onClick={() => onCreate({ kind, title, goalDays: Number(goal), startDate: start, witnesses: picked })}
      >
        {busy ? 'Signing…' : 'Sign and start'}
      </button>
    </div>
  );
};

const JourneyScreen = ({
  id,
  me,
  api,
  busy,
  send,
  onBack,
}: {
  id: string;
  me: string;
  api: BpositiveApi;
  busy: boolean;
  send: <P extends AnyPayload>(
    payload: P,
    post: (b: SignedBody<P>) => Promise<unknown>,
    ok: string,
  ) => Promise<boolean>;
  onBack: () => void;
}) => {
  const [v, setV] = useState<JourneyView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pledgeSats, setPledgeSats] = useState('');
  const [pledgeMsg, setPledgeMsg] = useState('');
  const [reporting, setReporting] = useState(false);
  const load = useCallback(() => {
    api.get(id).then(setV, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [api, id]);
  useEffect(load, [load]);

  if (err) {
    return (
      <div className="bp-page">
        <button className="bp-link" onClick={onBack}>
          ‹ Back
        </button>
        <p className="bp-muted">{err}</p>
      </div>
    );
  }
  if (!v) return <div className="bp-page bp-muted">Loading…</div>;

  const j = v.journey;
  const self = normHandle(me);
  const isOwner = normHandle(j.owner_handle) === self;
  const isWitness = j.witnesses.map(normHandle).includes(self);
  const day = currentDay(j);
  const days = new Set(v.checkins.map((c) => c.day)).size;
  const outcome = outcomeText(v);
  const after = (ok: boolean) => ok && load();
  const stamp = { handle: me };

  return (
    <div className="bp-page">
      <button className="bp-link" onClick={onBack}>
        ‹ Back
      </button>
      <h1>{j.title}</h1>
      <p className="bp-muted bp-small">
        {KIND_LABEL[j.kind] ?? j.kind} · ${j.owner_handle} · {j.visibility === 'public' ? 'Public' : 'Private'} ·
        witnesses {j.witnesses.map((w) => `$${w}`).join(', ')}
      </p>

      {isOwner && (
        <div className="bp-card bp-row">
          <span>
            <strong>{j.visibility === 'public' ? 'Public' : 'Private'}</strong>
            <span className="bp-muted bp-small">
              {' '}
              {j.visibility === 'public'
                ? 'Anyone with the link can see this journey.'
                : 'Only you, your witnesses and pledgers can see it.'}
            </span>
          </span>
          <button
            className="bp-btn small ghost"
            disabled={busy}
            onClick={async () => {
              const next = j.visibility === 'public' ? 'private' : 'public';
              if (next === 'public' && !window.confirm(PUBLIC_WARNING)) return;
              after(
                await send(
                  buildVisibility(stamp, j.id, next),
                  api.setVisibility,
                  next === 'public' ? 'Journey is now public.' : 'Journey is now private.',
                ),
              );
            }}
          >
            {j.visibility === 'public' ? 'Make private' : 'Make public'}
          </button>
        </div>
      )}
      <div className="bp-hero">
        <Ring value={progress(v)} label={`${days}`} sub={`of ${j.goal_days} days`} />
        <div>
          <strong>{outcome.title}</strong>
          <p className="bp-muted bp-small">{outcome.body}</p>
          {j.status === 'active' && day >= 1 && <p className="bp-small">Today is day {day}.</p>}
          {j.status === 'active' && day < 1 && <p className="bp-small">Starts {j.start_date}.</p>}
        </div>
      </div>

      {isOwner && canCheckInToday(v) && (
        <div className="bp-card">
          <strong>Today's check-in</strong>
          <input
            placeholder="A word about today (optional)"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="bp-btn"
            disabled={busy}
            onClick={async () => {
              const ok = await send(
                buildCheckin(stamp, j.id, day, note),
                api.checkin,
                `Day ${day} checked in. Well done.`,
              );
              if (ok) setNote('');
              after(ok);
            }}
          >
            Check in for day {day}
          </button>
        </div>
      )}
      {isOwner && j.status === 'active' && day >= 1 && !canCheckInToday(v) && (
        <p className="bp-muted bp-small">You've checked in today. See you tomorrow.</p>
      )}

      <div className="bp-card">
        <div className="bp-row">
          <strong>Pledges from friends</strong>
          <span className="bp-gold">{satsLabel(v.pot.pledged_sats)}</span>
        </div>
        <p className="bp-promise">{PROMISE}. Pledges are encouragement, recorded with a signature.</p>
        {v.pledges.length === 0 && <p className="bp-muted bp-small">No pledges yet.</p>}
        {v.pledges
          .filter((p) => !isBlocked(p.pledger_handle))
          .map((p, i) => (
            <div key={p.id ?? i} className="bp-row bp-small">
              <span>
                ${p.pledger_handle}: {satsLabel(p.amount_sats)}
                {p.message ? ` · “${p.message}”` : ''}
              </span>
              {isOwner && (
                <button className="bp-link" onClick={() => blockLocal(p.pledger_handle)}>
                  Block
                </button>
              )}
            </div>
          ))}
        {!isOwner && j.status === 'active' && (
          <>
            <div className="bp-two">
              <input
                inputMode="numeric"
                placeholder="Sats you promise"
                value={pledgeSats}
                onChange={(e) => setPledgeSats(e.target.value.replace(/\D/g, ''))}
              />
              <input
                placeholder="Message (optional)"
                maxLength={NOTE_MAX}
                value={pledgeMsg}
                onChange={(e) => setPledgeMsg(e.target.value)}
              />
            </div>
            <button
              className="bp-btn ghost"
              disabled={busy || !Number(pledgeSats)}
              onClick={async () => {
                let payload;
                try {
                  payload = buildPledge(stamp, j.id, Number(pledgeSats), pledgeMsg);
                } catch {
                  return;
                }
                const ok = await send(payload, api.pledge, 'Pledge recorded. No money has moved.');
                if (ok) {
                  setPledgeSats('');
                  setPledgeMsg('');
                }
                after(ok);
              }}
            >
              Pledge ({PROMISE.toLowerCase()})
            </button>
          </>
        )}
      </div>

      <div className="bp-card">
        <strong>Witnesses</strong>
        <p className="bp-muted bp-small">
          {v.witness.quorum} of {j.witnesses.length} witnesses decide each milestone and the outcome.
        </p>
        {v.witness.milestones
          .filter((m) => m.decided)
          .map((m) => (
            <div key={m.day} className="bp-small">
              Day {m.day}: {m.decided === 'confirm' ? 'confirmed by witnesses' : 'witnesses asked to look again'}
            </div>
          ))}
        {isWitness && j.status === 'active' && (
          <WitnessActions v={v} me={me} busy={busy} send={send} api={api} after={after} />
        )}
      </div>

      {!isOwner && (
        <div className="bp-row bp-small">
          <button className="bp-link" onClick={() => setReporting(true)}>
            Report
          </button>
          <button
            className="bp-link"
            onClick={() => {
              blockLocal(j.owner_handle);
              onBack();
            }}
          >
            Block ${j.owner_handle}
          </button>
        </div>
      )}
      {reporting && (
        <ReportSheet
          title="Report this journey"
          report={{ kind: 'user', target: `$${j.owner_handle}`, content: `bPositive journey ${j.id}: ${j.title}` }}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
};

const WitnessActions = ({
  v,
  me,
  busy,
  send,
  api,
  after,
}: {
  v: JourneyView;
  me: string;
  busy: boolean;
  send: <P extends AnyPayload>(
    payload: P,
    post: (b: SignedBody<P>) => Promise<unknown>,
    ok: string,
  ) => Promise<boolean>;
  api: BpositiveApi;
  after: (ok: boolean) => void;
}) => {
  const j = v.journey;
  const stamp = { handle: me };
  const days = openMilestoneDays(v)
    .filter((d) => !hasSigned(v, me, 'milestone', d))
    .slice(0, 5);
  const signedOutcome = hasSigned(v, me, 'outcome', 0);
  return (
    <div className="bp-witness">
      <p className="bp-small">You are a witness. Confirm what you know to be true; there is no rush.</p>
      {days.map((d) => (
        <div key={d} className="bp-row bp-small">
          <span>Day {d}</span>
          <span className="bp-actions">
            <button
              className="bp-btn small"
              disabled={busy}
              onClick={async () =>
                after(
                  await send(
                    buildWitness(stamp, j.id, { subject: 'milestone', day: d, verdict: 'confirm' }),
                    api.witness,
                    `Day ${d} confirmed.`,
                  ),
                )
              }
            >
              Confirm
            </button>
            <button
              className="bp-btn small ghost"
              disabled={busy}
              onClick={async () =>
                after(
                  await send(
                    buildWitness(stamp, j.id, { subject: 'milestone', day: d, verdict: 'reject' }),
                    api.witness,
                    'Noted, privately.',
                  ),
                )
              }
            >
              Not sure
            </button>
          </span>
        </div>
      ))}
      {signedOutcome ? (
        <p className="bp-muted bp-small">You've given your view on the outcome.</p>
      ) : (
        <div className="bp-outcome">
          <p className="bp-small">Outcome: only when the journey is complete, or the person asks you to close it.</p>
          <span className="bp-actions">
            <button
              className="bp-btn small"
              disabled={busy}
              onClick={async () =>
                window.confirm('Confirm the goal was reached? This is signed by your wallet.') &&
                after(
                  await send(
                    buildWitness(stamp, j.id, { subject: 'outcome', verdict: 'success' }),
                    api.witness,
                    'Thank you. Your confirmation is signed.',
                  ),
                )
              }
            >
              Goal reached
            </button>
            <button
              className="bp-btn small ghost"
              disabled={busy}
              onClick={async () =>
                window.confirm('Close this journey? Their check-ins stay. Two of three witnesses must agree.') &&
                after(
                  await send(
                    buildWitness(stamp, j.id, { subject: 'outcome', verdict: 'failure' }),
                    api.witness,
                    'Your view is recorded.',
                  ),
                )
              }
            >
              Close for now
            </button>
          </span>
        </div>
      )}
    </div>
  );
};

export default BPositivePage;
