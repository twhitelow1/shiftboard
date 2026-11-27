// A saved list (par list, core/stock-saved.js): its products with their pars and what each usually needs, the par
// change requests (the owner and managers answer them), who it's shared with (the owner and managers share and
// unshare: a person, a role, a position or a room, to use or to edit), and its last runs. "Run it" counts it down
// (stock-run.tsx). Building and reordering lists is easiest on the website; the phone runs them.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { StockPhoto } from '@/components/StockPhoto';
import { Badge, Button, Card, Chips, Empty, Loading, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { SavedList, SavedOptions } from '@/lib/stock';

export default function SavedListScreen() {
  const { t, tn, stamp } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, bump } = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();
  const res = useRpc<SavedList>('stock.saved.get', { id });
  const [l, setL] = useState<SavedList | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => { if (res.data) setL(res.data); }, [res.data]);
  const act = async (method: string, args: object, ok: string) => {
    try { const r = await client.call<SavedList>(method, { id, ...args }); setL(r); toast(ok); bump(); } catch (e) { toast(errorText(e), 'bad'); }
  };
  return (
    <Screen title={l?.name || t('stockSaved.title')} back bottomInset onRefresh={res.reload}>
      {!l && !res.error ? <Loading label={t('common.loading')} /> : null}
      {res.error && !l ? <Empty icon="alert" title={errorText(res.error)}><Button title={t('common.retry')} onPress={res.reload} /></Empty> : null}
      {l ? (
        <>
          <Card style={{ gap: 6 }}>
            <Txt v="small" tone="muted">{[l.scopeLabel, l.owner ? t('stockSaved.byOwner', { name: l.owner.name }) : ''].filter(Boolean).join(' · ')}</Txt>
            {l.notes ? <Txt>{l.notes}</Txt> : null}
            {l.runs[0] ? <Txt v="tiny" tone="faint">{t('stockSaved.lastRun', { name: l.runs[0].by.name, when: stamp(l.runs[0].at), count: l.runs[0].needs })}</Txt> : null}
            <Button kind="primary" icon="check" title={t('stockSaved.runIt')} onPress={() => router.push({ pathname: '/stock-run', params: { id: l.id } })} block />
            {l.canShare ? <Button icon="users" title={t('stockSaved.share')} onPress={() => setSharing(!sharing)} block /> : null}
          </Card>
          {sharing && l.canShare ? <ShareBox l={l} onChanged={(r) => { setL(r); bump(); }} /> : null}
          {l.requests.length ? (
            <Card style={{ gap: 10 }}>
              <Txt v="h3">{t('stockSaved.requests')}</Txt>
              {l.requests.map((r) => (
                <View key={r.id} style={{ gap: 6 }}>
                  <Txt v="small">{t('stockSaved.requestLine', { name: r.byName, product: r.product, from: r.from, to: r.to })}{r.note ? ` · “${r.note}”` : ''}</Txt>
                  {l.canEdit ? (
                    <View style={styles.row}>
                      <Button small kind="primary" title={t('stockSaved.accept')} onPress={() => act('stock.saved.answerRequest', { requestId: r.id, accept: true }, t('stockSaved.parChanged'))} />
                      <Button small title={t('stockSaved.decline')} onPress={() => act('stock.saved.answerRequest', { requestId: r.id, accept: false }, t('stockSaved.declined'))} />
                    </View>
                  ) : null}
                </View>
              ))}
            </Card>
          ) : null}
          <Card pad={false} style={{ overflow: 'hidden' }}>
            <Txt v="h3" style={{ padding: 14, paddingBottom: 4 }}>{tn('stockSaved.products', l.lines.length)}</Txt>
            {l.lines.map((x) => (
              <View key={x.id} style={[styles.line, { borderColor: c.border, opacity: x.archived ? 0.5 : 1 }]}>
                <StockPhoto product={x} size={48} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt bold>{x.name}</Txt>
                  {x.location ? <Txt v="tiny" tone="muted">{x.location}</Txt> : null}
                  {(x.usually || 0) > 0 ? <Txt v="tiny" tone="faint">{t('stockSaved.usually', { n: x.usually || 0 })}</Txt> : null}
                </View>
                <View style={{ alignItems: 'center', minWidth: 52 }}>
                  <Txt v="tiny" tone="faint">{t('stockSaved.par')}</Txt>
                  <Txt v="h3">{x.par}</Txt>
                  <Txt v="tiny" tone="faint">{x.unitName}</Txt>
                </View>
              </View>
            ))}
          </Card>
          {l.runs.length ? (
            <Card style={{ gap: 8 }}>
              <Txt v="h3">{t('stockSaved.history')}</Txt>
              {l.runs.map((r) => (
                <View key={r.id} style={{ gap: 2 }}>
                  <Txt v="small" bold>{r.by.name} · {stamp(r.at)}</Txt>
                  <Txt v="tiny" tone="muted">{[tn('stockSaved.nNeeded', r.needs), r.skipped ? tn('stockSaved.nSkipped', r.skipped) : '',
                    r.send === 'support' ? t('stockSaved.sentTo', { to: r.to }) : r.send === 'self' ? t('stockSaved.workedSelf') : '', r.out.length ? t('stockSaved.out86', { names: r.out.join(', ') }) : ''].filter(Boolean).join(' · ')}</Txt>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** Share with a person, a role, a position or a room (use or edit), or stop sharing. */
function ShareBox({ l, onChanged }: { l: SavedList; onChanged: (l: SavedList) => void }) {
  const { t } = useI18n();
  const c = useColors();
  const toast = useToast();
  const errorText = useErrorText();
  const { client } = useApp();
  const opts = useRpc<SavedOptions>('stock.saved.options.get');
  const [type, setType] = useState<string[]>(['position']);
  const [val, setVal] = useState<string[]>([]);
  const [can, setCan] = useState<string[]>(['use']);
  const o = opts.data;
  if (!o) return <Loading label={t('common.loading')} />;
  const choices = type[0] === 'person' ? o.people.map((p) => ({ value: p.id, label: p.name })) : type[0] === 'role' ? o.roles.map((r) => ({ value: r.id, label: r.name }))
    : type[0] === 'room' ? o.rooms.map((r) => ({ value: r, label: r })) : o.positions.map((p) => ({ value: p.id, label: p.name }));
  const v = val[0];
  const to = !v ? null : type[0] === 'person' ? { type: 'person', userId: v } : type[0] === 'role' ? { type: 'role', role: v } : type[0] === 'room' ? { type: 'room', room: v } : { type: 'position', jobCodeId: v };
  const run = async (method: string, args: object, ok: string) => {
    try { onChanged(await client.call<SavedList>(method, { id: l.id, ...args })); toast(ok); } catch (e) { toast(errorText(e), 'bad'); }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Txt v="small" tone="muted">{t('stockSaved.shareSub')}</Txt>
      <Chips single options={[{ value: 'person', label: t('stockSaved.toPerson') }, { value: 'role', label: t('stockSaved.toRole') }, { value: 'position', label: t('stockSaved.toPosition') }, { value: 'room', label: t('stockSaved.toRoom') }]}
        value={type} onChange={(x) => { setType(x.length ? x : type); setVal([]); }} label={t('stockSaved.shareWith')} />
      <Chips single options={choices} value={val} onChange={setVal} label={t('stockSaved.who')} />
      <Chips single options={[{ value: 'use', label: t('stockSaved.canUse') }, { value: 'edit', label: t('stockSaved.canEdit') }]} value={can} onChange={(x) => setCan(x.length ? x : can)} label={t('stockSaved.theyCan')} />
      <Txt v="tiny" tone="faint">{t('stockSaved.canHelp')}</Txt>
      <Button kind="primary" icon="users" title={t('stockSaved.share')} disabled={!to} onPress={() => run('stock.saved.share', { to, can: can[0] }, t('stockSaved.sharedMsg'))} block />
      {l.shares.length ? <Txt v="small" bold>{t('stockSaved.sharedWith')}</Txt> : null}
      {l.shares.map((s) => (
        <View key={s.id} style={[styles.share, { borderColor: c.border }]}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Txt>{s.label}</Txt><Badge tone={s.can === 'edit' ? 'brand' : 'neutral'} text={s.can === 'edit' ? t('stockSaved.canEdit') : t('stockSaved.canUse')} />
          </View>
          <Pressable onPress={() => run('stock.saved.unshare', { shareId: s.id }, t('stockSaved.unsharedMsg'))} accessibilityRole="button" accessibilityLabel={`${t('stockSaved.unshare')}: ${s.label}`} style={styles.unshare} hitSlop={4}>
            <Txt v="small" tone="bad" bold>{t('stockSaved.unshare')}</Txt>
          </Pressable>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  share: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth },
  unshare: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
