// Sign in with the same email and password as the website, then the second step when the restaurant's server
// asks for one (two-step sign-in; never SMS codes):
//   verify  the 6-digit code from the person's authenticator app, or one of their recovery codes
//   enroll  no second step set up yet: finish in the browser (<server>/#/security-setup), or set up an
//           authenticator app right here (secret → first code → recovery codes to save)
// The server's ticket for the second step lasts 10 minutes; after that the person starts again with the
// password. Passkeys and email-link sign-in are web-only for now. Older servers answer the password with the
// session token straight away, and the app signs in as before.
import { Image } from 'expo-image';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Linking, Share, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Button, Card, Field, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ApiError, displayServer, totpConfirm, totpSetup } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const TICKET_MS = 10 * 60 * 1000;
type Step =
  | { kind: 'password' }
  | { kind: 'verify'; ticket: string; at: number; methods: string[]; mode: 'totp' | 'recovery' }
  | { kind: 'enroll'; ticket: string; at: number }
  | { kind: 'setup'; ticket: string; at: number; secret: string; otpauthUrl: string }
  | { kind: 'codes'; codes: string[]; token: string };

/** A ticket the server no longer accepts (expired or used): start again from the password. */
const ticketGone = (e: unknown) => e instanceof ApiError && (e.status === 410 || /expired|ticket|venci|caduc/i.test(e.message));

export default function SignIn() {
  const { t } = useI18n();
  const c = useColors();
  const errorText = useErrorText();
  const { server, config, logoUrl, expired, signIn, verifyCode, acceptToken, startAdding } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // The second step's ticket runs out after 10 minutes: back to the password, saying why.
  const at = 'at' in step ? step.at : 0;
  const restart = (why = t('signIn.ticketExpired')) => { setStep({ kind: 'password' }); setPassword(''); setCode(''); setError(''); setNote(why); };
  useEffect(() => {
    if (!at) return;
    const id = setInterval(() => { if (Date.now() - at > TICKET_MS) restart(); }, 15000);
    return () => clearInterval(id);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!server) return <Redirect href="/welcome" />;
  const name = config?.brand?.name || displayServer(server);
  const openWeb = (path: string) => WebBrowser.openBrowserAsync(`${server}${path}`).catch(() => Linking.openURL(`${server}${path}`));

  /** Run a step's request: errors show on screen; an expired ticket starts over. */
  const attempt = async (fn: () => Promise<void>) => {
    setError('');
    if (at && Date.now() - at > TICKET_MS) return restart();
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (at && ticketGone(e)) restart();
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () => {
    if (!email.trim() || !password) return setError(t('signIn.missing'));
    setNote('');
    return attempt(async () => {
      const r = await signIn(email, password);
      setCode('');
      if (r.kind === 'token') router.replace('/shifts');
      else if (r.kind === 'verify') setStep({ kind: 'verify', ticket: r.ticket, at: Date.now(), methods: r.methods, mode: r.methods.includes('totp') || !r.methods.includes('recovery') ? 'totp' : 'recovery' });
      else setStep({ kind: 'enroll', ticket: r.ticket, at: Date.now() });
    });
  };
  const submitCode = () => {
    if (step.kind !== 'verify') return;
    if (!code.trim()) return setError(t('signIn.codeMissing'));
    return attempt(async () => {
      await verifyCode(step.ticket, step.mode, code);
      router.replace('/shifts');
    });
  };
  const startSetup = () => {
    if (step.kind !== 'enroll') return;
    return attempt(async () => {
      const r = await totpSetup(server, step.ticket);
      setCode('');
      setStep({ kind: 'setup', ticket: step.ticket, at: step.at, ...r });
    });
  };
  const confirmSetup = () => {
    if (step.kind !== 'setup') return;
    if (!code.trim()) return setError(t('signIn.codeMissing'));
    return attempt(async () => {
      const r = await totpConfirm(server, step.ticket, code);
      setStep({ kind: 'codes', codes: r.recoveryCodes, token: r.token });
    });
  };
  const finish = () => {
    if (step.kind !== 'codes') return;
    acceptToken(step.token);
    router.replace('/shifts');
  };

  // On the sign-in backdrop (dark, with a glow of the restaurant's color, like the website's sign-in page).
  const header = (
    <View style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
      {logoUrl ? (
        <Image source={{ uri: logoUrl }} style={{ width: 88, height: 88, borderRadius: 18, backgroundColor: '#ffffff', padding: 6 }} contentFit="contain" />
      ) : (
        <View style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: c.mark, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="calendar" size={32} color={c.onMark} />
        </View>
      )}
      <Txt v="title" style={{ textAlign: 'center', color: '#ffffff' }}>{name}</Txt>
      <Txt v="small" style={{ color: 'rgba(255,255,255,0.7)' }}>{displayServer(server)}</Txt>
    </View>
  );
  const errorBox = error ? <Notice tone="bad" text={error} /> : null;
  const backToPassword = <Button kind="ghost" title={t('signIn.backToPassword')} onPress={() => restart('')} />;
  const codeField = (label: string, recovery = false) => (
    <Field key={recovery ? 'recovery' : 'totp'} label={label} value={code} onChangeText={setCode} autoFocus autoCorrect={false}
      autoCapitalize={recovery ? 'characters' : 'none'} keyboardType={recovery ? 'default' : 'number-pad'}
      textContentType={recovery ? 'none' : 'oneTimeCode'} autoComplete={recovery ? 'off' : 'one-time-code'} maxLength={recovery ? 40 : 6}
      returnKeyType="go" onSubmitEditing={step.kind === 'setup' ? confirmSetup : submitCode} testID="code"
      style={recovery ? undefined : styles.codeInput} />
  );

  if (step.kind === 'verify') {
    const recovery = step.mode === 'recovery';
    const webOnly = !step.methods.includes('totp') && !step.methods.includes('recovery');
    return (
      <Screen title={t('signIn.codeTitle')} bell={false} bottomInset backdrop>
        {header}
        <Card style={{ gap: 14 }}>
          {webOnly ? (
            <>
              <Notice tone="brand" icon="lock" text={t('signIn.passkeyOnly')} />
              <Button kind="primary" icon="external" title={t('signIn.openWebSignIn')} onPress={() => openWeb('/')} />
            </>
          ) : (
            <>
              <Txt>{recovery ? t('signIn.recoveryLead') : t('signIn.codeLead')}</Txt>
              {codeField(recovery ? t('signIn.recoveryLabel') : t('signIn.codeLabel'), recovery)}
              {errorBox}
              <Button kind="primary" icon="check" title={busy ? t('signIn.verifying') : t('signIn.verify')} busy={busy} onPress={submitCode} />
              {step.methods.includes('recovery') && step.methods.includes('totp') ? (
                <Button kind="ghost" title={recovery ? t('signIn.useApp') : t('signIn.useRecovery')}
                  onPress={() => { setCode(''); setError(''); setStep({ ...step, mode: recovery ? 'totp' : 'recovery' }); }} />
              ) : null}
            </>
          )}
          {backToPassword}
        </Card>
      </Screen>
    );
  }

  if (step.kind === 'enroll') {
    return (
      <Screen title={t('signIn.enrollTitle')} bell={false} bottomInset backdrop>
        {header}
        <Card style={{ gap: 14 }}>
          <Txt v="h3">{t('signIn.enrollTitle')}</Txt>
          <Txt>{t('signIn.enrollLead')}</Txt>
          <Button kind="primary" icon="external" title={t('signIn.enrollOpen')} onPress={() => openWeb('/#/security-setup')} />
          <Button icon="right" title={t('signIn.enrollDone')} onPress={() => restart('')} />
          {errorBox}
          <Button kind="ghost" icon="lock" title={t('signIn.enrollHere')} busy={busy} onPress={startSetup} />
        </Card>
      </Screen>
    );
  }

  if (step.kind === 'setup') {
    const key = step.secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
    return (
      <Screen title={t('signIn.enrollTitle')} bell={false} bottomInset backdrop>
        <Card style={{ gap: 14 }}>
          <Txt>{t('signIn.setupLead')}</Txt>
          {step.otpauthUrl ? <Button icon="external" title={t('signIn.setupOpen')} onPress={() => Linking.openURL(step.otpauthUrl).catch(() => setError(t('signIn.setupNoApp')))} /> : null}
          <View style={{ gap: 4 }}>
            <Txt v="small" tone="muted" bold>{t('signIn.setupKey')}</Txt>
            <View style={[styles.key, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <Text selectable style={[styles.mono, { color: c.text }]} accessibilityLabel={`${t('signIn.setupKey')}: ${step.secret.split('').join(' ')}`}>{key}</Text>
            </View>
          </View>
          {codeField(t('signIn.codeLabel'))}
          {errorBox}
          <Button kind="primary" icon="check" title={t('signIn.setupConfirm')} busy={busy} onPress={confirmSetup} />
          {backToPassword}
        </Card>
      </Screen>
    );
  }

  if (step.kind === 'codes') {
    return (
      <Screen title={t('signIn.recoveryTitle')} bell={false} bottomInset backdrop>
        <Card style={{ gap: 14 }}>
          <Notice tone="warn" icon="lock" text={t('signIn.recoveryCodesLead')} />
          <View style={[styles.codes, { backgroundColor: c.surface2, borderColor: c.border }]}>
            {step.codes.map((x) => <Text key={x} selectable style={[styles.mono, styles.codeItem, { color: c.text }]}>{x}</Text>)}
          </View>
          <Button icon="send" title={t('signIn.shareCodes')}
            onPress={() => Share.share({ message: `${t('signIn.recoveryTitle')} (${name}):\n${step.codes.join('\n')}` }).catch(() => {})} />
          <Button kind="primary" icon="check" title={t('signIn.savedContinue')} onPress={finish} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t('signIn.title')} bell={false} bottomInset backdrop>
      {header}
      {expired ? <Notice tone="warn" icon="clock" text={t('signIn.expired')} /> : null}
      {note ? <Notice tone="warn" icon="clock" text={note} /> : null}
      {config?.paused ? <Notice tone="bad" text={t('welcome.paused')} /> : null}
      <Card style={{ gap: 14 }}>
        <Field label={t('signIn.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          textContentType="username" autoComplete="email" returnKeyType="next" testID="email" />
        <Field label={t('signIn.password')} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password"
          returnKeyType="go" onSubmitEditing={submitPassword} testID="password" />
        {errorBox}
        <Button kind="primary" title={busy ? t('signIn.busy') : t('signIn.submit')} busy={busy} onPress={submitPassword} />
        <Button kind="ghost" title={t('signIn.forgot')} onPress={() => router.push({ pathname: '/forgot', params: { email } })} />
        <Row style={{ justifyContent: 'center', flexWrap: 'wrap', gap: 4 }}>
          <Txt v="small" tone="muted">{t('signIn.notYou')}</Txt>
          <Button kind="ghost" small title={t('signIn.change')} onPress={() => { startAdding(); router.replace('/welcome'); }} />
        </Row>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  codeInput: { fontSize: 24, letterSpacing: 6, fontWeight: '700', textAlign: 'center' },
  key: { borderWidth: 1, borderRadius: 10, padding: 12 },
  mono: { fontFamily: 'monospace', fontSize: 16, letterSpacing: 1 },
  codes: { borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16, gap: 2 },
  codeItem: { paddingVertical: 4, textAlign: 'center' },
});
