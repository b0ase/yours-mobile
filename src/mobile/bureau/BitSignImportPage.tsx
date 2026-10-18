import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { TopNav } from '../../components/TopNav';
import { DocView } from './DocView';
import { bureauClient } from './session';
import { onChainTxid, vaultItemName } from './legacy';
import type { DocContent, VaultItem } from './api';
import './agreements.css';

/**
 * Import from bit-sign (/m/bmail/agreements/bit-sign), opened once from Settings › Tools: the documents this identity
 * signed or stored on bit-sign, read-only, signed in with the wallet's identity key. Not on the Agreements screen
 * (owner, 18 Oct 2026: bit-sign is retired quietly; its documents are reachable, not branded on the main view).
 */
const BitSignImportPage = () => {
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const client = useMemo(() => bureauClient(apiContext), [apiContext]);
  const [rows, setRows] = useState<VaultItem[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<VaultItem | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  useBackClose(!!sel, () => setSel(null));
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
  return (
    <div className={`ag ag-two ag-pane-${sel ? 'detail' : 'list'}`}>
      {/* The wallet's top bar, as bMail (BMailPage): on the wide layout it is clipped by the shell. */}
      <TopNav />
      <header className="ag-top">
        <button type="button" className="ag-btn ag-back" onClick={() => navigate('/m/bmail/agreements')}>
          <ChevronLeft size={16} aria-hidden="true" /> Agreements
        </button>
        <h1 className="ag-title">Earlier documents</h1>
      </header>
      <div className="ag-body">
        <div className="ag-list">
          {err && <p className="ag-err">{err}</p>}
          {!err && rows === null && <p className="ag-note">Opening your earlier documents…</p>}
          {rows && rows.length === 0 && <p className="ag-note">Nothing to import.</p>}
          {(rows ?? []).map((r) => (
            <div key={r.id} className={`ag-item${sel?.id === r.id ? ' on' : ''}`}>
              <button type="button" className="ag-item-main" onClick={() => setSel(r)}>
                <span className="ag-item-title">{vaultItemName(r)}</span>
                <span className="ag-item-sub">
                  {onChainTxid(r) ? 'Sealed on chain' : 'Not sealed'} · {new Date(r.created_at).toLocaleDateString()}
                </span>
              </button>
            </div>
          ))}
        </div>
        <div className="ag-view">
          {!sel ? (
            <div className="ag-blank">
              <p>Documents you signed or stored with this identity before agreements moved into bMail, read-only.</p>
            </div>
          ) : (
            <div className="ag-detail">
              <div className="ag-bar">
                <button type="button" className="ag-btn ag-back" onClick={() => setSel(null)}>
                  <ChevronLeft size={16} aria-hidden="true" /> Back
                </button>
                <div className="ag-h ag-grow">{vaultItemName(sel)}</div>
              </div>
              <div className="ag-paper ag-doc">
                {content ? (
                  <DocView content={content} title={vaultItemName(sel)} />
                ) : (
                  <p className="ag-note">Opening…</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BitSignImportPage;
