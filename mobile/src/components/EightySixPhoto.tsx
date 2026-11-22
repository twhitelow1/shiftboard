// 86 List photos in the app: a photo from the server (sent with the session's bearer token, since photos are only
// for people who can see the list), thumbnails under an item, and a full-screen viewer with Remove for the person
// who added it, the reporter and managers (the server says which: photo.canRemove).
import { Image } from 'expo-image';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import type { EightySixItem } from '@/lib/types';
import { Icon } from './Icon';
import { useColors } from './ui';

type Photo = EightySixItem['photos'][number];

/** One photo from the server, behind sign-in. */
export function E86Image({ id, style, fit = 'cover' }: { id: string; style: object; fit?: 'cover' | 'contain' }) {
  const { server, token } = useSession();
  return (
    <Image source={{ uri: `${server}/api/eighty-six/photos/${encodeURIComponent(id)}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
      style={style} contentFit={fit} transition={120} accessibilityIgnoresInvertColors />
  );
}

/** Small photos under an item; tap one to see it full screen. */
export function Thumbs({ photos, name, onOpen }: { photos: Photo[]; name: string; onOpen: (index: number) => void }) {
  const { t } = useI18n();
  const c = useColors();
  if (!photos?.length) return null;
  return (
    <View style={styles.thumbs}>
      {photos.map((p, i) => (
        <Pressable key={p.id} onPress={() => onOpen(i)} accessibilityRole="imagebutton" accessibilityLabel={`${name}: ${t('eightySix.photoN', { n: i + 1, count: photos.length })}`}
          style={[styles.thumb, { borderColor: c.border, backgroundColor: c.surface2 }]}>
          <E86Image id={p.id} style={StyleSheet.absoluteFill} />
        </Pressable>
      ))}
    </View>
  );
}

/** Full screen, one photo at a time. */
export function PhotoViewer({ name, photos, start, onClose, onRemove }: { name: string; photos: Photo[]; start: number; onClose: () => void; onRemove: (p: Photo) => void }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [i, setI] = useState(start);
  const p = photos[Math.min(i, photos.length - 1)];
  if (!p) return null;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait']}>
      <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.top}>
          <Text style={styles.title} numberOfLines={2}>{name}{photos.length > 1 ? ` · ${t('eightySix.photoN', { n: i + 1, count: photos.length })}` : ''}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('eightySix.close')} style={styles.round} hitSlop={6}>
            <Icon name="x" size={24} color="#fff" />
          </Pressable>
        </View>
        <View style={{ flex: 1 }}><E86Image key={p.id} id={p.id} style={StyleSheet.absoluteFill} fit="contain" /></View>
        <View style={styles.bar}>
          {photos.length > 1 ? (
            <Pressable onPress={() => setI(Math.max(0, i - 1))} disabled={i === 0} accessibilityRole="button" accessibilityLabel={t('eightySix.previousPhoto')} style={[styles.round, i === 0 && { opacity: 0.35 }]}>
              <Icon name="left" size={24} color="#fff" />
            </Pressable>
          ) : <View style={styles.round} />}
          {p.canRemove ? (
            <Pressable onPress={() => onRemove(p)} accessibilityRole="button" style={styles.remove}>
              <Icon name="trash" size={18} color="#fca5a5" />
              <Text style={styles.removeText}>{t('eightySix.removePhoto')}</Text>
            </Pressable>
          ) : <View />}
          {photos.length > 1 ? (
            <Pressable onPress={() => setI(Math.min(photos.length - 1, i + 1))} disabled={i >= photos.length - 1} accessibilityRole="button" accessibilityLabel={t('eightySix.nextPhoto')} style={[styles.round, i >= photos.length - 1 && { opacity: 0.35 }]}>
              <Icon name="right" size={24} color="#fff" />
            </Pressable>
          ) : <View style={styles.round} />}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 58, paddingBottom: 8 },
  thumb: { width: 56, height: 56, borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  viewer: { flex: 1, backgroundColor: '#05070c' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, minHeight: 56 },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700' },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(252,165,165,0.5)' },
  removeText: { color: '#fca5a5', fontSize: 16, fontWeight: '700' },
});
