// More: Ask ShiftBoard (the built-in assistant), the floor tools (leads and managers), Stock lists, the 86 List, the Feedback box (and its
// inbox for readers), my tips, events, availability and time off (when
// Training has the tab), profile, language, notifications, calendar, the full website, the restaurants this phone
// uses (switch, add another), privacy and help, delete my account, sign out. Rows for features the restaurant's
// plan doesn't include are hidden (lib/features.ts).
import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Linking, Share, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Badge, Card, ListRow, Notice, SectionTitle, Txt, useToast } from '@/components/ui';
import { useI18n, type Lang } from '@/i18n';
import { displayServer } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { pushStatus, registerForPush, type PushStatus } from '@/lib/push';
import { useApp, type Account } from '@/lib/session';
import type { EightySixSummary } from '@/lib/types';
import { savedCodes, type CodeSummary, type Inbox } from '@/lib/feedback';
import { showTimeOffTab, timeOffRoute } from '@/navigation';

export default function More() {
  const { t, tn, chosen, setLang, date } = useI18n();
  const { me, boot, settings, server, client, signOut, accounts, openRestaurant, startAdding, colors, has, isLead, canApprove, version } = useApp();
  const toast = useToast();
  const errorText = useErrorText();
  const [run, busy] = useAction();
  const [push, setPush] = useState<PushStatus>('unavailable');
  useEffect(() => { pushStatus().then(setPush).catch(() => {}); }, []);
  const origin = server!;
  const open = (path: string) => WebBrowser.openBrowserAsync(`${origin}${path}`).catch(() => Linking.openURL(`${origin}${path}`));

  const calendar = async () => {
    try {
      const path = await client.post<string>('/api/rpc-ical-link');
      const https = `${origin}${path}`;
      const webcal = https.replace(/^https?:/, 'webcal:');
      if (await Linking.canOpenURL(webcal).catch(() => false)) await Linking.openURL(webcal);
      else await Share.share({ message: https, url: https });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  const notifications = async () => {
    if (push === 'ask') { await registerForPush(client).catch(() => {}); setPush(await pushStatus()); } else Linking.openSettings();
  };
  const switchTo = async (a: Account) => {
    if (a.server === origin) return;
    await openRestaurant(a.server);
    router.replace('/');
  };
  const addRestaurant = () => {
    startAdding();
    router.replace('/welcome');
  };
  const deleteAccount = async () => {
    if (me.deletionRequestedAt) return toast(t('more.deleteAlready', { date: date(me.deletionRequestedAt.slice(0, 10)) }));
    if (!(await confirm(t('more.deleteTitle'), t('more.deleteBody'), t('more.deleteConfirm'), t('common.cancel'), true))) return;
    await run(() => client.call('account.requestDeletion'), t('more.deleteSent'));
  };
  const out = async () => {
    await signOut();
    router.replace('/sign-in');
  };
  const langValue: Lang | 'phone' = chosen ?? 'phone';
  const out86 = useRpc<EightySixSummary>('eightySix.summary', {}, [], has('eightySix')).data?.out || 0;
  // Feedback box: a reply waiting on an entry whose code is on this phone (checked when More opens), and new entries for readers.
  const [feedbackNew, setFeedbackNew] = useState(false);
  useEffect(() => {
    if (!has('feedback') || !server) return;
    let live = true;
    savedCodes(server).then(async (codes) => {
      if (!codes.length) return;
      const s = await client.call<CodeSummary[]>('feedback.codes.summary', { codes: codes.map((c) => c.code) });
      if (live) setFeedbackNew(codes.some((c, i) => !!s[i]?.found && (s[i].replies || 0) > c.seen));
    }).catch(() => {});
    return () => { live = false; };
  }, [server, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const feedbackUnread = useRpc<Inbox>('feedback.inbox.list', { status: 'new' }, [], has('feedbackInbox')).data?.items.length || 0;
  const billing = boot.tenant?.billing;
  const approvals = canApprove ? boot.pendingApprovals : 0;

  return (
    <Screen title={t('more.title')}>
      {billing ? (
        <Notice tone={billing.kind === 'pastDue' ? 'bad' : 'warn'} icon="alert"
          text={billing.kind === 'pastDue' ? t('more.pastDue') : billing.daysLeft ? tn('more.trialEnds', billing.daysLeft) : t('more.trialEndsToday')} />
      ) : null}

      {has('assistant') ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          <ListRow icon="message" title={t('ask.title')} sub={t('ask.menuHelp')} onPress={() => router.push('/ask')} />
        </Card>
      ) : null}

      {isLead || has('eightySix') || has('stock') ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {isLead ? (
            <ListRow icon="users" title={t('more.floor')} sub={t('more.floorHelp')} onPress={() => router.push('/floor')}
              right={approvals ? <Badge tone="warn" text={String(approvals)} /> : null} />
          ) : null}
          {has('stock') ? <ListRow icon="cards" title={t('stock.title')} sub={t('stock.menuHelp')} onPress={() => router.push('/stock')} /> : null}
          {has('eightySix') ? (
            <ListRow icon="ban" title={t('more.eightySix')} sub={t('more.eightySixHelp')} onPress={() => router.push('/eighty-six')}
              right={out86 ? <Badge tone="bad" text={String(out86)} /> : null} />
          ) : null}
        </Card>
      ) : null}

      {has('feedback') || has('feedbackInbox') ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {has('feedback') ? <ListRow icon="message" title={t('feedback.title')} sub={t('feedback.menuHelp')} onPress={() => router.push('/feedback')}
            right={feedbackNew ? <Badge tone="brand" text={t('feedback.newReply')} /> : null} /> : null}
          {has('feedbackInbox') ? <ListRow icon="message" title={t('feedback.inboxTitle')} sub={t('feedback.inboxHelp')} onPress={() => router.push('/feedback-inbox')}
            right={feedbackUnread ? <Badge tone="warn" text={String(feedbackUnread)} /> : null} /> : null}
        </Card>
      ) : null}

      <Card pad={false} style={{ overflow: 'hidden' }}>
        {has('tips') ? <ListRow icon="dollar" title={t('more.myTips')} sub={t('more.myTipsHelp')} onPress={() => router.push('/tips')} /> : null}
        {has('events') ? <ListRow icon="glass" title={t('more.events')} sub={t('more.eventsHelp')} onPress={() => router.push('/events')} /> : null}
        {!showTimeOffTab(has) ? <ListRow icon="sun" title={t('more.timeOff')} onPress={() => router.push(timeOffRoute(has))}
          right={canApprove && approvals ? <Badge tone="warn" text={String(approvals)} /> : null} /> : null}
        <ListRow icon="clock" title={t('more.availability')} sub={t('more.availabilityHelp')} onPress={() => router.push('/availability')} />
      </Card>

      <Card style={{ gap: 4 }}>
        <Txt v="h2">{me.name}</Txt>
        <View style={{ flexDirection: 'row' }}><Badge tone="brand" text={t(`more.role.${me.role}` as const)} /></View>
        {me.email ? <Txt v="small" tone="muted">{me.email}</Txt> : null}
        {me.phone ? <Txt v="small" tone="muted">{me.phone}</Txt> : null}
        <Txt v="small" tone="faint" style={{ marginTop: 6 }}>{t('more.restaurant')}: {settings.restaurantName} · {displayServer(origin)}</Txt>
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 2 }}>
          <Txt v="h3">{t('lang.title')}</Txt>
          <Txt v="small" tone="faint">{t('lang.help')}</Txt>
        </View>
        {([['es', 'Español'], ['en', 'English'], ['phone', t('lang.phone')]] as [Lang | 'phone', string][]).map(([v, label]) => (
          <ListRow key={v} title={label} chevron={false} label={label} onPress={() => setLang(v === 'phone' ? null : v)} selected={langValue === v}
            right={langValue === v ? <Icon name="check" size={20} color={colors.brand} /> : null} />
        ))}
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        {push !== 'unavailable' ? (
          <ListRow icon="bell" title={t('more.notifications')} sub={push === 'on' ? undefined : t('more.notificationsSettings')} onPress={notifications}
            right={<Badge tone={push === 'on' ? 'ok' : 'warn'} text={push === 'on' ? t('more.notificationsOn') : t('more.notificationsOff')} />} />
        ) : null}
        <ListRow icon="calendar" title={t('more.calendar')} sub={t('more.calendarHelp')} onPress={calendar} />
        <ListRow icon="external" title={t('more.web')} sub={displayServer(origin)} onPress={() => open('/')} />
      </Card>

      <SectionTitle title={t('more.restaurants')} />
      <Txt v="small" tone="muted">{t('more.restaurantsHelp')}</Txt>
      <Card pad={false} style={{ overflow: 'hidden' }}>
        {accounts.map((a) => {
          const here = a.server === origin;
          const name = here ? settings.restaurantName : a.name || displayServer(a.server);
          return (
            <ListRow key={a.server} icon="store" title={name} chevron={!here} selected={here}
              sub={here ? `${t('more.openNow')} · ${displayServer(a.server)}` : a.signedIn ? displayServer(a.server) : t('more.signedOutTap')}
              label={here ? `${name}, ${t('more.openNow')}` : t('more.switchTo', { name })}
              onPress={here ? undefined : () => switchTo(a)}
              right={here ? <Icon name="check" size={20} color={colors.brand} /> : null} />
          );
        })}
        <ListRow icon="plus" title={t('more.addRestaurant')} onPress={addRestaurant} />
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        <ListRow icon="alert" title={t('report.menu')} sub={t('report.menuHelp')} onPress={() => router.push('/report-problem')} />
        <ListRow icon="shield" title={t('more.privacy')} onPress={() => open('/privacy')} />
        <ListRow icon="help" title={t('more.help')} onPress={() => open('/support')} />
        <ListRow icon="trash" title={t('more.delete')} danger onPress={busy ? undefined : deleteAccount} />
        <ListRow icon="logout" title={t('more.signOut')} danger onPress={out} chevron={false} />
      </Card>
      <Txt v="tiny" tone="faint" style={{ textAlign: 'center' }}>{t('more.version', { version: Constants.expoConfig?.version || '1.0.0' })}</Txt>
    </Screen>
  );
}
