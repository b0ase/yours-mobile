import { useEffect, useState } from 'react';
import { BadgeCheck, ExternalLink, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { openDappBrowser } from '../dappBrowser';
import { KYC_PAGE_URL } from './config';
import {
  investorValid,
  kycValid,
  PLACEHOLDER_STATEMENTS,
  statementsFromServer,
  type InvestorStatement,
} from './kyc';
import { importKycCertificate, signedInClient, signInvestorStatement } from './kycWallet';
import { useKyc } from './useKyc';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Settings → Identity → "Get verified" (KYC via bit-sign's Veriff flow, stored as a BRC-52
 * certificate) and "Qualify as an investor" (UK FPO self-certification, signed with the
 * identity key).
 */
export const IdentityVerification = () => {
  const { theme } = useTheme();
  const { apiContext } = useServiceContext();
  const { query } = useBottomMenu();
  const { identityKey, kyc, investor, loading } = useKyc();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [qualifying, setQualifying] = useState(false);
  const [statements, setStatements] = useState<InvestorStatement[] | null>(null);
  const [choice, setChoice] = useState<InvestorStatement | null>(null);
  const [ticked, setTicked] = useState(false);

  const verified = kycValid(kyc, Date.now());
  const qualified = investorValid(investor, identityKey, Date.now());

  useEffect(() => {
    if (query === 'investor' && verified) setQualifying(true);
  }, [query, verified]);

  useEffect(() => {
    if (!qualifying || statements || !apiContext) return;
    signedInClient(apiContext)
      .then((c) => c.investorSelfCertOptions())
      .then((o) => {
        const s = statementsFromServer(o);
        setStatements(s.length ? s : PLACEHOLDER_STATEMENTS);
      })
      .catch(() => setStatements(PLACEHOLDER_STATEMENTS));
  }, [qualifying, statements, apiContext]);

  const gray = theme.color.global.gray;
  const fg = theme.color.global.contrast;
  const row = theme.color.global.row;
  const btn = 'px-3 py-2 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';

  const runImport = async () => {
    setBusy(true);
    setMsg('');
    try {
      const s = await importKycCertificate(apiContext);
      setMsg(`Verified${s.country ? ` · ${s.country}` : ''}. Certificate stored in your wallet.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Import failed';
      setMsg(/verification first|not_verified/i.test(m) ? 'bit-sign has no approved verification for you yet. Finish Veriff first.' : m);
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (!choice || !ticked) return;
    setBusy(true);
    setMsg('');
    try {
      const c = await signInvestorStatement(apiContext, choice);
      setQualifying(false);
      setMsg(
        c.synced
          ? `Signed. Valid until ${day(c.expiresAt)}.`
          : `Signed and saved on this device (valid until ${day(c.expiresAt)}). bit-sign did not record it yet.`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full rounded-2xl p-4 flex flex-col gap-3 mb-4" style={{ background: row }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: fg }}>
          Verified identity
        </span>
        {loading ? (
          <Loader2 size={14} className="animate-spin" color={gray} />
        ) : verified ? (
          <span className="flex items-center gap-1 text-xs font-semibold" style={{ color: '#2ecc71' }}>
            <BadgeCheck size={14} /> Verified
          </span>
        ) : (
          <span className="text-xs" style={{ color: gray }}>
            Not verified
          </span>
        )}
      </div>

      {verified && kyc ? (
        <p className="text-[11px]" style={{ color: gray }}>
          {kyc.country ? `Country ${kyc.country}` : 'Country not recorded'} ·{' '}
          {kyc.over18 === 'true' ? 'Over 18' : kyc.over18 === 'false' ? 'Under 18' : 'Age not recorded'} · Expires{' '}
          {day(kyc.expiresAt)}. Certified by bit-sign; you choose which fields to reveal to an app.
        </p>
      ) : (
        <>
          <p className="text-[11px]" style={{ color: gray }}>
            Verify once with bit-sign (Veriff), then import a certificate into this wallet. It holds only verified,
            over-18, country and level, never your name or document.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={`${btn} flex items-center gap-1`}
              style={{ background: '#FFD24D', color: '#000' }}
              onClick={() => void openDappBrowser(KYC_PAGE_URL)}
            >
              Get verified <ExternalLink size={12} />
            </button>
            <button
              type="button"
              disabled={busy}
              className={btn}
              style={{ background: '#2b2f36', color: '#fff' }}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : 'Import my certificate'}
            </button>
          </div>
        </>
      )}

      {verified && (
        <div className="flex flex-col gap-2 pt-2" style={{ borderTop: '1px solid #2b2f36' }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold" style={{ color: fg }}>
              Investor status
            </span>
            {qualified && investor ? (
              <span className="text-xs" style={{ color: '#2ecc71' }}>
                Qualified until {day(investor.expiresAt)}
              </span>
            ) : (
              <button
                type="button"
                className={btn}
                style={{ background: '#FFD24D', color: '#000' }}
                onClick={() => setQualifying((q) => !q)}
              >
                Qualify as an investor
              </button>
            )}
          </div>
          {qualifying && !qualified && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold" style={{ color: '#FFD24D' }}>
                [LEGAL REVIEW] Statement wording is pending legal review.
              </p>
              <p className="text-[11px]" style={{ color: gray }}>
                Choose the category that applies to you. You sign the statement with your identity key; it is valid for
                12 months. bit-sign records what you signed but does not verify it.
              </p>
              {statements === null && <Loader2 size={14} className="animate-spin" color={gray} />}
              {statements?.map((s) => (
                <button
                  key={s.category}
                  type="button"
                  onClick={() => {
                    setChoice(s);
                    setTicked(false);
                  }}
                  className="text-left rounded-lg p-2 border-0 cursor-pointer"
                  style={{ background: choice?.category === s.category ? '#2b2f36' : 'transparent', color: fg }}
                >
                  <div className="text-xs font-semibold">
                    {s.label} <span style={{ color: gray }}>({s.article})</span>
                  </div>
                </button>
              ))}
              {choice && (
                <>
                  <div
                    className="text-[11px] whitespace-pre-wrap rounded-lg p-2 max-h-48 overflow-y-auto"
                    style={{ background: '#010101', color: fg }}
                  >
                    {choice.statement}
                  </div>
                  <label className="flex items-start gap-2 text-[11px]" style={{ color: fg }}>
                    <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
                    I have read this statement and it applies to me.
                  </label>
                  {choice.placeholder && (
                    <p className="text-[11px]" style={{ color: '#F97066' }}>
                      bit-sign's current statements couldn't be loaded, so this placeholder can't be signed. Try again
                      when you're online.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!ticked || busy || choice.placeholder}
                    className={btn}
                    style={{ background: '#FFD24D', color: '#000' }}
                    onClick={() => void sign()}
                  >
                    {busy ? 'Signing…' : 'Sign with my identity key'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {msg && (
        <p className="text-xs" style={{ color: gray }}>
          {msg}
        </p>
      )}
    </div>
  );
};
