// What's on a day (regular programming, core/programming.js): each item by room in its color, crossed out with
// "Replaced by <event>" when an event took its room, one-off changes, and events. Tap an item for its time, room,
// notes and (for people with staffing pars) scheduled vs par per position. Names and notes are the restaurant's.
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Badge, Card, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/lib/session';

export type ProgLine = { jobCodeId: string; need: number; have: number; open: number; gap: number; start?: string };
export type ProgCoverage = { key: string; kind: 'item' | 'event'; id: string; name: string; room: string; all?: boolean; start?: string; lines: ProgLine[] };
export type ProgItem = {
  id: string; name: string; rooms: string[]; color: string; notes: string; start: string; end: string;
  status: 'on' | 'cancelled' | 'replaced' | 'partial'; partStart?: string; partEnd?: string; roomsLeft?: string[];
  replacedBy: { id: string | null; name: string }[]; exception: { cancel?: boolean; start?: string; end?: string; reason?: string; pars?: unknown[] } | null;
};
export type ProgEvent = { id: string; name: string; start: string; end: string; room: string; rooms: string[]; all: boolean; guestCount: number };
export type ProgDay = { date: string; closed: boolean; note: string; autoNote: string; items: ProgItem[]; events: ProgEvent[]; coverage?: ProgCoverage[]; short?: number };
export type ProgDays = { canPars: boolean; days: ProgDay[] };

export function ProgrammingDay({ day }: { day?: ProgDay }) {
  const { t, tn, time } = useI18n();
  const c = useColors();
  const { jobs, has } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  if (!day || (!day.items.length && !day.events.length)) return null;
  const cov = (kind: string, id: string) => day.coverage?.find((x) => x.kind === kind && x.id === id);
  const span = (x: ProgItem) => `${time(x.partStart || x.start)}–${x.partEnd ? time(x.partEnd) : x.end ? time(x.end) : t('programming.close')}`;
  const by = (x: ProgItem) => x.replacedBy.map((r) => r.name || t('programming.anEvent')).join(', ');
  const lines = (ls: ProgLine[]) => (
    <View style={styles.lines}>
      {ls.map((l, i) => <Badge key={i} tone={l.gap ? 'bad' : 'ok'} text={`${jobs[l.jobCodeId]?.name || '—'} ${l.have}/${l.need}${l.open ? ` (+${l.open})` : ''}`} />)}
    </View>
  );
  return (
    <Card pad={false} style={{ overflow: 'hidden' }}>
      <Row style={styles.head}>
        <Txt v="small" bold tone="muted" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('programming.whatsOn')}</Txt>
        {day.coverage && day.short ? <Badge tone="bad" text={tn('programming.short', day.short)} /> : null}
      </Row>
      {day.items.map((x) => {
        const off = x.status === 'replaced' || x.status === 'cancelled';
        const cv = cov('item', x.id);
        const isOpen = open === x.id;
        return (
          <Pressable key={x.id} onPress={() => setOpen(isOpen ? null : x.id)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}
            accessibilityLabel={`${x.name}, ${x.rooms.join(', ') || t('programming.wholeVenue')}, ${span(x)}${x.status === 'replaced' ? `, ${t('programming.replacedBy', { name: by(x) })}` : ''}`}
            style={({ pressed }) => [styles.item, { borderColor: c.border, borderLeftColor: x.color || c.brand, backgroundColor: pressed ? c.surface2 : 'transparent' }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt style={[{ fontWeight: '700' }, off ? { textDecorationLine: 'line-through', color: c.text3 } : null]}>{x.name}</Txt>
              <Txt v="small" tone="muted">{x.rooms.length ? x.rooms.join(' · ') : t('programming.wholeVenue')} · {span(x)}</Txt>
              {x.status === 'replaced' ? <Txt v="small">{t('programming.replacedBy', { name: by(x) })}</Txt> : null}
              {x.status === 'partial' ? <Txt v="small">{t('programming.partly', { name: by(x) })}</Txt> : null}
              {x.status === 'cancelled' ? <Txt v="small">{t('programming.cancelled')}{x.exception?.reason ? ` · ${x.exception.reason}` : ''}</Txt> : null}
              {x.status !== 'cancelled' && x.exception?.start ? <Txt v="small">{t('programming.newHours')}{x.exception.reason ? ` · ${x.exception.reason}` : ''}</Txt> : null}
              {isOpen && x.notes ? <Txt v="small">{x.notes}</Txt> : null}
              {isOpen && cv && !off ? lines(cv.lines) : null}
              {!isOpen && cv && !off && cv.lines.some((l) => l.gap) ? <Txt v="small" style={{ color: c.bad }}>{tn('programming.shortOfPar', cv.lines.reduce((s, l) => s + l.gap, 0))}</Txt> : null}
            </View>
            <Icon name={isOpen ? 'up' : 'down'} color={c.text3} size={16} />
          </Pressable>
        );
      })}
      {day.events.map((e) => {
        const cv = cov('event', e.id);
        return (
          <Pressable key={e.id} disabled={!has('events')} onPress={() => router.push({ pathname: '/events/[id]', params: { id: e.id } })} accessibilityRole={has('events') ? 'button' : undefined}
            style={[styles.item, { borderColor: c.border, borderLeftColor: c.warn }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt style={{ fontWeight: '700' }}>{e.name}</Txt>
              <Txt v="small" tone="muted">{e.all ? t('programming.fullBuyout') : e.rooms.join(' · ') || e.room} · {time(e.start)}{e.end ? `–${time(e.end)}` : ''}{e.guestCount ? ` · ${tn('programming.guests', e.guestCount)}` : ''}</Txt>
              {cv ? lines(cv.lines) : null}
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 10, minHeight: 52, borderTopWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4 },
  lines: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
});
