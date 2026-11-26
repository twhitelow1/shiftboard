// One event's BEO, read only: when and where, guests, your shift on it, the details it has, staffing (who's on
// it), then everything the BEO says by section (lib/beo.ts: timeline, menu, dietary, bar, setup… only the ones
// with something in them; dietary stands out) and the team thread.
// Only what events.get returns. The client's contact details are for the events team: the server leaves out
// their phone and email for everyone else, and the app shows the contact only to the events team.
// Editing, printing and posting to the thread are on the website.
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, View } from 'react-native';

import { useShiftTime } from '@/components/ShiftRow';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, JobDot, Loading, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { isStatus, isStyle, STATUS_TONE } from '@/lib/events';
import { eventSections, isLabelKey, isSectionKey, PRIVATE, type BeoSection, type KeyValueItem, type MenuItem, type TimelineItem } from '@/lib/beo';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { EventDetail } from '@/lib/types';

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tn, date, time, stamp } = useI18n();
  const c = useColors();
  const errorText = useErrorText();
  const { me, jobs, people, isEvents, server } = useApp();
  const shiftTime = useShiftTime();
  const { data: e, error, reload } = useRpc<EventDetail>('events.get', { id }, [id]);
  if (!e) {
    return (
      <Screen title={t('events.title')} back bottomInset>
        {error ? <Empty icon="alert" title={errorText(error)}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />}
      </Screen>
    );
  }
  const mine = e.shifts.find((s) => s.userId === me.id);
  const captain = e.captainId ? people[e.captainId] : null;
  const details: [string, string][] = ([
    [t('events.type'), e.type || ''],
    [t('events.service'), isStyle(e.serviceStyle) ? t(`events.style.${e.serviceStyle}`) : e.serviceStyle || ''],
    [t('events.captain'), captain?.name || ''],
    [t('events.attire'), e.attire || ''],
    [t('events.areas'), e.areas && e.areas.trim().toLowerCase() !== (e.room || '').trim().toLowerCase() ? e.areas : ''],
    [t('events.location'), e.location || ''],
    [t('events.salesManager'), e.salesManager || ''],
  ] as [string, string][]).filter(([, v]) => v);
  const sections = eventSections(e, isEvents);
  const dietary = sections.some((sec) => sec.key === 'dietary');
  const kicker = { textTransform: 'uppercase' as const, letterSpacing: 0.6 };

  return (
    <Screen title={e.name} back bottomInset onRefresh={reload}>
      <Card style={{ gap: 6 }}>
        <Txt v="tiny" tone="muted" bold style={kicker}>{t('events.beo')}</Txt>
        <Txt v="title" style={{ fontSize: 22 }}>{e.name}</Txt>
        <Txt tone="muted">{[date(e.date, 'long'), `${time(e.start)}${e.end ? `–${time(e.end)}` : ''}`, e.room || t('events.tbd')].join(' · ')}</Txt>
        <View style={styles.badges}>
          {isStatus(e.status) ? <Badge tone={STATUS_TONE[e.status]} text={t(`events.status.${e.status}`)} /> : null}
          {e.guestCount ? <Badge tone="brand" text={`${tn('events.guests', e.guestCount)}${e.guaranteed ? ` · ${t('events.guaranteed', { count: e.guaranteed })}` : ''}`} /> : null}
        </View>
        {mine ? <Notice tone="brand" icon="user" text={t('events.youreWorking', { job: jobs[mine.jobCodeId]?.name || '', time: shiftTime(mine) })} /> : null}
        {dietary ? <Notice tone="warn" icon="alert" text={t('events.dietaryBanner')} /> : null}
      </Card>

      {details.length ? (
        <Card style={{ gap: 10 }}>
          <Txt v="h3">{t('events.details')}</Txt>
          {details.map(([k, v]) => (
            <View key={k} style={{ gap: 1 }}>
              <Txt v="tiny" tone="muted" bold style={kicker}>{k}</Txt>
              <Txt>{v}</Txt>
            </View>
          ))}
        </Card>
      ) : null}

      {e.staffing.length || isEvents ? <Card style={{ gap: 10 }}>
        <Row>
          <Txt v="h3" style={{ flex: 1 }}>{t('events.staffing')}</Txt>
          {e.needed > 0 ? <Badge tone={e.filled >= e.needed ? 'ok' : 'warn'} text={t('events.staffed', { filled: e.filled, needed: e.needed })} /> : null}
        </Row>
        {e.staffing.map((l) => {
          const on = e.shifts.filter((s) => s.staffingLineId === l.id);
          return (
            <View key={l.id} style={[styles.line, { borderColor: c.border }]}>
              <Row>
                <JobDot color={jobs[l.jobCodeId]?.color} />
                <Txt bold style={{ flex: 1 }}>{jobs[l.jobCodeId]?.name || ''}</Txt>
                <Badge tone={l.filled >= l.count ? 'ok' : 'warn'} text={t('events.filled', { filled: l.filled, count: l.count })} />
              </Row>
              <Txt v="small" tone="muted">{t('events.need', { count: l.count, time: time(l.start || e.start) })}{l.notes ? ` · ${l.notes}` : ''}</Txt>
              {on.length ? (
                <View style={styles.badges}>
                  {on.map((s) => <Badge key={s.id} tone={s.userId ? (s.userId === me.id ? 'brand' : 'neutral') : 'warn'} text={`${s.userId ? people[s.userId]?.name || '' : t('schedule.openShift')} · ${time(s.start)}`} />)}
                </View>
              ) : null}
            </View>
          );
        })}
      </Card> : null}

      {/* Everything the BEO says, by section, only where it says something (lib/beo.ts). */}
      {sections.map((sec, i) => <SectionCard key={`${sec.key}-${i}`} s={sec} />)}

      <Card style={{ gap: 10 }}>
        <Txt v="h3">{t('events.thread')}</Txt>
        {(e.comments || []).map((cm) => (
          <View key={cm.id} style={{ gap: 2 }}>
            <Txt v="small"><Txt v="small" bold>{cm.userName}</Txt>  <Txt v="tiny" tone="faint">{stamp(cm.at)}</Txt></Txt>
            <Txt>{cm.text}</Txt>
          </View>
        ))}
        <Txt v="small" tone="muted">{t('events.threadHelp')}</Txt>
        <Button small icon="external" title={t('common.openWebsite')} onPress={() => WebBrowser.openBrowserAsync(`${server}/#/events/${e.id}`).catch(() => {})} style={{ alignSelf: 'flex-start' }} />
      </Card>
    </Screen>
  );
}

/** One section of the BEO: the app's name for it (the BEO's own heading for "other"), then what it says, as written. */
function SectionCard({ s }: { s: BeoSection }) {
  const { t, time } = useI18n();
  const c = useColors();
  const kicker = { textTransform: 'uppercase' as const, letterSpacing: 0.6 };
  const title = s.key === 'other' || !isSectionKey(s.key) ? s.title || t('events.section.other') : t(`events.section.${s.key}`);
  const alert = s.key === 'dietary';
  return (
    <Card style={[{ gap: 8 }, alert ? { borderColor: c.warn, borderWidth: 1.5 } : null]}>
      <Row>
        <Txt v="h3" style={[{ flex: 1 }, alert ? { color: c.warn } : null]}>{title}</Txt>
        {PRIVATE.includes(s.key) ? <Badge tone="neutral" text={t('events.managersOnly')} /> : null}
      </Row>
      {s.kind === 'timeline' ? (s.items as TimelineItem[]).map((x, i) => (
        <Row key={i} style={{ alignItems: 'flex-start' }}>
          <Txt bold style={{ minWidth: 76 }}>{`${time(x.time)}${x.end ? `–${time(x.end)}` : ''}`}</Txt>
          <Txt style={{ flex: 1 }}>{x.text}</Txt>
        </Row>
      )) : null}
      {s.kind === 'menu' ? (s.items as MenuItem[]).map((m, i, all) => (
        <View key={i} style={{ gap: 1 }}>
          {m.course && m.course !== all[i - 1]?.course ? <Txt v="tiny" tone="muted" bold style={kicker}>{m.course}</Txt> : null}
          {m.item ? <Txt bold>{`${m.item}${m.qty ? ` ×${m.qty}` : ''}${m.dietary?.length ? `  (${m.dietary.join(', ')})` : ''}`}</Txt> : null}
          {m.notes ? <Txt v="small" tone="muted">{m.notes}</Txt> : null}
        </View>
      )) : null}
      {s.kind === 'keyvalue' ? (s.items as KeyValueItem[]).map((x, i) => (
        <View key={i} style={x.drink ? [styles.drink, { backgroundColor: c.surface2 }] : { gap: 1 }}>
          {x.labelKey || x.label ? <Txt v="tiny" tone="muted" bold style={kicker}>{isLabelKey(x.labelKey) ? t(`events.label.${x.labelKey}`) : x.label || ''}</Txt> : null}
          <Txt>{x.value}</Txt>
        </View>
      )) : null}
      {s.kind === 'list' ? (s.items as string[]).map((x, i) => <Txt key={i} bold={alert}>{`• ${x.replace(/^[•◦▪●○*–-]\s*/, '')}`}</Txt>) : null}
      {s.kind === 'text' ? (s.items as string[]).map((x, i) => (/:$/.test(x) && x.length <= 48
        ? <Txt key={i} v="tiny" tone="muted" bold style={[kicker, { marginTop: 2 }]}>{x.slice(0, -1)}</Txt>
        : <Txt key={i}>{x}</Txt>)) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  line: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  drink: { borderRadius: 10, padding: 10, gap: 2 },
});
