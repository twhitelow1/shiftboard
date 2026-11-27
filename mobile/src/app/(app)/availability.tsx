// Availability: for each weekday (in the restaurant's week order), any time, some hours (from / until), or unavailable,
// with a note for the day. Yours, or (for whoever may edit staff availability: managers, and supervisors when Roles &
// features allows) someone else's, picked at the top. Saved with employees.setAvailability like the website; every
// change is in the History below (availability.history), and the person is told when someone else changed theirs.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { TimeField } from '@/components/TimeField';
import { Badge, Button, Card, Chips, Empty, Field, Loading, Notice, SectionTitle, Segmented, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { addDays } from '@/lib/time';
import type { DayAvailability } from '@/lib/types';

type Mode = 'any' | 'some' | 'off';
type Week = Record<string, DayAvailability>;
interface AvailabilityAnswer { userId: string; name: string; availability: Week; canEdit: boolean; effectiveFrom: string | null; notes: string }
interface HistoryEntry { id: string; at: string; via: 'app' | 'import' | 'connector' | 'assistant'; actorName: string; days: { day: number; before: DayAvailability; after: DayAvailability }[] }
const modeOf = (a?: DayAvailability): Mode => (a?.available === false ? 'off' : a?.from || a?.to ? 'some' : 'any');
// A Sunday (2023-01-01) plus n days, for the weekday's name in the person's language.
const dayName = (dow: number) => addDays('2023-01-01', dow);

export default function Availability() {
  const { t, date } = useI18n();
  const c = useColors();
  const { me, settings, client } = useApp();
  const params = useLocalSearchParams<{ userId?: string }>();
  const [who, setWho] = useState<string>(params.userId || me.id);
  const people = useRpc<{ id: string; name: string }[]>('availability.people');
  const got = useRpc<AvailabilityAnswer>('availability.get', { userId: who }, [who]);
  const history = useRpc<HistoryEntry[]>('availability.history', { userId: who, limit: 30 }, [who]);
  const [av, setAv] = useState<Week>({});
  const [saved, setSaved] = useState('{}');
  const [run, busy] = useAction();
  useEffect(() => { if (got.data) { setAv({ ...(got.data.availability || {}) }); setSaved(JSON.stringify(got.data.availability || {})); } }, [got.data]);
  const mine = who === me.id;
  const canEdit = !!got.data?.canEdit;
  const dirty = JSON.stringify(av) !== saved;
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + settings.weekStartDow) % 7);
  const set = (d: number, patch: DayAvailability) => setAv({ ...av, [d]: { ...(av[d] || { available: true }), ...patch } });
  const setMode = (d: number, m: Mode) => {
    const a = av[d] || {};
    // Leaving "unavailable" ends a standing request off.
    if (m === 'any') set(d, { available: true, from: '', to: '', standing: undefined, requestedAt: undefined });
    else if (m === 'some') set(d, { available: true, from: a.from || '16:00', to: a.to || '', standing: undefined, requestedAt: undefined });
    else set(d, { available: false });
  };
  const save = async () => {
    const r = await run(() => client.call('employees.setAvailability', { availability: av, ...(mine ? {} : { userId: who }) }),
      mine ? t('availability.saved') : t('availEdit.savedFor', { name: got.data?.name || '' }));
    if (r !== undefined) { setSaved(JSON.stringify(av)); history.reload(); if (mine) router.back(); }
  };
  const dayText = (a?: DayAvailability) => (a?.available === false ? (a.standing ? t('availEdit.standing') : t('availEdit.unavailable'))
    : a?.from || a?.to ? t('availEdit.hours', { from: a.from || t('availability.opening'), to: a.to || t('availability.closing') }) : t('availEdit.anyTime')) + (a?.note ? ` · ${a.note}` : '');

  return (
    <Screen title={mine ? t('availability.title') : t('availEdit.titleFor', { name: got.data?.name || '' })} back bottomInset>
      {people.data && people.data.length > 1 ? (
        <Card style={{ gap: 6 }}>
          <Txt v="small" tone="muted" bold>{t('availEdit.person')}</Txt>
          <Chips single value={[who]} onChange={(v) => v[0] && setWho(v[0])} label={t('availEdit.person')}
            options={[...people.data].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0)).map((p) => ({ value: p.id, label: p.id === me.id ? t('availEdit.me', { name: p.name }) : p.name }))} />
        </Card>
      ) : null}
      <Txt v="small" tone="muted">{mine ? t('availability.help') : canEdit ? '' : t('availEdit.readOnly', { name: got.data?.name || '' })}</Txt>
      {got.data?.effectiveFrom ? <Notice tone="brand" icon="calendar" text={t('availEdit.effectiveFrom', { date: date(got.data.effectiveFrom) })} /> : null}
      {!got.data ? <Loading /> : (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {order.map((d) => {
            const a = av[d] || {};
            const m = modeOf(a);
            const name = date(dayName(d), 'weekdayLong');
            return (
              <View key={d} style={[styles.day, { borderColor: c.border }]} accessibilityLabel={name}>
                <Txt v="h3" style={{ textTransform: 'capitalize' }}>{name}</Txt>
                {a.standing ? <Badge tone="ok" text={a.requestedAt ? t('availEdit.standingSince', { date: date(a.requestedAt.slice(0, 10)) }) : t('availEdit.standing')} /> : null}
                {canEdit ? (
                  <>
                    <Segmented value={m} onChange={(v) => setMode(d, v)} options={[
                      { value: 'any', label: t('availability.anyTime') },
                      { value: 'some', label: t('availability.someHours') },
                      { value: 'off', label: t('availability.unavailable') },
                    ]} />
                    {m === 'some' ? (
                      <View style={styles.times}>
                        <TimeField label={t('availability.from')} value={a.from || ''} onChange={(v) => set(d, { from: v })}
                          empty={t('availability.opening')} clearLabel={t('availability.clearTime')} />
                        <TimeField label={t('availability.to')} value={a.to || ''} onChange={(v) => set(d, { to: v })}
                          empty={t('availability.closing')} clearLabel={t('availability.clearTime')} />
                      </View>
                    ) : null}
                    <Field label={t('availEdit.note')} value={a.note || ''} onChangeText={(v) => set(d, { note: v })} maxLength={200} />
                  </>
                ) : <Txt v="small">{dayText(a)}</Txt>}
              </View>
            );
          })}
        </Card>
      )}
      {dirty ? <Notice tone="warn" icon="clock" text={t('availability.unsaved')} /> : null}
      {canEdit ? <Button kind="primary" icon="check" title={t('availability.save')} busy={busy} disabled={!dirty} onPress={save} /> : null}

      <SectionTitle title={t('availEdit.history')} />
      <Txt v="small" tone="faint">{t('availEdit.keptTwoYears')}</Txt>
      {!history.data ? <Loading /> : !history.data.length ? <Card><Empty icon="clock" title={t('availEdit.noHistory')} /></Card> : history.data.map((e) => (
        <Card key={e.id} style={{ gap: 4 }}>
          <Txt bold>{e.actorName} · {t(`availEdit.via_${e.via}` as const)}</Txt>
          <Txt v="small" tone="muted">{date(e.at.slice(0, 10))}</Txt>
          {e.days.map((x) => (
            <Txt key={x.day} v="small"><Txt v="small" bold style={{ textTransform: 'capitalize' }}>{date(dayName(x.day), 'weekday')}</Txt>: {dayText(x.before)} → {dayText(x.after)}</Txt>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  day: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
