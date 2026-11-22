// One page of the employee manual, in Spanish when the restaurant wrote a Spanish version, with "I've read this".
// When a manager changes a page and asks everyone to read it again, it says so here. The call-out page shows
// the manager on duty with Call and Text buttons.
import { useLocalSearchParams } from 'expo-router';

import { Markdown } from '@/components/Markdown';
import { ModCard } from '@/components/ModCard';
import { Screen } from '@/components/Screen';
import { Button, Card, Empty, Loading, Notice, Row, Txt, useColors } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useI18n } from '@/i18n';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { localize } from '@/lib/training';
import type { ManualPage } from '@/lib/types';

export default function ManualPageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang, date } = useI18n();
  const c = useColors();
  const { client } = useApp();
  const errorText = useErrorText();
  const { data: p, error, reload } = useRpc<ManualPage>('manual.get', { id }, [id]);
  const [run, busy] = useAction();
  if (!p) {
    return (
      <Screen title={t('manual.title')} back bottomInset>
        {error ? <Empty icon="alert" title={errorText(error)}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />}
      </Screen>
    );
  }
  const v = localize(p, lang);
  const section = localize({ title: p.sectionTitle, es: { title: p.sectionEs } }, lang).title;
  const day = (iso: string) => date(iso.slice(0, 10));
  const ack = () => run(() => client.call('manual.ack', { id }), t('manual.thanks'));
  return (
    <Screen title={v.title} back bottomInset onRefresh={reload}>
      <Card style={{ gap: 10 }}>
        {section ? <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{section}</Txt> : null}
        <Txt v="title" style={{ fontSize: 22 }}>{v.title}</Txt>
        {lang === 'es' && !p.es?.body && p.body ? <Notice tone="neutral" icon="globe" text={t('manual.onlyInEnglish')} /> : null}
        <Markdown text={v.body} />
        {p.updatedAt ? <Txt v="tiny" tone="faint">{p.updatedBy ? t('manual.updatedBy', { date: day(p.updatedAt), name: p.updatedBy }) : t('manual.updated', { date: day(p.updatedAt) })}</Txt> : null}
      </Card>
      {p.isCallOut ? <ModCard compact /> : null}
      <Card style={{ gap: 10 }}>
        {p.my.current ? (
          <Row>
            <Icon name="check" size={20} color={c.ok} />
            <Txt style={{ flex: 1 }}>{t('manual.youReadOn', { date: day(p.my.ackedAt || p.updatedAt) })}</Txt>
          </Row>
        ) : (
          <>
            {p.my.ackedAt ? <Txt v="small" tone="warn">{t('manual.changedSince', { date: day(p.my.ackedAt) })}</Txt> : null}
            <Button kind="primary" icon="check" title={t('manual.iveRead')} busy={busy} onPress={ack} />
          </>
        )}
      </Card>
    </Screen>
  );
}
