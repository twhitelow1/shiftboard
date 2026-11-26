// Working a stock list, the main phone flow: each product with its photo, how many, where it's kept, and three big
// buttons: Got it, Short (then how many you brought), Out. After Out, one tap reports it to the 86 List (the right
// list, marked out); after Short, one tap reports it running low. Progress saves with every tap, and someone else
// working the same list (every Barback on today's schedule) shows up here as it happens. Managers see it read-only.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { StockPhoto } from '@/components/StockPhoto';
import { Progress } from '@/components/StockParts';
import { Badge, Button, Card, Empty, Field, Loading, Notice, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { qtyText, type StockLine, type StockList } from '@/lib/stock';

const name86 = (l: { name: string; nameEs: string } | null, lang: string) => (lang === 'es' && l?.nameEs ? l.nameEs : l?.name || '');

export default function StockListScreen() {
  const { t, date, time, stamp } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const errorText = useErrorText();
  const res = useRpc<StockList>('stock.list.get', { id });
  const [l, setL] = useState<StockList | null>(null);
  useEffect(() => { if (res.data) setL(res.data); }, [res.data]);
  // Live: reload every 10 seconds while it isn't done (someone else may be working it).
  useEffect(() => {
    if (!l || l.status === 'done') return;
    const timer = setInterval(() => { res.reload(); }, 10000);
    return () => clearInterval(timer);
  }, [l?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Screen title={l?.name || t('stock.title')} back bottomInset onRefresh={res.reload}>
      {!l && !res.error ? <Loading label={t('common.loading')} /> : null}
      {res.error && !l ? <Empty icon="alert" title={errorText(res.error)}><Button title={t('common.retry')} onPress={res.reload} /></Empty> : null}
      {l ? (
        <>
          <Card style={{ gap: 6 }}>
            {l.assignLabel ? <Txt v="small" tone="muted">{t('stock.forWho', { who: l.assignLabel })}</Txt> : null}
            {l.date || l.due ? <Txt v="small" tone="muted">{[l.date ? date(l.date) : '', l.due ? t('stock.dueAt', { time: time(l.due) }) : ''].filter(Boolean).join(' · ')}</Txt> : null}
            {l.notes ? <Txt>{l.notes}</Txt> : null}
            <Progress counts={l.counts} />
          </Card>
          {l.status === 'done' && l.doneBy && l.doneAt ? <Notice tone="ok" icon="check" text={t('stock.allDone', { name: l.doneBy.name, when: stamp(l.doneAt) })} /> : null}
          {l.lines.map((x) => <Line key={x.id} x={x} list={l} onChange={setL} />)}
        </>
      ) : null}
    </Screen>
  );
}

function Line({ x, list, onChange }: { x: StockLine; list: StockList; onChange: (l: StockList) => void }) {
  const { t, lang, stamp } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const [short, setShort] = useState(false);
  const [brought, setBrought] = useState('');
  const [busy, setBusy] = useState(false);
  const [big, setBig] = useState(false);
  const insets = useSafeAreaInsets();
  const working = list.canWork && list.kind === 'list';
  const run = async (method: string, args: object, ok?: (r: StockList & { eightySix?: { listName: string } }) => string) => {
    setBusy(true);
    try {
      const r = await client.call<StockList & { eightySix?: { listName: string } }>(method, { id: list.id, lineId: x.id, ...args });
      onChange(r);
      if (ok) toast(ok(r));
      bump();
      return true;
    } catch (e) {
      toast(errorText(e), 'bad');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const mark = (state: 'got' | 'short' | 'out' | null, extra: object = {}) => run('stock.mark', { state, ...extra });
  const report = (status: 'out' | 'low') => run('stock.reportEightySix', { status },
    (r) => t(status === 'out' ? 'stock.reportedOut' : 'stock.reportedLow', { name: x.name, list: r.eightySix?.listName || '' }));
  const tone = x.state === 'got' ? c.ok : x.state === 'short' ? c.warn : x.state === 'out' ? c.bad : c.border;
  return (
    <Card pad={false} style={[styles.line, { borderLeftColor: tone }]}>
      <View style={styles.row}>
        <Pressable onPress={() => setBig(true)} accessibilityRole="imagebutton" accessibilityLabel={t('stock.seePhoto', { name: x.name })}>
          <StockPhoto product={x} size={84} />
        </Pressable>
        <View style={{ flex: 1, gap: 3 }}>
          <Txt v="h3">{x.name}{x.size ? ` · ${x.size}` : ''}</Txt>
          <Txt bold tone="brand" style={{ fontSize: 18 }}>{t('stock.bring', { qty: qtyText(x) })}</Txt>
          {x.location ? <View style={styles.loc}><Icon name="pin" size={15} color={c.text2} /><Txt v="small" tone="muted" style={{ flexShrink: 1 }}>{x.location}</Txt></View> : null}
          {x.note ? <Txt v="small" style={{ fontStyle: 'italic' }}>{x.note}</Txt> : null}
          {x.state ? (
            <View style={{ flexDirection: 'row' }}>
              <Badge tone={x.state === 'got' ? 'ok' : x.state === 'short' ? 'warn' : 'bad'}
                text={x.state === 'got' ? t('stock.got') : x.state === 'short' ? t('stock.shortN', { n: x.brought ?? 0 }) : t('stock.out')} />
            </View>
          ) : null}
          {x.state && x.by && x.at ? <Txt v="tiny" tone="faint">{x.by.name} · {stamp(x.at)}</Txt> : null}
        </View>
      </View>

      {working && !x.state && !short ? (
        <View style={styles.btns}>
          <Big label={t('stock.gotIt')} icon="check" fg={c.ok} bg={c.okSoft} disabled={busy} onPress={() => mark('got')} />
          <Big label={t('stock.short')} fg={c.warn} bg={c.warnSoft} disabled={busy} onPress={() => setShort(true)} />
          <Big label={t('stock.out')} icon="ban" fg={c.bad} bg={c.badSoft} disabled={busy} onPress={() => mark('out')} />
        </View>
      ) : null}
      {working && short && !x.state ? (
        <View style={{ gap: 8, padding: 12, paddingTop: 0 }}>
          <Field label={t('stock.howManyBrought', { qty: qtyText(x) })} value={brought} onChangeText={(v) => setBrought(v.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" autoFocus />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button kind="primary" title={t('common.save')} busy={busy} onPress={async () => { if (await mark('short', { brought: brought.replace(',', '.') })) setShort(false); }} style={{ flex: 1 }} />
            <Button title={t('common.cancel')} onPress={() => setShort(false)} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
      {working && x.state ? (
        <View style={styles.after}>
          {x.state === 'out' && x.eightySix && !x.reported86 ? (
            <Pressable onPress={busy ? undefined : () => report('out')} accessibilityRole="button" style={({ pressed }) => [styles.report, { backgroundColor: c.bad, opacity: busy ? 0.55 : pressed ? 0.85 : 1 }]}>
              <Icon name="ban" size={18} color="#fff" />
              <Text style={styles.reportText}>{t('stock.reportOut', { list: name86(x.eightySix, lang) })}</Text>
            </Pressable>
          ) : null}
          {x.state === 'short' && x.eightySix && !x.reported86 ? (
            <Pressable onPress={busy ? undefined : () => report('low')} accessibilityRole="button" style={({ pressed }) => [styles.report, { backgroundColor: c.warnSoft, borderColor: c.warn, borderWidth: 1, opacity: busy ? 0.55 : pressed ? 0.85 : 1 }]}>
              <Text style={[styles.reportText, { color: c.warn }]}>{t('stock.reportLow', { list: name86(x.eightySix, lang) })}</Text>
            </Pressable>
          ) : null}
          {x.reported86 ? <Txt v="small" tone="muted">{x.reported86.status === 'out' ? t('stock.on86Out', { list: x.reported86.listName }) : t('stock.on86Low', { list: x.reported86.listName })}</Txt> : null}
          <Button small kind="ghost" title={t('stock.undo')} onPress={() => mark(null)} disabled={busy} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}
      {!working && x.reported86 ? <Txt v="small" tone="muted" style={{ padding: 12, paddingTop: 0 }}>{x.reported86.status === 'out' ? t('stock.on86Out', { list: x.reported86.listName }) : t('stock.on86Low', { list: x.reported86.listName })}</Txt> : null}

      {big ? (
        <Modal visible animationType="fade" onRequestClose={() => setBig(false)} supportedOrientations={['portrait']}>
          <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <View style={styles.viewerTop}>
              <Text style={styles.viewerTitle} numberOfLines={2}>{x.name}</Text>
              <Pressable onPress={() => setBig(false)} accessibilityRole="button" accessibilityLabel={t('common.close')} style={styles.round} hitSlop={6}><Icon name="x" size={24} color="#fff" /></Pressable>
            </View>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><StockPhoto product={x} size={320} fit="contain" /></View>
          </View>
        </Modal>
      ) : null}
    </Card>
  );
}

function Big({ label, icon, fg, bg, onPress, disabled }: { label: string; icon?: 'check' | 'ban'; fg: string; bg: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={disabled ? undefined : onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.big, { backgroundColor: bg, borderColor: fg, opacity: disabled ? 0.55 : pressed ? 0.8 : 1 }]}>
      {icon ? <Icon name={icon} size={20} color={fg} /> : null}
      <Text style={[styles.bigText, { color: fg }]} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: { overflow: 'hidden', borderLeftWidth: 5 },
  row: { flexDirection: 'row', gap: 12, padding: 12, alignItems: 'flex-start' },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  btns: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  big: { flex: 1, minHeight: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4 },
  bigText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  after: { gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
  report: { minHeight: 52, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  reportText: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
  viewer: { flex: 1, backgroundColor: '#05070c' },
  viewerTop: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, minHeight: 56 },
  viewerTitle: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700' },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
