// Time off: my requests and their status, and (for shift leads and managers) requests to approve.
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, Loading, Row, Tabs, Txt, useColors, type Tone } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { TimeOff } from '@/lib/types';

const STATUS: Record<TimeOff['status'], [MsgKey, Tone]> = {
  pending: ['timeOff.pending', 'warn'], approved: ['timeOff.approved', 'ok'], denied: ['timeOff.denied', 'bad'], cancelled: ['timeOff.cancelled', 'neutral'],
};

export default function TimeOffScreen() {
  const { t, date } = useI18n();
  const c = useColors();
  const { me, today, canApprove, people, client } = useApp();
  const { data, error, reload } = useRpc<TimeOff[]>('timeOff.list');
  const [run, busy] = useAction();
  const [tab, setTab] = useState<'mine' | 'approve'>('mine');
  const toApprove = (data || []).filter((x) => x.status === 'pending' && x.userId !== me.id);
  const rows = tab === 'approve' ? toApprove : (data || []).filter((x) => x.userId === me.id);

  return (
    <Screen title={t('timeOff.title')} onRefresh={reload}>
      <Button kind="primary" icon="plus" title={t('timeOff.request')} onPress={() => router.push('/request-time-off')} />
      {canApprove ? (
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'mine', label: t('timeOff.mine') }, { value: 'approve', label: t('timeOff.toApprove'), count: toApprove.length }]} />
      ) : null}
      {!data && !error ? <Loading /> : null}
      {error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}
      {data && !rows.length ? (
        <Card><Empty icon="sun" title={tab === 'approve' ? t('timeOff.emptyApprove') : t('timeOff.empty')} body={tab === 'mine' ? t('timeOff.emptyBody') : undefined} /></Card>
      ) : null}
      {rows.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {rows.map((x) => {
            const [label, tone] = STATUS[x.status];
            return (
              <View key={x.id} style={[styles.row, { borderColor: c.border }]}>
                <Row style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    {tab === 'approve' ? <Txt style={{ fontWeight: '700' }}>{people[x.userId]?.name}</Txt> : null}
                    <Txt style={{ fontWeight: tab === 'approve' ? '400' : '700' }}>
                      {x.endDate !== x.startDate ? t('timeOff.summary', { start: date(x.startDate), end: date(x.endDate) }) : date(x.startDate, 'long')}
                    </Txt>
                    {x.reason ? <Txt v="small" tone="muted">{x.reason}</Txt> : null}
                    {x.note ? <Txt v="small" tone="muted">{t('swaps.resolution', { text: x.note })}</Txt> : null}
                  </View>
                  <Badge tone={tone} text={t(label)} />
                </Row>
                {tab === 'mine' && ['pending', 'approved'].includes(x.status) && x.startDate > today ? (
                  <Button small kind="danger" title={t('timeOff.cancel')} busy={busy} onPress={() => run(() => client.call('timeOff.cancel', { id: x.id }), t('timeOff.cancelled_toast'))} style={{ alignSelf: 'flex-start' }} />
                ) : null}
                {tab === 'approve' ? (
                  <Row>
                    <Button small kind="danger" title={t('timeOff.deny')} busy={busy} onPress={() => run(() => client.call('timeOff.decide', { id: x.id, status: 'denied' }), t('timeOff.denied'))} style={{ flex: 1 }} />
                    <Button small kind="ok" title={t('timeOff.approve')} busy={busy} onPress={() => run(() => client.call('timeOff.decide', { id: x.id, status: 'approved' }), t('timeOff.approved'))} style={{ flex: 1 }} />
                  </Row>
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
