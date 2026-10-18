import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBackClose } from '../backStack';
import { TopNav } from '../../components/TopNav';
import { ServiceContext } from '../../contexts/ServiceContext';
import { ChatApiError, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { fetchMyReports, releaseUrl, stageText, type MyReport } from './myReports';

/**
 * /m/reports — "Your reports" (owner, 18 Oct 2026). Everything you told b and where it stands, so a report
 * never just vanishes: Received → Looked at → Planned → Fixing → Fixed in x.y.z (with a link to the release notes).
 */
const LINE = '#2b2f36';
const STAGE_COLOR: Record<MyReport['stage'], string> = {
  received: '#9aa3ad',
  triaged: '#9aa3ad',
  planned: '#7cb7ff',
  fixing: '#F5C542',
  fixed: '#5fd38d',
  closed: '#9aa3ad',
};

const MyReportsPage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  const apiContext = useContext(ServiceContext)?.apiContext;
  const [reports, setReports] = useState<MyReport[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!apiContext) return setError('Unlock your wallet to see your reports.');
    setError('');
    const call = (m: 'GET' | 'POST', p: string, b?: unknown) =>
      signedInClient(apiContext)
        .then((c) => c.agentCall(m, p, b))
        .catch(async (e) => {
          if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
          saveSession(null);
          return (await signedInClient(apiContext, kycClient())).agentCall(m, p, b);
        });
    try {
      setReports(await fetchMyReports(call));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your reports.');
    }
  }, [apiContext]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="w-full h-full flex flex-col overflow-y-auto"
      style={{ background: 'var(--bw-bg)', paddingTop: '3.5rem', paddingBottom: 'var(--dock-h, 3.75rem)' }}
    >
      <TopNav />
      <div className="flex items-center gap-2 px-2 py-1 shrink-0" style={{ borderBottom: `1px solid ${LINE}` }}>
        <button aria-label="Back" onClick={close} className="p-2">
          <ArrowLeft size={20} color="#fff" />
        </button>
        <h1 className="text-lg font-bold text-white shrink-0">Your reports</h1>
      </div>
      <p className="px-4 pt-3 text-sm" style={{ color: '#9aa3ad' }}>
        What you told b, and where each one stands. Only you see this list.
      </p>
      {error && (
        <div className="px-4 py-3 text-sm" style={{ color: '#ffb4b4' }} role="alert">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {!error && reports === null && (
        <p className="px-4 py-3 text-sm" style={{ color: '#9aa3ad' }}>
          Loading…
        </p>
      )}
      {!error && reports?.length === 0 && (
        <p className="px-4 py-3 text-sm" style={{ color: '#9aa3ad' }}>
          Nothing yet. When something goes wrong, tap Report to b on the error, or tell b in Ask b.
        </p>
      )}
      <ul className="flex flex-col">
        {reports?.map((r) => (
          <li key={r.ref} className="px-4 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs" style={{ color: '#9aa3ad' }}>
                Ref {r.ref} · {r.category} · {r.area}
              </span>
              <span className="text-xs font-semibold" style={{ color: STAGE_COLOR[r.stage] }}>
                {stageText(r)}
              </span>
            </div>
            {r.summary && <p className="text-sm text-white mt-1 leading-snug">{r.summary}</p>}
            <div className="text-xs mt-1" style={{ color: '#6b737d' }}>
              {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              {r.fixedIn && (
                <>
                  {' · '}
                  <a href={releaseUrl(r.fixedIn)} target="_blank" rel="noreferrer" style={{ color: '#5fd38d' }}>
                    What changed in {r.fixedIn}
                  </a>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default MyReportsPage;
