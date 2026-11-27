// Stock lists in the phone app (core/stock.js on the server): the shapes the server sends, and small helpers.
// Who may do what is decided on the server; the app only hides buttons that wouldn't work.

export interface StockPhoto { id: string; w: number; h: number; canRemove?: boolean }
export interface StockCounts { lines: number; done: number; got: number; short: number; out: number }
export type LineState = 'got' | 'short' | 'out' | null;
export interface StockLine {
  id: string; productId: string; name: string; category: string; unit: string; unitName: string; size: string; location: string;
  photos: StockPhoto[]; review: string; qty: number; note: string; state: LineState; brought: number | null;
  by: { id: string; name: string } | null; at: string | null;
  reported86: { itemId: string; listId: string; listName: string; status: 'out' | 'low'; at: string } | null;
  eightySix: { id: string; name: string; nameEs: string } | null;
}
export interface StockListSummary {
  id: string; kind: 'list' | 'template'; name: string; notes: string; date: string; due: string; status: 'open' | 'in_progress' | 'done';
  quick: boolean; assignLabel: string; assignees: { id: string; name: string }[]; mine: boolean; counts: StockCounts;
  doneAt: string | null; doneBy: { id: string; name: string } | null; overdue: boolean;
}
export interface StockList extends StockListSummary {
  lines: StockLine[]; canWork: boolean; canEdit: boolean; canManage: boolean;
  log: { at: string; by: string; byName: string; what: string; state?: LineState; product?: string; brought?: number; to?: string }[];
}
export interface StockLists { lists: StockListSummary[]; canManage: boolean; canQuick: boolean; today: string }
export interface Product {
  id: string; name: string; aliases: string[]; category: string; unit: string; size: string; location: string; supplier: string; notes: string;
  photos: StockPhoto[]; review: 'new' | 'ok'; status: string; addedBy: { id: string; name: string } | null;
}
export interface Catalog {
  products: Product[]; categories: { id: string; name: string; nameEs: string }[]; units: { id: string; en: string; es: string }[];
  canManage: boolean; canManageLists: boolean; canQuick: boolean; newCount: number;
}
export interface ProductMatch extends Product { score: number; confidence: string; reasons: string[] }

/** A category's name in the reader's language. */
export const catName = (cats: Catalog['categories'] | undefined, id: string, lang: string) => {
  const c = (cats || []).find((x) => x.id === id);
  return c ? (lang === 'es' ? c.nameEs || c.name : c.name) : '';
};
/** "Bring 2 bottle" → the quantity and unit as the server words them ("2 botella"). */
export const qtyText = (x: Pick<StockLine, 'qty' | 'unitName'>) => `${x.qty}${x.unitName ? ` ${x.unitName}` : ''}`;
/** A product's placeholder color when it has no photo (its category's, like the website's tiles). */
export const TILE_COLORS: Record<string, string> = {
  spirits: '#0e7490', beer: '#ca8a04', wine: '#be185d', mixers: '#0369a1', garnish: '#65a30d', glassware: '#475569', smallwares: '#57534e',
  paper: '#0f766e', cleaning: '#0891b2', dry: '#c2410c',
};
/** Two letters for a tile, by characters (an emoji at the start of a name stays whole, never half of one). */
export const initials = (name: string) => {
  const w = String(name || '?').trim().split(/\s+/).filter(Boolean).map((x) => Array.from(x));
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || ['?']).slice(0, 2).join('')).toUpperCase() || '?';
};

const fold = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Does a product match what's typed? Its name, aliases ("Tito's", "titos"), size, where it's kept and its category's
 * name; accents, case and punctuation don't matter, and the words can be typed run together ("titos"). Same rules as
 * the website (core/products.js productMatches), on the catalog kept on the phone.
 */
export function productMatches(p: Pick<Product, 'name' | 'aliases' | 'size' | 'location'>, q: string, extra = '') {
  const words = fold(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = fold([p.name, ...(p.aliases || []), p.size, p.location, extra].join(' '));
  return words.every((w) => hay.includes(w)) || hay.replace(/ /g, '').includes(words.join(''));
}
export interface StockOptions {
  positions: { id: string; name: string }[]; rooms: string[]; quick: { jobCodeId: string; room: string }; canManage: boolean; canQuick: boolean; today: string;
}

// ---------- saved lists ("par lists", core/stock-saved.js) ----------
export type SavedScope = { type: 'personal' } | { type: 'room'; room: string } | { type: 'positions'; jobCodeIds: string[]; room?: string };
export type SavedAccess = 'owner' | 'manage' | 'edit' | 'use';
export interface SavedSummary {
  id: string; name: string; notes: string; scope: SavedScope; scopeLabel: string; owner: { id: string; name: string } | null; lines: number;
  access: SavedAccess; canEdit: boolean; canShare: boolean; mine: boolean; today: boolean; shared: number; sharedWithMe: boolean;
  lastRun: { at: string; by: { id: string; name: string }; needs: number } | null; openRequests: number; section?: 'mine' | 'forMe' | 'all';
}
export interface SavedLine {
  id: string; productId: string; name: string; category: string; unit: string; unitName: string; size: string; location: string;
  photos: StockPhoto[]; archived: boolean; par: number; note: string; usually: number | null; last: { onHand: number | null; need: number | null; at: string } | null;
}
export interface SavedShare { id: string; to: { type: string; userId?: string; role?: string; jobCodeId?: string; room?: string }; label: string; can: 'use' | 'edit' }
export interface SavedRun {
  id: string; at: string; by: { id: string; name: string }; send: 'support' | 'self' | 'none'; listId: string | null; to: string; needs: number; skipped: number;
  counts: { lineId: string | null; productId: string; name: string; par: number; onHand: number | null; need: number | null; unitName: string }[]; out: string[];
}
export interface SavedList extends Omit<SavedSummary, 'lines'> {
  lines: SavedLine[]; shares: SavedShare[]; runs: SavedRun[]; canManage: boolean; canScope: boolean;
  requests: { id: string; lineId: string; product: string; from: number; to: number; note: string; by: string; byName: string; status: string }[];
}
export interface SavedOptions {
  people: { id: string; name: string }[]; roles: { id: string; name: string }[]; positions: { id: string; name: string }[]; rooms: string[];
  support: { jobCodeId: string; room: string }; canManage: boolean; canCreate: boolean; today: string;
}
const HALVES = new Set(['lb', 'gallon']);
/** What a line needs: max(0, par − on hand), rounded up to its unit (the server's needFor, core/stock-saved.js). */
export function needFor(par: number, onHand: number | string | null | undefined, unit = ''): number | null {
  if (onHand === null || onHand === undefined || onHand === '') return null;
  const raw = Number(par) - Number(onHand);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const step = HALVES.has(unit) ? 0.5 : 1;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return r2(Math.ceil(r2(raw / step)) * step);
}
