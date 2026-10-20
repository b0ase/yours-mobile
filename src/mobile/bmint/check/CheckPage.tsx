import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { lookupPaymail } from '../../names/paymail';
import { checkMint } from './sources';
import { parseOutpoint, sha256File, type Verdict } from './verify';
import './check.css';

/**
 * bMint › Check (/m/bmint/check, linkable as /bmint/check?o=<outpoint> or /check?o=…): paste a mint link
 * or txid, optionally drop the file, get one verdict. The file is hashed on this device and never sent.
 * The verdict comes from check/verify.ts; nothing a server says is taken on trust.
 */

const HEAD: Record<Verdict['status'], { title: string; tone: string }> = {
  VERIFIED: { title: 'Verified', tone: 'ok' },
  PENDING: { title: 'Signed, not in a block yet', tone: 'wait' },
  REFUSED: { title: 'Refused', tone: 'bad' },
  UNREACHABLE: { title: "Couldn't check", tone: 'off' },
};

const short = (s: string, n = 10) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
const fmtTime = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const checkLink = (outpoint: string) => {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://web.bwalletx.com';
  return `${origin}/bmint/check?o=${outpoint}`;
};

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="ck-row">
    <dt>{k}</dt>
    <dd>{children}</dd>
  </div>
);

const Proves = ({ v }: { v: Extract<Verdict, { status: 'VERIFIED' }> }) => (
  <div className="ck-proves">
    <p>
      <b>This proves</b> that these exact bytes ({v.contentType || 'unknown type'}, {fmtBytes(v.contentBytes)}) were in
      Bitcoin block {v.height.toLocaleString()} (mined around {fmtTime(v.blockTime)}), signed by the key{' '}
      <code>{short(v.identityKey, 8)}</code>
      {v.fileMatch ? ', and that your file is that file' : ''}.
    </p>
    <p>
      <b>It does not prove</b> who holds that key, that they made the work, or that they own its copyright. A name next
      to the key is only a label unless a $401 identity is attached.
    </p>
  </div>
);

const VerdictCard = ({ v, paymail }: { v: Verdict; paymail: string | null }) => {
  const h = HEAD[v.status];
  const [copied, setCopied] = useState(false);
  const outpoint = 'outpoint' in v ? v.outpoint : undefined;
  const copy = async () => {
    if (!outpoint) return;
    try {
      await navigator.clipboard.writeText(checkLink(outpoint));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <section className={`ck-card ${h.tone}`} aria-live="polite">
      <div className="ck-verdict">
        <span className="ck-badge">{v.status}</span>
        <h2>{h.title}</h2>
      </div>
      {v.status === 'REFUSED' || v.status === 'UNREACHABLE' || v.status === 'PENDING' ? (
        <p className="ck-reason">{v.reason}</p>
      ) : null}
      {v.status === 'UNREACHABLE' && <p className="ck-fine">This is not a pass. Try again later.</p>}
      {(v.status === 'VERIFIED' || v.status === 'PENDING') && (
        <dl className="ck-facts">
          {v.name && <Row k="Title">{v.name}</Row>}
          <Row k="Signature">✓ valid</Row>
          {v.status === 'VERIFIED' && (
            <>
              <Row k="Merkle proof">✓ to block {v.height.toLocaleString()}</Row>
              <Row k="Block header">✓ proof of work checked here · {v.headerSources.join(' + ')} agree</Row>
              <Row k="In a block by">{fmtTime(v.blockTime)}</Row>
            </>
          )}
          <Row k="Signed by">
            <code title={v.identityKey}>{short(v.identityKey, 8)}</code>
            {paymail && <span className="ck-label"> · paymail {paymail} (a label, not proof of identity)</span>}
          </Row>
          <Row k="Content">
            {v.contentType || 'unknown type'} · {fmtBytes(v.contentBytes)}
          </Row>
          <Row k="sha256">
            <code title={v.contentSha256}>{short(v.contentSha256, 12)}</code>
          </Row>
          <Row k="Your file">
            {v.fileMatch ? '✓ same bytes (hashed on this device)' : 'not compared (drop it in to compare)'}
          </Row>
          <Row k="Outpoint">
            <code title={v.outpoint}>{short(v.outpoint, 8)}</code>
          </Row>
        </dl>
      )}
      {v.status === 'VERIFIED' && <Proves v={v} />}
      {outpoint && (
        <div className="ck-actions">
          <button type="button" className="bm-btn" onClick={copy}>
            {copied ? 'Link copied' : 'Copy check link'}
          </button>
          <a
            className="bm-btn"
            href={`https://whatsonchain.com/tx/${outpoint.split('_')[0]}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction
          </a>
        </div>
      )}
    </section>
  );
};

export const CheckPage = () => {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('o') ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [paymail, setPaymail] = useState<string | null>(null);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  const check = async (input: string, sha: string | null) => {
    const outpoint = parseOutpoint(input);
    if (!outpoint) return setError('Paste a mint link or a transaction id.');
    setError('');
    setBusy(true);
    setVerdict(null);
    setPaymail(null);
    const id = ++run.current;
    const v = await checkMint(outpoint, sha ? { fileSha256: sha } : {});
    if (id !== run.current) return;
    setVerdict(v);
    setBusy(false);
    if (params.get('o') !== outpoint) setParams({ o: outpoint }, { replace: true });
    if (v.status === 'VERIFIED' || v.status === 'PENDING')
      lookupPaymail(fetch, v.identityKey)
        .then((p) => id === run.current && setPaymail(p ?? null))
        .catch(() => undefined);
  };

  // A check link (?o=…) checks itself on open.
  useEffect(() => {
    const o = params.get('o');
    if (o && parseOutpoint(o)) void check(o, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const take = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setFileHash(null);
    const sha = await sha256File(f);
    setFileHash(sha);
    if (parseOutpoint(text)) void check(text, sha);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files?.[0]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void check(text, fileHash);
  };

  return (
    <div className="bm-body ck">
      <header className="ck-head">
        <h1>
          Check <span>this mint</span>
        </h1>
        <p>
          Paste a mint link or transaction id. Your device checks the signature, the merkle proof and the block&apos;s
          proof of work itself, so you don&apos;t have to trust us or anyone else.
        </p>
      </header>
      <form className="ck-form" onSubmit={submit}>
        <input
          className="ck-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Mint link or txid (txid_0)"
          aria-label="Mint link or transaction id"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" className="bm-btn gold" disabled={busy || !text.trim()}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </form>
      <div
        className={`ck-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => picker.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && picker.current?.click()}
      >
        <input ref={picker} type="file" hidden onChange={(e) => void take(e.target.files?.[0])} />
        {file ? (
          <span>
            <b>{file.name}</b> · {fmtBytes(file.size)} ·{' '}
            {fileHash ? <code>sha256 {short(fileHash, 8)}</code> : 'hashing on this device…'}
          </span>
        ) : (
          <span>
            Optional: drop the original file to check it is the one minted. It is hashed here and never uploaded.
          </span>
        )}
      </div>
      {error && <p className="bm-msg ck-err">{error}</p>}
      {busy && <p className="bm-msg">Fetching the transaction and two block headers…</p>}
      {verdict && <VerdictCard v={verdict} paymail={paymail} />}
    </div>
  );
};

export default CheckPage;
