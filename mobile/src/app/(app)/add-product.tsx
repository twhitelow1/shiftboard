// Add a product on the fly: a name (and a photo from the camera or the library) is enough. As the name is typed, products
// already in the catalog that look the same (the smart import's rules on the server) show with their photos and "Use
// this one". A new product is usable at once and waits for a manager's review, marked "Added by" this person.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { Button, Card, Chips, Field, Notice, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { pickPhotos, type ShrunkPhoto } from '@/lib/photos';
import { useApp } from '@/lib/session';
import { catName, type Catalog, type Product, type ProductMatch } from '@/lib/stock';

export default function AddProduct() {
  const { t, lang } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const cat = useRpc<Catalog>('products.list');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string[]>([]);
  const [unit, setUnit] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [aliases, setAliases] = useState('');
  const [photo, setPhoto] = useState<ShrunkPhoto | null>(null);
  const [matches, setMatches] = useState<ProductMatch[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!name.trim()) { setMatches([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      client.call<{ matches: ProductMatch[] }>('products.matches.get', { name }).then((r) => { if (live) setMatches(r.matches); }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [name, client]);

  const pick = async (source: 'camera' | 'library') => {
    const r = await pickPhotos(source, 1, { title: t('stock.allowTitle'), why: t(source === 'camera' ? 'stock.cameraWhy' : 'stock.libraryWhy'), allow: t('stock.allow'), cancel: t('common.cancel') });
    if ('denied' in r) return toast(t(source === 'camera' ? 'stock.cameraDenied' : 'stock.libraryDenied'), 'bad');
    if ('failed' in r) return toast(t('stock.photoBad'), 'bad');
    if (r.photos[0]) setPhoto(r.photos[0]);
  };
  const use = (p: Product) => { toast(t('stock.usingIt', { name: p.name })); router.back(); };
  const save = async () => {
    setBusy(true);
    try {
      const r = await client.call<{ product: Product }>('products.add', { name, ...(category[0] ? { category: category[0] } : {}), ...(unit[0] ? { unit: unit[0] } : {}), location, aliases, force: true });
      if (photo) {
        try { await client.call('products.addPhoto', { id: r.product.id, dataUrl: photo.dataUrl, w: photo.w, h: photo.h }); } catch (e) { toast(t('stock.photoFailed', { error: errorText(e) }), 'bad'); }
      }
      toast(t('stock.productAdded', { name: r.product.name }));
      bump();
      router.back();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('stock.addProduct')} back bottomInset>
      <Txt v="small" tone="muted">{t('stock.addProductSub')}</Txt>
      <Field label={t('stock.productName')} value={name} onChangeText={setName} placeholder={t('stock.productNamePh')} autoFocus autoCorrect={false} maxLength={80} />
      {matches.length ? (
        <Card style={{ gap: 10, backgroundColor: c.warnSoft, borderColor: c.warn }}>
          <Txt bold>{t('stock.alreadyHave')}</Txt>
          {matches.map((m) => (
            <View key={m.id} style={styles.match}>
              <StockPhoto product={m} size={56} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt bold>{m.name}</Txt>
                {m.size || m.location ? <Txt v="small" tone="muted">{[m.size, m.location].filter(Boolean).join(' · ')}</Txt> : null}
              </View>
              <Button small kind="primary" title={t('stock.useThis')} onPress={() => use(m)} />
            </View>
          ))}
        </Card>
      ) : null}

      <View style={{ gap: 6 }}>
        <Txt v="small" tone="muted" bold>{t('stock.photo')}</Txt>
        {photo ? (
          <View style={[styles.photo, { borderColor: c.border }]}>
            <Image source={{ uri: photo.dataUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
            <Pressable onPress={() => setPhoto(null)} accessibilityRole="button" accessibilityLabel={t('stock.removePhoto')} style={styles.photoX} hitSlop={6}><Icon name="x" size={16} color="#fff" /></Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button icon="camera" title={t('stock.takePhoto')} onPress={() => pick('camera')} style={{ flexGrow: 1 }} />
            <Button icon="image" title={t('stock.choosePhoto')} onPress={() => pick('library')} style={{ flexGrow: 1 }} />
          </View>
        )}
      </View>

      {cat.data ? (
        <>
          <View style={{ gap: 6 }}>
            <Txt v="small" tone="muted" bold>{t('stock.category')}</Txt>
            <Chips single options={cat.data.categories.map((x) => ({ value: x.id, label: catName(cat.data!.categories, x.id, lang) }))} value={category} onChange={setCategory} label={t('stock.category')} />
          </View>
          <View style={{ gap: 6 }}>
            <Txt v="small" tone="muted" bold>{t('stock.unit')}</Txt>
            <Chips single options={cat.data.units.map((u) => ({ value: u.id, label: lang === 'es' ? u.es : u.en }))} value={unit} onChange={setUnit} label={t('stock.unit')} />
          </View>
        </>
      ) : null}
      <Field label={t('stock.location')} value={location} onChangeText={setLocation} placeholder={t('stock.locationPh')} maxLength={80} />
      <Field label={t('stock.aliases')} value={aliases} onChangeText={setAliases} placeholder={t('stock.aliasesPh')} maxLength={200} autoCorrect={false} />
      <Notice tone="brand" icon="alert" text={t('stock.addHelp')} />
      <Button kind="primary" title={matches.length ? t('stock.addAnyway') : t('stock.addIt')} onPress={save} busy={busy} disabled={!name.trim()} block />
    </Screen>
  );
}

const styles = StyleSheet.create({
  match: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  photo: { width: 140, height: 112, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  photoX: { position: 'absolute', top: 6, right: 6, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(15,23,42,0.75)', alignItems: 'center', justifyContent: 'center' },
});
