// Training photos from the restaurant's server, sent with the session's bearer token (they're only for signed-in
// staff): a menu photo (/api/training/photos/:id) or a quiz question's photo, which doesn't say which item it is
// (/api/training/quiz-photo/:attemptId/:key). A camera placeholder while there's none or it can't load.
import { Image } from 'expo-image';
import { useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useSession } from '@/lib/session';
import { Icon } from './Icon';
import { useColors } from './ui';

export function TrainingPhoto({ id, attemptId, qKey, style, fit = 'cover', label }: {
  id?: string; attemptId?: string; qKey?: string; style?: StyleProp<ViewStyle>; fit?: 'cover' | 'contain'; label?: string;
}) {
  const { server, token } = useSession();
  const c = useColors();
  const [broken, setBroken] = useState(false);
  const path = attemptId && qKey
    ? `/api/training/quiz-photo/${encodeURIComponent(attemptId)}/${encodeURIComponent(qKey)}`
    : id ? `/api/training/photos/${encodeURIComponent(id)}` : '';
  if (!path || broken) {
    return (
      <View style={[{ alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface2 }, style]} accessibilityLabel={label}>
        <Icon name="camera" size={26} color={c.text3} />
      </View>
    );
  }
  return (
    <Image source={{ uri: `${server}${path}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
      style={[{ backgroundColor: c.surface2 }, style] as object} contentFit={fit} transition={120} onError={() => setBroken(true)}
      accessibilityLabel={label} accessible={!!label} accessibilityIgnoresInvertColors recyclingKey={path} />
  );
}
