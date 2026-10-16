/**
 * "Hidden tokens" row under "Refresh token balances", opening a folder with Archived / Quarantined / Worthless
 * (hiddenGroups.ts). Nothing here counts toward the wallet total, and the folder has no Buy buttons and no links.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Archive, ChevronRight, FolderArchive, Ghost, ShieldAlert, X } from 'lucide-react';
import type { Bsv21Balance } from '@1sat/actions';
import { useNavigate } from 'react-router-dom';
import { showAmount } from '../../utils/format';
import { activeQuarantine, hide, keep, type AirdropItem } from '../airdrops/inbox';
import { useAirdrops } from '../airdrops/useAirdrops';
import { TokenIcon } from '../exchange/TokenIcon';
import { tokenAmount } from './historyEvents';
import { hiddenCount, hiddenGroups } from './hiddenGroups';
import { setArchived, useTokenRows } from './tokenRows';
import './hiddenTokens.css';

const MUTED = '#98A2B3';
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const view = (t: Bsv21Balance) => ({ id: t.id, confirmed: t.all.confirmed, pending: t.all.pending });

/** One token: icon (token art, or the gold initial from TokenIcon, never grey), name, amount, chip, actions. */
const Row = ({
  name,
  icon,
  sub,
  actions,
}: {
  name: string;
  icon?: string | null;
  sub: string;
  actions?: React.ReactNode;
}) => (
  <div className="bw-hid-row">
    <TokenIcon icon={icon} sym={name} size={36} />
    <div className="bw-hid-main">
      <div className="bw-hid-name">{name}</div>
      <div className="bw-hid-amt">{sub}</div>
      <span className="bw-hid-chip">not counted</span>
    </div>
    {actions && <div className="bw-hid-acts">{actions}</div>}
  </div>
);

const Act = ({ label, onClick, strong }: { label: string; onClick: () => void; strong?: boolean }) => (
  <button type="button" onClick={onClick} className={`bw-hid-pill${strong ? ' is-gold' : ''}`}>
    {label}
  </button>
);

const Section = ({
  title,
  icon,
  note,
  children,
  empty,
  after,
}: {
  title: string;
  icon: React.ReactNode;
  note: string;
  children: React.ReactNode[];
  empty: string;
  after?: React.ReactNode;
}) => (
  <section className="bw-hid-sec" aria-label={title}>
    <div className="bw-hid-sechead">
      <span className="bw-hid-secicon">{icon}</span>
      <h3 className="bw-hid-sectitle">{title}</h3>
      <span className="bw-hid-count">{children.length}</span>
    </div>
    <p className="bw-hid-note">{note}</p>
    {children.length ? children : <p className="bw-hid-empty">{empty}</p>}
    {after}
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
  const reduce = useReducedMotion();

  return (
    <>
      <motion.button
        whileTap={reduce ? undefined : { scale: 0.98 }}
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
          <div role="dialog" aria-label="Hidden tokens" className="bw-hid">
            <div className="bw-hid-inner">
              <header className="bw-hid-head">
                <span className="bw-hid-badge">
                  <FolderArchive size={20} />
                </span>
                <div className="flex-1 min-w-0">
                  <h2 className="bw-hid-title">Hidden tokens</h2>
                  <p className="bw-hid-sub">Not counted in your balance</p>
                </div>
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="bw-hid-close">
                  <X size={18} />
                </button>
              </header>

              <Section
                title="Archived"
                icon={<Archive size={16} />}
                note="You archived these. Unarchive puts one back in your list."
                empty="Nothing archived. Swipe a token to archive it."
              >
                {groups.archived.map((t) => (
                  <Row
                    key={t.id}
                    name={t.sym || short(t.id)}
                    icon={t.icon}
                    sub={amount(t)}
                    actions={<Act label="Unarchive" strong onClick={() => setArchived(t.id, false)} />}
                  />
                ))}
              </Section>

              <Section
                title="Quarantined"
                icon={<ShieldAlert size={16} />}
                note="Sent to you without asking. Kept apart so they're never spent with your own coins."
                empty="All clear. Nothing in Quarantine."
                after={
                  <button type="button" onClick={() => navigate('/m/bmail?tab=quarantine')} className="bw-hid-more">
                    Open Quarantine for NFTs and notes ›
                  </button>
                }
              >
                {groups.quarantined.map((i) => (
                  <Row
                    key={i.key}
                    name={qName(i)}
                    sub={`${tokenAmount(i.asset.qty, i.asset.dec)} · from ${short(i.from || i.issuer)}`}
                    actions={
                      <>
                        <Act label="Keep" strong onClick={() => update((s) => keep(s, i.key))} />
                        <Act label="Hide" onClick={() => update((s) => hide(s, i))} />
                      </>
                    }
                  />
                ))}
              </Section>

              <Section
                title="Worthless"
                icon={<Ghost size={16} />}
                note="No balance left. Shown for your records."
                empty="No empty tokens."
              >
                {groups.worthless.map((t) => (
                  <Row key={t.id} name={t.sym || short(t.id)} icon={t.icon} sub={amount(t)} />
                ))}
              </Section>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
