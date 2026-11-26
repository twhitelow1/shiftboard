// Report an ingredient or supply that's 86'd or running low: pick the list, type it (or, on a list set to suggest
// menu items, pick one from the Training menu), then one tap. The server fills in the category it was filed under.
// With an itemId it updates that item (running low → 86'd, a new count or note). Up to 3 optional photos, shrunk on
// the phone (src/lib/photos.ts) and uploaded one per request after the report is saved.
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { E86Image } from '@/components/EightySixPhoto';
import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Button, Card, Empty, Field, Loading, Notice, Tabs, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { barFirst, nameIn } from '@/lib/eightySix';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { pickPhotos, type ShrunkPhoto } from '@/lib/photos';
import { useApp } from '@/lib/session';
import type { EightySixBoard } from '@/lib/types';

const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export default function Report86() {
  const { t, lang } = useI18n();
  const errorText = useErrorText();
  const params = useLocalSearchParams<{ listId?: string; itemId?: string }>();
  const board = useRpc<EightySixBoard>('eightySix.board.get');
  const editing = board.data?.lists.flatMap((l) => l.items).find((i) => i.id === params.itemId) || null;
  return (
    <Screen title={editing ? t('eightySix.updateTitle', { name: nameIn(editing, lang) }) : t('eightySix.reportTitle')} back bottomInset>
      {!board.data && !board.error ? <Loading label={t('common.loading')} /> : null}
      {board.error && !board.data ? <Empty icon="alert" title={errorText(board.error)}><Button title={t('common.retry')} onPress={board.reload} /></Empty> : null}
      {board.data ? <Form board={board.data} startList={params.listId} itemId={params.itemId} /> : null}
    </Screen>
  );
}

function Form({ board, startList, itemId }: { board: EightySixBoard; startList?: string; itemId?: string }) {
  const { t, tn, lang } = useI18n();
  const c = useColors();
  const toast = useToast();
  const { client } = useApp();
  const [run, busy] = useAction();
  const editing = board.lists.flatMap((l) => l.items).find((i) => i.id === itemId) || null;
  const reportable = board.lists.filter((l) => l.canReport).sort(barFirst);
  const [listId, setListId] = useState(editing?.listId || (reportable.some((l) => l.id === startList) ? startList! : reportable[0]?.id || ''));
  const list = board.lists.find((l) => l.id === listId);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ name: string; nameEs: string; menuItemId: string | null } | null>(editing ? { name: editing.name, nameEs: editing.nameEs, menuItemId: editing.menuItemId } : null);
  const [count, setCount] = useState(editing?.count != null ? String(editing.count) : '');
  const [note, setNote] = useState(editing?.note || '');
  const [area, setArea] = useState(editing?.area || '');
  const [areaOpen, setAreaOpen] = useState(false); // folded away so the two buttons stay in reach
  const errorText = useErrorText();
  const [kept, setKept] = useState(editing?.photos || []); // already on the item
  const [added, setAdded] = useState<ShrunkPhoto[]>([]); // new, shrunk, uploaded after the report
  const [uploading, setUploading] = useState(false);
  const room = 3 - kept.length - added.length;
  const addPhotos = async (source: 'camera' | 'library') => {
    const r = await pickPhotos(source, room, { title: t('eightySix.allowTitle'), why: t(source === 'camera' ? 'eightySix.cameraWhy' : 'eightySix.libraryWhy'), allow: t('eightySix.allow'), cancel: t('common.cancel') });
    if ('denied' in r) return toast(t(source === 'camera' ? 'eightySix.cameraDenied' : 'eightySix.libraryDenied'), 'bad');
    if ('failed' in r) return toast(t('eightySix.photoBad'), 'bad');
    setAdded((x) => [...x, ...r.photos].slice(0, 3 - kept.length));
  };
  const removeKept = async (photoId: string) => {
    try { await client.call('eightySix.removePhoto', { itemId: editing!.id, photoId }); setKept((x) => x.filter((p) => p.id !== photoId)); } catch (e) { toast(errorText(e), 'bad'); }
  };

  const words = norm(q).split(' ').filter(Boolean);
  const options = (list?.suggest || []).map((id) => ({ id, ...board.menu[id] }))
    .filter((m) => m.name && words.every((w) => norm(`${m.name} ${m.nameEs} ${m.category}`).includes(w)));
  const exact = q.trim() ? options.find((m) => norm(m.name) === norm(q) || (!!m.nameEs && norm(m.nameEs) === norm(q))) : undefined;
  const current = picked || (q.trim() ? { name: q.trim(), nameEs: '', menuItemId: exact?.id || null } : null);
  const existing = !editing && current ? list?.items.find((i) => (current.menuItemId ? i.menuItemId === current.menuItemId : norm(i.name) === norm(current.name))) : undefined;
  const pickTyped = () => { if (q.trim()) { setPicked({ name: q.trim(), nameEs: '', menuItemId: null }); setQ(''); } };

  const send = async (status: 'out' | 'low') => {
    if (!current) { toast(t('eightySix.pickFirst'), 'bad'); return; }
    let photoFailed = false;
    const r = await run(async () => {
      const x = await client.call<{ item: { id: string; name: string; nameEs: string }; notified: number }>('eightySix.report', {
        listId, name: current.name, menuItemId: current.menuItemId, status, count: status === 'low' ? count : '', note, area,
      });
      // One photo per request, after the report is saved: a photo that fails never loses the report.
      if (added.length) {
        setUploading(true);
        try {
          for (const p of added) await client.call('eightySix.addPhoto', { itemId: x.item.id, dataUrl: p.dataUrl, w: p.w, h: p.h });
        } catch (e) {
          photoFailed = true;
          toast(t('eightySix.photoFailed', { error: errorText(e) }), 'bad');
        } finally {
          setUploading(false);
        }
      }
      return x;
    });
    if (!r) return;
    const name = nameIn(r.item, lang);
    const said = status === 'out' ? t('eightySix.reportedOut', { name }) : t('eightySix.reportedLow', { name });
    if (!photoFailed) toast(r.notified ? `${said} · ${tn('eightySix.told', r.notified)}` : said);
    router.back();
  };

  return (
    <>
      {!editing && reportable.length > 1 ? (
        <View style={{ gap: 6 }}>
          <Txt v="small" tone="muted" bold>{t('eightySix.list')}</Txt>
          <Tabs tabs={reportable.map((l) => ({ value: l.id, label: nameIn(l, lang) }))} value={listId} onChange={(v) => { setListId(v); setPicked(null); }} />
        </View>
      ) : null}

      {picked ? (
        <Card style={styles.picked}>
          <Txt v="h3" style={{ flex: 1 }}>{nameIn(picked, lang)}</Txt>
          {!editing ? <Button small kind="ghost" title={t('eightySix.change')} onPress={() => setPicked(null)} /> : null}
        </Card>
      ) : (
        <>
          <Field label={t('eightySix.item')} value={q} onChangeText={setQ} placeholder={t('eightySix.search')} autoFocus autoCorrect={false}
            returnKeyType="done" onSubmitEditing={() => (exact ? setPicked({ name: exact.name, nameEs: exact.nameEs, menuItemId: exact.id }) : pickTyped())} />
          {options.length || q.trim() ? (
            <Card pad={false} style={{ overflow: 'hidden' }}>
              {!q.trim() ? <Txt v="tiny" tone="faint" style={{ paddingHorizontal: 14, paddingTop: 8 }}>{t('eightySix.fromMenu')}</Txt> : null}
              {q.trim() && !exact ? (
                <Pressable onPress={pickTyped} accessibilityRole="button" style={({ pressed }) => [styles.result, { borderColor: c.border }, pressed && { backgroundColor: c.surface2 }]}>
                  <Icon name="plus" size={18} color={c.brand} />
                  <Text style={[styles.resultName, { color: c.brand }]}>{t('eightySix.useTyped', { text: q.trim() })}</Text>
                </Pressable>
              ) : null}
              {options.slice(0, q.trim() ? 8 : 6).map((m) => (
                <Pressable key={m.id} onPress={() => { setPicked({ name: m.name, nameEs: m.nameEs, menuItemId: m.id }); setQ(''); }} accessibilityRole="button"
                  style={({ pressed }) => [styles.result, { borderColor: c.border }, pressed && { backgroundColor: c.surface2 }]}>
                  <Text style={[styles.resultName, { color: c.text }]}>{lang === 'es' && m.nameEs ? m.nameEs : m.name}</Text>
                  <Txt v="tiny" tone="faint">{m.category}</Txt>
                </Pressable>
              ))}
            </Card>
          ) : null}
        </>
      )}

      {existing ? <Notice tone="brand" icon="alert" text={existing.status === 'out' ? t('eightySix.alreadyOut') : t('eightySix.alreadyLow')} /> : null}
      <Field label={t('eightySix.howMany')} value={count} onChangeText={(v) => setCount(v.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder={t('eightySix.countPlaceholder')} maxLength={4} />
      <Field label={t('eightySix.note')} value={note} onChangeText={setNote} placeholder={t('eightySix.notePlaceholder')} maxLength={140} />
      <View style={{ gap: 6 }}>
        <Txt v="small" tone="muted" bold>{t('eightySix.photos')}</Txt>
        {kept.length || added.length ? (
          <View style={styles.photoRow}>
            {kept.map((p) => (
              <View key={p.id} style={[styles.photo, { borderColor: c.border, backgroundColor: c.surface2 }]}>
                <E86Image id={p.id} style={StyleSheet.absoluteFill} />
                {p.canRemove ? <Pressable onPress={() => removeKept(p.id)} accessibilityRole="button" accessibilityLabel={t('eightySix.removePhoto')} style={styles.photoX} hitSlop={6}><Icon name="x" size={14} color="#fff" /></Pressable> : null}
              </View>
            ))}
            {added.map((p, i) => (
              <View key={p.uri + i} style={[styles.photo, { borderColor: c.border, backgroundColor: c.surface2 }]}>
                <Image source={{ uri: p.dataUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                <Pressable onPress={() => setAdded((x) => x.filter((_, k) => k !== i))} accessibilityRole="button" accessibilityLabel={t('eightySix.removePhoto')} style={styles.photoX} hitSlop={6}><Icon name="x" size={14} color="#fff" /></Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {room > 0 ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button small icon="camera" title={t('eightySix.takePhoto')} onPress={() => addPhotos('camera')} style={{ flexGrow: 1 }} />
            <Button small icon="image" title={t('eightySix.choosePhoto')} onPress={() => addPhotos('library')} style={{ flexGrow: 1 }} />
          </View>
        ) : null}
        <Txt v="tiny" tone="faint">{t('eightySix.photosHelp')}</Txt>
      </View>
      {board.areas.length ? (
        <View style={{ gap: 6 }}>
          <Pressable onPress={() => setAreaOpen(!areaOpen)} accessibilityRole="button" accessibilityState={{ expanded: areaOpen }} style={styles.areaRow}>
            <Txt v="small" tone="muted" bold style={{ flex: 1 }}>{t('eightySix.area')}</Txt>
            <Txt v="small" tone={area ? 'text' : 'faint'} bold={!!area}>{area || t('eightySix.noArea')}</Txt>
            <Icon name={areaOpen ? 'down' : 'right'} size={16} color={c.text3} />
          </Pressable>
          {areaOpen ? <Tabs tabs={[{ value: '', label: t('eightySix.noArea') }, ...board.areas.map((a) => ({ value: a, label: a }))]} value={area} onChange={(v) => { setArea(v); setAreaOpen(false); }} /> : null}
        </View>
      ) : null}

      <View style={styles.choices}>
        <Pressable onPress={busy ? undefined : () => send('low')} accessibilityRole="button" accessibilityState={{ disabled: busy }}
          style={({ pressed }) => [styles.choice, { backgroundColor: c.warnSoft, borderColor: c.warn, opacity: busy ? 0.55 : pressed ? 0.8 : 1 }]}>
          <Text style={[styles.choiceText, { color: c.warn }]}>{t('eightySix.markLow')}</Text>
        </Pressable>
        <Pressable onPress={busy ? undefined : () => send('out')} accessibilityRole="button" accessibilityState={{ disabled: busy }}
          style={({ pressed }) => [styles.choice, { backgroundColor: c.bad, borderColor: c.bad, opacity: busy ? 0.55 : pressed ? 0.8 : 1 }]}>
          <Icon name="ban" size={18} color="#fff" />
          <Text style={[styles.choiceText, { color: '#fff' }]}>{uploading ? t('eightySix.uploading') : t('eightySix.markOut')}</Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  picked: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { width: 76, height: 76, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  photoX: { position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(15,23,42,0.75)', alignItems: 'center', justifyContent: 'center' },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  resultName: { flex: 1, fontSize: 16, fontWeight: '600' },
  choices: { flexDirection: 'row', gap: 10, marginTop: 4 },
  choice: { flex: 1, minHeight: 52, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 10 },
  choiceText: { fontSize: 16, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
});
