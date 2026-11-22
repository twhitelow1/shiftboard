// The 86 List's helpers for the phone app: names in the reader's language, the bar's colors, relative times.
// Who may see, report and clear is decided on the server (core/eighty-six.js); the app only hides buttons.
import type { MsgKey, PluralKey } from '@/i18n';
import { mix } from './theme';

type Named = { name: string; nameEs?: string };
/** A list's or an item's name in the reader's language (its Spanish name where there is one). */
export const nameIn = (x: Named | null | undefined, lang: string) => (lang === 'es' && x?.nameEs ? x.nameEs : x?.name || '');
/** Bar lists first: they're shown on their own, apart from the rest. */
export const barFirst = (a: { kind: string }, b: { kind: string }) => (a.kind === 'bar' ? 0 : 1) - (b.kind === 'bar' ? 0 : 1);

/** The bar's purple and the kitchen's orange (same as the website), with a soft version for headers. */
export function listColors(kind: string, dark: boolean) {
  const main = kind === 'bar' ? (dark ? '#a78bfa' : '#7c3aed') : dark ? '#fb923c' : '#c2410c';
  return { main, soft: mix(main, dark ? '#121a2e' : '#ffffff', dark ? 0.18 : 0.1) };
}

/** '12 min ago' · 'hace 12 min'. */
export function ago(t: (k: MsgKey, p?: Record<string, string | number>) => string, tn: (k: PluralKey, n: number) => string, iso: string, now = new Date()) {
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (!(min >= 1)) return t('eightySix.justNow');
  if (min < 60) return t('eightySix.minAgo', { count: min });
  const h = Math.floor(min / 60);
  if (h < 24) return tn('eightySix.hoursAgo', h);
  return tn('eightySix.daysAgo', Math.floor(h / 24));
}
