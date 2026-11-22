// Request time off: pick the days on a calendar, add a reason if you like, send.
import { router } from 'expo-router';
import { useState } from 'react';

import { DateRangePicker } from '@/components/DateRangePicker';
import { Screen } from '@/components/Screen';
import { Button, Card, Field, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { daysBetween } from '@/lib/time';

export default function RequestTimeOff() {
  const { t, tn, date } = useI18n();
  const { today, settings, client } = useApp();
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();

  const send = async () => {
    if (!start || !end) return;
    const r = await run(
      () => client.call<{ status: string; clashes: number }>('timeOff.create', { startDate: start, endDate: end, reason }),
      (x) => (x.clashes ? tn('timeOff.sentClashes', x.clashes) : t('timeOff.sent')),
    );
    if (r) router.back();
  };

  return (
    <Screen title={t('timeOff.request')} back bottomInset>
      <Card>
        <DateRangePicker start={start} end={end} min={today} weekStartDow={settings.weekStartDow} onChange={(a, b) => { setStart(a); setEnd(b); }} />
      </Card>
      {start && end ? (
        <Card style={{ gap: 4 }}>
          <Txt v="small" tone="muted" bold>{start === end ? t('timeOff.from') : `${t('timeOff.from')} – ${t('timeOff.to')}`}</Txt>
          <Txt v="h3">{start === end ? date(start, 'long') : t('timeOff.summary', { start: date(start), end: date(end) })}</Txt>
          <Txt v="small" tone="faint">{tn('common.days', daysBetween(start, end) + 1)}</Txt>
        </Card>
      ) : null}
      <Field label={t('timeOff.reason')} value={reason} onChangeText={setReason} placeholder={t('timeOff.reasonPlaceholder')} maxLength={200} />
      <Button kind="primary" icon="send" title={t('timeOff.submit')} busy={busy} disabled={!start || !end} onPress={send} />
    </Screen>
  );
}
