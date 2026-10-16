/**
 * Get your own theme (tier 1, $99 a year; bwalletx.com/themes/custom): the order form's rules. Same rules as
 * the server (site/lib/themeOrders.js validateOrder), so the form says what's wrong before anything is sent.
 */

export const PRICE_USD = 99;
export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const FILE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;
export type FileType = (typeof FILE_TYPES)[number];

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const RESERVED = new Set([
  'custom',
  'new',
  'edit',
  'admin',
  'api',
  'index',
  'all',
  'mine',
  'order',
  'orders',
  'preview',
  'gold',
  'bwallet',
  'bwalletx',
  'bcorp',
  'bitcoin',
  'official',
  'default',
  'classic',
]);

/** "Vex Void!" → "vex-void". */
export const toSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

/** An https URL on a public host, or null. */
export const publicUrl = (raw: string): string | null => {
  try {
    const s = raw.trim();
    if (!s || s.length > 300) return null;
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || /^[\d.]+$/.test(h) || h.includes(':'))
      return null;
    return u.toString();
  } catch {
    return null;
  }
};

export type PickedFile = { name: string; type: string; size: number };

export interface OrderForm {
  name: string;
  slug: string;
  brand: string;
  isBrand: boolean;
  link: string;
  colours: string[];
  files: PickedFile[];
  note: string;
  /** A verified name on this wallet (e.g. vexvoid.x, signed in with X), or '' for none. */
  proof: string;
}

export type FormErrors = Partial<Record<keyof OrderForm, string>>;

/** One file the user picked: type and size. Returns an error message or null. */
export const fileError = (f: PickedFile): string | null =>
  !(FILE_TYPES as readonly string[]).includes(f.type)
    ? `${f.name}: PNG, JPG or SVG only`
    : f.size > MAX_FILE_BYTES
      ? `${f.name}: 2 MB max`
      : f.size <= 0
        ? `${f.name}: empty file`
        : null;

export const validateForm = (f: OrderForm): FormErrors => {
  const e: FormErrors = {};
  const name = f.name.trim();
  if (name.length < 2 || name.length > 40) e.name = 'Edition name: 2–40 characters';
  if (!SLUG_RE.test(f.slug)) e.slug = 'Web address: 3–32 characters, a–z, 0–9 and -';
  else if (RESERVED.has(f.slug)) e.slug = 'That address is reserved';
  const brand = f.brand.trim();
  if (!brand || brand.length > 60) e.brand = 'Enter the artist or brand name';
  if (!publicUrl(f.link)) e.link = 'An https:// website or social link';
  if (f.colours.length < 2 || f.colours.length > 3 || !f.colours.every((c) => HEX_RE.test(c)))
    e.colours = 'Pick 2 or 3 colours';
  if (f.files.length < 1 || f.files.length > MAX_FILES) e.files = 'Add 1–4 logo or art files';
  else {
    const bad = f.files.map(fileError).find(Boolean);
    if (bad) e.files = bad;
  }
  if (f.note.length > 500) e.note = '500 characters max';
  if (f.isBrand && !f.proof) e.proof = 'Brands: pick one of your verified names';
  return e;
};

export const formOk = (f: OrderForm) => Object.keys(validateForm(f)).length === 0;

export type OrderStatus = 'paid' | 'building' | 'review' | 'live' | 'declined';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  paid: 'Paid · in the queue',
  building: 'Being built',
  review: 'In review',
  live: 'Live',
  declined: 'Declined · refund on its way',
};

export interface MyOrder {
  id: string;
  slug: string;
  name: string | null;
  status: OrderStatus;
  renews: string | null;
  expires_at: string | null;
  txid: string | null;
  created_at: string | null;
}

const RANK: Record<OrderStatus, number> = { live: 4, building: 3, review: 2, paid: 1, declined: 0 };

/**
 * My editions: one row per slug. Status = the furthest along of its orders (a renewal row never hides a live
 * edition); expiry = the latest; name = the first order's.
 */
export const editionsFrom = (orders: MyOrder[]) => {
  const by = new Map<string, { slug: string; name: string; status: OrderStatus; expires: string | null }>();
  for (const o of orders) {
    const cur = by.get(o.slug);
    if (!cur) {
      by.set(o.slug, { slug: o.slug, name: o.name ?? o.slug, status: o.status, expires: o.expires_at });
      continue;
    }
    if (o.name && cur.name === cur.slug) cur.name = o.name;
    if (RANK[o.status] > RANK[cur.status]) cur.status = o.status;
    if (o.expires_at && (!cur.expires || o.expires_at > cur.expires)) cur.expires = o.expires_at;
  }
  return [...by.values()];
};

export const previewUrl = (slug: string) => `https://bwalletx.com/themes/${slug}`;
