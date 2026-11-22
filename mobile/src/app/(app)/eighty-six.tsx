// The 86 List: what's out or running low, list by list, the bar's lists first and in their own color.
// Report opens the report screen; tapping an item updates it; Back in stock clears it, with undo. Photos show as
// thumbnails under an item; tap one for full screen.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PhotoViewer, Thumbs } from '@/components/EightySixPhoto';
import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, Empty, Loading, Notice, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ago, barFirst, listColors, nameIn } from '@/lib/eightySix';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { EightySixBoard, EightySixItem, EightySixList } from '@/lib/types';

const report = (params: { listId?: string; itemId?: string }) => router.push({ pathname: '/report-86', params });

export default function EightySixScreen() {
  const { t, lang } = useI18n();
  const { client, bump } = useApp();
  const toast = useToast();
  const errorText = useErrorText();
  const board = useRpc<EightySixBoard>('eightySix.board.get');
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const [viewer, setViewer] = useState<{ item: EightySixItem; start: number } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 10000);
    return () => clearTimeout(timer);
  }, [undo]);

  const data = board.data;
  const lists = data ? [...data.lists].sort(barFirst) : [];
  const bar = lists.filter((l) => l.kind === 'bar');
  const floor = lists.filter((l) => l.kind !== 'bar');
  const clear = async (it: EightySixItem, name: string) => {
    try {
      await client.call('eightySix.clear', { id: it.id });
      setUndo({ id: it.id, name });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
    bump();
  };
  const removePhoto = async (it: EightySixItem, photoId: string) => {
    setViewer(null);
    try { await client.call('eightySix.removePhoto', { itemId: it.id, photoId }); toast(t('eightySix.photoRemoved')); } catch (e) { toast(errorText(e), 'bad'); }
    bump();
  };
  const openPhoto = (item: EightySixItem, start: number) => setViewer({ item, start });
  const restore = async () => {
    if (!undo) return;
    setUndo(null);
    try { await client.call('eightySix.restore', { id: undo.id }); } catch (e) { toast(errorText(e), 'bad'); }
    bump();
  };

  return (
    <Screen title={t('eightySix.title')} back bottomInset onRefresh={board.reload}>
      {!data && !board.error ? <Loading label={t('common.loading')} /> : null}
      {board.error && !data ? <Empty icon="alert" title={errorText(board.error)}><Button title={t('common.retry')} onPress={board.reload} /></Empty> : null}
      {data ? (
        <>
          <Txt v="small" tone="muted">{t('eightySix.intro')}</Txt>
          {data.canReport ? <Button kind="primary" icon="plus" title={t('eightySix.report')} onPress={() => report({})} block /> : null}
          {undo ? (
            <Notice tone="ok" icon="check" text={t('eightySix.backName', { name: undo.name })}>
              <Button small title={t('eightySix.undo')} onPress={restore} style={{ alignSelf: 'flex-start' }} />
            </Notice>
          ) : null}
          {bar.length ? <Group kind="bar" title={t('eightySix.barColumn')} lists={bar} onClear={clear} onPhoto={openPhoto} /> : null}
          {floor.length ? <Group kind="kitchen" title={t('eightySix.floorColumn')} lists={floor} onClear={clear} onPhoto={openPhoto} /> : null}
        </>
      ) : null}
      {viewer ? <PhotoViewer name={nameIn(viewer.item, lang)} photos={viewer.item.photos} start={viewer.start} onClose={() => setViewer(null)} onRemove={(p) => removePhoto(viewer.item, p.id)} /> : null}
    </Screen>
  );
}

type OnPhoto = (item: EightySixItem, start: number) => void;

function Group({ kind, title, lists, onClear, onPhoto }: { kind: string; title: string; lists: EightySixList[]; onClear: (it: EightySixItem, name: string) => void; onPhoto: OnPhoto }) {
  const c = useColors();
  const col = listColors(kind, c.dark);
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <View style={styles.groupH}>
        <Icon name={kind === 'bar' ? 'glass' : 'ban'} size={15} color={col.main} />
        <Text style={[styles.groupText, { color: col.main }]}>{title.toUpperCase()}</Text>
      </View>
      {lists.map((l) => <ListCard key={l.id} list={l} onClear={onClear} onPhoto={onPhoto} />)}
    </View>
  );
}

function ListCard({ list, onClear, onPhoto }: { list: EightySixList; onClear: (it: EightySixItem, name: string) => void; onPhoto: OnPhoto }) {
  const { t, tn, lang, time } = useI18n();
  const c = useColors();
  const col = listColors(list.kind, c.dark);
  const out = list.items.filter((i) => i.status === 'out').length;
  const low = list.items.length - out;
  const name = nameIn(list, lang);
  return (
    <Card pad={false} style={{ overflow: 'hidden', borderTopWidth: 3, borderTopColor: col.main }}>
      <View style={[styles.listH, { backgroundColor: col.soft, borderColor: c.border }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Txt v="h3">{name}</Txt>
            {list.area ? <Badge text={list.area} /> : null}
          </View>
          <Txt v="small" tone="muted">{out || low ? [out ? tn('eightySix.nOut', out) : '', low ? tn('eightySix.nLow', low) : ''].filter(Boolean).join(' · ') : t('eightySix.allGood')}</Txt>
        </View>
        {list.canReport ? <Button small icon="plus" title={t('eightySix.report')} label={t('eightySix.reportOn', { list: name })} onPress={() => report({ listId: list.id })} /> : null}
      </View>
      {list.items.map((it) => <ItemRow key={it.id} it={it} list={list} onClear={onClear} onPhoto={onPhoto} />)}
      {list.resetAt ? (
        <View style={[styles.foot, { borderColor: c.border }]}>
          <Icon name="clock" size={13} color={c.text3} />
          <Txt v="tiny" tone="faint">{t('eightySix.clearsAt', { time: time(list.resetAt) })}</Txt>
        </View>
      ) : null}
    </Card>
  );
}

function ItemRow({ it, list, onClear, onPhoto }: { it: EightySixItem; list: EightySixList; onClear: (it: EightySixItem, name: string) => void; onPhoto: OnPhoto }) {
  const { t, tn, lang } = useI18n();
  const c = useColors();
  const name = nameIn(it, lang);
  const meta = [it.status === 'low' && it.count != null ? tn('eightySix.countLeft', it.count) : '', it.area && it.area !== list.area ? it.area : '', it.note].filter(Boolean).join(' · ');
  const body = (
    <>
      <View style={[styles.pill, it.status === 'out' ? { backgroundColor: c.bad } : { backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warn }]}>
        <Text style={{ color: it.status === 'out' ? '#fff' : c.warn, fontWeight: '800', fontSize: 12 }}>{it.status === 'out' ? t('eightySix.pillOut') : t('eightySix.pillLow')}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt bold>{name}</Txt>
        {meta ? <Txt v="small" tone="muted">{meta}</Txt> : null}
        <Txt v="tiny" tone="faint">{it.updatedBy.name} · {ago(t, tn, it.updatedAt)}</Txt>
      </View>
    </>
  );
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
    <View style={styles.item}>
      {list.canReport ? (
        <Pressable onPress={() => report({ listId: list.id, itemId: it.id })} accessibilityRole="button" accessibilityLabel={t('eightySix.updateTitle', { name })}
          style={({ pressed }) => [styles.itemMain, pressed && { backgroundColor: c.surface2 }]}>{body}</Pressable>
      ) : <View style={styles.itemMain}>{body}</View>}
      {list.canReport ? (
        <Pressable onPress={() => onClear(it, name)} accessibilityRole="button" accessibilityLabel={`${t('eightySix.backInStock')}: ${name}`}
          style={({ pressed }) => [styles.back, { borderColor: c.border, backgroundColor: pressed ? c.okSoft : c.surface }]}>
          <Icon name="check" size={18} color={c.ok} />
          <Text style={[styles.backText, { color: c.text }]} numberOfLines={2}>{t('eightySix.backInStock')}</Text>
        </Pressable>
      ) : null}
    </View>
    <Thumbs photos={it.photos || []} name={name} onOpen={(i) => onPhoto(it, i)} />
    </View>
  );
}

const styles = StyleSheet.create({
  groupH: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  groupText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  listH: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  item: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingLeft: 6, paddingRight: 10 },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 8, borderRadius: 10, minHeight: 44 },
  pill: { minWidth: 40, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginTop: 1 },
  back: { width: 78, minHeight: 48, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4, paddingVertical: 6 },
  backText: { fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 15 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
});
