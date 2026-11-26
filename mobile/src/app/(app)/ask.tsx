// Ask ShiftBoard (More → Ask): a chat with Claude that answers from ShiftBoard as you (server/assistant/). The same
// API as the web app, with the whole answer at once. A change it proposes is a card with Confirm and Cancel; only
// the tap runs it. Suggested questions by role, recent chats, Clear history, and "AI can make mistakes".
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Markdown } from '@/components/Markdown';
import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, ListRow, Notice, Txt, useColors, useToast } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { askClear, askConversation, askDecide, askSend, askStatus, type AskAction, type AskMessage, type AskStatus } from '@/lib/assistant';
import { confirm } from '@/lib/confirm';
import { useErrorText } from '@/lib/hooks';
import { useApp } from '@/lib/session';

export default function Ask() {
  const { t, stamp } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, isMgr, canApprove, has, bump } = useApp();
  const [info, setInfo] = useState<AskStatus | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);

  const load = () => askStatus(client).then(setInfo).catch((e) => toast(errorText(e), 'bad'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = !!info && !info.available && !['cap', 'daily'].includes(info.reason || '');
  const starters: MsgKey[] = (isMgr
    ? ['ask.sTonight', 'ask.sOver40', 'ask.sDrafts', canApprove ? 'ask.sApprovals' : null]
    : ['ask.sWhenNext', 'ask.sTonight', has('eightySix') ? 'ask.sEightySix' : null, 'ask.sOpenShifts']).filter(Boolean) as MsgKey[];

  const send = async (text?: string) => {
    const message = (text ?? draft).trim();
    if (!message || busy || blocked) return;
    setDraft('');
    setBusy(true);
    const temp: AskMessage = { id: `tmp_${Date.now()}`, role: 'user', text: message, at: new Date().toISOString() };
    setMessages((m) => [...m, temp]);
    try {
      const r = await askSend(client, message, chatId);
      setChatId(r.conversationId);
      setMessages((m) => [...m.map((x) => (x.id === temp.id ? r.userMessage : x)), r.message]);
      askStatus(client).then(setInfo).catch(() => {});
    } catch (e) {
      setMessages((m) => [...m, { id: `err_${Date.now()}`, role: 'assistant', text: errorText(e) || t('ask.failed'), at: new Date().toISOString(), notice: 'error' }]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (msg: AskMessage, action: AskAction, decision: 'confirm' | 'cancel') => {
    const mark = (a: Partial<AskAction>) => setMessages((list) => list.map((m) => (m.id !== msg.id ? m : { ...m, actions: (m.actions || []).map((x) => (x.id === action.id ? { ...x, ...a } : x)) })));
    if (!chatId) return;
    mark({ status: 'running' });
    try {
      const r = await askDecide(client, action.id, chatId, decision);
      mark(r.action);
      if (r.ok) bump(); // what it changed shows everywhere
    } catch (e) {
      mark({ status: 'proposed' });
      toast(errorText(e), 'bad');
    }
  };

  const open = async (id: string) => {
    setShowHistory(false);
    try {
      const chat = await askConversation(client, id);
      setChatId(chat.id);
      setMessages(chat.messages);
    } catch (e) { toast(errorText(e), 'bad'); }
  };
  const fresh = () => { setChatId(null); setMessages([]); setShowHistory(false); };
  const clear = async () => {
    if (!(await confirm(t('ask.clearTitle'), t('ask.clearBody'), t('ask.clearYes'), t('common.cancel'), true))) return;
    try { await askClear(client); fresh(); load(); toast(t('ask.cleared')); } catch (e) { toast(errorText(e), 'bad'); }
  };

  return (
    <Screen title={t('ask.title')} back scroll={false} contentStyle={styles.fill}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={56 + insets.top}>
        <View style={styles.bar}>
          {info?.today ? <Txt v="tiny" tone="faint" style={{ flex: 1 }}>{t('ask.today', { used: info.today.messages, limit: info.today.limit })}</Txt> : <View style={{ flex: 1 }} />}
          <Button small kind="ghost" icon="clock" title={t('ask.history')} onPress={() => setShowHistory((v) => !v)} />
          {messages.length ? <Button small icon="plus" title={t('ask.newChat')} onPress={fresh} /> : null}
        </View>

        <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
          {info && !info.available ? <Notice tone="warn" icon="alert" text={info.message || t('ask.unavailable')} /> : null}
          {showHistory ? (
            <Card pad={false} style={{ overflow: 'hidden' }}>
              {info?.conversations.length ? info.conversations.map((h) => (
                <ListRow key={h.id} title={h.title} sub={stamp(h.updatedAt)} onPress={() => open(h.id)} selected={h.id === chatId} />
              )) : <View style={{ padding: 16 }}><Txt tone="muted">{t('ask.noHistory')}</Txt></View>}
              {info?.conversations.length ? <ListRow icon="trash" title={t('ask.clear')} danger onPress={clear} chevron={false} /> : null}
            </Card>
          ) : null}
          {!messages.length && !showHistory ? (
            <View style={{ gap: 10 }}>
              <Txt tone="muted">{t('ask.intro')}</Txt>
              {!blocked ? (
                <>
                  <Txt v="small" tone="faint">{t('ask.tryAsking')}</Txt>
                  <View style={styles.chips}>
                    {starters.map((k) => (
                      <Pressable key={k} onPress={() => send(t(k))} accessibilityRole="button" style={({ pressed }) => [styles.chip, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
                        <Txt v="small">{t(k)}</Txt>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          ) : null}
          {messages.map((m) => (
            <View key={m.id} style={[styles.msg, m.role === 'user' ? styles.mine : styles.theirs]}>
              <View style={[styles.bubble, m.role === 'user' ? { backgroundColor: c.brand } : { backgroundColor: m.notice ? c.warnSoft : c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}>
                {m.role === 'user' ? <Txt tone="onBrand">{m.text}</Txt> : m.notice ? <Txt tone="warn" v="small">{m.text}</Txt> : <Markdown text={m.text} size={15} />}
              </View>
              {(m.actions || []).map((a) => (
                <Card key={a.id} style={[styles.action, a.status === 'proposed' && { borderColor: c.brand }]}>
                  <View style={styles.actionHead}>
                    <Icon name="check" size={16} color={c.brand} />
                    <Txt bold style={{ flex: 1 }}>{a.title}</Txt>
                    {a.status !== 'proposed' ? <Badge tone={a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : 'neutral'} text={t(`ask.st.${a.status}` as MsgKey)} /> : null}
                  </View>
                  {a.details.map(([k, v], i) => (
                    <View key={i} style={styles.detail}><Txt v="small" tone="faint" style={{ minWidth: 72 }}>{k}</Txt><Txt v="small" style={{ flex: 1 }}>{v}</Txt></View>
                  ))}
                  {a.status === 'failed' && a.result ? <Txt v="small" tone="bad">{a.result}</Txt> : null}
                  {a.status === 'proposed' ? (
                    <>
                      <Txt v="tiny" tone="faint">{t('ask.actionNote')}</Txt>
                      <View style={styles.actionButtons}>
                        <Button title={t('ask.cancel')} onPress={() => decide(m, a, 'cancel')} style={{ flex: 1 }} />
                        <Button kind="primary" icon="check" title={t('ask.confirm')} onPress={() => decide(m, a, 'confirm')} style={{ flex: 1 }} />
                      </View>
                    </>
                  ) : null}
                </Card>
              ))}
            </View>
          ))}
          {busy ? <View style={[styles.msg, styles.theirs]}><View style={[styles.bubble, { backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}><Txt tone="faint" v="small">{t('ask.thinking')}</Txt></View></View> : null}
        </ScrollView>

        <View style={[styles.composer, { borderColor: c.border, backgroundColor: c.bg, paddingBottom: 8 + insets.bottom }]}>
          <View style={styles.inputRow}>
            <TextInput value={draft} onChangeText={setDraft} placeholder={t('ask.placeholder')} placeholderTextColor={c.text3} editable={!blocked} multiline maxLength={2000}
              accessibilityLabel={t('ask.placeholder')} style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]} />
            <Pressable onPress={() => send()} disabled={busy || blocked || !draft.trim()} accessibilityRole="button" accessibilityLabel={t('ask.send')}
              style={[styles.send, { backgroundColor: c.brand, opacity: busy || blocked || !draft.trim() ? 0.5 : 1 }]}>
              <Icon name="send" size={20} color={c.onBrand} />
            </Pressable>
          </View>
          <Txt v="tiny" tone="faint">{t('ask.disclaimer')}</Txt>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6 },
  thread: { gap: 12, paddingBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  msg: { gap: 8, maxWidth: '92%' },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start' },
  bubble: { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10 },
  action: { gap: 8, borderWidth: 1 },
  actionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detail: { flexDirection: 'row', gap: 8 },
  actionButtons: { flexDirection: 'row', gap: 8 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 6, marginHorizontal: -16, paddingHorizontal: 16, marginBottom: -16 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 11, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
