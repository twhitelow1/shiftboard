// Team: adding an employee (name, email, role → the invitation is emailed right away, never texted), each
// person's status (invited / joined, two-step on or off, texts on, off or stopped), and a manager's sign-in
// help: resend the invitation and reset someone's second step (the recovery path when a phone is lost).
import React, { useState } from 'react';
import { useApp, Icon, Modal, Field, useAction } from '../ui.jsx';
import { ROLES, roleOf, roleInfo, assignableRoles, canManageUser } from '../../../core/roles.js';
import { deliverable } from '../../../core/email-address.js';
import { IS_DEMO } from '../api.js';
import { resetTwoStep } from '../auth-api.js';
import { useT, stampDay } from '../i18n/index.js';
import '../auth.css';

/** Where someone is: invited (date) or joined, two-step on or off, texts on, off or stopped. */
export function personStatus(e, t) {
  const out = [];
  if (e.active === false) return [{ label: t('team.inactive'), cls: '' }];
  if (e.onboardedAt || e.lastLoginAt) out.push({ label: t('teamStatus.joined'), cls: 'ok', title: e.lastLoginAt ? t('team.lastSignedInShortdate', { shortDate: stampDay(e.lastLoginAt) }) : undefined });
  else if (e.invitedAt) out.push({ label: t('teamStatus.invited', { date: stampDay(e.invitedAt) }), cls: 'brand', title: t('team.hasntSignedInYet') });
  else if (!deliverable(e.email)) out.push({ label: t('team.noEmail'), cls: 'warn', title: t('team.addAnEmailAddressSo') });
  else out.push({ label: t('team.notInvited'), cls: 'warn' });
  if (e.twoStep !== undefined && (e.onboardedAt || e.lastLoginAt || e.twoStep)) out.push({ label: e.twoStep ? t('teamStatus.twoStepOn') : t('teamStatus.twoStepOff'), cls: e.twoStep ? 'ok' : 'warn', icon: 'shield' });
  if (e.smsStatus === 'on') out.push({ label: t('teamStatus.textsOn'), cls: 'ok', icon: 'phone' });
  else if (e.smsStatus === 'stopped') out.push({ label: t('teamStatus.textsStopped'), cls: 'warn', icon: 'phone', title: t('teamStatus.repliedStop') });
  else out.push({ label: t('teamStatus.textsOff'), cls: '', icon: 'phone' });
  return out;
}

export function PersonBadges({ e }) {
  const t = useT();
  if (IS_DEMO) return null;
  return personStatus(e, t).map((s) => <span key={s.label} className={`badge ${s.cls}`} title={s.title}>{s.icon && <Icon name={s.icon} size={11} />}{s.label}</span>);
}

/** Team → Add employee: name, email and role. Saving sends the invitation by email. */
export function AddEmployeeDialog({ onClose, onFullEditor }) {
  const t = useT();
  const { call, me, employees, emailEnabled } = useApp();
  const [f, setF] = useState({ name: '', email: '', role: 'employee' });
  const [done, setDone] = useState(null);
  const [run, busy] = useAction();
  const superAdminExists = employees.some((e) => roleOf(e) === 'super_admin' && e.active !== false);
  const roles = assignableRoles(me, { superAdminExists });
  const email = f.email.trim().toLowerCase();
  const taken = email && employees.find((x) => String(x.email || '').toLowerCase() === email);
  const valid = f.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !taken;
  const save = async () => {
    const r = await run(() => call('employees.save', { name: f.name.trim(), email, role: f.role, invite: true, jobCodes: [], active: true, onSchedule: true }));
    if (r) setDone(r);
  };
  if (done) return (
    <Modal title={t('team.nameAdded', { name: done.name })} onClose={() => onClose(true)} footer={<button className="btn primary" onClick={() => onClose(true)}>{t('common.done')}</button>}>
      {done.invited
        ? <div className="alert ok"><Icon name="send" size={16} />{t('teamStatus.invitationSent', { email: done.email })}</div>
        : <div className="alert warn"><Icon name="alert" size={16} />{done.inviteError || t('teamStatus.noInvitation')}</div>}
      <div className="help">{t('teamStatus.whatHappensNext')}</div>
      <div className="help">{t('teamStatus.addJobsLater')}</div>
    </Modal>
  );
  return (
    <Modal title={t('teamStatus.addEmployee')} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !valid} onClick={save}><Icon name="send" />{emailEnabled ? t('teamStatus.addAndInvite') : t('team.addPerson')}</button></>}>
      {!emailEnabled && !IS_DEMO && <div className="alert warn"><Icon name="alert" size={16} />{t('teamStatus.emailNotSetUp')}</div>}
      <Field label={t('common.name')}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus autoComplete="off" /></Field>
      <Field label={t('common.email')} help={taken ? t('teamStatus.emailTaken', { name: taken.name }) : t('teamStatus.emailHelp')}>
        <input className="input" type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder={t('team.nameExampleCom')} autoComplete="off" />
      </Field>
      <Field label={t('team.role')}>
        <div className="col" style={{ gap: 6 }}>
          {ROLES.filter((r) => roles.includes(r.id)).map((role) => roleInfo(role, t.lang)).map((r) => (
            <label key={r.id} className="check role-choice" style={{ background: f.role === r.id ? 'var(--brand-soft)' : undefined }}>
              <input type="radio" name="new-role" checked={f.role === r.id} onChange={() => setF({ ...f, role: r.id })} />
              <span><b>{r.label}</b><span className="small muted"> — {r.summary}</span></span>
            </label>
          ))}
        </div>
      </Field>
      <div className="help">{t('teamStatus.neverTexted')}</div>
      {onFullEditor && <div><button type="button" className="btn ghost sm wrap-btn" onClick={onFullEditor}>{t('teamStatus.noEmailFullEditor')}</button></div>}
    </Modal>
  );
}

/** In the person's editor (next to Resend invite): their two-step status, and resetting it (with a confirmation). */
export function SignInHelp({ emp }) {
  const t = useT();
  const { me, refresh, toast } = useApp();
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  if (IS_DEMO || !emp?.id || emp.id === me.id || !canManageUser(me, emp)) return null;
  const joined = !!(emp.onboardedAt || emp.lastLoginAt);
  const reset = async () => {
    const r = await run(() => resetTwoStep(emp.id));
    setSure(false);
    if (r) { toast(r.emailed ? t('teamStatus.resetDoneEmailed', { name: emp.name }) : t('teamStatus.resetDone', { name: emp.name })); refresh(); }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="small muted">{emp.twoStep ? t('teamStatus.twoStepIsOn') : joined ? t('teamStatus.twoStepNextSignIn') : t('teamStatus.twoStepAtSetup')}</div>
      {emp.twoStep && !sure && <div><button className="btn sm" disabled={busy} onClick={() => setSure(true)}><Icon name="shield" />{t('teamStatus.resetTwoStep')}</button></div>}
      {sure && (
        <div className="alert warn col" style={{ alignItems: 'stretch', gap: 8 }}>
          <div>{t('teamStatus.resetConfirm', { name: emp.name })}</div>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm danger solid" disabled={busy} onClick={reset}>{t('teamStatus.yesReset')}</button>
            <button className="btn sm" onClick={() => setSure(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The demo: admins can walk through the welcome wizard and the consent screen with sample data. */
export function PreviewOnboardingLink() {
  const t = useT();
  const { isAdmin } = useApp();
  if (!IS_DEMO || !isAdmin) return null;
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <a className="btn sm" href="#/welcome?preview=1"><Icon name="sparkle" />{t('teamStatus.previewOnboarding')}</a>
      <a className="btn sm ghost" href="#/welcome?preview=1&step=consent">{t('teamStatus.previewConsent')}</a>
    </div>
  );
}
