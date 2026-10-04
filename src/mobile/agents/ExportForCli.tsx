import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { encryptAgentKeyFile, MIN_PASSPHRASE } from './agentKeyFile';
import { isAgentAccount } from './agentAccounts';
import { saveTextFile } from './saveText';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';

/**
 * Agent account › Run on a computer: export this agent account's keys, encrypted with a passphrase, for
 * `bwalletx key import` (CLI / MCP, standalone mode). Agent accounts only, current account only (its keys
 * are the unlocked ones), wallet password required.
 */
export const ExportForCli = ({ id, name }: { id: string; name: string }) => {
  const { keysService } = useServiceContext();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const run = async () => {
    setError('');
    if (!isAgentAccount(id)) return setError('Only agent accounts can be exported.');
    if (pass.length < MIN_PASSPHRASE) return setError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
    if (pass !== pass2) return setError('The passphrases don’t match.');
    setBusy(true);
    try {
      const keys = await keysService.retrieveKeys(password);
      if (keys.identityAddress !== id) throw new Error('Switch to this account first.');
      if (!keys.walletWif || !keys.ordWif || !keys.identityWif) throw new Error('This account’s keys are incomplete.');
      const file = await encryptAgentKeyFile(
        { name, identityAddress: id },
        { payPk: keys.walletWif, ordPk: keys.ordWif, identityPk: keys.identityWif },
        pass,
      );
      const text = JSON.stringify(file, null, 2);
      setDone(text);
      await saveTextFile(`${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'agent'}.key.json`, text);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(/Unauthorized|retrieve/i.test(m) ? 'Wrong wallet password.' : m);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border';
  const style = { background: '#010101', borderColor: LINE };
  return (
    <div className="rounded-2xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
      <div className="text-sm font-bold text-white">Run on a computer</div>
      <div className="text-xs" style={{ color: MUTED }}>
        Export this agent account for the bWalletX CLI and MCP (<span className="font-mono">bwalletx key import</span>), to
        run it on a laptop or server. The file is locked with a passphrase you choose. Your other accounts are never
        included.
      </div>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-lg px-3 py-2 text-sm font-bold border-0" style={{ background: '#F5B80022', color: GOLD }}>
          Export for CLI
        </button>
      ) : done ? (
        <>
          <div className="text-xs" style={{ color: '#6CE9A6' }}>
            Exported. Anyone with this file and the passphrase controls this account’s balance; keep both safe.
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(done)} className="flex-1 rounded-lg px-3 py-2 text-sm font-bold border-0" style={{ background: LINE, color: '#fff' }}>
              Copy file
            </button>
            <button type="button" onClick={() => (setDone(null), setOpen(false), setPass(''), setPass2(''))} className="flex-1 rounded-lg px-3 py-2 text-sm font-bold border-0" style={{ background: LINE, color: '#fff' }}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Wallet password" autoComplete="current-password" className={input} style={style} />
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={`New file passphrase (${MIN_PASSPHRASE}+ characters)`} autoComplete="new-password" className={input} style={style} />
          <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="Passphrase again" autoComplete="new-password" className={input} style={style} />
          {error && <div className="text-xs" style={{ color: '#FDA29B' }}>{error}</div>}
          <button type="button" disabled={busy || !password} onClick={() => void run()} className="rounded-lg px-3 py-2 text-sm font-bold border-0" style={{ background: GOLD, color: '#000', opacity: busy || !password ? 0.6 : 1 }}>
            {busy ? 'Encrypting…' : 'Export'}
          </button>
        </>
      )}
    </div>
  );
};
