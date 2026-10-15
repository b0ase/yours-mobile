/**
 * Address book Import / Export (owner, 15 Oct 2026): bring paymail lists over from other apps (CSV with any
 * columns, vCard, JSON arrays, or plain text one per line) and export your own book as CSV.
 * Parsing and dedupe are pure and run on this device; only the paymail lookups go out.
 */

export type ImportEntry = {
  /** As found in the file: `name@domain` or `$handle` (lowercased). */
  raw: string;
  /** `name@domain`, or null for a `$handle` until a domain is chosen. */
  paymail: string | null;
  /** Bare handle for `$handle` entries. */
  handle: string | null;
  name: string;
  notes: string;
};

export type ParseResult = { entries: ImportEntry[]; invalid: string[] };

export const HANDLE_DOMAINS = ['bwalletx.com', 'handcash.io'] as const;
export type HandleDomain = (typeof HANDLE_DOMAINS)[number];

const PAYMAIL_RE = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
const HANDLE_RE = /^\$([a-z0-9_.-]{1,50})$/i;
const MAX_ROWS = 5000;
const MAX_TEXT = 200;

const clip = (s: unknown, n = MAX_TEXT) =>
  String(s ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, n);

/** One cell → a paymail or $handle, or null. `$name@domain` and `mailto:` prefixes are accepted. */
export const recognise = (cell: string): { paymail: string | null; handle: string | null } | null => {
  let s = cell.trim().replace(/^mailto:/i, '');
  if (s.startsWith('$') && s.includes('@')) s = s.slice(1);
  if (PAYMAIL_RE.test(s)) return { paymail: s.toLowerCase(), handle: null };
  const h = s.match(HANDLE_RE);
  return h ? { paymail: null, handle: h[1].toLowerCase() } : null;
};

const looksLikeId = (cell: string) => {
  const s = cell.trim();
  return s.includes('@') || s.startsWith('$');
};

const entry = (cell: string, name = '', notes = ''): ImportEntry | null => {
  const r = recognise(cell);
  if (!r) return null;
  return { raw: r.paymail ?? `$${r.handle}`, ...r, name: clip(name), notes: clip(notes, 1000) };
};

/** RFC 4180-ish CSV: quotes, doubled quotes, commas/semicolons/tabs, CRLF. */
export const splitCsv = (text: string): string[][] => {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].reduce(
    (best, d) => (first.split(d).length > first.split(best).length ? d : best),
    ',',
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
};

const NAME_HEAD = /^(name|display ?name|full ?name|contact|label|nickname|first ?name)$/i;
const NOTES_HEAD = /^(notes?|comments?|description|memo)$/i;
const ID_HEAD = /(paymail|handle|e-?mail|address|username|user|id)/i;

export const parseCsv = (text: string): ParseResult => {
  const rows = splitCsv(text);
  if (!rows.length) return { entries: [], invalid: [] };
  const head = rows[0].map((h) => h.trim());
  const hasHeader = !head.some((c) => recognise(c));
  const body = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(...rows.map((r) => r.length));
  // The paymail column: the one with the most recognised cells (ties go to a paymail-ish header).
  let idCol = 0;
  let best = -1;
  for (let c = 0; c < width; c++) {
    const n = body.filter((r) => r[c] && recognise(r[c])).length + (hasHeader && ID_HEAD.test(head[c] ?? '') ? 0.5 : 0);
    if (n > best) {
      best = n;
      idCol = c;
    }
  }
  const nameCol = hasHeader ? head.findIndex((h, i) => i !== idCol && NAME_HEAD.test(h)) : -1;
  const notesCol = hasHeader ? head.findIndex((h, i) => i !== idCol && NOTES_HEAD.test(h)) : -1;
  // Headerless: the first non-id column is a name.
  const fallbackName = !hasHeader && width > 1 ? (idCol === 0 ? 1 : 0) : -1;
  const out: ParseResult = { entries: [], invalid: [] };
  for (const r of body.slice(0, MAX_ROWS)) {
    const cell = (r[idCol] ?? '').trim();
    if (!cell) continue;
    const name = r[nameCol >= 0 ? nameCol : fallbackName] ?? '';
    const e = entry(cell, name, notesCol >= 0 ? r[notesCol] : '');
    if (e) out.entries.push(e);
    else out.invalid.push(clip(cell));
  }
  return out;
};

/** vCard: FN for the name, NOTE for notes, EMAIL / X-* / IMPP values that look like paymails. */
export const parseVcf = (text: string): ParseResult => {
  const out: ParseResult = { entries: [], invalid: [] };
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1, MAX_ROWS + 1)) {
    let name = '';
    let notes = '';
    const ids: string[] = [];
    for (const line of card.split(/\r?\n/)) {
      const m = line.match(/^(?:item\d+\.)?([A-Z-]+)(?:;[^:]*)?:(.*)$/i);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const val = m[2].replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
      if (key === 'FN') name = val;
      else if (key === 'NOTE') notes = val;
      else if (key === 'EMAIL' || key === 'IMPP' || key.startsWith('X-')) {
        const v = val.replace(/^[a-z]+:/i, '');
        if (looksLikeId(v)) ids.push(v);
      }
    }
    if (!ids.length) continue;
    for (const id of ids) {
      const e = entry(id, name, notes);
      if (e) out.entries.push(e);
      else out.invalid.push(clip(id));
    }
  }
  return out;
};

/** JSON: an array of strings or objects (or `{ contacts: [...] }`). */
export const parseJson = (text: string): ParseResult => {
  const out: ParseResult = { entries: [], invalid: [] };
  let j: unknown = JSON.parse(text);
  if (j && !Array.isArray(j) && typeof j === 'object') {
    j = Object.values(j as Record<string, unknown>).find(Array.isArray) ?? [];
  }
  if (!Array.isArray(j)) return out;
  for (const item of j.slice(0, MAX_ROWS)) {
    if (typeof item === 'string') {
      const e = entry(item);
      if (e) out.entries.push(e);
      else if (item.trim()) out.invalid.push(clip(item));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const keys = Object.keys(o);
    const pick = (re: RegExp) => keys.find((k) => re.test(k) && typeof o[k] === 'string');
    const idKey =
      keys.find((k) => typeof o[k] === 'string' && recognise(o[k] as string)) ??
      pick(/paymail|handle|e-?mail|address/i);
    const nameKey = pick(/^(name|displayName|display_name|fullName|nickname|label)$/i);
    const notesKey = pick(/^(notes?|comments?|description|memo)$/i);
    if (!idKey) continue;
    const id = o[idKey] as string;
    const e = entry(id, nameKey ? (o[nameKey] as string) : '', notesKey ? (o[notesKey] as string) : '');
    if (e) out.entries.push(e);
    else out.invalid.push(clip(id));
  }
  return out;
};

/** Plain text: one entry per line; anything else on the line (before the id) is the name. */
export const parseLines = (text: string): ParseResult => {
  const out: ParseResult = { entries: [], invalid: [] };
  for (const line of text.split(/\r?\n/).slice(0, MAX_ROWS)) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(/[\s,;<>]+/).filter(Boolean);
    const id = parts.find((p) => recognise(p));
    if (!id) {
      out.invalid.push(clip(s));
      continue;
    }
    const name = s
      .replace(id, '')
      .replace(/[<>,;]/g, ' ')
      .trim();
    out.entries.push(entry(id, name)!);
  }
  return out;
};

export type ImportFormat = 'csv' | 'vcf' | 'json' | 'text';

export const detectFormat = (text: string, fileName = ''): ImportFormat => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const t = text.trimStart();
  if (ext === 'vcf' || /^BEGIN:VCARD/i.test(t)) return 'vcf';
  if (ext === 'json' || t.startsWith('[') || t.startsWith('{')) return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  return /[,;\t]/.test(first) && !/\s<[^>]+>$/.test(first) ? 'csv' : 'text';
};

export const parseImport = (text: string, fileName = ''): ParseResult => {
  const fmt = detectFormat(text, fileName);
  try {
    if (fmt === 'vcf') return parseVcf(text);
    if (fmt === 'json') return parseJson(text);
    if (fmt === 'csv') return parseCsv(text);
  } catch {
    /* fall back to lines */
  }
  return parseLines(text);
};

export const hasHandles = (entries: ImportEntry[]) => entries.some((e) => !e.paymail);

/** Give every `$handle` the chosen domain. */
export const applyHandleDomain = (entries: ImportEntry[], domain: HandleDomain): ImportEntry[] =>
  entries.map((e) => (e.paymail ? e : { ...e, paymail: `${e.handle}@${domain}` }));

export type PreviewRow = ImportEntry & { paymail: string; status: 'new' | 'existing' };

/**
 * Dedupe within the file (first wins, later names/notes fill blanks) and against the book.
 * `known` holds paymails (lowercased) already in the address book.
 */
export const dedupe = (entries: ImportEntry[], known: Iterable<string>): PreviewRow[] => {
  const have = new Set([...known].map((k) => k.toLowerCase()));
  const seen = new Map<string, PreviewRow>();
  for (const e of entries) {
    if (!e.paymail) continue;
    const pm = e.paymail.toLowerCase();
    const prev = seen.get(pm);
    if (prev) {
      prev.name ||= e.name;
      prev.notes ||= e.notes;
      continue;
    }
    seen.set(pm, { ...e, paymail: pm, status: have.has(pm) ? 'existing' : 'new' });
  }
  return [...seen.values()];
};

/** Run `fn` over `items` with at most `limit` in flight; `onDone` after each. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
  onDone?: (done: number) => void,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const csvCell = (s: string) => {
  // Neutralise spreadsheet formulas (=, +, -, @) so an exported name can't run in Excel.
  const v = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export type ExportRow = { name: string; paymail: string; handle: string; identityKey: string; notes: string };

export const toCsv = (rows: ExportRow[]): string =>
  ['name,paymail,handle,identity_key,notes']
    .concat(rows.map((r) => [r.name, r.paymail, r.handle, r.identityKey, r.notes].map(csvCell).join(',')))
    .join('\r\n') + '\r\n';
