import { describeRules, inactiveRuleNotices, paperRuleGaps, RULE_CHECK_SCOPE } from './describeRules';
import { type StrategyRules } from './strategy';

const MUTED = '#98A2B3';

/** A visible warning for each rule in this strategy that isn't enforced. Renders nothing when all are. */
export const InactiveRuleNotices = ({ rules }: { rules: StrategyRules }) => {
  const notices = inactiveRuleNotices(rules);
  if (!notices.length) return null;
  return (
    <div
      role="status"
      className="rounded-lg px-3 py-2 text-xs flex flex-col gap-1"
      style={{ background: '#F7900922', color: '#FEC84B' }}
    >
      {notices.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  );
};

/** The rules of a loaded strategy: what is checked, what isn't, and what the check covers. */
export const StrategyRuleNotes = ({ rules, paper }: { rules: StrategyRules; paper: boolean }) => (
  <>
    <ul className="m-0 pl-4 text-xs flex flex-col gap-0.5" style={{ color: MUTED }}>
      {describeRules(rules).map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
    <InactiveRuleNotices rules={rules} />
    <div className="text-[11px]" style={{ color: MUTED }}>
      {RULE_CHECK_SCOPE}
    </div>
    {paper &&
      paperRuleGaps(rules).map((g) => (
        <div key={g} className="text-[11px]" style={{ color: MUTED }}>
          {g}
        </div>
      ))}
  </>
);
