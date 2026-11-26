// Feedback inbox (readers: managers and up; supervisors when an admin allows it). Filters by status, kind, signed or
// anonymous, and dates (the website has the topic too); tap an entry to read and answer it (feedback-read.tsx).
// Anonymous entries have no author, for anyone.
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { StatusBadge } from '@/components/Feedback';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Chips, Empty, Field, ListRow, Loading, Row, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import type { FeedbackStatus, Inbox } from '@/lib/feedback';
import { useErrorText, useRpc } from '@/lib/hooks';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function FeedbackInbox() {
  const { t, tn, date } = useI18n();
  const errorText = useErrorText();
  const [status, setStatus] = useState<FeedbackStatus[]>([]);
  const [kind, setKind] = useState<string[]>([]);
  const [signed, setSigned] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const args = { status: status[0] || '', kind: kind[0] || '', signed: signed[0] || '', from: DATE.test(from) ? from : '', to: DATE.test(to) ? to : '' };
  const inbox = useRpc<Inbox>('feedback.inbox.list', args);
  const d = inbox.data;
  return (
    <Screen title={t('feedback.inboxTitle')} back bottomInset onRefresh={inbox.reload}>
      <Txt v="small" tone="muted">{t('feedback.inboxIntro')}</Txt>
      {inbox.error && !d ? <Empty icon="alert" title={errorText(inbox.error)}><Button title={t('common.retry')} onPress={inbox.reload} /></Empty> : null}
      {!d && !inbox.error ? <Loading label={t('common.loading')} /> : null}
      {d ? (
        <>
          <Chips single label={t('feedback.status')} value={status} onChange={setStatus}
            options={d.statuses.map((s) => ({ value: s.id, label: `${s.label} (${d.counts[s.id] || 0})` }))} />
          <Chips single label={t('feedback.allKinds')} value={kind} onChange={setKind} options={d.kinds.map((k) => ({ value: k.id, label: k.label }))} />
          <Chips single label={t('feedback.signedAll')} value={signed} onChange={setSigned}
            options={[{ value: 'signed', label: t('feedback.signedOnly') }, { value: 'anonymous', label: t('feedback.anonOnly') }]} />
          <Row gap={8}>
            <View style={{ flex: 1 }}><Field label={t('feedback.from')} value={from} onChangeText={setFrom} placeholder="2026-01-31" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} /></View>
            <View style={{ flex: 1 }}><Field label={t('feedback.to')} value={to} onChangeText={setTo} placeholder="2026-12-31" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} /></View>
          </Row>
          {d.items.length === 0 ? <Empty icon="message" title={t('feedback.inboxEmpty')} /> : (
            <Card pad={false} style={{ overflow: 'hidden' }}>
              {d.items.map((e) => (
                <ListRow key={e.id} title={[e.kindLabel, e.topicLabel].filter(Boolean).join(' · ')}
                  sub={`${date(e.date)} · ${e.author ? t('feedback.signedBy', { name: e.author.name }) : t('feedback.anonymous')}${e.replies ? ` · ${tn('feedback.replies', e.replies)}` : ''}\n${e.message.slice(0, 90)}`}
                  onPress={() => router.push({ pathname: '/feedback-read', params: { id: e.id } })}
                  right={<View style={{ alignItems: 'flex-end', gap: 4 }}><StatusBadge status={e.status} label={e.statusLabel} />{e.adminsOnly ? <Badge tone="warn" text={t('feedback.adminsOnly')} /> : null}</View>} />
              ))}
            </Card>
          )}
        </>
      ) : null}
    </Screen>
  );
}
