import LISTS from './language-lists.json';

/**
 * Feed bad-language filter (owner-approved, Oct 2026). ONE matcher for post text, link-card
 * titles / descriptions, author display names and open-room names. The word lists live in
 * language-lists.json, which bwalletX ships byte-identical (src/mobile/feed/language-lists.json);
 * both repos' selftests pin its sha256, so changing one without the other fails a test.
 *
 *   'slur'   — hate slurs (racial, ethnic, homophobic, transphobic, disability). Always hidden.
 *   'strong' — ordinary swearing. Shown normally; blurred when a viewer opts in (or always in the
 *              bWallet store edition, behind "Show anyway").
 *
 * Scunthorpe-safe: words match as whole tokens (plus a plural suffix), never as raw substrings.
 * A few unambiguous stems ("fuck", "nigger", …) also match inside a token, but only at its start
 * or followed by a known suffix, and only after allowlisted words ("Scunthorpe", "snigger",
 * "Nigeria", "Yamashita") are cut out of it. Obfuscation is normalised first: accents and
 * look-alike letters, zero-width characters, leetspeak (n1gg3r, $hit), punctuation or spaces
 * between letters (f.u.c.k, f u c k), repeated letters (fuuuuck) and * wildcards (f*ck).
 */
export type Language = 'slur' | 'strong' | null;

type Lists = {
    slurs: string[]; slurPhrases: string[]; slurStems: string[];
    strong: string[]; strongStems: string[]; allowlist: string[]; allowPhrases: string[];
};
const L = LISTS as unknown as Lists;

const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');
const SLUR = new Set(L.slurs);
const SLUR_C = new Set(L.slurs.map(collapse));
const STRONG = new Set(L.strong);
const STRONG_C = new Set(L.strong.map(collapse));
const ALLOW = new Set(L.allowlist);
const ALLOW_BY_LEN = [...L.allowlist].sort((a, b) => b.length - a.length);
const SLUR_STEMS = L.slurStems.map(collapse);
const STRONG_STEMS = L.strongStems.map(collapse);
/** What may follow a stem inside a token ("motherfuckers", "bullshitting", "sandniggers"). */
const STEM_TAIL = /^(?:|s|es|z|ed|er|ers|ing|in|y|ty|ter|ters|ting|head|heads|face|hole|holes|wit|wits|bag|bags|stain|storm|show|post|posting|lover|lovers)$/;
const ALLOW_PHRASES = L.allowPhrases.map((p) => new RegExp(`(?<![a-z0-9])${p.split(' ').join('[^a-z0-9]+')}(?![a-z0-9])`, 'g'));
const SUFFIX = /(?:es|s|z)$/;

const LEET: Record<string, string> = {
    '0': 'o', '1': 'i', '6': 'g', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '9': 'g', '8': 'b', '+': 't', '€': 'e', '£': 'l',
};
/** Cyrillic / Greek letters that look Latin. */
const CONFUSABLE: Record<string, string> = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'к': 'k', 'н': 'h', 'т': 't', 'м': 'm', 'в': 'b', 'ѕ': 's', 'ј': 'j', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't',
};

function fold(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[­​-‏⁠﻿]/g, '')
        .toLowerCase()
        .replace(/[Ͱ-ӿ]/g, (c) => CONFUSABLE[c] ?? c);
}

const leet = (w: string, one = 'i') => w.replace(/[013456789!|@$+€£]/g, (c) => (c === '1' ? one : LEET[c] ?? c));
const letters = (w: string) => w.replace(/[^a-z]/g, '');

/** Cut allowlisted words out of a token so their insides are never matched ("scunthorpe"). */
function withoutAllowed(tok: string): string {
    let t = tok;
    for (const a of ALLOW_BY_LEN) if (t.includes(a)) t = t.split(a).join(' ');
    return t;
}

function stemHit(tok: string, stems: string[]): boolean {
    for (const part of withoutAllowed(tok).split(' ')) {
        if (!part) continue;
        const c = collapse(part);
        for (const s of stems) {
            let i = c.indexOf(s);
            while (i >= 0) {
                if (i === 0 || STEM_TAIL.test(c.slice(i + s.length))) return true;
                i = c.indexOf(s, i + 1);
            }
        }
    }
    return false;
}

function wholeHit(tok: string, exact: Set<string>, collapsed: Set<string>): boolean {
    const vs = [tok, tok.replace(/s$/, ''), tok.replace(SUFFIX, '')];
    if (vs.some((v) => ALLOW.has(v))) return false;
    return vs.some((v) => !!v && (exact.has(v) || collapsed.has(collapse(v))));
}

/** `f*ck`, `n**ger`: interior * stands for one letter; tried against the word lists only. */
function wildcardHit(raw: string, words: Set<string>): boolean {
    const w = raw.replace(/^[^a-z0-9*]+|[^a-z0-9*]+$/g, '');
    if (!/[a-z0-9]\*+[a-z0-9]?/.test(w)) return false;
    const pat = leet(w).replace(/[^a-z*]/g, '');
    if (pat.replace(/\*/g, '').length < 2) return false;
    const re = new RegExp(`^${pat.replace(/\*/g, '[a-z]')}(?:es|s|z)?$`);
    for (const word of words) if (re.test(word)) return true;
    return false;
}

function tokenVariants(raw: string): string[] {
    const out = new Set<string>();
    const trimmed = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    for (const w of [raw, trimmed]) {
        out.add(letters(leet(w)));
        if (w.includes('1')) out.add(letters(leet(w, 'l')));
    }
    for (const part of raw.split(/[^a-z0-9]+/)) if (part) out.add(letters(leet(part)));
    out.delete('');
    return [...out];
}

function classify(text: string): Language {
    let flat = ` ${fold(text).split(/\s+/).filter(Boolean).join(' ')} `;
    const phraseFlat = ` ${flat.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()} `;
    for (const re of ALLOW_PHRASES) flat = flat.replace(re, ' ');
    const raws = flat.split(' ').filter(Boolean);
    if (L.slurPhrases.some((p) => phraseFlat.includes(` ${p} `))) return 'slur';

    // Letters spaced out one per token ("n i g g e r", "f u c k") are joined back up.
    const toks: string[] = [];
    let run = '';
    for (const r of raws) {
        const v = letters(leet(r));
        if (v.length === 1) { run += v; continue; }
        if (run.length >= 3) toks.push(run);
        run = '';
        toks.push(...tokenVariants(r));
    }
    if (run.length >= 3) toks.push(run);

    let strong = false;
    for (const t of toks) {
        if (ALLOW.has(t)) continue;
        if (wholeHit(t, SLUR, SLUR_C) || stemHit(t, SLUR_STEMS)) return 'slur';
        if (!strong && (wholeHit(t, STRONG, STRONG_C) || stemHit(t, STRONG_STEMS))) strong = true;
    }
    for (const r of raws) {
        if (wildcardHit(r, SLUR)) return 'slur';
        if (!strong && wildcardHit(r, STRONG)) strong = true;
    }
    return strong ? 'strong' : null;
}

const CACHE_MAX = 5000;
const cache = new Map<string, Language>();

/** 'slur' | 'strong' | null for one piece of text. Memoised (bounded), so feeds compute it once. */
export function languageOf(text: string | null | undefined): Language {
    if (!text || !text.trim()) return null;
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const v = classify(text.slice(0, 10_000));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(text, v);
    return v;
}

/** The worse of several flags. */
export function worstLanguage(...xs: Language[]): Language {
    return xs.includes('slur') ? 'slur' : xs.includes('strong') ? 'strong' : null;
}

export const isSlur = (text: string | null | undefined): boolean => languageOf(text) === 'slur';

export const HIDDEN_NAME = 'Hidden name';
/** A display name, or "Hidden name" when it contains a slur. */
export const safeName = (name: string): string => (isSlur(name) ? HIDDEN_NAME : name);

/** What a viewer sees for a flagged post or link card. */
export type LanguageView = 'show' | 'blur' | 'hide' | 'hide-final';

/**
 * How to show text with flag `lang`. Store edition: slurs hidden with no reveal, swearing blurred.
 * Elsewhere: slurs hidden (revealable when the viewer opted in to "Show anyway"), swearing shown
 * unless "Filter strong language" is on.
 */
export function languageView(
    lang: Language,
    opts: { store?: boolean; filterStrong?: boolean; allowReveal?: boolean } = {},
): LanguageView {
    if (lang === 'slur') return opts.store || !opts.allowReveal ? 'hide-final' : 'hide';
    if (lang === 'strong') return opts.store || opts.filterStrong ? 'blur' : 'show';
    return 'show';
}
