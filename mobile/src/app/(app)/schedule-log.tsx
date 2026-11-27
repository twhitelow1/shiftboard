// The schedule log on the phone (core/schedule-log.js): managers see every change (filter by what), everyone else
// "My schedule changes": only what affected them. Each row is the sentence the server writes, with when and how.
import { useState } from 'react';

import { Screen } from '@/components/Screen';
import { Badge, Card, Empty, Loading, Segmented, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

type Group = '' | 'shift' | 'request' | 'timeOff';
interface Row { id: string; at: string; via: string; text: string }

export default function ScheduleLog() {
  const { t, date } = useI18n();
  const { isMgr } = useApp();
  const [group, setGroup] = useState<Group>('');
  const list = useRpc<Row[]>(isMgr ? 'scheduleLog.list' : 'scheduleLog.mine', isMgr ? { group, limit: 100 } : {}, [group]);
  return (
    <Screen title={isMgr ? t('schedLog.title') : t('schedLog.mineTitle')} back bottomInset onRefresh={list.reload}>
      <Txt v="small" tone="muted">{isMgr ? t('schedLog.help') : t('schedLog.mineHelp')}</Txt>
      {isMgr ? (
        <Segmented value={group} onChange={setGroup} options={[
          { value: '', label: t('schedLog.all') }, { value: 'shift', label: t('schedLog.shift') },
          { value: 'request', label: t('schedLog.request') }, { value: 'timeOff', label: t('schedLog.timeOff') },
        ]} />
      ) : null}
      {!list.data ? <Loading /> : !list.data.length ? <Card><Empty icon="clock" title={t('schedLog.empty')} /></Card> : list.data.map((r) => (
        <Card key={r.id} style={{ gap: 4 }}>
          <Txt>{r.text}</Txt>
          <Txt v="small" tone="faint">{date(r.at.slice(0, 10))} {new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Txt>
          <Badge text={t(`schedLog.via_${r.via}` as 'schedLog.via_web')} />
        </Card>
      ))}
    </Screen>
  );
}
