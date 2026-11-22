// A menu item's photos: one per screen width, swipe between them (arrows too), tap for full screen.
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { TrainingPhoto } from '@/components/TrainingPhoto';
import { useColors } from '@/components/ui';
import { useI18n } from '@/i18n';

type Photo = { id: string; w: number; h: number };

function Pager({ photos, name, height, fit, onTap, start = 0, onIndex }: {
  photos: Photo[]; name: string; height: number | undefined; fit: 'cover' | 'contain'; onTap?: (i: number) => void; start?: number; onIndex?: (i: number) => void;
}) {
  const { t } = useI18n();
  const [w, setW] = useState(0);
  const [i, setI] = useState(start);
  const ref = useRef<ScrollViewInstance>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const nw = Math.round(e.nativeEvent.layout.width);
    if (nw && nw !== w) { setW(nw); requestAnimationFrame(() => ref.current?.scrollTo({ x: i * nw, animated: false })); }
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!w) return;
    const n = Math.round(e.nativeEvent.contentOffset.x / w);
    if (n !== i) { setI(n); onIndex?.(n); }
  };
  const go = (n: number) => { const k = Math.max(0, Math.min(photos.length - 1, n)); ref.current?.scrollTo({ x: k * w, animated: true }); setI(k); onIndex?.(k); };
  return (
    <View onLayout={onLayout} style={{ flex: height ? undefined : 1 }}>
      <ScrollView ref={ref} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onScroll={onScroll} scrollEventThrottle={32}
        style={{ flex: height ? undefined : 1 }}>
        {photos.map((p, k) => (
          <Pressable key={p.id} onPress={onTap ? () => onTap(k) : undefined} disabled={!onTap} accessibilityRole={onTap ? 'imagebutton' : 'image'}
            accessibilityLabel={`${name}: ${t('menu.photoN', { n: k + 1, count: photos.length })}`} style={{ width: w || 1, height: height ?? '100%' }}>
            <TrainingPhoto id={p.id} style={StyleSheet.absoluteFill} fit={fit} />
          </Pressable>
        ))}
      </ScrollView>
      {photos.length > 1 ? (
        <>
          <Pressable onPress={() => go(i - 1)} disabled={i === 0} accessibilityRole="button" accessibilityLabel={t('common.previous')} style={[styles.arrow, { left: 6, opacity: i === 0 ? 0.3 : 1 }]}>
            <Icon name="left" size={22} color="#fff" />
          </Pressable>
          <Pressable onPress={() => go(i + 1)} disabled={i >= photos.length - 1} accessibilityRole="button" accessibilityLabel={t('common.next')} style={[styles.arrow, { right: 6, opacity: i >= photos.length - 1 ? 0.3 : 1 }]}>
            <Icon name="right" size={22} color="#fff" />
          </Pressable>
          <View style={styles.dots} pointerEvents="none">
            {photos.map((p, k) => <View key={p.id} style={[styles.dot, { opacity: k === i ? 1 : 0.45 }]} />)}
          </View>
        </>
      ) : null}
    </View>
  );
}

export function Gallery({ photos, name }: { photos: Photo[]; name: string }) {
  const { t } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [big, setBig] = useState<number | null>(null);
  const [at, setAt] = useState(0);
  if (!photos.length) return null;
  return (
    <View style={[styles.box, { backgroundColor: c.surface2 }]}>
      <Pager photos={photos} name={name} height={240} fit="cover" onTap={setBig} onIndex={setAt} />
      <Pressable onPress={() => setBig(at)} accessibilityRole="button" accessibilityLabel={t('menu.fullScreen')} style={styles.expand}>
        <Icon name="expand" size={18} color="#fff" />
      </Pressable>
      {big != null ? (
        <Modal visible animationType="fade" onRequestClose={() => setBig(null)} supportedOrientations={['portrait', 'landscape']}>
          <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <View style={styles.top}>
              <Text style={styles.title} numberOfLines={2}>{name}</Text>
              <Pressable onPress={() => setBig(null)} accessibilityRole="button" accessibilityLabel={t('common.close')} style={styles.close}>
                <Icon name="x" size={24} color="#fff" />
              </Pressable>
            </View>
            <View style={{ flex: 1 }}><Pager photos={photos} name={name} height={undefined} fit="contain" start={big} /></View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 16, overflow: 'hidden' },
  arrow: { position: 'absolute', top: '50%', marginTop: -22, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  dots: { position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  expand: { position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  viewer: { flex: 1, backgroundColor: '#05070c' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, minHeight: 56 },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700' },
  close: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
