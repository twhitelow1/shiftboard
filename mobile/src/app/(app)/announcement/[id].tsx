// One announcement from management (core/announcements.js), in the person's language (the Spanish version when
// there is one). Opening it is the read receipt managers see. A link in it opens that screen (lib/links.ts).
import { router, useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/Screen';
import { Button, Card, Empty, Loading, Row, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { routeForLink } from '@/lib/links';
import { useApp } from '@/lib/session';

type Mine = { id: string; title: string; body: string; lang: string; link: string; at: string; from: string; urgent: boolean; read: boolean };

export default function AnnouncementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, stamp } = useI18n();
  const { has } = useApp();
  const errorText = useErrorText();
  // announcements.open marks it read and answers { mine: what I got, manage: delivery details for managers }.
  const { data, error, reload } = useRpc<{ mine: Mine | null }>('announcements.open', { id }, [id]);
  const a = data?.mine;
  if (!a) {
    return (
      <Screen title={t('announcement.title')} back bottomInset>
        {error || data ? <Empty icon="alert" title={error ? errorText(error) : t('announcement.title')}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />}
      </Screen>
    );
  }
  const target = a.link ? routeForLink(a.link, has) : null;
  return (
    <Screen title={t('announcement.title')} back bottomInset onRefresh={reload}>
      <Card style={{ gap: 10 }}>
        <Row gap={6}>
          {a.urgent ? <Txt v="tiny" tone="bad" bold>{t('announcement.urgent')}</Txt> : null}
          <Txt v="small" tone="muted">{t('announcement.from', { name: a.from })} · {stamp(a.at)}</Txt>
        </Row>
        <Txt v="title" style={{ fontSize: 22 }}>{a.title}</Txt>
        <Txt>{a.body}</Txt>
        {target && target !== '/notifications' ? <Button kind="primary" icon="right" title={t('announcement.open')} onPress={() => router.push(target)} /> : null}
      </Card>
    </Screen>
  );
}
