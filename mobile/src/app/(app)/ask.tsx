// Ask ShiftBoard (More → Ask): a chat with Claude that answers from ShiftBoard as you (server/assistant/). The same
// API as the web app, with the whole answer at once. A change it proposes is a card with Confirm and Cancel; only
// the tap runs it. Suggested questions by role, recent chats, Clear history, and "AI can make mistakes".
// Files: the paperclip attaches a photo (or, in the browser version, any file); the server works out what it is and
// answers with an import card (server/assistant/imports.js). Import now (when nothing needs a decision) shows the
// usual Confirm card; Review & import opens the website at the import's preview (the wizards live there).
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { Markdown } from '@/components/Markdown';
import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, ListRow, Notice, Txt, useColors, useToast } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { askAttachAll, askClear, askConversation, askDecide, askProposeImport, askSend, askStatus, type AskAction, type AskFilePayload, type AskImport, type AskMessage, type AskStatus } from '@/lib/assistant';
import { attachPhoto, attachWebFile, canAttachFiles, type Attached } from '@/lib/attach';
import { confirm } from '@/lib/confirm';
import { useErrorText } from '@/lib/hooks';
import { useApp, useSession } from '@/lib/session';

export default function Ask() {
  const { t, stamp } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const errorText = useErrorText();
  const { client, isMgr, canApprove, has, bump } = useApp();
  const { server } = useSession();
  const [attachOpen, setAttachOpen] = useState(false);
  const files = useRef(new Map<string, AskFilePayload>()); // import id → the attached file (this screen only)
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
  const fileBlocked = !!info && !info.available && !info.files && !['cap', 'daily'].includes(info.reason || '');
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

  const put = (m: AskMessage) => setMessages((list) => (list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m]));
  const keep = (m: AskMessage, file: AskFilePayload) => { if (m.import?.id) files.current.set(m.import.id, file); };
  /** Attach a photo or a file, and show what it is. */
  const attach = async (how: 'library' | 'camera' | 'file') => {
    setAttachOpen(false);
    if (busy || fileBlocked) return;
    let got: Attached;
    try {
      got = how === 'file' ? await attachWebFile()
        : await attachPhoto(how, { title: t('ask.photoTitle'), why: t(how === 'camera' ? 'ask.cameraWhy' : 'ask.libraryWhy'), allow: t('ask.allow'), cancel: t('common.cancel') });
    } catch { got = { error: 'unreadable' }; }
    if (!got) return;
    if ('denied' in got) { toast(t('ask.denied'), 'bad'); return; }
    if ('error' in got) { toast(t(got.error === 'type' ? 'ask.fileType' : got.error === 'tooBig' ? 'ask.fileTooBig' : 'ask.fileUnreadable'), 'bad'); return; }
    const file = got.file;
    const message = draft.trim();
    setDraft('');
    setBusy(true);
    const temp: AskMessage = { id: `tmp_${Date.now()}`, role: 'user', text: message, at: new Date().toISOString(), file: { name: file.name, size: file.size } };
    setMessages((m) => [...m, temp]);
    try {
      const r = await askAttachAll(client, file, { message, conversationId: chatId }, (step) => { setChatId(step.conversationId); keep(step.message, file); put(step.message); });
      setChatId(r.conversationId);
      keep(r.message, file);
      setMessages((m) => m.map((x) => (x.id === temp.id && r.userMessage ? r.userMessage : x)));
      put(r.message);
    } catch (e) {
      setMessages((m) => [...m, { id: `err_${Date.now()}`, role: 'assistant', text: errorText(e) || t('ask.failed'), at: new Date().toISOString(), notice: 'error' }]);
    } finally {
      setBusy(false);
    }
  };
  const retarget = async (msg: AskMessage, card: AskImport, target: string) => {
    const file = files.current.get(card.id);
    if (!file || !chatId) { toast(t('ask.attachAgain'), 'bad'); return; }
    setBusy(true);
    try { put((await askAttachAll(client, file, { conversationId: chatId, importId: card.id, target }, (step) => put(step.message))).message); } catch (e) { toast(errorText(e), 'bad'); put(msg); } finally { setBusy(false); }
  };
  const importNow = async (card: AskImport) => {
    if (!chatId) return;
    try { put((await askProposeImport(client, card.id, chatId)).message); } catch (e) { toast(errorText(e), 'bad'); }
  };
  const review = (card: AskImport) => {
    if (!server || !chatId) return;
    const url = `${server}/#/ask/import/${encodeURIComponent(card.id)}/${encodeURIComponent(chatId)}`;
    WebBrowser.openBrowserAsync(url).catch(() => toast(t('ask.failed'), 'bad'));
  };

  const decide = async (msg: AskMessage, action: AskAction, decision: 'confirm' | 'cancel') => {
    const mark = (a: Partial<AskAction>) => setMessages((list) => list.map((m) => (m.id !== msg.id ? m : { ...m, actions: (m.actions || []).map((x) => (x.id === action.id ? { ...x, ...a } : x)) })));
    if (!chatId) return;
    mark({ status: 'running' });
    try {
      const r = await askDecide(client, action.id, chatId, decision);
      mark(r.action);
      if (r.ok) bump(); // what it changed shows everywhere
      if (action.tool === 'import_file') askConversation(client, chatId).then((chat) => setMessages(chat.messages)).catch(() => {}); // the card says it's done
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
              {m.file ? (
                <View style={[styles.fileChip, { borderColor: c.border, backgroundColor: c.surface }]}>
                  <Icon name="file" size={14} color={c.brand} />
                  <Txt v="small" bold lines={1} style={{ flexShrink: 1 }}>{m.file.name}</Txt>
                </View>
              ) : null}
              {m.text || !m.file ? (
                <View style={[styles.bubble, m.role === 'user' ? { backgroundColor: c.brand } : { backgroundColor: m.notice ? c.warnSoft : c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}>
                  {m.role === 'user' ? <Txt tone="onBrand">{m.text}</Txt> : m.notice ? <Txt tone="warn" v="small">{m.text}</Txt> : <Markdown text={m.text} size={15} />}
                </View>
              ) : null}
              {m.import ? <ImportCard card={m.import} busy={busy} onPick={(id) => retarget(m, m.import!, id)} onImportNow={() => importNow(m.import!)} onReview={() => review(m.import!)} /> : null}
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
          {attachOpen ? (
            <View style={{ gap: 6 }}>
              <Txt v="tiny" tone="faint">{t(canAttachFiles ? 'ask.attachHelpWeb' : 'ask.attachHelp')}</Txt>
              <View style={styles.attachRow}>
                {canAttachFiles ? <Button small icon="paperclip" title={t('ask.chooseFile')} onPress={() => attach('file')} /> : null}
                {!canAttachFiles ? <Button small icon="image" title={t('ask.choosePhoto')} onPress={() => attach('library')} /> : null}
                {!canAttachFiles ? <Button small icon="camera" title={t('ask.takePhoto')} onPress={() => attach('camera')} /> : null}
              </View>
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <Pressable onPress={() => setAttachOpen((v) => !v)} disabled={busy || fileBlocked} accessibilityRole="button" accessibilityLabel={t('ask.attach')}
              style={[styles.send, { borderWidth: 1, borderColor: c.border, backgroundColor: attachOpen ? c.surface2 : c.surface, opacity: busy || fileBlocked ? 0.5 : 1 }]}>
              <Icon name="paperclip" size={20} color={c.text} />
            </Pressable>
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

/** What a file is and what importing it would do. */
function ImportCard({ card, busy, onPick, onImportNow, onReview }: { card: AskImport; busy: boolean; onPick: (id: string) => void; onImportNow: () => void; onReview: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const reading = card.status === 'reading';
  const [picking, setPicking] = useState(!card.target); // the other kinds, on a tap (all of them when it's not sure)
  const canReview = !!card.wizard && !card.needsFile && ['ready', 'empty', 'failed'].includes(card.status); // a file the website must read itself can't come from the phone
  return (
    <Card style={[styles.action, { borderColor: card.status === 'done' ? c.ok : c.brand }]}>
      <View style={styles.actionHead}>
        <Icon name="file" size={16} color={c.brand} />
        <Txt bold style={{ flexShrink: 1 }}>{card.label || t('ask.unknown')}</Txt>
        {card.confidence ? <Badge tone={card.confidence === 'high' ? 'ok' : card.confidence === 'medium' ? 'warn' : 'neutral'} text={t(`ask.conf.${card.confidence}` as MsgKey)} /> : null}
        {card.status === 'done' ? <Badge tone="ok" text={t('ask.st.done')} /> : null}
      </View>
      {card.how === 'ai' ? <Txt v="tiny" tone="faint">{t('ask.byAi')}</Txt> : null}
      {reading ? <Txt v="small" tone="muted">{card.progress && card.progress.parts > 1 ? t('ask.readingPart', { n: Math.min(card.progress.part + 1, card.progress.parts), total: card.progress.parts }) : t('ask.readingFile')}</Txt> : null}
      {card.summary?.line ? <Txt bold v="small">{card.summary.line}</Txt> : null}
      {(card.summary?.details || []).map((d, i) => <Txt key={i} v="small" tone="muted">{d}</Txt>)}
      {card.lowConfidence ? <Txt v="small" tone="warn">{t('ask.lowConfidence', { count: card.lowConfidence })}</Txt> : null}
      {card.needsReview && card.status === 'ready' ? <Txt v="small" tone="warn">{t('ask.needsReview')}</Txt> : null}
      {card.status === 'empty' ? <Txt v="small" tone="muted">{t('ask.importEmpty')}</Txt> : null}
      {card.notes.map((n, i) => <Txt key={i} v="tiny" tone="faint">{n}</Txt>)}
      {card.refused ? <Txt v="small" tone="warn">{card.refused}</Txt> : null}
      {card.result ? <Txt v="small">{card.result}</Txt> : null}
      {!reading && card.status !== 'done' && card.choices.length ? (
        picking ? (
          <View style={{ gap: 6 }}>
            <Txt v="tiny" tone="faint">{card.target ? t('ask.notRight') : t('ask.pickType')}</Txt>
            <View style={styles.attachRow}>
              {card.choices.map((x) => <Button key={x.id} small title={x.label} disabled={busy} onPress={() => onPick(x.id)} />)}
            </View>
          </View>
        ) : <Button small kind="ghost" title={t('ask.notRight')} onPress={() => setPicking(true)} style={{ alignSelf: 'flex-start' }} />
      ) : null}
      {(canReview || card.canImportNow) && card.status !== 'done' ? (
        <View style={styles.actionButtons}>
          {canReview ? <Button title={t('ask.review')} icon="external" disabled={busy} onPress={onReview} style={{ flex: 1 }} /> : null}
          {card.canImportNow ? <Button kind="primary" icon="check" title={t('ask.importNow')} disabled={busy} onPress={onImportNow} style={{ flex: 1 }} /> : null}
        </View>
      ) : null}
      {canReview ? <Txt v="tiny" tone="faint">{t('ask.reviewWeb')}</Txt> : null}
      {card.needsFile && card.status !== 'done' ? <Txt v="tiny" tone="faint">{t('ask.needsFileWeb')}</Txt> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingBottom: 6 },
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
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
});
