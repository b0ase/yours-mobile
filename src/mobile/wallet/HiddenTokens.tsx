/**
 * "Hidden tokens" row under "Refresh token balances", opening a folder with Archived / Quarantined / Worthless
 * (hiddenGroups.ts). Nothing here counts toward the wallet total, and the folder has no Buy buttons and no links.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { ChevronRight, FolderArchive, X } from 'lucide-react';
import type { Bsv21Balance } from '@1sat/actions';
import { useNavigate } from 'react-router-dom';
import { showAmount } from '../../utils/format';
import { activeQuarantine, hide, keep, type AirdropItem } from '../airdrops/inbox';
import { useAirdrops } from '../airdrops/useAirdrops';
import { tokenAmount } from './historyEvents';
import { hiddenCount, hiddenGroups } from './hiddenGroups';
import { setArchived, useTokenRows } from './tokenRows';

const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent-hi)';
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const view = (t: Bsv21Balance) => ({ id: t.id, confirmed: t.all.confirmed, pending: t.all.pending });

const Row = ({ name, sub, actions }: { name: string; sub: string; actions?: React.ReactNode }) => (
  <div className="flex items-center gap-3 py-2.5 border-b" style={{ borderColor: '#22252c' }}>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">{name}</div>
      <div className="text-[11px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: MUTED }}>
        {sub}
      </div>
    </div>
    {actions}
  </div>
);

const Act = ({ label, onClick, strong }: { label: string; onClick: () => void; strong?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    className="text-xs font-bold px-2.5 py-1.5 rounded-lg bg-transparent border-0 cursor-pointer"
    style={{ color: strong ? GOLD : MUTED }}
  >
    {label}
  </button>
);

const Section = ({
  title,
  note,
  children,
  empty,
}: {
  title: string;
  note: string;
  children: React.ReactNode[];
  empty: string;
}) => (
  <section className="mt-5">
    <h3 className="text-[11px] font-semibold uppercase tracking-wider m-0" style={{ color: MUTED }}>
      {title} ({children.length})
    </h3>
    <p className="text-[11px] m-0 mt-1 mb-1" style={{ color: '#667085' }}>
      {note}
    </p>
    {children.length ? (
      children
    ) : (
      <p className="text-xs m-0 py-2" style={{ color: '#667085' }}>
        {empty}
      </p>
    )}
  </section>
);

export const HiddenTokens = ({ tokens, style }: { tokens: Bsv21Balance[]; style?: React.CSSProperties }) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const rows = useTokenRows();
  const { visible, update } = useAirdrops();
  const groups = useMemo(
    () => hiddenGroups(tokens, view, rows.archived, visible, activeQuarantine()),
    [tokens, rows.archived, visible],
  );
  const n = hiddenCount(groups);
  const amount = (t: Bsv21Balance) => `${showAmount(t.all.confirmed, t.dec)} ${t.sym || ''}`.trim();
  const qName = (i: AirdropItem) => (i.asset.kind === 'token' && i.asset.symbol) || short(i.asset.id);

  return (
    <>
      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left cursor-pointer outline-none transition-colors duration-150 bg-[var(--bw-surface)] hover:bg-[#1f2128]"
        style={style}
      >
        <FolderArchive size={16} color={MUTED} />
        <span className="flex-1 text-sm font-semibold" style={{ color: MUTED }}>
          Hidden tokens
        </span>
        {n > 0 && (
          <span className="text-xs" style={{ color: MUTED }}>
            {n}
          </span>
        )}
        <ChevronRight size={16} color={MUTED} />
      </motion.button>
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-label="Hidden tokens"
            className="fixed inset-0 z-[1000] overflow-y-auto px-4 pb-10"
            style={{ background: 'var(--bw-bg, #0b0c0f)', paddingTop: 'max(16px, env(safe-area-inset-top))' }}
          >
            <div className="flex items-center gap-2">
              <h2 className="flex-1 text-lg font-bold text-white m-0">Hidden tokens</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="p-2 bg-transparent border-0 cursor-pointer"
              >
                <X size={20} color={MUTED} />
              </button>
            </div>
            <p className="text-xs m-0 mt-1" style={{ color: MUTED }}>
              Tokens left out of your list. None of them count toward your wallet total.
            </p>

            <Section
              title="Archived"
              note="You archived these. Unarchive puts one back in your list."
              empty="Nothing archived."
            >
              {groups.archived.map((t) => (
                <Row
                  key={t.id}
                  name={t.sym || short(t.id)}
                  sub={`${amount(t)} · not counted`}
                  actions={<Act label="Unarchive" strong onClick={() => setArchived(t.id, false)} />}
                />
              ))}
            </Section>

            <Section
              title="Quarantined"
              note="Sent to you without asking. Kept apart so they're never spent with your own coins."
              empty="Nothing in Quarantine."
            >
              {groups.quarantined.map((i) => (
                <Row
                  key={i.key}
                  name={qName(i)}
                  sub={`${tokenAmount(i.asset.qty, i.asset.dec)} · from ${short(i.from || i.issuer)} · not counted`}
                  actions={
                    <>
                      <Act label="Keep" strong onClick={() => update((s) => keep(s, i.key))} />
                      <Act label="Hide" onClick={() => update((s) => hide(s, i))} />
                    </>
                  }
                />
              ))}
            </Section>
            <button
              type="button"
              onClick={() => navigate('/m/bmail?tab=quarantine')}
              className="text-[11px] underline bg-transparent border-0 cursor-pointer p-0 mt-1"
              style={{ color: MUTED }}
            >
              Open Quarantine for NFTs and notes
            </button>

            <Section
              title="Worthless"
              note="No balance left. Shown for your records, not counted."
              empty="No empty tokens."
            >
              {groups.worthless.map((t) => (
                <Row key={t.id} name={t.sym || short(t.id)} sub={`${amount(t)} · not counted`} />
              ))}
            </Section>
          </div>,
          document.body,
        )}
    </>
  );
};
