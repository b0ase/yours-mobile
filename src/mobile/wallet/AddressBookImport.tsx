import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { Contact } from '../chat/contacts';
import { resolvePaymail } from '../names/names';
import { addFriend } from '../calls/friends';
import { isEmptyNotes, loadNotes, saveNotes } from './contactNotes';
import {
  HANDLE_DOMAINS,
  applyHandleDomain,
  dedupe,
  hasHandles,
  mapLimited,
  parseImport,
  type HandleDomain,
  type ParseResult,
  type PreviewRow,
} from './abookParse';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const LOOKUPS_AT_ONCE = 4;
const MAX_FILE = 2_000_000;

type Lookup = { state: 'checking' } | { state: 'found'; key: string; display?: string } | { state: 'missing' };
type Row = PreviewRow & { lookup: Lookup; ticked: boolean };

const muted = { color: 'var(--bw-muted)' };
const box = { background: 'var(--bw-surface)', border: '1px solid rgb(var(--bw-accent-rgb) / 0.27)' };
const btn = 'rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50';
const primary = { background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' };

/**
 * Import (owner, 15 Oct 2026): a file or pasted text → preview (new / already in the book / invalid) → each
 * paymail looked up with the Send screen's resolver → ticked rows saved as friends. Imported names and notes go
 * into this device's private notes, only where the contact has none yet.
 */
export const AddressBookImport = ({
  contacts,
  account,
  onBack,
}: {
  contacts: Contact[];
  account: string | undefined;
  onBack: () => void;
}) => {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [domain, setDomain] = useState<HandleDomain | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [checked, setChecked] = useState(0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const run = useRef(0);

  // The book as it was when the preview was built: a refresh after saving must not restart the lookups.
  const book = useRef(contacts);
  book.current = contacts;
  const needsDomain = !!parsed && hasHandles(parsed.entries) && !domain;

  // Build the preview once the input is parsed (and a domain chosen for $handles), then look each new one up.
  useEffect(() => {
    if (!parsed || needsDomain) return;
    const entries = domain ? applyHandleDomain(parsed.entries, domain) : parsed.entries;
    const known = book.current.map((c) => c.paymail).filter((p): p is string => !!p);
    const knownKeys = new Set(book.current.map((c) => c.identityKey).filter(Boolean));
    const base: Row[] = dedupe(entries, known).map((r) => ({
      ...r,
      lookup: r.status === 'new' ? { state: 'checking' } : { state: 'missing' },
      ticked: r.status === 'new',
    }));
    setRows(base);
    setChecked(0);
    const id = ++run.current;
    const todo = base.filter((r) => r.status === 'new');
    void mapLimited(
      todo,
      LOOKUPS_AT_ONCE,
      async (r) => {
        let lookup: Lookup;
        try {
          const res = await resolvePaymail(f, r.paymail);
          lookup =
            res.pubkey && /^0[23][0-9a-f]{64}$/i.test(res.pubkey)
              ? { state: 'found', key: res.pubkey.toLowerCase(), display: res.displayName }
              : { state: 'missing' };
        } catch {
          lookup = { state: 'missing' };
        }
        if (run.current !== id) return;
        setRows((rs) =>
          rs.map((x) => {
            if (x.paymail !== r.paymail) return x;
            const dup = lookup.state === 'found' && knownKeys.has(lookup.key);
            return {
              ...x,
              lookup,
              status: dup ? 'existing' : x.status,
              ticked: x.ticked && lookup.state === 'found' && !dup,
            };
          }),
        );
      },
      (n) => run.current === id && setChecked(n),
    );
  }, [parsed, domain, needsDomain]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE) return setMsg('That file is too big (2 MB max).');
    setFileName(file.name);
    setText(await file.text());
  };

  const preview = () => {
    setMsg('');
    setDomain(null);
    const p = parseImport(text, fileName);
    if (!p.entries.length) setMsg(p.invalid.length ? 'No paymails or $handles found.' : 'Paste or choose a file.');
    else setParsed(p);
  };

  const fresh = rows.filter((r) => r.status === 'new');
  const existing = rows.length - fresh.length;
  const toSave = rows.filter((r) => r.ticked && r.lookup.state === 'found');
  const pending = fresh.length - checked;

  const save = async () => {
    setSaving(true);
    setMsg('');
    let done = 0;
    for (const r of toSave) {
      if (r.lookup.state !== 'found') continue;
      try {
        await addFriend({ key: r.lookup.key, name: r.paymail });
        const noteKey = r.paymail;
        const text = [r.name && r.name !== r.lookup.display ? r.name : '', r.notes].filter(Boolean).join('\n');
        if (text && isEmptyNotes(loadNotes(account, noteKey))) {
          saveNotes(account, noteKey, { email: '', phone: '', text });
        }
        done++;
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Could not save');
        break;
      }
    }
    setSaving(false);
    setMsg(`${done} added to your address book.`);
    if (done === toSave.length) setRows((rs) => rs.filter((r) => !toSave.includes(r)));
  };

  const setAll = (on: boolean) =>
    setRows((rs) => rs.map((r) => (r.status === 'new' && r.lookup.state === 'found' ? { ...r, ticked: on } : r)));

  return (
    <div className="w-[92%] mx-auto flex flex-col gap-3 pb-6">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm self-start" style={muted}>
        <ArrowLeft size={16} aria-hidden="true" /> Address book
      </button>
      <h3 className="text-base font-bold" style={{ color: 'var(--bw-accent)' }}>
        Import contacts
      </h3>

      {!parsed && (
        <>
          <p className="text-xs" style={muted}>
            CSV, vCard (.vcf), JSON or one paymail per line. Only the paymail lookups leave this device.
          </p>
          <label className={`${btn} text-center cursor-pointer`} style={box}>
            <span style={{ color: 'var(--bw-text)' }}>{fileName || 'Choose a file'}</span>
            <input
              type="file"
              accept=".csv,.tsv,.vcf,.json,.txt,text/*,application/json"
              className="sr-only"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </label>
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'alice@handcash.io\n$bob\nCarol, carol@bwalletx.com'}
            className="rounded-lg p-2 text-sm"
            style={{ ...box, color: 'var(--bw-text)' }}
          />
          <button type="button" className={btn} style={primary} disabled={!text.trim()} onClick={preview}>
            Preview
          </button>
        </>
      )}

      {needsDomain && (
        <div className="rounded-lg p-3 flex flex-col gap-2" style={box}>
          <p className="text-sm" style={{ color: 'var(--bw-text)' }}>
            Some entries are $handles. Which wallet are they from?
          </p>
          {HANDLE_DOMAINS.map((d) => (
            <button
              key={d}
              type="button"
              className={btn}
              style={d === 'bwalletx.com' ? primary : box}
              onClick={() => setDomain(d)}
            >
              <span style={d === 'bwalletx.com' ? undefined : { color: 'var(--bw-text)' }}>$name → name@{d}</span>
            </button>
          ))}
        </div>
      )}

      {parsed && !needsDomain && (
        <>
          <p className="text-sm" style={{ color: 'var(--bw-text)' }}>
            {fresh.length} new · {existing} already in the book · {parsed.invalid.length} invalid
          </p>
          {pending > 0 && (
            <p className="text-xs" role="status" style={muted}>
              Looking up {checked}/{fresh.length}…
            </p>
          )}
          {fresh.length > 0 && (
            <div className="flex gap-3 text-xs">
              <button type="button" style={{ color: 'var(--bw-accent)' }} onClick={() => setAll(true)}>
                Tick all
              </button>
              <button type="button" style={{ color: 'var(--bw-accent)' }} onClick={() => setAll(false)}>
                Untick all
              </button>
            </div>
          )}
          <ul className="flex flex-col gap-1">
            {rows.map((r) => {
              const found = r.lookup.state === 'found';
              const status =
                r.status === 'existing'
                  ? 'Already in your book'
                  : r.lookup.state === 'checking'
                    ? 'Checking…'
                    : found
                      ? r.lookup.state === 'found' && r.lookup.display
                        ? r.lookup.display
                        : 'Found'
                      : 'Not found: can’t be added';
              return (
                <li key={r.paymail} className="flex items-center gap-2 rounded-lg px-2 py-2" style={box}>
                  <input
                    type="checkbox"
                    aria-label={`Import ${r.paymail}`}
                    checked={r.ticked}
                    disabled={!found || r.status === 'existing'}
                    onChange={(e) =>
                      setRows((rs) => rs.map((x) => (x.paymail === r.paymail ? { ...x, ticked: e.target.checked } : x)))
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate" style={{ color: 'var(--bw-text)' }}>
                      {r.name || r.paymail}
                    </div>
                    <div className="text-xs truncate" style={muted}>
                      {r.name ? `${r.paymail} · ` : ''}
                      <span
                        style={
                          r.status === 'new' && r.lookup.state === 'missing' ? { color: 'var(--bw-danger)' } : undefined
                        }
                      >
                        {status}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {parsed.invalid.length > 0 && (
            <details className="text-xs" style={muted}>
              <summary>{parsed.invalid.length} invalid (not a paymail or $handle)</summary>
              <ul>
                {parsed.invalid.slice(0, 50).map((s, i) => (
                  <li key={i} className="truncate">
                    {s}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className={`${btn} flex-1`}
              style={primary}
              disabled={saving || !toSave.length}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : `Add ${toSave.length}`}
            </button>
            <button
              type="button"
              className={btn}
              style={box}
              onClick={() => {
                run.current++;
                setParsed(null);
                setRows([]);
                setMsg('');
              }}
            >
              <span style={{ color: 'var(--bw-text)' }}>Start over</span>
            </button>
          </div>
        </>
      )}
      {msg && (
        <p className="text-sm" role="status" style={{ color: 'var(--bw-text)' }}>
          {msg}
        </p>
      )}
    </div>
  );
};
