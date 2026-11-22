// The menu as its reader sees it: names, descriptions and sections in their language, allergen and dietary
// names, and which items are 86'd today (on an 86 List the person can see). Kept on the phone for offline use.
import { useMemo } from 'react';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { categoryLabel, dietaryFallback, localizeItem, STANDARD_DIETARY } from '@/lib/training';
import type { EightySixSummary, MenuItem, MenuList } from '@/lib/types';

export interface MenuView {
  items: (MenuItem & { raw: MenuItem })[];
  categories: string[];
  allergens: MenuList['allergens'];
  dietary: string[];
  allergenName: (id: string) => string;
  cat: (c: string) => string;
  diet: (tag: string) => string;
  out86: Set<string>;
}

export function useMenu() {
  const { t, lang } = useI18n();
  const { has } = useSession();
  const menu = useRpc<MenuList>('menu.list', {}, [], has('training'), { cache: 'menu' });
  const e86 = useRpc<EightySixSummary>('eightySix.summary', {}, [], has('eightySix'));
  const view = useMemo<MenuView | null>(() => {
    const d = menu.data;
    if (!d) return null;
    const names = Object.fromEntries(d.allergens.map((a) => [a.id, lang === 'es' ? a.es : a.label]));
    return {
      items: d.items.map((it) => ({ ...localizeItem(it, lang), raw: it })),
      categories: d.categories,
      allergens: d.allergens,
      dietary: d.dietary,
      allergenName: (id) => names[id] || id,
      cat: (c) => categoryLabel(c, lang, d.categoryEs),
      diet: (tag) => ((STANDARD_DIETARY as readonly string[]).includes(tag) ? t(`menu.tag.${tag as (typeof STANDARD_DIETARY)[number]}`) : dietaryFallback(tag)),
      out86: new Set(e86.data?.outMenuItemIds || []),
    };
  }, [menu.data, e86.data, lang, t]);
  return { view, ...menu };
}
