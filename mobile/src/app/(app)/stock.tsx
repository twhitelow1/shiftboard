// Stock lists: my lists (what to bring up and restock), for managers every open list with its progress, and the
// products everyone builds together (search, photos, Add a product). Tap a list to work it (stock-list.tsx).
// Making and assigning lists, templates and reviewing new products are on the website (More → Full website).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { ListCard } from '@/components/StockParts';
import { Badge, Button, Card, Empty, Field, Loading, Tabs, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { catName, type Catalog, type StockLists } from '@/lib/stock';

type Tab = 'mine' | 'all' | 'history' | 'products';
const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export default function StockScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'products' ? 'products' : 'mine');
  const scope = tab === 'products' ? 'mine' : tab;
  const lists = useRpc<StockLists>('stock.lists.list', { scope }, [], tab !== 'products');
  const catalog = useRpc<Catalog>('products.list', {}, [], tab === 'products');
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
      {tab === 'products' && catalog.data ? <ProductsView cat={catalog.data} /> : null}
    </Screen>
  );
}

function ListsView({ data, tab }: { data: StockLists; tab: Tab }) {
  const { t } = useI18n();
  return (
    <>
      <Txt v="small" tone="muted">{tab === 'all' ? t('stock.introAll') : t('stock.intro')}</Txt>
      {!data.lists.length ? <Card><Empty icon="check" title={tab === 'history' ? t('stock.noneHistory') : tab === 'all' ? t('stock.noneAll') : t('stock.noneMine')} /></Card> : null}
      {data.lists.map((l) => <ListCard key={l.id} l={l} />)}
      {data.canManage ? <Txt v="tiny" tone="faint" style={{ textAlign: 'center' }}>{t('stock.makeOnWeb')}</Txt> : null}
    </>
  );
}

function ProductsView({ cat }: { cat: Catalog }) {
  const { t, lang } = useI18n();
  const c = useColors();
  const [q, setQ] = useState('');
  const words = norm(q).split(' ').filter(Boolean);
  const shown = cat.products.filter((p) => words.every((w) => norm(`${p.name} ${p.size} ${p.location}`).includes(w))).slice(0, 80);
  return (
    <>
      <Txt v="small" tone="muted">{t('stock.productsIntro')}</Txt>
      <Button kind="primary" icon="camera" title={t('stock.addProduct')} onPress={() => router.push('/add-product')} block />
      <Field label={t('stock.search')} value={q} onChangeText={setQ} placeholder={t('stock.searchPh')} autoCorrect={false} returnKeyType="search" />
      <Card pad={false} style={{ overflow: 'hidden' }}>
        {!shown.length ? <Empty icon="search" title={t('stock.noProducts')} /> : null}
        {shown.map((p) => (
          <View key={p.id} style={[styles.prod, { borderColor: c.border }]}>
            <StockPhoto product={p} size={56} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt bold>{p.name}{p.size ? ` · ${p.size}` : ''}</Txt>
              <Txt v="small" tone="muted">{catName(cat.categories, p.category, lang)}</Txt>
              {p.location ? <View style={styles.loc}><Icon name="pin" size={13} color={c.text3} /><Txt v="small" tone="faint" style={{ flexShrink: 1 }}>{p.location}</Txt></View> : null}
              {p.review === 'new' && p.addedBy ? <View style={{ flexDirection: 'row' }}><Badge tone="brand" text={t('stock.addedBy', { name: p.addedBy.name })} /></View> : null}
            </View>
          </View>
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  prod: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 72 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
