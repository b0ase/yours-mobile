import { describe, expect, test } from 'bun:test';
import { FORBIDDEN_WORDS, TEMPLATES, TEMPLATE_CONFIRM, TEMPLATE_NOTE, nextDeadline, reviewAllowed } from './templates';
import { EMPTY_AMOUNTS, needsSizeCheck, valuesEntered } from './builderForm';
import { MIN_PIECE_SATS, buildGradual, buildOnce } from './schedule';
import { parsePcts, type Curve } from './curves';

const NOW = new Date('2026-10-08T12:00:00Z');
const H = 970_000;
const sats = (s?: string) => Math.round(Number(s) * 1e8);

describe('lock templates', () => {
  for (const t of TEMPLATES)
    test(`${t.name} produces a valid schedule`, () => {
      const v = t.values(NOW);
      expect(v.label.length).toBeGreaterThan(0);
      const at = v.unlockOn ?? new Date(NOW.getTime() + (v.startInDays ?? 30) * 86_400_000);
      expect(
        valuesEntered({ kind: v.kind, gmode: v.gmode ?? 'usd', until: 'count', amountBsv: v.amountBsv ?? '', usdPer: v.usdPer ?? '', bsvPer: v.bsvPer ?? '', pct: '', count: String(v.count ?? '') }),
      ).toBe(true);
      let r;
      if (v.kind === 'once') r = buildOnce(sats(v.amountBsv), at, NOW, H);
      else {
        const curve: Curve | undefined = v.curve
          ? { kind: v.curve.kind, steepness: v.curve.steep ? Number(v.curve.steep) : undefined, pcts: v.curve.custom ? (parsePcts(v.curve.custom) ?? []) : undefined }
          : undefined;
        const common = { start: at, frequency: v.frequency!, customDays: v.customDays, count: v.count, curve };
        r = v.gmode === 'usd' ? buildGradual({ ...common, usdPerPayout: Number(v.usdPer), rate: 50, bufferPct: 20 }, NOW, H) : buildGradual({ ...common, perPayoutSats: sats(v.bsvPer) }, NOW, H);
      }
      expect(r.error).toBeUndefined();
      expect(r.pieces.length).toBeGreaterThan(0);
      expect(r.pieces.every((p) => p.sats >= MIN_PIECE_SATS)).toBe(true);
    });

  test('coupons: regular pieces and a larger final piece', () => {
    const v = TEMPLATES.find((t) => t.id === 'coupons')!.values(NOW);
    const r = buildGradual({ start: NOW, frequency: 'custom', customDays: 91, count: 8, perPayoutSats: sats(v.bsvPer), curve: { kind: 'custom', pcts: parsePcts(v.curve!.custom!)! } }, NOW, H);
    const a = r.pieces.map((p) => p.sats);
    expect(new Set(a.slice(0, 7)).size).toBe(1);
    expect(a[7]).toBeGreaterThan(a[0] * 10);
  });

  test('tax pot unlocks just before the next 31 January', () => {
    const d = nextDeadline(NOW, 1, 31);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(28);
    expect(nextDeadline(new Date('2027-01-30T12:00:00Z'), 1, 31).getFullYear()).toBe(2028);
  });

  test('templates never bypass the empty start or the review check', () => {
    expect(Object.values(EMPTY_AMOUNTS).every((x) => x === '')).toBe(true);
    expect(reviewAllowed(true, true, false)).toBe(false);
    expect(reviewAllowed(true, true, true)).toBe(true);
    expect(reviewAllowed(false, true, true)).toBe(false);
    expect(reviewAllowed(true, false, false)).toBe(true);
    // The 0.01 BSV caution is applied to the schedule total at Review, whatever filled the form.
    expect(needsSizeCheck(1_000_001)).toBe(true);
  });

  test('no interest, yield or returns wording in template copy', () => {
    const text = [TEMPLATE_NOTE, TEMPLATE_CONFIRM, ...TEMPLATES.flatMap((t) => [t.name, t.blurb, t.values(NOW).label])].join(' ');
    expect(FORBIDDEN_WORDS.test(text)).toBe(false);
    expect(FORBIDDEN_WORDS.test('8% yield')).toBe(true);
  });
});
