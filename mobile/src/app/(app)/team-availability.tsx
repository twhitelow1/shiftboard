// Team availability (read only): everyone's week, for managers (and supervisors for employees when Roles & features
// turns on "Edit staff availability"), from availability.team.get (core/availability-team.js), like Time Off →
// Availability → Team on the website. Each person: name, positions and primary room, then each weekday: standing
// request off, unavailable, some hours or open, with the day's note. Filters: search, room, only standing requests off.
// Tapping a person opens their availability (edit there when allowed). The sheet view is on the website (a link).
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, Chips, Empty, Field, Loading, Notice, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

type Status = 'standing' | 'off' | 'partial' | 'open';
interface TeamDay { date: string; dow: number; status: Status; from: string; to: string; note: string; timeOff?: { status: 'approved' | 'pending' } }
interface TeamPerson { id: string; name: string; room: string; positions: { jobCodeId: string; name: string }[]; days: TeamDay[]; notes: string }
interface TeamAnswer { weekStart: string; dates: string[]; rooms: { room: string }[]; people: TeamPerson[] }

export default function TeamAvailability() {
  const { t, date, time } = useI18n();
  const c = useColors();
  const { server } = useApp();
  const got = useRpc<TeamAnswer>('availability.team.get');
  const [q, setQ] = useState('');
  const [room, setRoom] = useState('');
  const [only, setOnly] = useState(false);
  const rows = useMemo(() => (got.data?.people || []).filter((p) => (!room || p.room === room)
    && (!q || p.name.toLowerCase().includes(q.trim().toLowerCase())) && (!only || p.days.some((d) => d.status === 'standing'))), [got.data, q, room, only]);
  const label = (d: TeamDay) => (d.status === 'standing' ? t('teamAvail.standing') : d.status === 'off' ? t('teamAvail.off')
    : d.status === 'partial' ? (d.from && d.to ? `${time(d.from)}–${time(d.to)}` : d.from ? t('teamAvail.after', { time: time(d.from) }) : t('teamAvail.until', { time: time(d.to) }))
      : t('teamAvail.open'));
  const tone = (s: Status) => (s === 'standing' ? { bg: c.okSoft, fg: c.ok } : s === 'off' ? { bg: c.surface2, fg: c.text } : s === 'partial' ? { bg: c.brandSoft, fg: c.brand } : { bg: 'transparent', fg: c.text3 });
  const sheet = () => { const url = `${server}/#/timeoff/availability/sheet`; WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url)); };
  const counts = (got.data?.dates || []).map((_, i) => rows.filter((p) => p.days[i]?.status === 'standing').length);

  return (
    <Screen title={t('teamAvail.title')} back bottomInset>
      <Txt v="small" tone="muted">{t('teamAvail.help')}</Txt>
      <Button icon="external" title={t('teamAvail.openSheet')} onPress={sheet} />
      {got.error ? <Notice tone="bad" text={t('teamAvail.cantSee')} /> : !got.data ? <Loading /> : (
        <>
          <Txt v="small" bold>{t('teamAvail.weekOf', { date: date(got.data.weekStart) })}</Txt>
          <Field label={t('teamAvail.search')} value={q} onChangeText={setQ} autoCorrect={false} />
          {got.data.rooms.length ? (
            <Chips single value={[room || '*']} onChange={(v) => setRoom(v[0] && v[0] !== '*' ? v[0] : '')} label={t('teamAvail.room')}
              options={[{ value: '*', label: t('teamAvail.allRooms') }, ...got.data.rooms.map((r) => ({ value: r.room, label: r.room }))]} />
          ) : null}
          <Chips value={only ? ['standing'] : []} onChange={(v) => setOnly(v.includes('standing'))} label={t('teamAvail.onlyStanding')}
            options={[{ value: 'standing', label: t('teamAvail.onlyStanding') }]} />
          <Card style={{ gap: 6 }}>
            <Txt v="small" bold>{t('teamAvail.standingPerDay')}</Txt>
            <View style={styles.week}>
              {got.data.dates.map((d, i) => (
                <View key={d} style={styles.cell}><Txt v="small" tone="muted" style={{ textTransform: 'capitalize' }}>{date(d, 'weekday')}</Txt><Txt bold>{String(counts[i])}</Txt></View>
              ))}
            </View>
          </Card>
          {!rows.length ? <Card><Empty icon="users" title={t('teamAvail.none')} /></Card> : rows.map((p) => (
            <Pressable key={p.id} onPress={() => router.push({ pathname: '/availability', params: { userId: p.id } })} accessibilityRole="button" accessibilityLabel={p.name}>
              <Card style={{ gap: 6 }}>
                <Txt bold>{p.name}</Txt>
                <Txt v="small" tone="muted">{[p.positions.map((x) => x.name).join(', '), p.room].filter(Boolean).join(' · ')}</Txt>
                <View style={styles.week}>
                  {p.days.map((d) => {
                    const k = tone(d.status);
                    return (
                      <View key={d.date} style={styles.cell} accessibilityLabel={`${date(d.date, 'weekdayLong')}: ${label(d)}${d.note ? `, ${d.note}` : ''}`}>
                        <Txt v="small" tone="muted" style={{ textTransform: 'capitalize' }}>{date(d.date, 'weekday')}</Txt>
                        <View style={[styles.chip, { backgroundColor: k.bg }]}><Txt v="small" bold style={{ color: k.fg, fontSize: 11, textAlign: 'center' }}>{label(d)}</Txt></View>
                        {d.timeOff ? <Txt v="small" tone="warn" style={{ fontSize: 10, textAlign: 'center' }}>{d.timeOff.status === 'pending' ? t('teamAvail.timeOffPending') : t('teamAvail.timeOff')}</Txt> : null}
                      </View>
                    );
                  })}
                </View>
                {p.days.filter((d) => d.note).map((d) => (
                  <Txt key={d.date} v="small" tone="muted"><Txt v="small" bold style={{ textTransform: 'capitalize' }}>{date(d.date, 'weekday')}</Txt>: {d.note}</Txt>
                ))}
                {p.notes ? <Txt v="small" tone="faint">{p.notes}</Txt> : null}
              </Card>
            </Pressable>
          ))}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  week: { flexDirection: 'row', gap: 2 },
  cell: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2 },
  chip: { borderRadius: 8, paddingHorizontal: 2, paddingVertical: 2, alignSelf: 'stretch' },
});
