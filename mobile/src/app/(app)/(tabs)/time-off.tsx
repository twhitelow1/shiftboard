// Time off: my requests and their status, my availability, and (for shift leads and managers) requests to approve,
// with how many shifts the person has then and an optional note. A tab when the restaurant has no Training;
// otherwise opened from My Shifts and More, with a back button (src/navigation.ts).
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, Field, Loading, Row, Tabs, Txt, useColors, type Tone } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { ShiftsList, TimeOff } from '@/lib/types';
import { showTimeOffTab } from '@/navigation';

const STATUS: Record<TimeOff['status'], [MsgKey, Tone]> = {
  pending: ['timeOff.pending', 'warn'], approved: ['timeOff.approved', 'ok'], denied: ['timeOff.denied', 'bad'], cancelled: ['timeOff.cancelled', 'neutral'],
};

export default function TimeOffScreen() {
  const { t, date } = useI18n();
  const c = useColors();
  const { me, today, canApprove, people, has } = useApp();
  const { data, error, reload } = useRpc<TimeOff[]>('timeOff.list');
  const [tab, setTab] = useState<'mine' | 'approve' | null>(null);
  const toApprove = (data || []).filter((x) => x.status === 'pending' && x.userId !== me.id);
  const cur = tab || (canApprove && toApprove.length ? 'approve' : 'mine');
  const rows = cur === 'approve' ? toApprove : (data || []).filter((x) => x.userId === me.id);
  // Approvers: who has shifts during the days asked for.
  const span = toApprove.length ? { start: toApprove.map((x) => x.startDate).sort()[0], end: toApprove.map((x) => x.endDate).sort().pop()! } : null;
  const shifts = useRpc<ShiftsList>('shifts.list', span || {}, [], !!span && cur === 'approve');
  const clashes = (x: TimeOff) => (shifts.data?.shifts || []).filter((s) => s.userId === x.userId && s.date >= x.startDate && s.date <= x.endDate).length;

  return (
    <Screen title={t('timeOff.title')} back={!showTimeOffTab(has)} onRefresh={reload}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button kind="primary" icon="plus" title={t('timeOff.request')} onPress={() => router.push('/request-time-off')} style={{ flexGrow: 1 }} />
        <Button icon="clock" title={t('timeOff.availability')} onPress={() => router.push('/availability')} style={{ flexGrow: 1 }} />
      </Row>
      {canApprove ? (
        <Tabs value={cur} onChange={setTab} tabs={[{ value: 'mine', label: t('timeOff.mine') }, { value: 'approve', label: t('timeOff.toApprove'), count: toApprove.length }]} />
      ) : null}
      {!data && !error ? <Loading /> : null}
      {error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}
      {data && !rows.length ? (
        <Card><Empty icon="sun" title={cur === 'approve' ? t('timeOff.emptyApprove') : t('timeOff.empty')} body={cur === 'mine' ? t('timeOff.emptyBody') : undefined} /></Card>
      ) : null}
      {rows.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {rows.map((x) => (
            <RequestRow key={x.id} x={x} approving={cur === 'approve'} today={today} name={people[x.userId]?.name || ''}
              clashes={cur === 'approve' && shifts.data ? clashes(x) : null} border={c.border} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

function RequestRow({ x, approving, today, name, clashes, border }: { x: TimeOff; approving: boolean; today: string; name: string; clashes: number | null; border: string }) {
  const { t, tn, date } = useI18n();
  const { client } = useApp();
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const [label, tone] = STATUS[x.status];
  const decide = (status: 'approved' | 'denied') => run(() => client.call('timeOff.decide', { id: x.id, status, note }), t(status === 'approved' ? 'timeOff.approvedToast' : 'timeOff.deniedToast'));
  return (
    <View style={[styles.row, { borderColor: border }]}>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          {approving ? <Txt bold>{name}</Txt> : null}
          <Txt style={{ fontWeight: approving ? '400' : '700' }}>
            {x.endDate !== x.startDate ? t('timeOff.summary', { start: date(x.startDate), end: date(x.endDate) }) : date(x.startDate, 'long')}
          </Txt>
          {x.reason ? <Txt v="small" tone="muted">{x.reason}</Txt> : null}
          {x.note ? <Txt v="small" tone="muted">{t('swaps.resolution', { text: x.note })}</Txt> : null}
          {clashes ? <Txt v="small" tone="warn">{tn('timeOff.shiftsThen', clashes)}</Txt> : null}
        </View>
        <Badge tone={tone} text={t(label)} />
      </Row>
      {!approving && ['pending', 'approved'].includes(x.status) && x.startDate > today ? (
        <Button small kind="danger" title={t('timeOff.cancel')} busy={busy} onPress={() => run(() => client.call('timeOff.cancel', { id: x.id }), t('timeOff.cancelled_toast'))} style={{ alignSelf: 'flex-start' }} />
      ) : null}
      {approving ? (
        <>
          <Field label={t('timeOff.noteTo', { name: name.split(' ')[0] })} value={note} onChangeText={setNote} maxLength={300} />
          <Row>
            <Button small kind="danger" icon="x" title={t('timeOff.deny')} busy={busy} onPress={() => decide('denied')} style={{ flex: 1 }} />
            <Button small kind="ok" icon="check" title={t('timeOff.approve')} busy={busy} onPress={() => decide('approved')} style={{ flex: 1 }} />
          </Row>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
