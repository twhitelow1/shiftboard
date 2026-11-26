// One of my Feedback box entries: an anonymous one by its follow-up code (?code=) or a signed one (?id=). The
// conversation, writing back (still anonymous by code), and for a signed one whether "You said, we did" may show my
// name. Opening it marks its replies read on this phone (the badge in My feedback).
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { StatusBadge, Thread } from '@/components/Feedback';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, Field, Loading, Notice, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { forgetCode, markSeen, markSignedSeen, type MyEntry } from '@/lib/feedback';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

export default function FeedbackEntry() {
  const { t, date } = useI18n();
  const { client, server } = useApp();
  const errorText = useErrorText();
  const { code, id } = useLocalSearchParams<{ code?: string; id?: string }>();
  const entry = useRpc<MyEntry>(code ? 'feedback.byCode.get' : 'feedback.mine.get', code ? { code } : { id });
  const [e, setE] = useState<MyEntry | null>(null);
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  const cur = e || entry.data;
  useEffect(() => {
    if (!cur || !server) return;
    if (code) markSeen(server, code, cur.replies); else if (id) markSignedSeen(server, id, cur.replies);
  }, [cur?.replies]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    const r = await run(() => client.call<MyEntry>(code ? 'feedback.byCode.reply' : 'feedback.mine.reply', code ? { code, text } : { id, text }), t('feedback.sent'));
    if (r) { setE(r); setText(''); }
  };
  const nameOk = async (ok: boolean) => { const r = await run(() => client.call<MyEntry>('feedback.mine.nameOk', { id, ok })); if (r) setE(r); };
  return (
    <Screen title={cur ? [cur.kindLabel, cur.topicLabel].filter(Boolean).join(' · ') : t('feedback.tabMine')} back bottomInset>
      {entry.error && !cur ? <Empty icon="alert" title={errorText(entry.error)}><Button title={t('common.retry')} onPress={entry.reload} /></Empty> : null}
      {!cur && !entry.error ? <Loading label={t('common.loading')} /> : null}
      {cur ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <StatusBadge status={cur.status} label={cur.statusLabel} />
            <Badge text={cur.signed ? t('feedback.signed') : t('feedback.anonymous')} />
            <Txt v="tiny" tone="faint">{date(cur.date)}</Txt>
          </View>
          <Card><Txt>{cur.message}</Txt></Card>
          <Thread items={cur.thread} mine={t('feedback.you')} />
          {cur.shared ? <Notice tone="ok" icon="check" text={t('feedback.sharedOn', { date: date(cur.shared.date) })} /> : null}
          {cur.signed ? (
            <Card style={styles.switchRow}>
              <Txt v="small" style={{ flex: 1 }}>{t('feedback.nameOk')}</Txt>
              <Switch value={!!cur.nameOk} disabled={busy} onValueChange={nameOk} accessibilityLabel={t('feedback.nameOk')} />
            </Card>
          ) : null}
          <Field label={t('feedback.writeBack')} value={text} onChangeText={setText} multiline maxLength={2000} help={cur.signed ? undefined : t('feedback.writeBackAnon')} />
          <Button kind="primary" icon="send" title={t('feedback.reply')} busy={busy} disabled={!text.trim()} onPress={send} block />
          {code ? <Button kind="danger" icon="trash" title={t('feedback.removeFromDevice')} onPress={async () => { if (server) await forgetCode(server, code); router.back(); }} /> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
