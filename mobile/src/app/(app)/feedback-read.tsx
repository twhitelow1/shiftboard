// One Feedback box entry, for a reader: the message, its status, the conversation with the person who wrote it
// (anonymous: they read it with their code), internal notes, and sharing an edited version on "You said, we did".
// Opening a new entry marks it seen.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { StatusBadge, Thread } from '@/components/Feedback';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Chips, Empty, Field, Loading, Notice, SectionTitle, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import type { FeedbackStatus, InboxEntry } from '@/lib/feedback';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

export default function FeedbackRead() {
  const { t, date, stamp } = useI18n();
  const c = useColors();
  const { client } = useApp();
  const errorText = useErrorText();
  const { id } = useLocalSearchParams<{ id: string }>();
  const got = useRpc<InboxEntry>('feedback.inbox.get', { id });
  const [e, setE] = useState<InboxEntry | null>(null);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareText, setShareText] = useState('');
  const [shareReply, setShareReply] = useState('');
  const [showName, setShowName] = useState(false);
  const [asked, setAsked] = useState(false);
  const [run, busy] = useAction();
  const cur = e || got.data;
  useEffect(() => {
    if (got.data?.status === 'new') client.call<InboxEntry>('feedback.setStatus', { id, status: 'seen' }).then(setE).catch(() => {});
  }, [got.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (method: string, args: object, ok?: string) => { const r = await run(() => client.call<InboxEntry>(method, { id, ...args }), ok); if (r) setE(r); return r; };
  const startShare = () => {
    if (!cur) return;
    setShareText(cur.message.slice(0, 1000));
    setShareReply(([...(cur.thread || [])].reverse().find((m) => m.from === 'reader')?.text || '').slice(0, 1000));
    setSharing(true);
  };
  return (
    <Screen title={cur ? [cur.kindLabel, cur.topicLabel].filter(Boolean).join(' · ') : t('feedback.inboxTitle')} back bottomInset>
      {got.error && !cur ? <Empty icon="alert" title={errorText(got.error)}><Button title={t('common.retry')} onPress={got.reload} /></Empty> : null}
      {!cur && !got.error ? <Loading label={t('common.loading')} /> : null}
      {cur ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <StatusBadge status={cur.status} label={cur.statusLabel} />
            <Badge text={cur.author ? t('feedback.signedBy', { name: cur.author.name }) : t('feedback.anonymous')} />
            {cur.adminsOnly ? <Badge tone="warn" text={t('feedback.adminsOnly')} /> : null}
            <Txt v="tiny" tone="faint">{date(cur.date)}</Txt>
          </View>
          <Card><Txt>{cur.message}</Txt></Card>
          {cur.statuses?.length ? (
            <View style={{ gap: 6 }}>
              <Txt v="small" tone="muted" bold>{t('feedback.status')}</Txt>
              <Chips single label={t('feedback.status')} value={[cur.status]} options={cur.statuses.map((s) => ({ value: s.id, label: s.label }))}
                onChange={(v: FeedbackStatus[]) => { if (v[0] && v[0] !== cur.status) act('feedback.setStatus', { status: v[0] }); }} />
            </View>
          ) : null}

          <SectionTitle title={t('feedback.replyTo')} />
          <Thread items={cur.thread || []} mine={cur.author ? cur.author.name : t('feedback.anonymous')} />
          <Field label={t('feedback.replyTo')} value={reply} onChangeText={setReply} multiline maxLength={2000} help={cur.signed ? t('feedback.replyHelpSigned') : t('feedback.replyHelpAnon')} />
          <Button kind="primary" icon="send" title={t('feedback.reply')} busy={busy} disabled={!reply.trim()} onPress={async () => { if (await act('feedback.reply', { text: reply }, t('feedback.sent'))) setReply(''); }} />

          <SectionTitle title={t('feedback.notes')} />
          <Txt v="small" tone="muted">{t('feedback.notesHelp')}</Txt>
          {(cur.notes || []).map((n) => (
            <View key={n.id} style={[styles.note, { backgroundColor: c.warnSoft }]}>
              <Txt v="tiny" tone="faint">{n.name} · {stamp(n.at)}</Txt>
              <Txt v="small">{n.text}</Txt>
            </View>
          ))}
          <Field label={t('feedback.addNote')} value={note} onChangeText={setNote} multiline maxLength={1000} />
          <Button title={t('feedback.addNote')} disabled={busy || !note.trim()} onPress={async () => { if (await act('feedback.note', { text: note })) setNote(''); }} />

          <SectionTitle title={t('feedback.share')} />
          {cur.shared ? (
            <>
              <Notice tone="ok" icon="check" text={t('feedback.sharedOn', { date: date(cur.shared.date) })} />
              <Card style={{ gap: 4 }}><Txt>{cur.shared.text}</Txt>{cur.shared.reply ? <Txt v="small" bold>{t('feedback.whatWeDid', { text: cur.shared.reply })}</Txt> : null}</Card>
              <Button kind="danger" title={t('feedback.unshare')} disabled={busy} onPress={() => act('feedback.unshare', {})} />
            </>
          ) : sharing ? (
            <>
              <Txt v="small" tone="muted">{t('feedback.shareHelp')}</Txt>
              <Field label={t('feedback.shareText')} value={shareText} onChangeText={setShareText} multiline maxLength={1000} />
              <Field label={t('feedback.shareReply')} value={shareReply} onChangeText={setShareReply} multiline maxLength={1000} />
              {cur.signed ? (cur.nameOk ? (
                <Card style={styles.switchRow}>
                  <Txt v="small" style={{ flex: 1 }}>{t('feedback.showName')}</Txt>
                  <Switch value={showName} onValueChange={setShowName} accessibilityLabel={t('feedback.showName')} />
                </Card>
              ) : (
                <View style={{ gap: 6 }}>
                  <Txt v="small" tone="faint">{t('feedback.showNameNo')}</Txt>
                  <Button small title={asked ? t('feedback.asked') : t('feedback.askName')} disabled={busy || asked}
                    onPress={async () => { const r = await run(() => client.call('feedback.askName', { id }), t('feedback.asked')); if (r) setAsked(true); }} />
                </View>
              )) : null}
              <Button kind="primary" title={t('feedback.shareSave')} busy={busy} disabled={!shareText.trim()}
                onPress={async () => { if (await act('feedback.share', { text: shareText, reply: shareReply, showName })) setSharing(false); }} />
              <Button kind="ghost" title={t('common.cancel')} onPress={() => setSharing(false)} />
            </>
          ) : <Button title={t('feedback.share')} onPress={startShare} />}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  note: { borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, gap: 2 },
});
