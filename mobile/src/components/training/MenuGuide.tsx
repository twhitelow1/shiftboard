// The menu study guide: search (either language), filter out allergens, only dietary tags, hide what's 86'd,
// menu sections, and a card per dish with its photo, price and allergens. Tapping one opens it (app/(app)/menu/[id]).
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { TrainingPhoto } from '@/components/TrainingPhoto';
import { Button, Card, Chips, Empty, Loading, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { money, norm } from '@/lib/training';
import { useMenu, type MenuView } from './useMenu';

export function MenuGuide() {
  const { t, tn } = useI18n();
  const c = useColors();
  const { view: menu, error, reload } = useMenu();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [without, setWithout] = useState<string[]>([]);
  const [diet, setDiet] = useState<string[]>([]);
  const [hide86, setHide86] = useState(false);
  const [filters, setFilters] = useState(false);
  if (!menu) return error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />;

  const words = norm(q).split(/\s+/).filter(Boolean);
  const shown = menu.items.filter((it) => {
    if (cat && it.category !== cat) return false;
    if (hide86 && (it.eightySixed || menu.out86.has(it.id))) return false;
    if (without.some((a) => it.allergens.includes(a))) return false;
    if (diet.some((d) => !it.dietary.includes(d))) return false;
    if (!words.length) return true;
    const hay = norm([it.name, it.raw.name, it.description, it.raw.description, menu.cat(it.category), ...it.keyIngredients, ...it.raw.keyIngredients].join(' '));
    return words.every((w) => hay.includes(w));
  });
  const groups = menu.categories.map((cg) => [cg, shown.filter((it) => it.category === cg)] as const).filter(([, l]) => l.length);
  const active = without.length + diet.length + (hide86 ? 1 : 0);

  return (
    <View style={{ gap: 12 }}>
      <View style={[styles.search, { borderColor: c.border, backgroundColor: c.surface }]}>
        <Icon name="search" size={18} color={c.text3} />
        <TextInput value={q} onChangeText={setQ} placeholder={t('menu.search')} placeholderTextColor={c.text3} accessibilityLabel={t('menu.search')}
          style={[styles.searchInput, { color: c.text }]} autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" />
      </View>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button icon="filter" kind={active ? 'primary' : 'secondary'} title={active ? t('menu.filtersN', { count: active }) : t('menu.filters')}
          onPress={() => setFilters(!filters)} style={{ flexGrow: 1 }} />
        <Button icon="cards" title={t('menu.flashcards')} onPress={() => router.push('/study')} style={{ flexGrow: 1 }} />
      </Row>
      {filters ? (
        <Card style={{ gap: 10 }}>
          <Txt v="small" tone="muted" bold>{t('menu.withoutAllergens')}</Txt>
          <Chips label={t('menu.withoutAllergens')} value={without} onChange={setWithout} options={menu.allergens.map((a) => ({ value: a.id, label: menu.allergenName(a.id) }))} />
          <Txt v="small" tone="muted" bold>{t('menu.onlyDietary')}</Txt>
          <Chips label={t('menu.onlyDietary')} value={diet} onChange={setDiet} options={menu.dietary.map((d) => ({ value: d, label: menu.diet(d) }))} />
          <Chips value={hide86 ? ['86'] : []} onChange={(v) => setHide86(v.length > 0)} options={[{ value: '86', label: t('menu.hide86') }]} />
          {active ? <Button kind="ghost" small title={t('menu.clearFilters')} onPress={() => { setWithout([]); setDiet([]); setHide86(false); }} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }} accessibilityRole="tablist">
        {[['', t('common.all')] as const, ...menu.categories.map((cg) => [cg, menu.cat(cg)] as const)].map(([v, label]) => {
          const on = cat === v;
          return (
            <Pressable key={v || 'all'} onPress={() => setCat(on && v ? '' : v)} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={[styles.cat, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brand : c.surface }]}>
              <Text style={{ color: on ? c.onBrand : c.text2, fontWeight: '700', fontSize: 14 }}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {without.length ? <Txt v="small" tone="muted">{t('menu.showingWithout', { list: without.map(menu.allergenName).join(', ') })}</Txt> : null}
      {!menu.items.length ? <Card><Empty icon="star" title={t('menu.noItems')} body={t('menu.noItemsBody')} /></Card> : null}
      {menu.items.length > 0 && !shown.length ? <Card><Empty icon="search" title={t('menu.nothingMatches')} /></Card> : null}
      {groups.map(([cg, list]) => (
        <View key={cg} style={{ gap: 8 }}>
          <Row>
            <Txt v="h3" style={{ flex: 1 }}>{menu.cat(cg)}</Txt>
            <Txt v="small" tone="faint">{tn('menu.items', list.length)}</Txt>
          </Row>
          <View style={styles.grid}>
            {list.map((it) => <ItemCard key={it.id} it={it} menu={menu} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

function ItemCard({ it, menu }: { it: MenuView['items'][number]; menu: MenuView }) {
  const { t } = useI18n();
  const c = useColors();
  const is86 = it.eightySixed || menu.out86.has(it.id);
  const allergens = it.allergens.map(menu.allergenName).join(' · ');
  return (
    <Pressable onPress={() => router.push({ pathname: '/menu/[id]', params: { id: it.id } })} accessibilityRole="button"
      accessibilityLabel={[it.name, is86 ? (it.eightySixed ? t('menu.eightySixed') : t('menu.outToday')) : '', money(it.price), allergens].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.item, { borderColor: c.border, backgroundColor: c.surface, opacity: pressed ? 0.85 : 1 }]}>
      <View>
        <TrainingPhoto id={it.photos[0]?.id} style={styles.photo} />
        {is86 ? <View style={[styles.badge86, { backgroundColor: c.bad }]}><Text style={styles.badge86Text}>{it.eightySixed ? t('menu.eightySixed') : t('menu.outToday')}</Text></View> : null}
        {it.photos.length > 1 ? <View style={styles.count}><Text style={styles.countText}>{it.photos.length}</Text></View> : null}
      </View>
      <View style={{ padding: 10, gap: 2, opacity: is86 ? 0.6 : 1 }}>
        <Txt bold lines={2}>{it.name}</Txt>
        {it.price != null ? <Txt v="small" tone="muted">{money(it.price)}</Txt> : null}
        {allergens ? <Txt v="tiny" tone="bad" lines={2}>{allergens}</Txt> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
  searchInput: { flex: 1, fontSize: 16, minHeight: 46 },
  cat: { minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  item: { width: '48.4%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  photo: { width: '100%', aspectRatio: 4 / 3 },
  badge86: { position: 'absolute', top: 8, left: 8, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badge86Text: { color: '#fff', fontWeight: '800', fontSize: 12 },
  count: { position: 'absolute', right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  countText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
