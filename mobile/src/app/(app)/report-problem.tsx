// Report a problem (More): what happened, the screen they were on (filled in, optional), and a screenshot picked
// from the photos (optional, shrunk on the phone like the 86 List's photos, src/lib/photos.ts). The app version,
// the screen, the phone's model and the app's last steps go along by themselves (src/lib/errors.ts). DubLow
// Digital reads it in the console's Errors & reports.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, Empty, Field, Notice, Txt, useColors } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { pageBefore, sendReport } from '@/lib/errors';
import { pickPhotos, type ShrunkPhoto } from '@/lib/photos';

// The screen's name for the "Which screen?" box, from its path.
const SCREEN: Record<string, MsgKey> = {
  shifts: 'tabs.shifts', schedule: 'tabs.schedule', swaps: 'tabs.swaps', 'time-off': 'tabs.timeOff', training: 'tabs.training',
  'eighty-six': 'more.eightySix', 'report-86': 'more.eightySix', events: 'more.events', tips: 'more.myTips', availability: 'more.availability',
  'my-time-off': 'more.timeOff', 'request-time-off': 'more.timeOff', floor: 'more.floor', notifications: 'more.notifications', shift: 'tabs.shifts',
  menu: 'tabs.training', quiz: 'tabs.training', study: 'tabs.training', manual: 'tabs.training',
};

export default function ReportProblem() {
  const { t, lang } = useI18n();
  const c = useColors();
  const [text, setText] = useState('');
  const [page, setPage] = useState(() => {
    const p = pageBefore(['/more', '/report-problem']).split('/').filter(Boolean)[0] || '';
    return SCREEN[p] ? t(SCREEN[p]) : '';
  });
  const [shot, setShot] = useState<ShrunkPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);

  const pick = async () => {
    setProblem('');
    const r = await pickPhotos('library', 1, { title: t('report.addScreenshot'), why: t('report.screenshotWhy'), allow: t('common.continue'), cancel: t('common.cancel') });
    if ('denied' in r) return setProblem(t('report.photosDenied'));
    if ('failed' in r) return setProblem(t('report.photoBad'));
    if (r.photos[0]) setShot(r.photos[0]);
  };
  const send = async () => {
    if (text.trim().length < 3) { setProblem(t('report.needText')); return; }
    setBusy(true); setProblem('');
    try {
      await sendReport({ text: text.trim(), page: page.trim(), screenshot: shot?.dataUrl, lang });
      setDone(true);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setProblem(status && status < 500 && e instanceof Error && e.message ? e.message : t('report.failed'));
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Screen title={t('report.title')} back bottomInset>
        <Empty icon="check" title={t('report.thanks')} body={t('report.thanksHelp')}>
          <Button kind="primary" title={t('common.done')} onPress={() => router.back()} />
        </Empty>
      </Screen>
    );
  }

  return (
    <Screen title={t('report.title')} back bottomInset>
      <Field label={t('report.what')} value={text} onChangeText={setText} placeholder={t('report.whatPlaceholder')} multiline maxLength={2000} autoFocus
        style={{ minHeight: 110 }} />
      <Field label={t('report.page')} value={page} onChangeText={setPage} placeholder={t('report.pagePlaceholder')} maxLength={100} />
      <View style={{ gap: 6 }}>
        <Txt v="small" tone="muted" bold>{t('report.screenshot')}</Txt>
        {shot ? (
          <Card style={styles.shotCard}>
            <Image source={{ uri: shot.dataUrl }} style={[styles.shot, { borderColor: c.border, aspectRatio: shot.w && shot.h ? shot.w / shot.h : 0.6 }]} contentFit="contain" accessibilityLabel={t('report.screenshot')} />
            <View style={{ gap: 8, flex: 1 }}>
              <Button small icon="image" title={t('report.changeScreenshot')} onPress={pick} />
              <Button small kind="danger" icon="trash" title={t('common.remove')} label={t('report.removeScreenshot')} onPress={() => setShot(null)} />
            </View>
          </Card>
        ) : (
          <Button icon="image" title={t('report.addScreenshot')} onPress={pick} block />
        )}
      </View>
      <Txt v="tiny" tone="faint">{t('report.attached')}</Txt>
      {problem ? <Notice tone="bad" icon="alert" text={problem} /> : null}
      <Button kind="primary" icon="send" title={busy ? t('report.sending') : t('common.send')} onPress={send} busy={busy} block />
    </Screen>
  );
}

const styles = StyleSheet.create({
  shotCard: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  shot: { width: 110, maxHeight: 200, borderRadius: 10, borderWidth: 1 },
});
