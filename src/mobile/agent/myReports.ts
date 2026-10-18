/**
 * "Your reports" (owner, 18 Oct 2026: make /bugs real). Everything you told b, from Report to b or Ask b,
 * with where it stands: received → triaged → planned → fixing → fixed in x.y.z (or closed).
 * Served by bit-sign GET /api/bitsign/agent/feedback (your own rows only, never the team's notes).
 */
export type ReportStage = 'received' | 'triaged' | 'planned' | 'fixing' | 'fixed' | 'closed';
export type MyReport = {
  ref: string;
  createdAt: string;
  updatedAt: string;
  category: string;
  area: string;
  stage: ReportStage;
  summary: string;
  fixedIn: string | null;
};

const STAGES: readonly ReportStage[] = ['received', 'triaged', 'planned', 'fixing', 'fixed', 'closed'];

export const STAGE_LABEL: Record<ReportStage, string> = {
  received: 'Received',
  triaged: 'Looked at',
  planned: 'Planned',
  fixing: 'Fixing',
  fixed: 'Fixed',
  closed: 'Closed',
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The server's reply → reports. Unknown stages read as 'received'; malformed rows are dropped. */
export const parseMyReports = (v: unknown): MyReport[] => {
  const list = v && typeof v === 'object' ? (v as { reports?: unknown }).reports : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r): MyReport[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const ref = str(o.ref, 20).replace(/^#/, '');
    if (!/^F-\d+$/.test(ref)) return [];
    const stage = STAGES.includes(o.stage as ReportStage) ? (o.stage as ReportStage) : 'received';
    const fixedIn = stage === 'fixed' && /^\d+\.\d+\.\d+/.test(str(o.fixed_in, 40)) ? str(o.fixed_in, 40) : null;
    const createdAt = str(o.created_at, 40);
    return [
      {
        ref,
        createdAt,
        updatedAt: str(o.updated_at, 40) || createdAt,
        category: str(o.category, 20) || 'bug',
        area: str(o.area, 20) || 'other',
        stage,
        summary: str(o.summary, 300),
        fixedIn,
      },
    ];
  });
};

/** "Fixed in 5.2.31", "Fixing", … */
export const stageText = (r: Pick<MyReport, 'stage' | 'fixedIn'>) =>
  r.stage === 'fixed' && r.fixedIn ? `Fixed in ${r.fixedIn}` : STAGE_LABEL[r.stage];

/** Release notes for a fixed report (bwalletx.com/releases has an anchor per version). */
export const releaseUrl = (version: string) =>
  `https://bwalletx.com/releases#v${encodeURIComponent(version.split(' ')[0])}`;

export const fetchMyReports = async (
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>,
): Promise<MyReport[]> => parseMyReports(await call('GET', '/api/bitsign/agent/feedback'));
