// Feedback box (More → Feedback box): write an entry (anonymous unless they sign it), My feedback (the codes kept on
// this phone with a "New reply" badge, Open with a code, the signed ones) and "You said, we did". Readers get a link
// to the inbox. The rules and what's stored: core/feedback.js; the codes on the phone: lib/feedback.ts.
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { HowAnonymous, StatusBadge } from '@/components/Feedback';
import { Badge, Button, Card, Empty, Field, ListRow, Loading, Notice, SectionTitle, Tabs, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { copyOrShare, formatCode, keepCode, savedCodes, signedSeen, type BoardItem, type CodeSummary, type FeedbackForm, type MyEntry, type SavedCode } from '@/lib/feedback';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

type Tab = 'write' | 'mine' | 'board';
const pick = (v?: string): Tab => (v === 'mine' || v === 'board' ? v : 'write');
const MAX = 2000;

export default function FeedbackBox() {
  const { t } = useI18n();
  const { has } = useApp();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(() => pick(params.tab));
  useEffect(() => { if (params.tab) setTab(pick(params.tab)); }, [params.tab]);
  return (
    <Screen title={t('feedback.title')} back bottomInset>
      {has('feedbackInbox') ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          <ListRow icon="message" title={t('feedback.inboxTitle')} sub={t('feedback.inboxHelp')} onPress={() => router.push('/feedback-inbox')} />
        </Card>
      ) : null}
      <Tabs tabs={[{ value: 'write', label: t('feedback.tabWrite') }, { value: 'mine', label: t('feedback.tabMine') }, { value: 'board', label: t('feedback.tabBoard') }]}
        value={tab} onChange={setTab} />
      {tab === 'write' ? <Write onMine={() => setTab('mine')} /> : tab === 'mine' ? <Mine /> : <Board />}
    </Screen>
  );
}

// ---------- write ----------
function Write({ onMine }: { onMine: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const { client, server } = useApp();
  const form = useRpc<FeedbackForm>('feedback.form.get');
  const [kind, setKind] = useState('');
  const [topic, setTopic] = useState('');
  const [message, setMessage] = useState('');
  const [signed, setSigned] = useState(false);
  const [done, setDone] = useState<{ code?: string; signed: boolean; kept: boolean } | null>(null);
  const [run, busy] = useAction();
  const errorText = useErrorText();
  useEffect(() => { if (form.data && !kind) setKind(form.data.kinds[0]?.id || ''); }, [form.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (form.error && !form.data) return <Empty icon="alert" title={errorText(form.error)}><Button title={t('common.retry')} onPress={form.reload} /></Empty>;
  if (!form.data) return <Loading label={t('common.loading')} />;
  if (done) return <Sent done={done} onAgain={() => { setDone(null); setMessage(''); setSigned(false); }} onMine={onMine} />;
  const f = form.data;
  const k = f.kinds.find((x) => x.id === kind);
  const send = async () => {
    const r = await run(() => client.call<{ code?: string; signed: boolean }>('feedback.submit', { kind, topic, message, signed }));
    if (!r) return;
    const kept = r.code && server ? await keepCode(server, r.code) : false;
    setDone({ ...r, kept });
  };
  return (
    <>
      <Txt tone="muted">{t('feedback.intro')}</Txt>
      <View style={{ gap: 6 }}>
        <Txt v="small" tone="muted" bold>{t('feedback.kind')}</Txt>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {f.kinds.map((x) => {
            const on = x.id === kind;
            return (
              <Pressable key={x.id} onPress={() => setKind(x.id)} accessibilityRole="radio" accessibilityState={{ selected: on }}
                style={[styles.chip, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : c.surface }]}>
                <Text style={{ color: on ? c.brand : c.text2, fontWeight: '700', fontSize: 15 }}>{x.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {k?.safety ? (
        <Notice tone="warn" icon="alert">
          <View style={{ gap: 4, flex: 1 }}>
            <Txt v="small" bold tone="warn">{t('feedback.safetyTitle')}</Txt>
            <Txt v="small" tone="warn">{f.safetyNote}</Txt>
            {f.callOutPhone ? <Pressable onPress={() => Linking.openURL(`tel:${f.callOutPhone.replace(/[^\d+]/g, '')}`)} accessibilityRole="link"><Txt v="small" tone="warn" bold>{t('feedback.callOut', { phone: f.callOutPhone })}</Txt></Pressable> : null}
            {f.managers.map((m) => (
              <Pressable key={`${m.name}${m.phone}`} disabled={!m.phone} onPress={() => Linking.openURL(`tel:${m.phone.replace(/[^\d+]/g, '')}`)} accessibilityRole={m.phone ? 'link' : undefined}>
                <Txt v="small" tone="warn">{t('feedback.onDuty', { name: m.name })}{m.phone ? ` · ${m.phone}` : ''}</Txt>
              </Pressable>
            ))}
          </View>
        </Notice>
      ) : null}
      {f.topics.length ? (
        <View style={{ gap: 6 }}>
          <Txt v="small" tone="muted" bold>{t('feedback.topic')}</Txt>
          <View style={styles.chips}>
            {[{ id: '', label: t('feedback.topicNone') }, ...f.topics].map((x) => {
              const on = x.id === topic;
              return (
                <Pressable key={x.id || 'none'} onPress={() => setTopic(x.id)} accessibilityRole="radio" accessibilityState={{ selected: on }}
                  style={[styles.chip, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : c.surface }]}>
                  <Text style={{ color: on ? c.brand : c.text2, fontWeight: '600', fontSize: 14 }}>{x.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      <Field label={t('feedback.message')} value={message} onChangeText={setMessage} multiline maxLength={MAX} placeholder={t('feedback.messagePlaceholder')}
        help={`${message.length} / ${MAX}`} style={{ minHeight: 140 }} />
      <Card style={styles.switchRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt bold>{t('feedback.signIt')}</Txt>
          <Txt v="small" tone="muted">{t('feedback.signItHelp')}</Txt>
        </View>
        <Switch value={signed} onValueChange={setSigned} accessibilityLabel={t('feedback.signIt')} />
      </Card>
      <Card style={{ gap: 4 }}>
        <Txt v="small" bold>{t('feedback.seeTitle')}</Txt>
        <Txt v="small">{t(signed ? 'feedback.seeSigned' : 'feedback.seeAnon')}</Txt>
        <Txt v="small">{t(signed ? 'feedback.notSeeSigned' : 'feedback.notSeeAnon')}</Txt>
        <Txt v="small" tone="faint">{k?.adminsOnly ? t('feedback.readersAdmins') : t(f.supervisorsCanRead ? 'feedback.readersSup' : 'feedback.readersMgr')}</Txt>
        <HowAnonymous />
      </Card>
      <Button kind="primary" icon="send" title={t('feedback.send')} busy={busy} disabled={!kind || !message.trim()} onPress={send} block />
    </>
  );
}

function Sent({ done, onAgain, onMine }: { done: { code?: string; signed: boolean; kept: boolean }; onAgain: () => void; onMine: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const toast = useToast();
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Icon name="check" size={22} color={c.ok} /><Txt v="h2">{t('feedback.sentTitle')}</Txt></View>
      {done.signed || !done.code ? <Txt>{t('feedback.sentSigned')}</Txt> : (
        <>
          <Txt bold>{t('feedback.codeTitle')}</Txt>
          <Text selectable style={[styles.code, { color: c.text, borderColor: c.border, backgroundColor: c.surface2 }]} accessibilityLabel={done.code.split('').join(' ')}>{done.code}</Text>
          <Button icon="send2" title={t('feedback.copy')} onPress={async () => { if ((await copyOrShare(done.code!)) === 'copied') toast(t('feedback.copied')); }} />
          <Txt v="small">{t('feedback.codeHelp')}</Txt>
          <Txt v="small" tone="faint">{done.kept ? t('feedback.codeKept') : t('feedback.codeNotKept')}</Txt>
        </>
      )}
      <Button title={t('feedback.writeAnother')} onPress={onAgain} />
      <Button kind="ghost" title={t('feedback.seeMine')} onPress={onMine} />
    </Card>
  );
}

// ---------- My feedback ----------
function Mine() {
  const { t, date } = useI18n();
  const { client, server, version } = useApp();
  const errorText = useErrorText();
  const [codes, setCodes] = useState<SavedCode[] | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [summary, setSummary] = useState<CodeSummary[]>([]);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const signed = useRpc<MyEntry[]>('feedback.mine.list');
  const load = useCallback(async () => {
    if (!server) return;
    const list = await savedCodes(server);
    setCodes(list);
    setSeen(await signedSeen(server));
    if (list.length) setSummary(await client.call<CodeSummary[]>('feedback.codes.summary', { codes: list.map((x) => x.code) }).catch(() => []));
    else setSummary([]);
  }, [client, server]);
  useEffect(() => { load(); }, [load, version]);
  const openTyped = async () => {
    setErr('');
    const code = formatCode(typed);
    try {
      await client.call('feedback.byCode.get', { code });
      if (server) await keepCode(server, code);
      setTyped('');
      router.push({ pathname: '/feedback-entry', params: { code } });
    } catch (e) { setErr(errorText(e)); }
  };
  return (
    <>
      <SectionTitle title={t('feedback.deviceTitle')} />
      <Txt v="small" tone="muted">{t('feedback.deviceHelp')}</Txt>
      {codes === null ? <Loading /> : codes.length === 0 ? <Txt v="small" tone="faint">{t('feedback.deviceEmpty')}</Txt> : (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {codes.map((c, i) => {
            const s = summary[i];
            const fresh = !!s?.found && (s.replies || 0) > c.seen;
            return (
              <ListRow key={c.code} title={s?.found ? [s.kindLabel, s.topicLabel].filter(Boolean).join(' · ') : t('feedback.notFound')}
                sub={`${c.code}${s?.found && s.date ? ` · ${date(s.date)}` : ''}`}
                onPress={() => router.push({ pathname: '/feedback-entry', params: { code: c.code } })}
                right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{fresh ? <Badge tone="brand" text={t('feedback.newReply')} /> : null}{s?.found ? <StatusBadge status={s.status} label={s.statusLabel} /> : null}</View>} />
            );
          })}
        </Card>
      )}
      <Field label={t('feedback.openWithCode')} value={typed} onChangeText={setTyped} placeholder="XXXX-XXXX-XXXX-XXXX" autoCapitalize="characters" autoCorrect={false} />
      {err ? <Txt v="small" tone="bad">{err}</Txt> : null}
      <Button title={t('feedback.open')} disabled={!formatCode(typed)} onPress={openTyped} />

      <SectionTitle title={t('feedback.signedTitle')} />
      {!signed.data ? <Loading /> : signed.data.length === 0 ? <Txt v="small" tone="faint">{t('feedback.signedEmpty')}</Txt> : (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {signed.data.map((e) => (
            <ListRow key={e.id} title={[e.kindLabel, e.topicLabel].filter(Boolean).join(' · ')} sub={`${date(e.date)} · ${e.message.slice(0, 80)}`}
              onPress={() => router.push({ pathname: '/feedback-entry', params: { id: e.id! } })}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{e.replies > (seen[e.id!] || 0) ? <Badge tone="brand" text={t('feedback.newReply')} /> : null}<StatusBadge status={e.status} label={e.statusLabel} /></View>} />
          ))}
        </Card>
      )}
    </>
  );
}

// ---------- You said, we did ----------
function Board() {
  const { t, date } = useI18n();
  const board = useRpc<BoardItem[]>('feedback.board.list');
  return (
    <>
      <Txt v="small" tone="muted">{t('feedback.boardIntro')}</Txt>
      {!board.data ? <Loading /> : board.data.length === 0 ? <Empty icon="message" title={t('feedback.boardEmpty')} /> : board.data.map((b) => (
        <Card key={b.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Badge tone="brand" text={b.kindLabel} />{b.topicLabel ? <Badge text={b.topicLabel} /> : null}
            <Txt v="tiny" tone="faint">{date(b.date)}</Txt>
          </View>
          <Txt>{b.text}</Txt>
          {b.name ? <Txt v="small" tone="muted">— {b.name}</Txt> : null}
          {b.reply ? <Txt v="small" bold>{t('feedback.whatWeDid', { text: b.reply })}</Txt> : null}
        </Card>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  code: { fontSize: 20, fontWeight: '800', letterSpacing: 1, borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, textAlign: 'center', fontFamily: 'monospace' },
});
