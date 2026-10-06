import { useState } from 'react';
import { checkIn, cleanLink, lastStatus, setTesterLink, testerLink, type TesterStatus } from './checkin';

/** Settings › Testing (Google Play build only): link this install to a bwalletx.com/testers place. */
export const TesterSettings = () => {
  const [link, setLink] = useState(testerLink());
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<TesterStatus | null>(lastStatus());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    const v = cleanLink(draft);
    if (!v) return setErr('Enter your tester code (BWT-XXXX-XXXX) or the Google email you applied with.');
    setErr('');
    setBusy(true);
    setTesterLink(v);
    setLink(v);
    setStatus(await checkIn(true));
    setBusy(false);
  };
  const box = { background: '#17191E', border: '1px solid #2b2f36' };
  return (
    <div className="px-4 py-3 text-sm text-white">
      {link ? (
        <>
          <div>
            Linked as <b>{link}</b>
          </div>
          {status && 'day' in status && (
            <div className="mt-1 text-[#98A2B3]">
              Day {status.day} of {status.of} · {status.counted} days checked in
              {status.playVerified ? '' : ' · install from Google Play to count'}
            </div>
          )}
          {status && 'error' in status && <div className="mt-1 text-[#ff6b6b]">{status.error}</div>}
          <button className="mt-2 text-[#98A2B3] underline" onClick={() => { setTesterLink(null); setLink(null); setStatus(null); }}>
            Unlink (stops check-ins)
          </button>
        </>
      ) : (
        <>
          <div className="text-[#98A2B3]">
            Testing bWallet for bwalletx.com/testers? Enter the tester code from your status page. The app then sends one
            check-in a day: a random install id, your code, and whether it came from Google Play. Nothing else.
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="BWT-XXXX-XXXX or email"
              autoCapitalize="characters"
              className="flex-1 rounded-lg px-2 py-1 outline-none"
              style={box}
            />
            <button disabled={busy} onClick={() => void save()} className="rounded-lg px-3 py-1 font-semibold text-black" style={{ background: '#f5c542' }}>
              Link
            </button>
          </div>
          {err && <div className="mt-1 text-[#ff6b6b]">{err}</div>}
        </>
      )}
    </div>
  );
};
