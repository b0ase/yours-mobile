import { useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { openDappBrowser } from '../dappBrowser';
import { saveBackupFile, saveRoute } from '../backup/backupFile';
import { KYC_PAGE_URL } from './config';
import { kycValid } from './kyc';
import { trustedCertifiers } from './kycWallet';
import {
  isOwnAddress,
  isP2pkhAddress,
  payoutAddressMessage,
  payoutProofFile,
  payoutProofFileName,
  proofDate,
  signPayoutAddress,
  storedKycCertificate,
  walletReceiveAddress,
} from './payoutProof';
import { useKyc } from './useKyc';

const btn = 'px-3 py-2 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';
const gold = { background: 'var(--bw-accent-hi)', color: '#000' };
const dark = { background: '#2b2f36', color: '#fff' };

/**
 * "Prove my reward address" (b-Aware policy v4). Signs only `bwalletx b-aware payout address <address> <date>`
 * with the identity key and hands over one JSON file: the public KYC certificate + that proof.
 */
export const PayoutProofButton = () => {
  const { apiContext } = useServiceContext();
  const { kyc, loading } = useKyc();
  const verified = kycValid(kyc, Date.now());
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [own, setOwn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [json, setJson] = useState('');
  const date = proofDate();

  useEffect(() => {
    if (!open || address || !apiContext) return;
    walletReceiveAddress(apiContext)
      .then(setAddress)
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, [open, address, apiContext]);

  useEffect(() => {
    setOwn(null);
    setJson('');
    if (!apiContext || !isP2pkhAddress(address)) return;
    let live = true;
    isOwnAddress(apiContext, address)
      .then((o) => live && setOwn(o))
      .catch(() => live && setOwn(false));
    return () => {
      live = false;
    };
  }, [address, apiContext]);

  if (loading) return null;
  if (!verified) {
    return (
      <button
        type="button"
        className={`${btn} flex items-center gap-1 self-start`}
        style={dark}
        onClick={() => void openDappBrowser(KYC_PAGE_URL)}
      >
        Prove my reward address: get verified first <ExternalLink size={12} />
      </button>
    );
  }

  const valid = isP2pkhAddress(address);
  const file = () => new File([json], payoutProofFileName(date), { type: 'application/json' });

  const sign = async () => {
    if (!apiContext || !valid) return;
    setBusy(true);
    setMsg('');
    try {
      const cert = await storedKycCertificate(apiContext.wallet, trustedCertifiers(), kyc?.serialNumber);
      if (!cert) throw new Error('No KYC certificate in this wallet. Import it first.');
      const proof = await signPayoutAddress(apiContext.wallet, address, date);
      setJson(JSON.stringify(payoutProofFile(cert, proof), null, 2));
      setMsg('Signed. Send this file to b-Aware with your report.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  const save = async (route: 'share' | 'download' | 'auto') => {
    try {
      const f = file();
      await saveBackupFile(f, route === 'auto' ? saveRoute(f, isNative) : isNative ? 'native' : route);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save the file');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setMsg('Copied.');
    } catch {
      setMsg('Could not copy. Use Save instead.');
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-2" style={{ borderTop: '1px solid #2b2f36' }}>
      <button type="button" className={`${btn} self-start`} style={gold} onClick={() => setOpen((o) => !o)}>
        Prove my reward address
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px]" style={{ color: 'var(--bw-muted, #98a2b3)' }}>
            b-Aware pays rewards of 1 BSV or more only to an address your verified identity key has signed for. You get
            one file to send with your report. It holds your public certificate, never your keys.
          </p>
          <label className="text-[11px]" style={{ color: 'var(--bw-muted, #98a2b3)' }}>
            Reward address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              spellCheck={false}
              className="w-full mt-1 rounded-lg p-2 text-xs font-mono"
              style={{ background: 'var(--bw-bg)', color: '#fff', border: '1px solid #2b2f36' }}
            />
          </label>
          {address && !valid && (
            <p className="text-[11px]" style={{ color: '#F97066' }}>
              That is not a valid BSV address.
            </p>
          )}
          {valid && own === false && (
            <p className="text-[11px] font-semibold" style={{ color: '#F97066' }}>
              This address is not in this wallet. The reward will go to whoever holds it. Only sign if it is yours.
            </p>
          )}
          {valid && own && (
            <p className="text-[11px]" style={{ color: '#2ecc71' }}>
              This wallet's own receive address.
            </p>
          )}
          {valid && !json && (
            <div className="rounded-lg p-2 flex flex-col gap-2" style={{ background: 'var(--bw-bg)' }}>
              <p className="text-[11px]" style={{ color: 'var(--bw-muted, #98a2b3)' }}>
                Sign with your identity key:
              </p>
              <code className="text-[11px] break-all" style={{ color: '#fff' }}>
                {payoutAddressMessage(address, date)}
              </code>
              <button
                type="button"
                disabled={busy}
                className={`${btn} self-start`}
                style={gold}
                onClick={() => void sign()}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : 'Sign'}
              </button>
            </div>
          )}
          {json && (
            <div className="flex gap-2 flex-wrap">
              <button type="button" className={btn} style={gold} onClick={() => void save('auto')}>
                Share
              </button>
              <button type="button" className={btn} style={dark} onClick={() => void copy()}>
                Copy
              </button>
              <button type="button" className={btn} style={dark} onClick={() => void save('download')}>
                Save
              </button>
            </div>
          )}
          {msg && (
            <p className="text-[11px]" style={{ color: 'var(--bw-muted, #98a2b3)' }}>
              {msg}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
