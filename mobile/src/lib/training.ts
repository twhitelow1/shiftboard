// Training helpers for the phone app, copied from core/training.js (keep them in step): an item, a quiz or a
// manual page in the reader's language (the Spanish version of each field where the server has one, English
// otherwise), menu section names in Spanish, and the 9 major allergens' names. Who may see recipes and prep notes
// is decided on the server: menu.list only sends the groups the person may see.
import type { MenuItem } from './types';

const has = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const key = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const same = (a: unknown, b: unknown) => !!key(a) && key(a) === key(b);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** An item as its reader should see it: Spanish fields where there are some, English otherwise. */
export function localizeItem(item: MenuItem, lang: string): MenuItem {
  const es = item.es;
  if (lang !== 'es' || !es) return item;
  const rows = <T,>(e: T[] | undefined, b: T[]) => (Array.isArray(e) && e.length ? e : b);
  return {
    ...item,
    name: has(es.name) ? es.name : item.name,
    description: has(es.description) ? es.description : item.description,
    keyIngredients: rows(es.keyIngredients, item.keyIngredients),
    ...(item.selling ? { selling: { notes: has(es.selling?.notes) ? es.selling!.notes! : item.selling.notes, pairings: has(es.selling?.pairings) ? es.selling!.pairings! : item.selling.pairings } } : {}),
    ...(item.recipe ? { recipe: { yield: has(es.recipe?.yield) ? es.recipe!.yield! : item.recipe.yield, ingredients: rows(es.recipe?.ingredients, item.recipe.ingredients), steps: rows(es.recipe?.steps, item.recipe.steps) } } : {}),
    ...(item.prep ? { prep: { notes: has(es.prep?.notes) ? es.prep!.notes! : item.prep.notes } } : {}),
  };
}

/** A quiz, manual page or section in the reader's language (title, body, description). */
export function localize<T extends { title?: string; body?: string; description?: string; es?: { title?: string; body?: string; description?: string } }>(doc: T, lang: string): T {
  const es = doc.es;
  if (lang !== 'es' || !es) return doc;
  const out = { ...doc };
  for (const k of ['title', 'body', 'description'] as const) if (has(es[k])) (out as Record<string, unknown>)[k] = es[k];
  return out;
}

// Built-in Spanish names for common menu sections (core/training.js TEXT.es.categories).
const CATEGORIES_ES: Record<string, string> = {
  starters: 'Entradas', appetizers: 'Entradas', mains: 'Platos fuertes', entrees: 'Platos fuertes', sides: 'Guarniciones', desserts: 'Postres',
  cocktails: 'Cocteles', beer: 'Cerveza', wine: 'Vino', nonalcoholic: 'Sin alcohol', other: 'Otros', drinks: 'Bebidas', salads: 'Ensaladas', soups: 'Sopas',
};

/** A menu section's name: the restaurant's own Spanish name, a built-in one, or as written. */
export function categoryLabel(c: string, lang: string, own: Record<string, string> = {}): string {
  if (lang !== 'es' || !c) return c;
  const mine = Object.entries(own || {}).find(([k]) => same(k, c));
  return (mine && has(mine[1]) ? mine[1] : CATEGORIES_ES[key(c)]) || c;
}

/** A dietary tag's name: the app's words for the standard ones (menu.tag.*), others as written. */
export const STANDARD_DIETARY = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'spicy'] as const;
export const dietaryFallback = (tag: string) => cap(tag);

/** Lower case, no accents: for searching the menu in either language. */
export const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** $12 or $12.50 (menu prices are in dollars). */
export const money = (n: number | null | undefined) => (n == null ? '' : `$${n % 1 ? n.toFixed(2) : n}`);
