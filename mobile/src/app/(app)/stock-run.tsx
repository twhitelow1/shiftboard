// Running a saved list down, the main phone flow (core/stock-saved.js): each product with its photo, par and where
// it's kept, a big − / + stepper (hold to go fast) or the keypad for how many are on hand, and Skip. What's needed
// (par − on hand, rounded up to the unit) adds up at the bottom, under the thumb. Done counting: send it to support (the
// barbacks on duty, a position, a room or a person: the quick-list send and its notifications), work it myself (a
// list for me, then Got it / Short / Out), mark what's out with none in the storeroom (86), or just save the count.
// The count is kept on the phone as you go (the cache folder), so it survives the app going to the background or
// being closed; it's cleared once the run is saved. Pull down to reload the list (the count stays).
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { Button, Card, Chips, Empty, Field, Loading, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { readCache, writeCache } from '@/lib/cache';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp, useSession } from '@/lib/session';
import { catName, needFor, productMatches, type Catalog, type Product, type SavedLine, type SavedList, type SavedOptions } from '@/lib/stock';

type Extra = { productId: string; name: string; category: string; photos: Product['photos']; unit: string; location: string; par: number };
type Draft = { counts: Record<string, string>; skip: Record<string, boolean>; extra: Extra[] };
type RunLine = Pick<SavedLine, 'name' | 'category' | 'photos' | 'unit' | 'location' | 'par'> & { key: string; id?: string; productId: string; unitName: string; usually?: number | null; extra?: boolean };
const EMPTY: Draft = { counts: {}, skip: {}, extra: [] };

export default function StockRun() {
  const { t, tn, lang } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client } = useApp();
  const { cachePrefix } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const res = useRpc<SavedList>('stock.saved.get', { id });
  const [l, setL] = useState<SavedList | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [finish, setFinish] = useState(false);
  const [adding, setAdding] = useState(false);
  const [par, setPar] = useState<RunLine | null>(null);
  const key = `${cachePrefix}|stockRun.${id}`;
  useEffect(() => { if (res.data) setL(res.data); }, [res.data]);
  // The count kept on the phone, first; then every change is saved as it happens.
  useEffect(() => { let live = true; readCache<Draft>(key).then((d) => { if (live) setDraft(d?.data || EMPTY); }); return () => { live = false; }; }, [key]);
  const change = (fn: (d: Draft) => Draft) => setDraft((d) => { const n = fn(d || EMPTY); writeCache(key, n); return n; });
  if (!l || !draft) {
    return <Screen title={t('stockSaved.title')} back bottomInset>{res.error ? <Empty icon="alert" title={errorText(res.error)}><Button title={t('common.retry')} onPress={res.reload} /></Empty> : <Loading label={t('common.loading')} />}</Screen>;
  }
  const lines: RunLine[] = [...l.lines.filter((x) => !x.archived).map((x) => ({ ...x, key: x.id })),
    ...draft.extra.map((x) => ({ ...x, key: `p:${x.productId}`, unitName: x.unit, extra: true }))];
  const countOf = (x: RunLine) => (draft.skip[x.key] ? null : draft.counts[x.key] ?? '');
  const needOf = (x: RunLine) => needFor(x.par, countOf(x), x.unit);
  const needs = lines.filter((x) => (needOf(x) || 0) > 0);
  const counted = lines.filter((x) => { const v = countOf(x); return v !== null && v !== ''; }).length;
  const started = Object.keys(draft.counts).length > 0;
  const addPicked = async (p: Product) => {
    setAdding(false);
    if (lines.some((x) => x.productId === p.id)) { toast(t('stockSaved.alreadyOn', { name: p.name })); return; }
    if (l.canEdit) {
      try { setL(await client.call<SavedList>('stock.saved.addLine', { id: l.id, productId: p.id, par: 1 })); toast(t('stockSaved.addedTo', { name: p.name })); } catch (e) { toast(errorText(e), 'bad'); }
    } else change((d) => ({ ...d, extra: [...d.extra, { productId: p.id, name: p.name, category: p.category, photos: p.photos, unit: p.unit, location: p.location, par: 1 }] }));
  };
  const footer = (
    <View style={styles.bar}>
      <View style={{ flex: 1 }}>
        <Txt bold>{tn('stockSaved.needsSummary', needs.length)}</Txt>
        <Txt v="tiny" tone="muted">{t('stockSaved.countedOf', { n: counted, total: lines.length })}</Txt>
      </View>
      <Button kind="primary" title={t('stockSaved.finish')} onPress={() => setFinish(true)} disabled={!counted} />
    </View>
  );
  return (
    <Screen title={l.name} back onRefresh={res.reload} footer={footer}>
      <Txt v="small" tone="muted">{t('stockSaved.runHelp')}</Txt>
      {started ? (
        <Pressable onPress={() => change(() => EMPTY)} accessibilityRole="button" style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}>
          <Txt v="small" tone="brand" bold>{t('stockSaved.startOver')}</Txt>
        </Pressable>
      ) : null}
      {lines.map((x) => {
        const v = countOf(x);
        const need = needOf(x);
        const skipped = !!draft.skip[x.key];
        return (
          <Card key={x.key} pad={false} style={[styles.line, { borderLeftColor: skipped ? c.border : need && need > 0 ? c.warn : v !== '' && v !== null ? c.ok : c.border, opacity: skipped ? 0.6 : 1 }]}>
            <View style={styles.row}>
              <StockPhoto product={x} size={64} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="h3">{x.name}</Txt>
                <Txt v="small" bold>{x.unitName ? t('stockSaved.parIs', { n: x.par, unit: x.unitName }) : `${t('stockSaved.par')} ${x.par}`}{(x.usually || 0) > 0 ? <Txt v="small" tone="muted">{` · ${t('stockSaved.usually', { n: x.usually || 0 })}`}</Txt> : null}</Txt>
                {x.location ? <View style={styles.loc}><Icon name="pin" size={13} color={c.text3} /><Txt v="tiny" tone="muted" style={{ flexShrink: 1 }}>{x.location}</Txt></View> : null}
              </View>
              <View style={[styles.need, need && need > 0 ? { backgroundColor: c.warnSoft } : null]} accessibilityLiveRegion="polite">
                <Text style={{ color: need && need > 0 ? c.warn : c.ok, fontWeight: '800', fontSize: 15 }}>{need === null ? '' : need > 0 ? t('stockSaved.needN', { n: need }) : '✓'}</Text>
              </View>
            </View>
            <View style={styles.ctl}>
              <Stepper value={v === null ? '' : v} disabled={skipped} label={t('stockSaved.onHandFor', { name: x.name })}
                onChange={(n) => change((d) => ({ ...d, counts: { ...d.counts, [x.key]: n }, skip: { ...d.skip, [x.key]: false } }))} />
              <Pressable onPress={() => change((d) => ({ ...d, skip: { ...d.skip, [x.key]: !d.skip[x.key] } }))} accessibilityRole="button" accessibilityState={{ selected: skipped }}
                style={({ pressed }) => [styles.skip, { borderColor: c.border, backgroundColor: skipped ? c.surface2 : pressed ? c.surface2 : c.surface }]}>
                <Text style={{ color: c.text2, fontWeight: '700' }}>{skipped ? t('stockSaved.skipped') : t('stockSaved.skip')}</Text>
              </Pressable>
            </View>
            {!x.extra ? (
              <Pressable onPress={() => setPar(x)} accessibilityRole="button" style={styles.parLink} hitSlop={4}>
                <Txt v="tiny" tone="brand" bold>{l.canEdit ? t('stockSaved.changePar') : t('stockSaved.askPar')}</Txt>
              </Pressable>
            ) : null}
          </Card>
        );
      })}
      <Button icon="plus" title={t('stockSaved.addOnFly')} onPress={() => setAdding(true)} block />
      {finish ? <Finish l={l} lines={lines} countOf={countOf} needOf={needOf} onClose={() => setFinish(false)}
        onDone={async (listId) => { await writeCache(key, EMPTY); setDraft(EMPTY); setFinish(false); if (listId) router.replace({ pathname: '/stock-list', params: { id: listId } }); else router.back(); }} /> : null}
      {adding ? <AddLine lang={lang} onClose={() => setAdding(false)} onPick={addPicked} /> : null}
      {par ? <ParSheet l={l} line={par} onClose={() => setPar(null)} onSaved={(r) => { setL(r); setPar(null); }} /> : null}
    </Screen>
  );
}

/** − / + (hold to repeat, faster after a while) and the number in between, typed with the keypad. */
function Stepper({ value, onChange, label, disabled }: { value: string; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  const c = useColors();
  const cur = useRef(value);
  cur.current = value;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const step = (d: number) => { const n = Number(cur.current === '' ? 0 : cur.current) || 0; const v = String(Math.max(0, Math.round((n + d) * 100) / 100)); cur.current = v; onChange(v); };
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const hold = (d: number) => { let n = 0; const again = () => { n++; step(d * (n > 10 ? 5 : 1)); timer.current = setTimeout(again, 90); }; timer.current = setTimeout(again, 450); };
  useEffect(() => stop, []);
  const btn = (d: number, text: string) => (
    <Pressable onPress={() => step(d)} onLongPress={() => hold(d)} delayLongPress={350} onPressOut={stop} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={`${d > 0 ? '+1' : '−1'} ${label}`} style={({ pressed }) => [styles.step, { borderColor: c.border, backgroundColor: pressed ? c.brandSoft : c.surface2, opacity: disabled ? 0.5 : 1 }]}>
      <Text style={[styles.stepText, { color: c.text }]}>{text}</Text>
    </Pressable>
  );
  return (
    <View style={styles.stepper}>
      {btn(-1, '−')}
      <TextInput value={value} onChangeText={(v) => onChange(v.replace(',', '.').replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder="0" editable={!disabled}
        accessibilityLabel={label} selectTextOnFocus style={[styles.count, { borderColor: c.border, color: c.text, backgroundColor: c.surface }]} placeholderTextColor={c.text3} />
      {btn(1, '+')}
    </View>
  );
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} supportedOrientations={['portrait']}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: c.bg, paddingBottom: 16 + insets.bottom }]}>
          <View style={styles.sheetTop}>
            <Txt v="h2" style={{ flex: 1 }}>{title}</Txt>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} style={styles.round} hitSlop={6}><Icon name="x" size={22} color={c.text} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** The end: send to support, work it myself, mark what's out (86), or just save the count. */
function Finish({ l, lines, countOf, needOf, onClose, onDone }: {
  l: SavedList; lines: RunLine[]; countOf: (x: RunLine) => string | null; needOf: (x: RunLine) => number | null; onClose: () => void; onDone: (listId: string | null) => void;
}) {
  const { t, tn } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const opts = useRpc<SavedOptions>('stock.saved.options.get');
  const [to, setTo] = useState<string[]>([]);
  const [job, setJob] = useState<string[]>([]);
  const [room, setRoom] = useState<string[]>([]);
  const [person, setPerson] = useState<string[]>([]);
  const [out, setOut] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const o = opts.data;
  useEffect(() => { if (o) { setTo([o.support.jobCodeId ? 'duty' : 'position']); setRoom(o.support.room ? [o.support.room] : []); } }, [o]);
  const zero = lines.filter((x) => { const v = countOf(x); return v !== null && v !== '' && Number(v) === 0; });
  const needs = lines.filter((x) => (needOf(x) || 0) > 0 && !out.includes(x.key));
  const counts = lines.map((x) => { const v = countOf(x); const skip = v === null || v === ''; return x.extra ? { productId: x.productId, par: x.par, onHand: skip ? null : v, skip } : { lineId: x.id, onHand: skip ? null : v, skip }; });
  const way = to[0];
  const assign = !o ? null : way === 'person' ? (person[0] ? { type: 'person', userId: person[0] } : null) : way === 'room' ? (room[0] ? { type: 'room', room: room[0] } : null)
    : way === 'duty' ? (o.support.jobCodeId ? { type: 'position', jobCodeId: o.support.jobCodeId, ...(o.support.room ? { room: o.support.room } : {}) } : null)
      : job[0] ? { type: 'position', jobCodeId: job[0], ...(room[0] ? { room: room[0] } : {}) } : null;
  const run = async (send: 'support' | 'self' | 'none') => {
    setBusy(true);
    try {
      const r = await client.call<{ list: { id: string } | null; notified: number; eightySix: { name: string }[] }>('stock.saved.run',
        { id: l.id, counts, send, assign: send === 'support' ? assign : null, out: out.map((k) => (k.startsWith('p:') ? k.slice(2) : k)) });
      toast(send === 'support' ? (r.notified ? tn('stockSaved.sentN', r.notified) : t('stockSaved.sentNobody')) : send === 'self' ? t('stockSaved.madeForMe') : t('stockSaved.countSaved'));
      if (r.eightySix.length) toast(t('stockSaved.reported86', { names: r.eightySix.map((x) => x.name).join(', ') }));
      bump();
      onDone(r.list?.id || null);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('stockSaved.finishTitle')} onClose={onClose}>
      <Txt bold>{tn('stockSaved.needsSummary', needs.length)}</Txt>
      {needs.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {needs.map((x) => (
            <View key={x.key} style={[styles.needRow, { borderColor: c.border }]}><Txt style={{ flex: 1 }}>{x.name}</Txt><Txt bold>{needOf(x)} {x.unitName}</Txt></View>
          ))}
        </Card>
      ) : null}
      {zero.length ? (
        <View style={{ gap: 6 }}>
          <Txt bold>{t('stockSaved.outTitle')}</Txt>
          <Txt v="small" tone="muted">{t('stockSaved.outHelp')}</Txt>
          <Chips options={zero.map((x) => ({ value: x.key, label: x.name }))} value={out} onChange={setOut} label={t('stockSaved.outTitle')} />
        </View>
      ) : null}
      {!o ? <Loading label={t('common.loading')} /> : (
        <>
          <View style={[styles.choice, { borderColor: c.border }]}>
            <Txt v="h3">{t('stockSaved.sendSupport')}</Txt>
            <Chips single options={[...(o.support.jobCodeId ? [{ value: 'duty', label: t('stockSaved.toDuty') }] : []), { value: 'position', label: t('stockSaved.toPosition') },
              { value: 'room', label: t('stockSaved.toRoom') }, { value: 'person', label: t('stockSaved.toPerson') }]} value={to} onChange={(v) => setTo(v.length ? v : to)} label={t('stockSaved.sendSupport')} />
            {way === 'duty' ? <Txt v="tiny" tone="muted">{t('stockSaved.dutyHelp', { room: o.support.room || t('stockSaved.anyRoom') })}</Txt> : null}
            {way === 'position' ? <Chips single options={o.positions.map((p) => ({ value: p.id, label: p.name }))} value={job} onChange={setJob} label={t('stockSaved.toPosition')} /> : null}
            {way === 'position' || way === 'room' ? <Chips single options={o.rooms.map((r) => ({ value: r, label: r }))} value={room} onChange={setRoom} label={t('stockSaved.room')} /> : null}
            {way === 'person' ? <Chips single options={o.people.map((p) => ({ value: p.id, label: p.name }))} value={person} onChange={setPerson} label={t('stockSaved.toPerson')} /> : null}
            <Button kind="primary" icon="send" title={way === 'duty' ? t('stockSaved.sendToBarbacks') : t('stockSaved.send')} onPress={() => run('support')} busy={busy} disabled={!needs.length || !assign} block />
          </View>
          <View style={[styles.choice, { borderColor: c.border }]}>
            <Txt v="h3">{t('stockSaved.workSelf')}</Txt>
            <Txt v="tiny" tone="muted">{t('stockSaved.workSelfHelp')}</Txt>
            <Button icon="check" title={t('stockSaved.workSelfBtn')} onPress={() => run('self')} disabled={busy || !needs.length} block />
          </View>
          <Button kind="ghost" title={t('stockSaved.justSave')} onPress={() => run('none')} disabled={busy} block />
        </>
      )}
    </Sheet>
  );
}

/** Add a product during the run: search the catalog (kept on the phone), or add a new one. */
function AddLine({ lang, onClose, onPick }: { lang: string; onClose: () => void; onPick: (p: Product) => void }) {
  const { t } = useI18n();
  const c = useColors();
  const cat = useRpc<Catalog>('products.list', {}, [], true, { cache: 'products' });
  const [q, setQ] = useState('');
  const shown = cat.data && q.trim() ? cat.data.products.filter((p) => productMatches(p, q, catName(cat.data!.categories, p.category, lang))).slice(0, 20) : [];
  return (
    <Sheet title={t('stockSaved.addOnFly')} onClose={onClose}>
      <Field label={t('stock.search')} value={q} onChangeText={setQ} placeholder={t('stock.searchPh')} autoCorrect={false} autoFocus />
      {shown.map((p) => (
        <Pressable key={p.id} onPress={() => onPick(p)} accessibilityRole="button" accessibilityLabel={t('stock.addToList', { name: p.name })}
          style={({ pressed }) => [styles.result, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
          <StockPhoto product={p} size={44} />
          <Txt bold style={{ flex: 1 }}>{p.name}</Txt>
          <Icon name="plus" size={20} color={c.brand} />
        </Pressable>
      ))}
      <Button icon="camera" title={t('stock.addProduct')} onPress={() => { onClose(); router.push('/add-product'); }} block />
    </Sheet>
  );
}

/** A par: changed right away (the owner, managers, people it's shared with to edit), or asked for (the owner decides). */
function ParSheet({ l, line, onClose, onSaved }: { l: SavedList; line: RunLine; onClose: () => void; onSaved: (l: SavedList) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const [v, setV] = useState(String(line.par));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await client.call<SavedList>(l.canEdit ? 'stock.saved.setPar' : 'stock.saved.requestPar', { id: l.id, lineId: line.id, par: v, ...(l.canEdit ? {} : { note }) });
      toast(l.canEdit ? t('stockSaved.parChanged') : t('stockSaved.parAsked'));
      bump();
      onSaved(r);
    } catch (e) { toast(errorText(e), 'bad'); } finally { setBusy(false); }
  };
  return (
    <Sheet title={l.canEdit ? t('stockSaved.changeParFor', { name: line.name }) : t('stockSaved.askParFor', { name: line.name })} onClose={onClose}>
      {!l.canEdit ? <Txt v="small" tone="muted">{t('stockSaved.askParSub')}</Txt> : null}
      <Stepper value={v} onChange={setV} label={t('stockSaved.par')} />
      {!l.canEdit ? <Field label={t('stockSaved.why')} value={note} onChangeText={setNote} maxLength={200} /> : null}
      <Button kind="primary" title={l.canEdit ? t('common.save') : t('stockSaved.send')} onPress={save} busy={busy} block />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  line: { overflow: 'hidden', borderLeftWidth: 5, gap: 10, paddingBottom: 8 },
  row: { flexDirection: 'row', gap: 10, padding: 12, paddingBottom: 0, alignItems: 'flex-start' },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  need: { minWidth: 64, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10 },
  ctl: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  stepper: { flex: 1, flexDirection: 'row', gap: 6 },
  step: { width: 56, height: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 28, fontWeight: '800' },
  count: { flex: 1, minWidth: 56, height: 56, borderRadius: 14, borderWidth: 1, textAlign: 'center', fontSize: 22, fontWeight: '800' },
  skip: { minWidth: 72, height: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  parLink: { alignSelf: 'flex-start', paddingHorizontal: 12, minHeight: 28, justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8 },
  sheetTop: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  needRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  choice: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1 },
});
