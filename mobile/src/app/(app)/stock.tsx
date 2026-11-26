// Stock lists: my lists (what to bring up and restock, and the quick lists I sent), for managers every open list with
// its progress, and the product library everyone builds together (big photos, instant search by name, nickname,
// category or where it's kept, on the copy kept on the phone). Quick list: search, tap, how many, send to the people
// on duty (quick-list.tsx). Tap a list to work it (stock-list.tsx), a product to see it (product.tsx).
// Scheduled lists, templates and reviewing new products are on the website (More → Full website).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { ListCard } from '@/components/StockParts';
import { Badge, Button, Card, Chips, Empty, Field, Loading, Tabs, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { catName, productMatches, type Catalog, type StockLists } from '@/lib/stock';

type Tab = 'mine' | 'all' | 'history' | 'products';

export default function StockScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'products' ? 'products' : 'mine');
  const scope = tab === 'products' ? 'mine' : tab;
  const lists = useRpc<StockLists>('stock.lists.list', { scope }, [], tab !== 'products');
  // The library is kept on the phone: it opens at once, and works offline with what was last seen.
  const catalog = useRpc<Catalog>('products.list', {}, [], tab === 'products', { cache: 'products' });
  const errorText = useErrorText();
  const canManage = lists.data?.canManage || catalog.data?.canManageLists;
  const tabs: { value: Tab; label: string }[] = [
    { value: 'mine', label: t('stock.mine') }, ...(canManage ? [{ value: 'all' as Tab, label: t('stock.allOpen') }] : []),
    { value: 'history', label: t('stock.history') }, { value: 'products', label: t('stock.products') },
  ];
  const cur = tab === 'products' ? catalog : lists;
  return (
    <Screen title={t('stock.title')} back bottomInset onRefresh={cur.reload}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {!cur.data && !cur.error ? <Loading label={t('common.loading')} /> : null}
      {cur.error && !cur.data ? <Empty icon="alert" title={errorText(cur.error)}><Button title={t('common.retry')} onPress={cur.reload} /></Empty> : null}
      {tab !== 'products' && lists.data ? <ListsView data={lists.data} tab={tab} /> : null}
      {tab === 'products' && catalog.data ? <Library cat={catalog.data} /> : null}
    </Screen>
  );
}

function ListsView({ data, tab }: { data: StockLists; tab: Tab }) {
  const { t } = useI18n();
  return (
    <>
      {data.canQuick && tab !== 'history' ? <Button kind="primary" icon="send" title={t('stock.quickList')} onPress={() => router.push('/quick-list')} block /> : null}
      <Txt v="small" tone="muted">{tab === 'all' ? t('stock.introAll') : t('stock.intro')}</Txt>
      {!data.lists.length ? <Card><Empty icon="check" title={tab === 'history' ? t('stock.noneHistory') : tab === 'all' ? t('stock.noneAll') : t('stock.noneMine')} /></Card> : null}
      {data.lists.map((l) => <ListCard key={l.id} l={l} />)}
      {data.canManage ? <Txt v="tiny" tone="faint" style={{ textAlign: 'center' }}>{t('stock.makeOnWeb')}</Txt> : null}
    </>
  );
}

function Library({ cat }: { cat: Catalog }) {
  const { t, lang } = useI18n();
  const c = useColors();
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<string[]>([]);
  const used = new Set(cat.products.map((p) => p.category));
  const shown = cat.products.filter((p) => (!only.length || only.includes(p.category)) && productMatches(p, q, catName(cat.categories, p.category, lang))).slice(0, 120);
  return (
    <>
      <Field label={t('stock.search')} value={q} onChangeText={setQ} placeholder={t('stock.searchPh')} autoCorrect={false} returnKeyType="search" />
      <Chips single options={cat.categories.filter((x) => used.has(x.id)).map((x) => ({ value: x.id, label: catName(cat.categories, x.id, lang) }))} value={only} onChange={setOnly} label={t('stock.category')} />
      <Button icon="camera" title={t('stock.addProduct')} onPress={() => router.push('/add-product')} block />
      {!shown.length ? <Card><Empty icon="search" title={t('stock.noProducts')} /></Card> : null}
      <View style={styles.grid}>
        {shown.map((p) => (
          <Pressable key={p.id} onPress={() => router.push({ pathname: '/product', params: { id: p.id } })} accessibilityRole="button" accessibilityLabel={p.name}
            style={({ pressed }) => [styles.tile, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
            <StockPhoto product={p} size={150} style={styles.tilePhoto} />
            <View style={{ padding: 10, gap: 2 }}>
              <Txt bold lines={2}>{p.name}{p.size ? ` · ${p.size}` : ''}</Txt>
              {p.location ? <View style={styles.loc}><Icon name="pin" size={13} color={c.text3} /><Txt v="tiny" tone="muted" style={{ flexShrink: 1 }} lines={2}>{p.location}</Txt></View> : null}
              {p.review === 'new' && p.addedBy ? <View style={{ flexDirection: 'row' }}><Badge tone="brand" text={t('stock.addedBy', { name: p.addedBy.name })} /></View> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: '47.5%', flexGrow: 1, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  tilePhoto: { width: '100%', height: 130, borderRadius: 0 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
