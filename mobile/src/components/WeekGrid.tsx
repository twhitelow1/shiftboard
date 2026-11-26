// The week at a glance, like the house sheet: a row per person in each area and position (the same grouping as
// the day view), a column per day that scrolls sideways while the names stay put, projected covers under each
// day, and open shifts. Tap a day's heading for that day; tap a shift for its details.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n';
import { daySections } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { dow } from '@/lib/time';
import type { Shift } from '@/lib/types';
import { useShiftTime } from './ShiftRow';
import { JobDot, useColors } from './ui';

const NAME_W = 116;
const COL_W = 78;
const HEAD_H = 64;
const SECTION_H = 34;
const BANNER_H = 28;
const ROW_H = 54;

interface Row { key: string; kind: 'banner' | 'section' | 'person'; label: string; color?: string; text?: string; userId?: string | null; cells?: Shift[][] }

export function WeekGrid({ days, shifts, covers, onDay, onShift }: {
  days: string[]; shifts: Shift[]; covers: Record<string, number | undefined>; onDay: (d: string) => void; onShift: (s: Shift) => void;
}) {
  const { t, date, num } = useI18n();
  const c = useColors();
  const { me, today, settings, jobs, people, boot } = useApp();
  const shiftTime = useShiftTime();

  const rows: Row[] = [];
  const sections = daySections(shifts, jobs, settings, boot.layout); // the week, in Settings → Rooms & positions order
  sections.forEach((sec, i) => {
    if (sec.banner && sec.banner !== sections[i - 1]?.banner) rows.push({ key: `b:${sec.key}`, kind: 'banner', label: sec.banner, color: sec.bannerColor, text: sec.bannerText });
    rows.push({ key: `s:${sec.key}`, kind: 'section', label: sec.job.name, color: sec.job.color });
    const order: (string | null)[] = [];
    for (const s of [...sec.shifts].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) if (!order.includes(s.userId)) order.push(s.userId);
    order.sort((a, b) => (a === null ? 1 : b === null ? -1 : (people[a]?.name || '').localeCompare(people[b]?.name || '')));
    for (const u of order) {
      rows.push({
        key: `p:${sec.key}:${u}`, kind: 'person', userId: u,
        label: u ? people[u]?.name || '—' : t('schedule.openShift'),
        cells: days.map((d) => sec.shifts.filter((s) => s.userId === u && s.date === d)),
      });
    }
  });
  const closed = (d: string) => settings.closedDays.includes(dow(d));

  return (
    <View style={[styles.wrap, { borderColor: c.border, backgroundColor: c.surface }]}>
      {/* Names: fixed on the left */}
      <View style={[styles.names, { borderColor: c.border }]}>
        <View style={[styles.head, { height: HEAD_H, borderColor: c.border, alignItems: 'flex-start', paddingHorizontal: 10 }]}>
          <Text style={[styles.tiny, { color: c.text3 }]} numberOfLines={2}>{t('schedule.projected')}</Text>
        </View>
        {rows.map((r) => (r.kind === 'banner' ? (
          <View key={r.key} style={[styles.sectionL, { height: BANNER_H, backgroundColor: r.color, borderColor: c.border }]}>
            <Text style={[styles.tiny, { color: r.text, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' }]} numberOfLines={1}>{r.label}</Text>
          </View>
        ) : r.kind === 'section' ? (
          <View key={r.key} style={[styles.sectionL, { height: SECTION_H, backgroundColor: c.surface2, borderColor: c.border }]}>
            <JobDot color={r.color} />
            <Text style={[styles.sectionText, { color: c.text }]} numberOfLines={1}>{r.label}</Text>
          </View>
        ) : (
          <View key={r.key} style={[styles.nameCell, { height: ROW_H, borderColor: c.border, backgroundColor: r.userId === me.id ? c.brandSoft : 'transparent' }]}>
            <Text style={{ color: r.userId ? c.text : c.text3, fontWeight: r.userId === me.id ? '800' : '600', fontSize: 14, fontStyle: r.userId ? 'normal' : 'italic' }} numberOfLines={2}>{r.label}</Text>
          </View>
        )))}
      </View>
      {/* Days: scroll sideways */}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ width: COL_W * days.length }} accessibilityLabel={t('schedule.scrollHint')}>
        <View>
          <View style={{ flexDirection: 'row' }}>
            {days.map((d) => {
              const isToday = d === today;
              const cv = covers[d];
              return (
                <Pressable key={d} onPress={() => onDay(d)} accessibilityRole="button"
                  accessibilityLabel={`${date(d, 'long')}${cv ? `, ${t('schedule.covers', { count: num(cv) })}` : ''}`}
                  style={({ pressed }) => [styles.head, styles.dayHead, { width: COL_W, height: HEAD_H, borderColor: c.border, backgroundColor: pressed ? c.surface2 : isToday ? c.brandSoft : 'transparent', opacity: closed(d) ? 0.5 : 1 }]}>
                  <Text style={[styles.tiny, { color: isToday ? c.brand : c.text2, fontWeight: '800', textTransform: 'uppercase' }]}>{date(d, 'weekday')}</Text>
                  <Text style={{ color: isToday ? c.brand : c.text, fontWeight: '800', fontSize: 17 }}>{date(d, 'day')}</Text>
                  <Text style={[styles.tiny, { color: c.text3 }]} numberOfLines={1}>{closed(d) ? t('schedule.closed') : cv ? `~${num(cv)}` : ' '}</Text>
                </Pressable>
              );
            })}
          </View>
          {rows.map((r) => (r.kind !== 'person' ? (
            <View key={r.key} style={[styles.sectionR, { height: r.kind === 'banner' ? BANNER_H : SECTION_H, width: COL_W * days.length, backgroundColor: r.kind === 'banner' ? r.color : c.surface2, borderColor: c.border }]} />
          ) : (
            <View key={r.key} style={{ flexDirection: 'row', height: ROW_H, backgroundColor: r.userId === me.id ? c.brandSoft : 'transparent' }}>
              {r.cells!.map((cell, k) => (
                <View key={days[k]} style={[styles.cell, { width: COL_W, borderColor: c.border, backgroundColor: closed(days[k]) ? c.surface2 : 'transparent' }]}>
                  {cell.map((s) => (
                    <Pressable key={s.id} onPress={() => onShift(s)} accessibilityRole="button"
                      accessibilityLabel={`${r.label}, ${date(s.date, 'long')}, ${shiftTime(s)}`}
                      style={({ pressed }) => [styles.chip, { borderLeftColor: jobs[s.jobCodeId]?.color || c.border, backgroundColor: pressed ? c.surface2 : !s.userId ? c.okSoft : c.surface }]}>
                      <Text style={{ color: c.text, fontSize: 12, fontWeight: '700' }} numberOfLines={2}>{shiftTime(s)}</Text>
                      {s.tag ? <Text style={{ color: c.text3, fontSize: 10 }} numberOfLines={1}>{s.tag}</Text> : null}
                    </Pressable>
                  ))}
                </View>
              ))}
            </View>
          )))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  names: { width: NAME_W, borderRightWidth: StyleSheet.hairlineWidth },
  head: { justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  dayHead: { alignItems: 'center', borderLeftWidth: StyleSheet.hairlineWidth, gap: 1 },
  tiny: { fontSize: 11 },
  sectionL: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  sectionText: { fontSize: 12, fontWeight: '800', flexShrink: 1 },
  sectionR: { justifyContent: 'center', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  nameCell: { justifyContent: 'center', paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { padding: 3, gap: 2, borderLeftWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  chip: { flex: 1, borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 4, justifyContent: 'center', minHeight: 44 },
});
