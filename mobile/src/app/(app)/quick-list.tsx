// A quick list from anyone on shift (a bartender who needs bottles): search the library, tap products, set how many,
// an optional note, then "Send to barbacks on duty": everyone on shift now as a Barback in the sender's room (or a
// position or room they pick). They get a notification and check it off; the sender watches it in My lists.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { Button, Card, Chips, Empty, Field, Loading, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { catName, productMatches, type Catalog, type StockList, type StockOptions } from '@/lib/stock';

type Line = { productId: string; qty: number };

export default function QuickList() {
  const { t, tn, lang } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const cat = useRpc<Catalog>('products.list', {}, [], true, { cache: 'products' });
  const opts = useRpc<StockOptions>('stock.options.get');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [to, setTo] = useState<'position' | 'room'>('position');
  const [job, setJob] = useState<string[]>([]);
  const [room, setRoom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!opts.data) return;
    if (opts.data.quick.jobCodeId) setJob([opts.data.quick.jobCodeId]);
    if (opts.data.quick.room) setRoom([opts.data.quick.room]);
  }, [opts.data]);
  if (!cat.data || !opts.data) {
    return <Screen title={t('stock.quickList')} back bottomInset>{cat.error || opts.error ? <Empty icon="alert" title={errorText(cat.error || opts.error)} /> : <Loading label={t('common.loading')} />}</Screen>;
  }
  const o = opts.data;
  const byId = Object.fromEntries(cat.data.products.map((p) => [p.id, p]));
  const results = q.trim() ? cat.data.products.filter((p) => productMatches(p, q, catName(cat.data!.categories, p.category, lang))).slice(0, 8) : [];
  const add = (id: string) => { setLines((ls) => (ls.some((x) => x.productId === id) ? ls.map((x) => (x.productId === id ? { ...x, qty: x.qty + 1 } : x)) : [...ls, { productId: id, qty: 1 }])); setQ(''); };
  const setQty = (id: string, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((x) => x.productId !== id) : ls.map((x) => (x.productId === id ? { ...x, qty } : x))));
  const assign = to === 'position' ? (job[0] ? { type: 'position', jobCodeId: job[0], ...(room[0] ? { room: room[0] } : {}) } : null) : room[0] ? { type: 'room', room: room[0] } : null;
  const toBarbacks = to === 'position' && !!o.quick.jobCodeId && job[0] === o.quick.jobCodeId;
  const send = async () => {
    setBusy(true);
    try {
      const now = new Date();
      const name = t('stock.quickDefaultName', { time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
      const r = await client.call<StockList & { notified: number }>('stock.save', { kind: 'list', quick: true, name, notes: note, lines, assign });
      toast(r.notified ? tn('stock.sentTo', r.notified) : t('stock.sentNobody'));
      bump();
      router.replace({ pathname: '/stock-list', params: { id: r.id } });
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t('stock.quickList')} back bottomInset>
      <Txt v="small" tone="muted">{t('stock.quickIntro')}</Txt>
      <Field label={t('stock.search')} value={q} onChangeText={setQ} placeholder={t('stock.searchPh')} autoCorrect={false} returnKeyType="search" />
      {results.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {results.map((p) => (
            <Pressable key={p.id} onPress={() => add(p.id)} accessibilityRole="button" accessibilityLabel={t('stock.addToList', { name: p.name })}
              style={({ pressed }) => [styles.result, { borderColor: c.border }, pressed && { backgroundColor: c.surface2 }]}>
              <StockPhoto product={p} size={48} />
              <View style={{ flex: 1 }}><Txt bold>{p.name}{p.size ? ` · ${p.size}` : ''}</Txt>{p.location ? <Txt v="tiny" tone="muted">{p.location}</Txt> : null}</View>
              <Icon name="plus" size={22} color={c.brand} />
            </Pressable>
          ))}
        </Card>
      ) : null}
      <Card pad={false} style={{ overflow: 'hidden' }}>
        {!lines.length ? <Txt v="small" tone="faint" style={{ padding: 14 }}>{t('stock.noLinesYet')}</Txt> : null}
        {lines.map((x) => {
          const p = byId[x.productId];
          return (
            <View key={x.productId} style={[styles.line, { borderColor: c.border }]}>
              {p ? <StockPhoto product={p} size={48} /> : null}
              <Txt bold style={{ flex: 1 }}>{p?.name || ''}</Txt>
              <Pressable onPress={() => setQty(x.productId, x.qty - 1)} accessibilityRole="button" accessibilityLabel={t('stock.less')} style={[styles.step, { borderColor: c.border }]}><Text style={[styles.stepText, { color: c.text }]}>−</Text></Pressable>
              <Txt v="h3" style={{ minWidth: 28, textAlign: 'center' }}>{x.qty}</Txt>
              <Pressable onPress={() => setQty(x.productId, x.qty + 1)} accessibilityRole="button" accessibilityLabel={t('stock.more')} style={[styles.step, { borderColor: c.border }]}><Text style={[styles.stepText, { color: c.text }]}>+</Text></Pressable>
            </View>
          );
        })}
      </Card>
      <Field label={t('stock.note')} value={note} onChangeText={setNote} placeholder={t('stock.notePh')} maxLength={300} />
      <View style={{ gap: 6 }}>
        <Txt v="small" tone="muted" bold>{t('stock.sendTo')}</Txt>
        <Chips single options={[{ value: 'position', label: t('stock.toPosition') }, { value: 'room', label: t('stock.toWholeRoom') }]} value={[to]} onChange={(v) => setTo((v[0] as 'position' | 'room') || to)} label={t('stock.sendTo')} />
        {to === 'position' ? <Chips single options={o.positions.map((p) => ({ value: p.id, label: p.name }))} value={job} onChange={setJob} label={t('stock.toPosition')} /> : null}
        <Chips single options={o.rooms.map((r) => ({ value: r, label: r }))} value={room} onChange={setRoom} label={t('stock.toWholeRoom')} />
      </View>
      <Button kind="primary" icon="send" title={toBarbacks ? t('stock.sendToBarbacks') : t('stock.send')} onPress={send} busy={busy} disabled={!lines.length || !assign} block />
    </Screen>
  );
}

const styles = StyleSheet.create({
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
  step: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 22, fontWeight: '700' },
});
