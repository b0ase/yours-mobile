import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OneSatContext } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { setAgentDraft } from '../agent/handoff';
import { getChatAccount } from '../chat/chatAccount';
import { resolveCallee } from '../calls/peer';
import { shortKey } from '../calls/machine';
import { money } from '../money/money';
import { SignaturePad } from '../signature/SignaturePad';
import { SIG_VIEWBOX, getSignature, signatureSha256 } from '../signature/signature';
import {
  docContent,
  makeDoc,
  sealOnChain,
  signAgreement,
  CONTENT_MAX,
  type AgreementPart,
  type DocMime,
} from './agreement';
import {
  COMING_FOLDERS,
  FOLDERS,
  countFolders,
  listFolder,
  stateOf,
  statusLine,
  type AgreementItem,
  type FolderId,
} from './folders';
import { DocView } from './DocView';
import { useBureau } from './useBureau';
import { bureauClient } from './session';
import { onChainTxid, vaultItemName } from './legacy';
import type { DocContent, VaultItem } from './api';
import { newMessageId } from '../bmail/envelope';
import './bureau.css';

/**
 * Bureau (/m/bureau): bMail's agreements, desktop-first (owner, 18 Oct 2026: "an email client with vaults").
 * Folders → list → viewer. An agreement is a bMail letter carrying a document; signing uses the card signature and the
 * identity key; sealing puts a hashes-only receipt on chain from this wallet. "From bit-sign" lists the old vault.
 */
const f = (u: string, i?: RequestInit) => fetch(u, i);

const QUICK_STARTS: { label: string; prompt: string }[] = [
  { label: 'NDA', prompt: 'Draft a mutual NDA between me and ' },
  { label: 'Contractor', prompt: 'Draft a contractor agreement: the work is ' },
  { label: 'From a transcript', prompt: 'Turn this call transcript into an agreement both sides can sign:\n\n' },
  { label: 'Split a venture', prompt: 'Draft a venture split agreement. The partners and their shares are ' },
];

const SigImage = ({ path }: { path: string }) => (
  <svg className="bu-sig" viewBox={SIG_VIEWBOX} aria-label="Signature">
    <path d={path} />
  </svg>
);

const AskB = () => {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const go = (t: string) => {
    setAgentDraft(t);
    navigate('/m/ask-b');
  };
  return (
    <div className="bu-card">
      <div className="bu-card-title">Describe the agreement you need</div>
      <p className="bu-note">b drafts it with you. Paste the result into a new agreement to send it for signing.</p>
      <textarea
        className="bu-input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. A one-page NDA with $alice for the bMusic launch"
      />
      <div className="bu-row">
        {QUICK_STARTS.map((q) => (
          <button key={q.label} type="button" className="bu-chip" onClick={() => go(q.prompt)}>
            {q.label}
          </button>
        ))}
        <span className="bu-grow" />
        <button type="button" className="bu-btn primary" disabled={!text.trim()} onClick={() => go(text.trim())}>
          Ask b
        </button>
      </div>
    </div>
  );
};

const readFile = (file: File): Promise<{ mime: DocMime; content: string }> =>
  new Promise((resolve, reject) => {
    const mime: DocMime | null =
      file.type === 'application/pdf'
        ? 'application/pdf'
        : file.type === 'text/html'
          ? 'text/html'
          : file.type.startsWith('text/')
            ? 'text/plain'
            : null;
    if (!mime) return reject(new Error('PDF, HTML or text files only.'));
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.onload = () => {
      const v = String(r.result ?? '');
      resolve({ mime, content: mime === 'application/pdf' ? v.slice(v.indexOf(',') + 1) : v });
    };
    if (mime === 'application/pdf') r.readAsDataURL(file);
    else r.readAsText(file);
  });

const NewAgreement = ({ bureau, onDone }: { bureau: ReturnType<typeof useBureau>; onDone: () => void }) => {
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; mime: DocMime; content: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const send = async () => {
    setErr('');
    try {
      setBusy('Looking up…');
      const names = to.split(/[\s,]+/).filter(Boolean);
      if (!names.length) throw new Error('Add at least one person to sign with.');
      const peers = await Promise.all(names.map((n) => resolveCallee(f, n)));
      const doc = makeDoc({
        id: newMessageId(),
        title,
        mime: file?.mime ?? 'text/plain',
        content: file?.content ?? text,
        author: bureau.me,
        parties: peers.map((p) => p.key),
        createdAt: Date.now(),
      });
      setBusy('Sending…');
      const labels = Object.fromEntries(peers.map((p) => [p.key, p.label]));
      await bureau.deliver(
        { doc, sigs: [] },
        `Agreement: ${doc.title}`,
        `${doc.title}\n\nAn agreement for you to read and sign. Open it in bWalletX › Bureau.`,
        labels,
      );
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send it.');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="bu-card">
      <div className="bu-card-title">New agreement</div>
      <input
        className="bu-input"
        placeholder="Sign with: $handle, paymail or name (several: commas)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        className="bu-input"
        placeholder="Title"
        maxLength={120}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {file ? (
        <div className="bu-row">
          <span className="bu-note">{file.name}</span>
          <button type="button" className="bu-chip" onClick={() => setFile(null)}>
            Remove
          </button>
        </div>
      ) : (
        <textarea
          className="bu-input"
          rows={10}
          placeholder="The terms (or attach a file)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="bu-row">
        <label className="bu-chip">
          Attach PDF / HTML / text
          <input
            type="file"
            hidden
            accept="application/pdf,text/html,text/plain"
            onChange={(e) => {
              const fl = e.target.files?.[0];
              if (fl)
                readFile(fl)
                  .then((r) =>
                    r.content.length > CONTENT_MAX
                      ? setErr('Files up to about 22 KB for now: larger files are coming to bWalletX.')
                      : setFile({ name: fl.name, ...r }),
                  )
                  .catch((x: Error) => setErr(x.message));
            }}
          />
        </label>
        <span className="bu-grow" />
        <button type="button" className="bu-btn" onClick={onDone} disabled={!!busy}>
          Cancel
        </button>
        <button type="button" className="bu-btn primary" onClick={() => void send()} disabled={!!busy}>
          {busy || 'Send for signing'}
        </button>
      </div>
      <p className="bu-fine">
        Sent by bMail: sealed so only the signers can open it, with each person’s normal postage (1¢ unless they set
        more).
      </p>
      {err && <p className="bu-err">{err}</p>}
    </div>
  );
};

const AgreementView = ({ it, bureau }: { it: AgreementItem; bureau: ReturnType<typeof useBureau> }) => {
  const { doc, sigs, seal } = it.part;
  const me = bureau.me;
  const s = stateOf(it, me);
  const card = getSignature(getChatAccount() ?? undefined);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const others = doc.parties.filter((p) => p !== me);
  useEffect(() => {
    let live = true;
    void Promise.all(others.map((k) => bureau.postageFor(k))).then(
      (v) => live && setCost(v.reduce((a, b) => a + b, 0)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);
  const content = useMemo(() => docContent(doc), [doc]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setErr('');
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy('');
    }
  };
  const sign = (svgPath: string) =>
    run('Signing…', async () => {
      const mine = await signAgreement(bureau.wallet, me, doc, svgPath, signatureSha256(svgPath));
      const part: AgreementPart = { doc, sigs: [...sigs.filter((x) => x.key !== me), mine], ...(seal ? { seal } : {}) };
      await bureau.deliver(part, `Signed: ${doc.title}`, `I signed “${doc.title}”. Open it in bWalletX › Bureau.`);
    });
  const doSeal = () =>
    run('Sealing on chain…', async () => {
      const sl = await sealOnChain(bureau.wallet, me, it.part);
      await bureau.deliver(
        { doc, sigs, seal: sl },
        `Sealed: ${doc.title}`,
        `“${doc.title}” is sealed on chain (${sl.txid}).`,
      );
    });

  return (
    <div className="bu-detail">
      <div className="bu-head">
        <div className="bu-title">{doc.title}</div>
        <div className="bu-sub">
          {statusLine(s)} · {new Date(doc.createdAt).toLocaleDateString()}
        </div>
      </div>
      <div className="bu-doc">
        <DocView content={content} title={doc.title} />
      </div>
      <div className="bu-parties">
        {doc.parties.map((k) => {
          const sg = sigs.find((x) => x.key === k && it.signed.includes(k));
          return (
            <div key={k} className="bu-party">
              <span className="bu-mono">{k === me ? 'You' : shortKey(k)}</span>
              {sg ? <SigImage path={sg.svgPath} /> : <span className="bu-note">Not signed yet</span>}
            </div>
          );
        })}
        {seal && (
          <div className="bu-party">
            <span>Sealed</span>
            <a className="bu-mono" href={`https://whatsonchain.com/tx/${seal.txid}`} target="_blank" rel="noreferrer">
              {shortKey(seal.txid)} ↗
            </a>
          </div>
        )}
      </div>
      {drawing && (
        <SignaturePad
          onCancel={() => setDrawing(false)}
          onSave={(p) => {
            setDrawing(false);
            void sign(p);
          }}
        />
      )}
      <div className="bu-row">
        {s.needsMe && card && (
          <button type="button" className="bu-btn primary" disabled={!!busy} onClick={() => void sign(card.svgPath)}>
            Sign with my card signature
          </button>
        )}
        {s.needsMe && (
          <button type="button" className="bu-btn" disabled={!!busy} onClick={() => setDrawing(true)}>
            {card ? 'Draw a new one' : 'Draw and sign'}
          </button>
        )}
        {s.complete && !s.sealed && (
          <button type="button" className="bu-btn primary" disabled={!!busy} onClick={() => void doSeal()}>
            Seal on chain
          </button>
        )}
        <span className="bu-grow" />
        <button type="button" className="bu-btn" onClick={() => bureau.setArchived(doc.id, !it.archived)}>
          {it.archived ? 'Put back' : 'Archive'}
        </button>
      </div>
      {(s.needsMe || (s.complete && !s.sealed)) && (
        <p className="bu-fine">
          {s.needsMe
            ? 'Signing adds your signature and an identity-key proof, then sends the signed copy to the other signers by bMail'
            : 'Sealing writes the document and signature hashes (never the content) on chain from this wallet, then tells the signers'}
          {cost !== null && others.length > 0 ? ` (postage ${money(cost, bureau.rate)}).` : '.'}
        </p>
      )}
      {busy && <p className="bu-note">{busy}</p>}
      {err && <p className="bu-err">{err}</p>}
    </div>
  );
};

/** "From bit-sign": the old vault, read-only, signed in with this wallet's identity key. */
const BitSignFolder = ({ ctx, q }: { ctx: OneSatContext; q: string }) => {
  const client = useMemo(() => bureauClient(ctx), [ctx]);
  const [rows, setRows] = useState<VaultItem[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<VaultItem | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  useEffect(() => {
    client
      .vault()
      .then(setRows)
      .catch((e: Error) => setErr(e.message));
  }, [client]);
  useEffect(() => {
    if (!sel) return;
    setContent(null);
    client
      .preview(sel.id)
      .then(setContent)
      .catch((e: Error) => setContent({ kind: 'empty', reason: e.message }));
  }, [client, sel]);
  const shown = (rows ?? []).filter((r) => !q || vaultItemName(r).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="bu-list">
        {err && <p className="bu-err">{err}</p>}
        {!err && rows === null && <p className="bu-note">Opening your bit-sign documents…</p>}
        {rows && shown.length === 0 && <p className="bu-note">Nothing here.</p>}
        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`bu-item${sel?.id === r.id ? ' on' : ''}`}
            onClick={() => setSel(r)}
          >
            <span className="bu-item-title">{vaultItemName(r)}</span>
            <span className="bu-item-sub">
              {onChainTxid(r) ? 'Sealed on chain' : 'Not sealed'} · {new Date(r.created_at).toLocaleDateString()}
            </span>
          </button>
        ))}
      </div>
      <div className="bu-view">
        {!sel ? (
          <p className="bu-note">
            Documents you signed or stored on bit-sign, read-only. New agreements go through bMail. Signing and sealing
            these older documents from bWalletX is coming.
          </p>
        ) : (
          <div className="bu-detail">
            <div className="bu-head">
              <div className="bu-title">{vaultItemName(sel)}</div>
            </div>
            <div className="bu-doc">
              {content ? <DocView content={content} title={vaultItemName(sel)} /> : <p className="bu-note">Opening…</p>}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

const BureauPage = () => {
  const navigate = useNavigate();
  useBackClose(true, () => navigate(-1));
  const { apiContext } = useServiceContext();
  const bureau = useBureau();
  const [folder, setFolder] = useState<FolderId>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const counts = useMemo(() => countFolders(bureau.items, bureau.me), [bureau.items, bureau.me]);
  const shown = useMemo(() => listFolder(bureau.items, folder, bureau.me, q), [bureau.items, folder, bureau.me, q]);
  const active = shown.find((it) => it.part.doc.id === sel) ?? null;

  return (
    <div className="bu">
      <nav className="bu-rail" aria-label="Bureau folders">
        <button type="button" className="bu-btn primary bu-new" onClick={() => setComposing(true)}>
          New agreement
        </button>
        {FOLDERS.map((fd) => (
          <button
            key={fd.id}
            type="button"
            className={`bu-folder${fd.id === folder ? ' on' : ''}`}
            onClick={() => {
              setFolder(fd.id);
              setComposing(false);
            }}
          >
            <span>{fd.label}</span>
            {!COMING_FOLDERS.has(fd.id) && fd.id !== 'bitsign' && <span className="bu-count">{counts[fd.id]}</span>}
          </button>
        ))}
      </nav>
      {folder === 'bitsign' ? (
        <BitSignFolder ctx={apiContext} q={q} />
      ) : COMING_FOLDERS.has(folder) ? (
        <div className="bu-view bu-span">
          <div className="bu-card">
            <div className="bu-card-title">Trusts are coming to bWalletX</div>
            <p className="bu-note">
              Trust deeds with multisig key shares (bTrust) will live here. Nothing is shown until it is real.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="bu-list">
            <input className="bu-input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            {bureau.error && <p className="bu-err">{bureau.error}</p>}
            {shown.length === 0 && (
              <p className="bu-note">{bureau.loading ? 'Checking your mail…' : 'Nothing here.'}</p>
            )}
            {shown.map((it) => (
              <button
                key={it.part.doc.id}
                type="button"
                className={`bu-item${active?.part.doc.id === it.part.doc.id ? ' on' : ''}`}
                onClick={() => {
                  setSel(it.part.doc.id);
                  setComposing(false);
                }}
              >
                <span className="bu-item-title">{it.part.doc.title}</span>
                <span className="bu-item-sub">{statusLine(stateOf(it, bureau.me))}</span>
              </button>
            ))}
          </div>
          <div className="bu-view">
            {composing ? (
              <NewAgreement bureau={bureau} onDone={() => setComposing(false)} />
            ) : active ? (
              <AgreementView key={active.part.doc.id} it={active} bureau={bureau} />
            ) : (
              <AskB />
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default BureauPage;
