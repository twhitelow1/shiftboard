// A product's photo (Stock lists' catalog), from the server behind sign-in (the session's bearer token), or a tile with
// its initials in its category's color when it has none.
import { Image } from 'expo-image';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { initials, TILE_COLORS } from '@/lib/stock';
import { useSession } from '@/lib/session';

export function StockPhoto({ product, size = 64, style, fit = 'cover' }: {
  product: { name: string; category?: string; photos?: { id: string }[] }; size?: number; style?: StyleProp<ViewStyle>; fit?: 'cover' | 'contain';
}) {
  const { server, token } = useSession();
  const id = product.photos?.[0]?.id;
  const box = [styles.box, { width: size, height: size, borderRadius: Math.round(size / 6) }, style];
  if (!id) {
    return (
      <View style={[box, { backgroundColor: TILE_COLORS[product.category || ''] || '#64748b', alignItems: 'center', justifyContent: 'center' }]} accessibilityIgnoresInvertColors>
        <Text style={{ color: '#fff', fontWeight: '800', fontSize: Math.round(size / 2.6) }}>{initials(product.name)}</Text>
      </View>
    );
  }
  return (
    <View style={box}>
      <Image source={{ uri: `${server}/api/stock/photos/${encodeURIComponent(id)}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
        style={StyleSheet.absoluteFill} contentFit={fit} transition={120} accessibilityIgnoresInvertColors />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: '#e2e8f0' },
});
