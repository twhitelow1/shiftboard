// Time off: my requests and their status, my availability, and (for shift leads and managers) requests to approve,
// with how many shifts the person has then and an optional note. Shown by two routes (src/navigation.ts): the
// Time Off tab when the restaurant has no Training, otherwise the /my-time-off screen (with a back button) that
// My Shifts, More and the floor screen open. (A hidden tab can't be opened in Expo Router, so it's a screen.)
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from './Screen';
import { Badge, Button, Card, Empty, Field, Loading, Row, Tabs, Txt, useColors, type Tone } from './ui';
import { useI18n, type MsgKey } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { ShiftsList, TimeOff } from '@/lib/types';

/** When each request came in and its place in line (core/time-off.js timeOff.queue). */
interface QueueInfo { requestedAt: string | null; approx: boolean; source?: string; enteredByName?: string; place?: number; of?: number; date?: string; others?: { name: string; requestedAt: string | null; place: number }[] }
interface Scope { scope: { mode: string; timeOff?: boolean }; label: { en: string; es: string } }

const STATUS: Record<TimeOff['status'], [MsgKey, Tone]> = {
  pending: ['timeOff.pending', 'warn'], approved: ['timeOff.approved', 'ok'], denied: ['timeOff.denied', 'bad'], cancelled: ['timeOff.cancelled', 'neutral'],
};

export function TimeOffView({ asTab }: { asTab?: boolean }) {
  const { t, date } = useI18n();
  const c = useColors();
  const { me, today, canApprove, people } = useApp();
  const { data, error, reload } = useRpc<TimeOff[]>('timeOff.list');
  const queue = useRpc<Record<string, QueueInfo>>('timeOff.queue');
  const scope = useRpc<Scope>('approvalScope.get', {}, [], canApprove);
  const { lang } = useI18n();
  const [tab, setTab] = useState<'mine' | 'approve' | null>(null);
  // To approve: in my "Approves for" scope only, oldest request first.
  const at = (x: TimeOff) => queue.data?.[x.id]?.requestedAt || '9';
  const toApprove = (data || []).filter((x) => x.status === 'pending' && x.userId !== me.id && !(x as TimeOff & { outOfScope?: boolean }).outOfScope).sort((a, b) => at(a).localeCompare(at(b)));
  const cur = tab || (canApprove && toApprove.length ? 'approve' : 'mine');
  const rows = cur === 'approve' ? toApprove : (data || []).filter((x) => x.userId === me.id);
  // Approvers: who has shifts during the days asked for.
  const span = toApprove.length ? { start: toApprove.map((x) => x.startDate).sort()[0], end: toApprove.map((x) => x.endDate).sort().pop()! } : null;
  const shifts = useRpc<ShiftsList>('shifts.list', span || {}, [], !!span && cur === 'approve');
  const clashes = (x: TimeOff) => (shifts.data?.shifts || []).filter((s) => s.userId === x.userId && s.date >= x.startDate && s.date <= x.endDate).length;

  return (
    <Screen title={t('timeOff.title')} back={!asTab} bottomInset={!asTab} onRefresh={reload}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button kind="primary" icon="plus" title={t('timeOff.request')} onPress={() => router.push('/request-time-off')} style={{ flexGrow: 1 }} />
        <Button icon="clock" title={t('timeOff.availability')} onPress={() => router.push('/availability')} style={{ flexGrow: 1 }} />
      </Row>
      {canApprove ? <Button icon="user" title={t('timeOffAdd.button')} onPress={() => router.push({ pathname: '/request-time-off', params: { for: '1' } })} /> : null}
      {canApprove && cur === 'approve' && scope.data && !(scope.data.scope.mode === 'all' || scope.data.scope.timeOff === false) ? (
        <Txt v="small" tone="muted">{t('scope.youApprove', { scope: lang === 'es' ? scope.data.label.es : scope.data.label.en })} {t('scope.elsewhere')}</Txt>
      ) : null}
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
            <RequestRow key={x.id} x={x} q={queue.data?.[x.id]} approving={cur === 'approve'} today={today} name={people[x.userId]?.name || ''}
              clashes={cur === 'approve' && shifts.data ? clashes(x) : null} border={c.border} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

function RequestRow({ x, q, approving, today, name, clashes, border }: { x: TimeOff; q?: QueueInfo; approving: boolean; today: string; name: string; clashes: number | null; border: string }) {
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
          {q ? <Requested q={q} mine={!approving} /> : null}
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

/** "Requested Nov 3, 4:12 PM" · "Added by Moe · by email on Nov 3" · "#1 of 3 for Sat, Dec 13". */
function Requested({ q, mine }: { q: QueueInfo; mine: boolean }) {
  const { t, date } = useI18n();
  const when = q.requestedAt ? `${date(q.requestedAt.slice(0, 10))} ${new Date(q.requestedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '—';
  const how = q.source && q.source !== 'app' ? t(`timeOffQueue.src_${q.source}` as 'timeOffQueue.src_other') : t('timeOffQueue.src_other');
  return (
    <View style={{ gap: 2 }}>
      <Txt v="small" tone="faint">{q.enteredByName ? t('timeOffQueue.addedBy', { name: q.enteredByName, how, when }) : t('timeOffQueue.requested', { when })}{q.approx ? ` ${t('timeOffQueue.approx')}` : ''}</Txt>
      {q.place && q.of && q.date ? (
        <Badge tone={q.place === 1 ? 'ok' : 'warn'} text={t(mine ? 'timeOffQueue.yourPlace' : 'timeOffQueue.place', { place: t('timeOffQueue.ord', { n: q.place }), of: q.of, date: date(q.date) })} />
      ) : null}
      {q.others?.length ? <Txt v="small" tone="faint">{t('timeOffQueue.others', { list: q.others.map((o) => `${t('timeOffQueue.ord', { n: o.place })} ${o.name}`).join(', ') })}</Txt> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
