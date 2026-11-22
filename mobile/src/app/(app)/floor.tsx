// Today on the floor, for shift leads and managers: who's working now (and who's coming in later), requests to
// approve, the 86 List, and (managers) publishing a drafted week, with a confirmation. Building and editing the
// schedule stays on the website; a button opens it. "Now" is the phone's clock on the restaurant's date.
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ModCard } from '@/components/ModCard';
import { Screen } from '@/components/Screen';
import { useShiftTime } from '@/components/ShiftRow';
import { Badge, Button, Card, Empty, JobDot, ListRow, Loading, Row, SectionTitle, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { confirm } from '@/lib/confirm';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { absNow, addDays, effectiveShift, shiftSpan, weekStart } from '@/lib/time';
import type { EightySixSummary, Shift, ShiftsList, SwapsList, TimeOff } from '@/lib/types';

/** Ticks every minute so "working now" stays current while the screen is open. */
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id); }, []);
  return now;
}

export default function Floor() {
  const { t, tn, date, time } = useI18n();
  const c = useColors();
  const { me, today, settings, jobs, people, has, isMgr, canApprove, client, server } = useApp();
  const shiftTime = useShiftTime();
  const now = useMinute();
  const [run, busy] = useAction();
  const yesterday = addDays(today, -1);
  const day = useRpc<ShiftsList>('shifts.list', { start: yesterday, end: today });
  const swaps = useRpc<SwapsList>('swaps.list', {}, [], canApprove);
  const timeOff = useRpc<TimeOff[]>('timeOff.list', {}, [], canApprove);
  const e86 = useRpc<EightySixSummary>('eightySix.summary', {}, [], has('eightySix'));
  const thisWeek = weekStart(today, settings.weekStartDow);
  const weeks = useRpc<ShiftsList>('shifts.list', { start: thisWeek, end: addDays(thisWeek, 13) }, [], isMgr);

  // Who's on: posted shifts from today (and last night's, which can run past midnight) that have started and
  // haven't ended ("until close" ends are estimated, like the server's manager on duty).
  const t0 = absNow(today, now);
  const posted = (day.data?.shifts || []).filter((s) => s.published && s.userId);
  const span = (s: Shift) => shiftSpan(effectiveShift(s, settings));
  const onNow = posted.filter((s) => { const [a, b] = span(s); return a <= t0 && t0 < b; }).sort((a, b) => span(b)[1] - span(a)[1] || (people[a.userId!]?.name || '').localeCompare(people[b.userId!]?.name || ''));
  const later = posted.filter((s) => s.date === today && span(s)[0] > t0).sort((a, b) => a.start.localeCompare(b.start));
  const byJob = (list: Shift[]) => {
    const m = new Map<string, Shift[]>();
    for (const s of list) m.set(s.jobCodeId, [...(m.get(s.jobCodeId) || []), s]);
    return [...m.entries()].sort((a, b) => (jobs[a[0]]?.order ?? 0) - (jobs[b[0]]?.order ?? 0));
  };

  const trades = swaps.data?.approvals.length || 0;
  const offs = (timeOff.data || []).filter((x) => x.status === 'pending' && x.userId !== me.id).length;
  const drafts = [thisWeek, addDays(thisWeek, 7)].map((w) => ({ w, n: (weeks.data?.shifts || []).filter((s) => !s.published && s.date >= w && s.date <= addDays(w, 6) && s.date >= today).length }))
    .filter((x) => x.n > 0);
  const publish = async (w: string, n: number) => {
    const ok = await confirm(t('floor.publishTitle', { date: date(w, 'dayMonth') }), tn('floor.publishBody', n), t('floor.publishYes'), t('common.cancel'));
    if (!ok) return;
    await run(() => client.call<{ published: number }>('shifts.publish', { start: w, end: addDays(w, 6) }), (r) => tn('floor.published', r.published));
  };
  const person = (s: Shift) => {
    const eff = effectiveShift(s, settings);
    return (
      <View key={s.id} style={[styles.person, { borderColor: c.border }]} accessible
        accessibilityLabel={`${people[s.userId!]?.name || ''}, ${jobs[s.jobCodeId]?.name || ''}, ${shiftTime(s)}`}>
        <Txt bold style={{ flex: 1 }} lines={1}>{people[s.userId!]?.name || '—'}</Txt>
        <Txt v="small" tone="muted">{s.date !== today ? `${date(s.date, 'weekday')} ` : ''}{shiftTime(s)}{!s.end && eff.end ? ` (~${time(eff.end)})` : ''}</Txt>
      </View>
    );
  };

  return (
    <Screen title={t('floor.title')} back bottomInset onRefresh={() => Promise.all([day.reload(), swaps.reload(), timeOff.reload(), e86.reload(), weeks.reload()])}>
      {has('training') ? <ModCard /> : null}

      <SectionTitle title={t('floor.workingNow')} right={onNow.length ? <Badge tone="ok" text={String(onNow.length)} /> : undefined} />
      {!day.data ? <Loading /> : !onNow.length ? <Card><Empty icon="users" title={t('floor.nobodyNow')} /></Card> : (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          <View style={{ paddingHorizontal: 14, paddingTop: 12 }}><Txt v="small" tone="muted">{tn('floor.workingCount', onNow.length)}</Txt></View>
          {byJob(onNow).map(([jobId, list]) => (
            <View key={jobId}>
              <Row style={styles.jobHead}><JobDot color={jobs[jobId]?.color} /><Txt v="small" tone="muted" bold>{jobs[jobId]?.name}</Txt></Row>
              {list.map(person)}
            </View>
          ))}
        </Card>
      )}
      {later.length ? (
        <>
          <SectionTitle title={t('floor.later')} right={<Badge text={String(later.length)} />} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {byJob(later).map(([jobId, list]) => (
              <View key={jobId}>
                <Row style={styles.jobHead}><JobDot color={jobs[jobId]?.color} /><Txt v="small" tone="muted" bold>{jobs[jobId]?.name}</Txt></Row>
                {list.map(person)}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {canApprove ? (
        <>
          <SectionTitle title={t('floor.approvals')} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {!trades && !offs ? <ListRow icon="check" title={t('floor.nothingToApprove')} /> : null}
            {trades ? <ListRow icon="swap" title={tn('floor.trades', trades)} onPress={() => router.push('/swaps')} right={<Badge tone="warn" text={t('floor.review')} />} /> : null}
            {offs ? <ListRow icon="sun" title={tn('floor.timeOff', offs)} onPress={() => router.push('/time-off')} right={<Badge tone="warn" text={t('floor.review')} />} /> : null}
          </Card>
        </>
      ) : null}

      {has('eightySix') ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          <ListRow icon="ban" title={t('more.eightySix')} sub={t('floor.eightySixHelp')} onPress={() => router.push('/eighty-six')}
            right={e86.data && (e86.data.out || e86.data.low) ? <Badge tone="bad" text={[e86.data.out ? tn('eightySix.nOut', e86.data.out) : '', e86.data.low ? tn('eightySix.nLow', e86.data.low) : ''].filter(Boolean).join(' · ')} /> : null} />
        </Card>
      ) : null}

      {isMgr ? (
        <>
          <SectionTitle title={t('floor.publish')} />
          {!weeks.data ? <Loading /> : !drafts.length ? <Card><Txt tone="muted">{t('floor.noDrafts')}</Txt></Card> : drafts.map((x) => (
            <Card key={x.w} style={{ gap: 10 }}>
              <Txt bold>{tn('floor.drafts', x.n, { date: date(x.w, 'dayMonth') })}</Txt>
              <Button kind="primary" icon="send" title={t('floor.publishWeek', { date: date(x.w, 'dayMonth') })} busy={busy} onPress={() => publish(x.w, x.n)} />
            </Card>
          ))}
          <Card style={{ gap: 8 }}>
            <Txt bold>{t('floor.buildOnWeb')}</Txt>
            <Txt v="small" tone="muted">{t('floor.buildOnWebHelp')}</Txt>
            <Button icon="external" title={t('common.openWebsite')} onPress={() => WebBrowser.openBrowserAsync(`${server}/#/schedule`).catch(() => {})} style={{ alignSelf: 'flex-start' }} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  jobHead: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth },
});
