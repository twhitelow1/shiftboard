// Request time off: pick the days on a calendar, add a reason if you like, send. With ?for=1 (shift leads and managers):
// time off for someone else that came in by email, a text, a call…: who, how it came in, when they asked (never in the
// future), approved or pending, and whether to tell them. Shifts they have then are never removed (timeOff.create).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { DateRangePicker } from '@/components/DateRangePicker';
import { Screen } from '@/components/Screen';
import { Button, Card, Chips, Field, Notice, Segmented, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { daysBetween } from '@/lib/time';

const SOURCES = ['email', 'text', 'phone', 'in_person', 'other'] as const;

export default function RequestTimeOff() {
  const { t, tn, date } = useI18n();
  const { today, settings, client, people, me, canApprove } = useApp();
  const params = useLocalSearchParams<{ for?: string; userId?: string }>();
  const forOther = canApprove && (params.for === '1' || !!params.userId);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [who, setWho] = useState<string>(params.userId || '');
  const [source, setSource] = useState<string>('email');
  const [requestedOn, setRequestedOn] = useState(today);
  const [status, setStatus] = useState<'approved' | 'pending'>('approved');
  const [notify, setNotify] = useState<'yes' | 'no'>('yes');
  const [run, busy] = useAction();
  const [clashes, setClashes] = useState(0);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(requestedOn) && requestedOn <= today;

  const send = async () => {
    if (!start || !end) return;
    if (forOther) {
      const r = await run(
        () => client.call<{ clashShifts?: unknown[] }>('timeOff.create', { userId: who, startDate: start, endDate: end, reason, source, requestedAt: requestedOn, status, notify: notify === 'yes' }),
        t('timeOffAdd.added'),
      );
      if (r && r.clashShifts?.length) { setClashes(r.clashShifts.length); return; }
      if (r) router.back();
      return;
    }
    const r = await run(
      () => client.call<{ status: string; clashes: number }>('timeOff.create', { startDate: start, endDate: end, reason }),
      (x) => (x.clashes ? tn('timeOff.sentClashes', x.clashes) : t('timeOff.sent')),
    );
    if (r) router.back();
  };

  const choices = Object.values(people).filter((p) => p.active !== false && p.id !== me.id).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Screen title={forOther ? t('timeOffAdd.title') : t('timeOff.request')} back bottomInset>
      {forOther ? (
        <Card style={{ gap: 6 }}>
          <Txt v="small" tone="muted" bold>{t('timeOffAdd.person')}</Txt>
          <Chips single value={who ? [who] : []} onChange={(v) => setWho(v[0] || '')} label={t('timeOffAdd.person')} options={choices.map((p) => ({ value: p.id, label: p.name }))} />
        </Card>
      ) : null}
      <Card>
        <DateRangePicker start={start} end={end} min={forOther ? '2000-01-01' : today} weekStartDow={settings.weekStartDow} onChange={(a, b) => { setStart(a); setEnd(b); }} />
      </Card>
      {start && end ? (
        <Card style={{ gap: 4 }}>
          <Txt v="small" tone="muted" bold>{start === end ? t('timeOff.from') : `${t('timeOff.from')} – ${t('timeOff.to')}`}</Txt>
          <Txt v="h3">{start === end ? date(start, 'long') : t('timeOff.summary', { start: date(start), end: date(end) })}</Txt>
          <Txt v="small" tone="faint">{tn('common.days', daysBetween(start, end) + 1)}</Txt>
        </Card>
      ) : null}
      <Field label={t('timeOff.reason')} value={reason} onChangeText={setReason} placeholder={t('timeOff.reasonPlaceholder')} maxLength={200} />
      {forOther ? (
        <Card style={{ gap: 10 }}>
          <Txt v="small" tone="muted" bold>{t('timeOffAdd.cameIn')}</Txt>
          <Chips single value={[source]} onChange={(v) => v[0] && setSource(v[0])} label={t('timeOffAdd.cameIn')}
            options={SOURCES.map((s) => ({ value: s, label: t(`timeOffQueue.src_${s}` as 'timeOffQueue.src_other') }))} />
          <Field label={t('timeOffAdd.requestedOn')} value={requestedOn} onChangeText={setRequestedOn} maxLength={10} />
          <Segmented value={status} onChange={setStatus} options={[{ value: 'approved', label: t('timeOffAdd.approved') }, { value: 'pending', label: t('timeOffAdd.pending') }]} />
          <Segmented value={notify} onChange={setNotify} options={[{ value: 'yes', label: t('timeOffAdd.notifyOn') }, { value: 'no', label: t('timeOffAdd.notifyOff') }]} />
        </Card>
      ) : null}
      {clashes ? <Notice tone="warn" icon="alert" text={tn('timeOffAdd.clashes', clashes)} /> : null}
      {clashes ? <Button title={t('common.done')} onPress={() => router.back()} /> : (
        <Button kind="primary" icon="send" title={forOther ? t('timeOffAdd.add') : t('timeOff.submit')} busy={busy}
          disabled={!start || !end || (forOther && (!who || !valid))} onPress={send} />
      )}
    </Screen>
  );
}
