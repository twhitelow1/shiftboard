// The employee manual: sections and their pages, each marked Read, Please read or Read again (changed since).
import { router } from 'expo-router';
import { View } from 'react-native';

import { Badge, Button, Card, Empty, ListRow, Loading, SectionTitle } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { localize } from '@/lib/training';
import type { ManualList as Manual } from '@/lib/types';

export function ManualList() {
  const { t, lang } = useI18n();
  const { data, error, reload } = useRpc<Manual>('manual.list', {}, [], true, { cache: 'manual' });
  if (!data) return error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />;
  if (!data.sections.length) return <Card><Empty icon="book" title={t('manual.none')} body={t('manual.noneBody')} /></Card>;
  return (
    <View style={{ gap: 4 }}>
      {data.sections.map((s) => (
        <View key={s.id} style={{ gap: 6 }}>
          <SectionTitle title={localize(s, lang).title} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {!s.pages.length ? <ListRow title={t('manual.noPages')} /> : s.pages.map((p) => {
              const title = localize(p, lang).title;
              const status = p.my.current ? t('manual.read') : p.my.ackedAt ? t('manual.readAgain') : t('manual.pleaseRead');
              return (
                <ListRow key={p.id} icon={p.isCallOut ? 'phone' : 'cards'} title={title} label={`${title}, ${status}`}
                  onPress={() => router.push({ pathname: '/manual/[id]', params: { id: p.id } })}
                  right={<Badge tone={p.my.current ? 'ok' : 'warn'} text={status} />} />
              );
            })}
          </Card>
        </View>
      ))}
    </View>
  );
}
