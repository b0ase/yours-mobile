import { useRef, useState, type DragEvent } from 'react';
import {
  addToShelf,
  exportVault,
  importVault,
  parseVaultFile,
  removeFromVault,
  type Counts,
  type Shelf,
  type VaultState,
} from './opnsVault';

/**
 * bMint › OpNS names › Vault: names the owner keeps (never listed, never auto-listed after a mint) and a
 * "To gift" shelf. Each has a drop-pad for a .txt list (e.g. opns-KEEP.txt / opns-GIFT.txt); export/import JSON.
 */
const GOLD = 'var(--bw-accent-hi)';
const GOLD_DIM = 'rgb(var(--bw-accent-hi-rgb) / 0.14)';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.58)';
const HAIR = 'rgba(255,255,255,0.08)';
const CARD_BG = 'rgba(12,12,14,0.92)';
const ghostBtn =
  'rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer bg-transparent border-0 transition-colors duration-150 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 disabled:cursor-not-allowed';

const SHOW = 60;

/** Vault · To gift · Listed · Unlisted, at the top of the page. */
export const OpnsVaultCounts = ({ counts }: { counts: Counts }) => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Your names">
    {(
      [
        ['Vault', counts.keep],
        ['To gift', counts.gift],
        ['Listed', counts.listed],
        ['Unlisted', counts.unlisted],
      ] as const
    ).map(([label, n]) => (
      <a
        key={label}
        href={label === 'Vault' || label === 'To gift' ? '#opns-vault' : '#opns-owned'}
        className="rounded-xl px-3 py-2.5 no-underline transition-colors duration-150 hover:bg-white/[0.03]"
        style={{ background: CARD_BG, border: `1px solid ${HAIR}` }}
      >
        <span className="block text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: MUTED }}>
          {label}
        </span>
        <span className="block text-xl font-bold tabular-nums mt-0.5" style={{ color: n ? GOLD : TEXT }}>
          {n}
        </span>
      </a>
    ))}
  </div>
);

const Pad = (p: { shelf: Shelf; names: string[]; owned: Set<string>; onAdd: (names: string[]) => void } & Rm) => {
  const [drag, setDrag] = useState(false);
  const [all, setAll] = useState(false);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const title = p.shelf === 'keep' ? 'Vault' : 'To gift';
  const file = p.shelf === 'keep' ? 'opns-KEEP.txt' : 'opns-GIFT.txt';
  const add = (text: string) => {
    const r = parseVaultFile(text);
    p.onAdd(r.names);
    setNote(
      `Added ${r.names.length} ${r.names.length === 1 ? 'name' : 'names'}${r.invalid.length ? ` · ${r.invalid.length} skipped (not valid names)` : ''}.`,
    );
  };
  const addFiles = async (files: FileList | null | undefined) => {
    let body = '';
    for (const f of Array.from(files ?? [])) body += `\n${await f.text()}`;
    if (body.trim()) add(body);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
    else {
      const t = e.dataTransfer.getData('text/plain');
      if (t) add(t);
    }
  };
  const shown = all ? p.names : p.names.slice(0, SHOW);
  const minted = p.names.filter((n) => p.owned.has(n)).length;
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold" style={{ color: TEXT }}>
          {title} <span style={{ color: GOLD }}>· {p.names.length}</span>
        </h3>
        {p.names.length > 0 && (
          <span className="text-[11px]" style={{ color: MUTED }}>
            {minted} owned · {p.names.length - minted} not minted yet
          </span>
        )}
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Drop a .txt list of names for ${title}, or press to choose a file`}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') input.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className="rounded-xl flex flex-col items-center justify-center gap-1 text-center cursor-pointer transition-colors duration-150 focus-visible:outline focus-visible:outline-2"
        style={{
          minHeight: 84,
          padding: 14,
          border: `1.5px dashed ${drag ? GOLD : 'rgb(var(--bw-accent-hi-rgb) / 0.35)'}`,
          background: drag ? 'rgb(var(--bw-accent-hi-rgb) / 0.08)' : 'rgb(var(--bw-accent-hi-rgb) / 0.03)',
        }}
      >
        <span className="text-[13px] font-semibold" style={{ color: TEXT }}>
          {drag ? 'Drop to add' : `Drop ${file} here`}
        </span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          or <span style={{ color: GOLD }}>choose a file</span> · one name per line
        </span>
        <input
          ref={input}
          type="file"
          accept=".txt,text/plain"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {note && (
        <span className="text-[11px]" role="status" style={{ color: MUTED }}>
          {note}
        </span>
      )}
      {p.names.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
          {shown.map((n) => (
            <span
              key={n}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium"
              style={{
                background: p.owned.has(n) ? GOLD_DIM : 'transparent',
                color: GOLD,
                border: p.owned.has(n) ? '1px solid transparent' : '1px dashed rgb(var(--bw-accent-hi-rgb) / 0.35)',
              }}
              title={p.owned.has(n) ? 'Owned' : 'Not minted yet: protected from listing once it mints'}
            >
              {n}
              <button
                type="button"
                aria-label={`Take ${n} off ${title}`}
                className="w-4 h-4 rounded-full border-0 bg-transparent cursor-pointer leading-none p-0 hover:bg-white/10"
                style={{ color: GOLD }}
                onClick={() => p.onRemove(n)}
              >
                ×
              </button>
            </span>
          ))}
          {p.names.length > SHOW && (
            <button type="button" className={ghostBtn} style={{ color: GOLD }} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `+${p.names.length - SHOW} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
type Rm = { onRemove: (name: string) => void };

export const OpnsVaultSection = (p: { vault: VaultState; owned: Set<string>; onChange: (v: VaultState) => void }) => {
  const { vault, onChange } = p;
  const importer = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportVault(vault)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'opns-vault.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      id="opns-vault"
      aria-labelledby="opns-vault-h"
      className="rounded-2xl p-4 sm:p-5 flex flex-col gap-4"
      style={{ background: CARD_BG, border: `1px solid ${HAIR}` }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <h2 id="opns-vault-h" className="m-0 text-[15px] font-semibold tracking-tight" style={{ color: TEXT }}>
            OpNS Vault
          </h2>
          <span className="text-xs" style={{ color: MUTED }}>
            Names you keep or plan to give. They are never listed, and never auto-listed when they mint.
          </span>
        </div>
        <span className="flex gap-1 shrink-0">
          <button type="button" className={ghostBtn} style={{ color: GOLD }} onClick={download}>
            Export
          </button>
          <button type="button" className={ghostBtn} style={{ color: GOLD }} onClick={() => importer.current?.click()}>
            Import
          </button>
          <input
            ref={importer}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const next = importVault(vault, await file.text());
              onChange(next);
              setMsg(`Imported. Vault ${next.keep.length} · To gift ${next.gift.length}.`);
            }}
          />
        </span>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Pad
          shelf="keep"
          names={vault.keep}
          owned={p.owned}
          onAdd={(n) => onChange(addToShelf(vault, 'keep', n))}
          onRemove={(n) => onChange(removeFromVault(vault, n))}
        />
        <Pad
          shelf="gift"
          names={vault.gift}
          owned={p.owned}
          onAdd={(n) => onChange(addToShelf(vault, 'gift', n))}
          onRemove={(n) => onChange(removeFromVault(vault, n))}
        />
      </div>
      {msg && (
        <p className="m-0 text-xs" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </section>
  );
};
