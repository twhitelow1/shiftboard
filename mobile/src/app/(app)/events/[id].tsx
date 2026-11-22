// One event's BEO, read only: when and where, guests, your shift on it, details, staffing (who's on it),
// menu and dietary notes, beverage and special drinks, the timeline, setup notes and the team thread.
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
  const contact = isEvents ? [e.contactName, e.contactPhone, e.contactEmail].filter(Boolean).join(' · ') : '';
  const details: [string, string][] = ([
    [t('events.type'), e.type || ''],
    [t('events.service'), isStyle(e.serviceStyle) ? t(`events.style.${e.serviceStyle}`) : e.serviceStyle || ''],
    [t('events.captain'), captain?.name || ''],
    [t('events.client'), e.client || ''],
    [t('events.contact'), contact],
    [t('events.attire'), e.attire || ''],
  ] as [string, string][]).filter(([, v]) => v);
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

      <Card style={{ gap: 10 }}>
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
      </Card>

      {e.menu?.length || e.dietaryNotes ? (
        <Card style={{ gap: 10 }}>
          <Txt v="h3">{t('events.menu')}</Txt>
          {e.menu?.length ? e.menu.map((m, i) => (
            <View key={i} style={{ gap: 1 }}>
              {m.course ? <Txt v="tiny" tone="muted" bold style={kicker}>{m.course}</Txt> : null}
              <Txt bold>{m.item}</Txt>
              {m.notes ? <Txt v="small" tone="muted">{m.notes}</Txt> : null}
            </View>
          )) : <Txt v="small" tone="muted">{t('events.noMenu')}</Txt>}
          {e.dietaryNotes ? <Notice tone="warn" text={t('events.dietaryNotes', { text: e.dietaryNotes })} /> : null}
        </Card>
      ) : null}

      {e.beverage?.package || e.beverage?.bar || e.beverage?.notes || e.specialDrinks?.length ? (
        <Card style={{ gap: 8 }}>
          <Txt v="h3">{t('events.beverage')}</Txt>
          {e.beverage?.package ? <Txt><Txt bold>{t('events.package')}: </Txt>{e.beverage.package}</Txt> : null}
          {e.beverage?.bar ? <Txt><Txt bold>{t('events.bar')}: </Txt>{e.beverage.bar}</Txt> : null}
          {e.beverage?.notes ? <Txt><Txt bold>{t('common.notesLabel')}: </Txt>{e.beverage.notes}</Txt> : null}
          {e.specialDrinks?.length ? (
            <>
              <Txt v="tiny" tone="muted" bold style={[kicker, { marginTop: 4 }]}>{t('events.specialDrinks')}</Txt>
              {e.specialDrinks.map((d, i) => (
                <View key={i} style={[styles.drink, { backgroundColor: c.surface2 }]}>
                  <Txt bold>{d.name}</Txt>
                  {d.recipe ? <Txt v="small">{d.recipe}</Txt> : null}
                  {d.batch ? <Txt v="tiny" tone="faint">{d.batch}</Txt> : null}
                </View>
              ))}
            </>
          ) : null}
        </Card>
      ) : null}

      {e.timeline?.length ? (
        <Card style={{ gap: 8 }}>
          <Txt v="h3">{t('events.timeline')}</Txt>
          {e.timeline.map((x, i) => (
            <Row key={i} style={{ alignItems: 'flex-start' }}>
              <Txt bold style={{ minWidth: 64 }}>{time(x.time)}</Txt>
              <Txt style={{ flex: 1 }}>{x.item}</Txt>
            </Row>
          ))}
        </Card>
      ) : null}

      {e.setupNotes || e.avNotes || e.notes ? (
        <Card style={{ gap: 8 }}>
          <Txt v="h3">{t('events.setup')}</Txt>
          {e.setupNotes ? <Txt>{t('events.setupLabel', { text: e.setupNotes })}</Txt> : null}
          {e.avNotes ? <Txt>{t('events.av', { text: e.avNotes })}</Txt> : null}
          {e.notes ? <Txt>{e.notes}</Txt> : null}
        </Card>
      ) : null}

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

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  line: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  drink: { borderRadius: 10, padding: 10, gap: 2 },
});
