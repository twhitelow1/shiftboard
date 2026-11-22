// The team's posted schedule. Day view: one day at a time, grouped like the website's day view (area banner,
// then each position, by start time). Week view: the whole week, a row per person, scrolling sideways.
// Both show projected covers (forecast.covers) when the restaurant has forecasting. The last week seen is kept
// on the phone for when there's no signal.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { useShiftTime } from '@/components/ShiftRow';
import { WeekGrid } from '@/components/WeekGrid';
import { Badge, Button, Card, Empty, JobDot, Loading, Notice, OfflineNote, Row, Segmented, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { canTrade, daySections } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { addDays, dow, range, weekStart } from '@/lib/time';
import type { CoversWeek, Shift, ShiftsList } from '@/lib/types';

export default function Schedule() {
  const { t, date, time, num, stamp } = useI18n();
  const c = useColors();
  const params = useLocalSearchParams<{ date?: string }>();
  const { me, today, settings, jobs, people, has, offlineSince, boot } = useApp();
  const shiftTime = useShiftTime();
  const [ws, setWs] = useState(() => weekStart(params.date || today, settings.weekStartDow));
  const days = range(ws, 7);
  const inWeek = (d: string) => d >= ws && d <= addDays(ws, 6);
  const firstOpen = () => days.find((d) => !settings.closedDays.includes(dow(d))) || ws;
  const [day, setDay] = useState(() => (params.date && inWeek(params.date) ? params.date : inWeek(today) ? today : firstOpen()));
  const [mine, setMine] = useState<'all' | 'me'>('all');
  const [view, setView] = useState<'day' | 'week'>('day');
  useEffect(() => { if (!inWeek(day)) setDay(inWeek(today) ? today : firstOpen()); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!params.date) return;
    setWs(weekStart(params.date, settings.weekStartDow));
    setDay(params.date);
    setView('day');
  }, [params.date]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, reload, offline, updatedAt } = useRpc<ShiftsList>('shifts.list', { start: ws, end: addDays(ws, 6) }, [ws], true, { cache: `schedule-${ws}` });
  const coversQ = useRpc<CoversWeek>('forecast.covers', { weekStart: ws }, [ws], has('forecast'));
  const covers = useMemo(() => Object.fromEntries((coversQ.data?.days || []).filter((d) => d.totalCovers > 0).map((d) => [d.date, d.totalCovers])), [coversQ.data]);
  const weekShifts = useMemo(() => (data?.shifts || []).filter((s) => s.published && (mine === 'all' || s.userId === me.id)), [data, mine, me.id]);
  const shifts = useMemo(() => weekShifts.filter((s) => s.date === day), [weekShifts, day]);
  const sections = useMemo(() => daySections(shifts, jobs, settings, boot.layout), [shifts, jobs, settings, boot.layout]);
  const closed = settings.closedDays.includes(dow(day));
  const events = (data?.events || []).filter((e) => e.date === day);
  const notes = (data?.notes || []).filter((n) => (n.kind === 'day' && n.date === day) || (view === 'week' && n.kind === 'week' && n.date === ws));
  const off = (data?.timeOff || []).filter((x) => x.status === 'approved' && x.startDate <= day && x.endDate >= day).map((x) => people[x.userId]?.name).filter(Boolean);
  const open = (s: Shift) => router.push({ pathname: '/shift/[id]', params: { id: s.id, date: s.date } });
  const thisWeek = weekStart(today, settings.weekStartDow);

  return (
    <Screen title={t('schedule.title')} onRefresh={() => Promise.all([reload(), coversQ.reload()])}>
      {offline && updatedAt && !offlineSince ? <OfflineNote text={t('common.offline', { when: stamp(updatedAt) })} /> : null}
      <Row>
        <Pressable onPress={() => setWs(addDays(ws, -7))} style={styles.arrow} accessibilityRole="button" accessibilityLabel={t('schedule.prevWeek')}><Icon name="left" color={c.text} /></Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" style={{ textAlign: 'center' }}>{date(ws, 'dayMonth')} – {date(addDays(ws, 6), 'dayMonth')}</Txt>
          {ws !== thisWeek ? (
            <Pressable onPress={() => { setWs(thisWeek); setDay(today); }} accessibilityRole="button" hitSlop={8} style={{ minHeight: 28, justifyContent: 'center' }}>
              <Txt v="small" tone="brand" bold>{t('schedule.today')}</Txt>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={() => setWs(addDays(ws, 7))} style={styles.arrow} accessibilityRole="button" accessibilityLabel={t('schedule.nextWeek')}><Icon name="right" color={c.text} /></Pressable>
      </Row>
      <View style={styles.toggles}>
        <View style={{ flex: 1 }}><Segmented value={view} onChange={setView} options={[{ value: 'day', label: t('schedule.day') }, { value: 'week', label: t('schedule.week') }]} /></View>
        <View style={{ flex: 1 }}><Segmented value={mine} onChange={setMine} options={[{ value: 'all', label: t('schedule.everyone') }, { value: 'me', label: t('schedule.justMe') }]} /></View>
      </View>

      {!data && !error ? <Loading /> : null}
      {error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}

      {view === 'week' && data ? (
        <>
          {notes.map((n) => <Notice key={n.id} tone="brand" icon="alert" text={n.text} />)}
          {weekShifts.length ? (
            <>
              <WeekGrid days={days} shifts={weekShifts} covers={covers} onShift={open} onDay={(d) => { setDay(d); setView('day'); }} />
              <Txt v="small" tone="faint">{t('schedule.scrollHint')}</Txt>
            </>
          ) : <Card><Empty title={mine === 'me' ? t('schedule.youreOff') : t('schedule.noShifts')} /></Card>}
        </>
      ) : null}

      {view === 'day' ? (
        <>
          <View style={styles.strip}>
            {days.map((d) => {
              const on = d === day;
              const working = (data?.shifts || []).some((s) => s.date === d && s.userId === me.id && s.published);
              return (
                <Pressable key={d} onPress={() => setDay(d)} accessibilityRole="button" accessibilityState={{ selected: on }}
                  accessibilityLabel={`${date(d, 'long')}${covers[d] ? `, ${t('schedule.covers', { count: num(covers[d]!) })}` : ''}`}
                  style={[styles.day, { backgroundColor: on ? c.brand : c.surface, borderColor: on ? c.brand : c.border, opacity: settings.closedDays.includes(dow(d)) ? 0.5 : 1 }]}>
                  <Txt v="tiny" tone={on ? 'onBrand' : 'muted'} bold>{date(d, 'weekday')}</Txt>
                  <Txt v="h3" tone={on ? 'onBrand' : d === today ? 'brand' : 'text'}>{date(d, 'day')}</Txt>
                  <View style={[styles.workDot, { backgroundColor: working ? (on ? c.onBrand : c.brand) : 'transparent' }]} />
                </Pressable>
              );
            })}
          </View>
          <View style={{ gap: 2 }}>
            <Txt v="h3">{date(day, 'long')}</Txt>
            {covers[day] ? <Txt v="small" tone="muted">{t('schedule.projected')}: ~{num(covers[day]!)}</Txt> : null}
          </View>

          {events.map((e) => (
            <Pressable key={e.id} disabled={!has('events')} onPress={() => router.push({ pathname: '/events/[id]', params: { id: e.id } })} accessibilityRole={has('events') ? 'button' : undefined}>
              <Notice tone="warn" icon="glass" text={`${e.name} · ${time(e.start)}${e.room ? ` · ${e.room}` : ''}${e.guestCount ? ` · ${t('schedule.guests', { count: e.guestCount })}` : ''}`} />
            </Pressable>
          ))}
          {notes.map((n) => <Notice key={n.id} tone="brand" icon="alert" text={n.text} />)}
          {data && closed ? <Card><Empty title={t('schedule.closed')} /></Card> : null}
          {data && !closed && !sections.length ? <Card><Empty title={mine === 'me' ? t('schedule.youreOff') : t('schedule.noShifts')} /></Card> : null}

          {sections.map((sec, i) => (
            <View key={sec.key} style={{ gap: 6 }}>
              {sec.banner && sec.banner !== sections[i - 1]?.banner ? (
                <View style={[styles.banner, { backgroundColor: c.surface2, borderColor: c.border }]}><Txt v="small" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{sec.banner}</Txt></View>
              ) : null}
              <Row style={{ paddingHorizontal: 4 }}>
                <JobDot color={sec.job.color} />
                <Txt v="small" tone="muted" bold style={{ flex: 1 }}>{sec.job.name}</Txt>
                <Txt v="small" tone="faint">{sec.shifts.length}</Txt>
              </Row>
              <Card pad={false} style={{ overflow: 'hidden' }}>
                {sec.shifts.map((s) => {
                  const isMe = s.userId === me.id;
                  return (
                    <Pressable key={s.id} onPress={() => open(s)} accessibilityRole="button"
                      accessibilityLabel={`${s.userId ? people[s.userId]?.name || '' : t('schedule.openShift')}, ${shiftTime(s)}`}
                      style={({ pressed }) => [styles.shift, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : isMe ? c.brandSoft : 'transparent', borderLeftColor: jobs[s.jobCodeId]?.color || c.border }]}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Txt style={{ fontWeight: '700' }} lines={1}>{s.userId ? people[s.userId]?.name || '—' : t('schedule.openShift')}{isMe ? ` (${t('schedule.you')})` : ''}</Txt>
                        {s.area || s.tag ? <Txt v="small" tone="muted">{[s.area, s.tag].filter(Boolean).join(' · ')}</Txt> : null}
                      </View>
                      <Txt style={{ fontWeight: '700' }}>{shiftTime(s)}</Txt>
                      {s.pending ? <Badge tone="warn" text={t('myShifts.pending')} /> : canTrade(s, me.id, today) ? <Badge tone="brand" text={t('myShifts.trade')} /> : !s.userId ? <Badge tone="ok" text={t('myShifts.pickUp')} /> : null}
                    </Pressable>
                  );
                })}
              </Card>
            </View>
          ))}
          {mine === 'all' && off.length > 0 ? <Txt v="small" tone="muted">{t('schedule.off', { names: off.join(', ') })}</Txt> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  strip: { flexDirection: 'row', gap: 3 },
  toggles: { flexDirection: 'row', gap: 8 },
  day: { flex: 1, minHeight: 60, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, gap: 1 },
  workDot: { width: 6, height: 6, borderRadius: 3 },
  banner: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6, marginTop: 8 },
  shift: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4 },
});
