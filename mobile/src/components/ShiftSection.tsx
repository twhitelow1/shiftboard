// A shift's server section: which room, which tables (sections.list, core/venue-links.js), and the room's floor
// plan with the shift's tables highlighted (venue.get). Read only: managers assign sections on the website.
// Staff only see sections of posted shifts, like the schedule. Needs the Venue feature.
import { StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Room, SectionDay, SectionEntry, Shift } from '@/lib/types';
import { FloorPlan, sectionMarks } from './FloorPlan';
import { Icon } from './Icon';
import { Card, Txt, useColors } from './ui';

export type SectionHit = SectionEntry & { roomId: string; roomName: string; day: SectionDay };

/** The section for one shift, or null. */
export function useShiftSection(shift: Pick<Shift, 'id' | 'date'> | null | undefined) {
  const { has } = useSession();
  const on = !!shift?.id && has('venue');
  const days = useRpc<SectionDay[]>('sections.list', { start: shift?.date || '', end: shift?.date || '' }, [shift?.date], on);
  if (!on || !days.data) return null;
  for (const d of days.data) {
    const e = d.entries.find((x) => x.shiftId === shift!.id);
    if (e) return { ...e, roomId: d.roomId, roomName: d.roomName, day: d } as SectionHit;
  }
  return null;
}

/** "Restaurant · Your tables: T4, T7 · 12 seats" (one line, for lists and the next-shift card). */
export function sectionLine(hit: SectionHit, t: ReturnType<typeof useI18n>['t'], tn: ReturnType<typeof useI18n>['tn'], mine: boolean) {
  const tables = hit.tables.join(', ');
  return [hit.roomName, hit.tables.length ? tn(mine ? 'shift.yourTables' : 'shift.tables', hit.tables.length, { tables }) : '', hit.seats ? tn('shift.seats', hit.seats) : '']
    .filter(Boolean).join(' · ');
}

/** The section card on a shift's screen: room, tables and the plan. */
export function ShiftSectionCard({ shift, mine }: { shift: Shift; mine: boolean }) {
  const { t, tn } = useI18n();
  const c = useColors();
  const { people } = useSession();
  const hit = useShiftSection(shift);
  const venue = useRpc<{ rooms: Room[] }>('venue.get', {}, [], !!hit, { cache: 'venue' });
  if (!hit) return null;
  const room = venue.data?.rooms.find((r) => r.id === hit.roomId);
  const marks = sectionMarks(hit.day.entries, people, { mine: (e) => e.shiftId === shift.id, you: mine ? t('shift.markYou') : (people[shift.userId || '']?.name || '').split(' ')[0], open: t('shift.markOpen') });
  return (
    <Card style={{ gap: 10 }}>
      <View style={styles.head}>
        <Icon name="pin" size={18} color={c.brand} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {mine ? t('shift.section') : t('shift.sectionOf', { name: people[shift.userId || '']?.name || '' })}
          </Txt>
          <Txt bold>{hit.roomName}</Txt>
          <Txt v="small" tone="muted">
            {hit.tables.length ? [tn(mine ? 'shift.yourTables' : 'shift.tables', hit.tables.length, { tables: hit.tables.join(', ') }), hit.seats ? tn('shift.seats', hit.seats) : ''].filter(Boolean).join(' · ') : t('shift.noTables')}
          </Txt>
        </View>
      </View>
      {room?.plan?.items?.length ? (
        <>
          <FloorPlan plan={room.plan} marks={marks} focus={hit.tableIds} title={t('shift.planTitle', { room: room.name })}
            labels={{ mine: mine ? t('shift.planMine') : t('shift.planTheirs'), room: t('shift.planRoom') }} />
          {hit.tableIds.length ? <Txt v="tiny" tone="faint">{t('shift.planHelp')}</Txt> : null}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
});
