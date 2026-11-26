// One product from the library: a big photo (tap the small ones to switch), where it's kept, what else it's called,
// its category, size and supplier. For the "what does that bottle look like?" moment behind the bar.
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { Button, Card, Empty, Loading, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { catName, type Catalog, type Product } from '@/lib/stock';

export default function ProductScreen() {
  const { t, lang } = useI18n();
  const c = useColors();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const errorText = useErrorText();
  const cat = useRpc<Catalog>('products.list', {}, [], true, { cache: 'products' });
  const res = useRpc<{ product: Product }>('products.get', { id });
  const [shown, setShown] = useState(0);
  const p = res.data?.product || cat.data?.products.find((x) => x.id === id) || null;
  const big = Math.min(width - 32, 520);
  return (
    <Screen title={p?.name || t('stock.products')} back bottomInset onRefresh={res.reload}>
      {!p && !res.error ? <Loading label={t('common.loading')} /> : null}
      {res.error && !p ? <Empty icon="alert" title={errorText(res.error)}><Button title={t('common.retry')} onPress={res.reload} /></Empty> : null}
      {p ? (
        <>
          <StockPhoto product={{ ...p, photos: p.photos.slice(Math.min(shown, Math.max(0, p.photos.length - 1))) }} size={big} fit="contain" style={{ alignSelf: 'center', backgroundColor: c.surface2 }} />
          {p.photos.length > 1 ? (
            <View style={styles.thumbs}>
              {p.photos.map((ph, i) => (
                <Pressable key={ph.id} onPress={() => setShown(i)} accessibilityRole="imagebutton" accessibilityLabel={t('stock.seePhoto', { name: p.name })}
                  style={[styles.thumb, { borderColor: i === shown ? c.brand : c.border }]}>
                  <StockPhoto product={{ ...p, photos: [ph] }} size={56} />
                </Pressable>
              ))}
            </View>
          ) : null}
          <Txt v="title">{p.name}</Txt>
          {p.location ? (
            <Card style={styles.where}>
              <Icon name="pin" size={22} color={c.brand} />
              <View style={{ flex: 1 }}><Txt v="small" tone="muted">{t('stock.location')}</Txt><Txt v="h3">{p.location}</Txt></View>
            </Card>
          ) : null}
          {p.aliases?.length ? <Txt tone="muted">{t('stock.alsoCalled', { names: p.aliases.join(', ') })}</Txt> : null}
          <Card style={{ gap: 6 }}>
            {[[t('stock.category'), catName(cat.data?.categories, p.category, lang)], [t('stock.size'), p.size], [t('stock.unit'), cat.data?.units.find((u) => u.id === p.unit)?.[lang === 'es' ? 'es' : 'en'] || p.unit],
              [t('stock.supplier'), p.supplier], [t('stock.notes'), p.notes]].filter(([, v]) => v).map(([k, v]) => (
              <View key={k} style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Txt tone="muted">{k}:</Txt><Txt style={{ flexShrink: 1 }}>{v}</Txt></View>
            ))}
            {p.review === 'new' && p.addedBy ? <Txt v="small" tone="faint">{t('stock.addedBy', { name: p.addedBy.name })}</Txt> : null}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  thumbs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  thumb: { borderWidth: 2, borderRadius: 12, overflow: 'hidden' },
  where: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
