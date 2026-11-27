import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, useAction, JobDot, Empty } from '../ui.jsx';
import { AvailabilitySummary } from './AvailabilityEditor.jsx'; // their week, editable with its history (logged)
import { ApprovesFor } from './ApprovalScope.jsx'; // which positions they approve trades and time off for
import { AddTimeOffButton } from './TimeOff.jsx'; // a manager adds time off for them (emailed in, a call…)
import { ROLES, roleLabel, roleOf, assignableRoles, canManageUser, canManageEvents, roleInfo } from '../../../core/roles.js';
import { deliverable } from '../../../core/email-address.js';
import { sameArea } from '../../../core/areas.js';
import { roomsForPosition, homeRoom, entryRooms } from '../../../core/layout.js';
import { sendSignInLink, inviteAll, IS_DEMO } from '../api.js';
import { t, useT, stampDay } from '../i18n/index.js';
import { AddEmployeeDialog, PersonBadges, SignInHelp, PreviewOnboardingLink } from './TeamInvite.jsx'; // invitations, status, sign-in help
import { LegalNameFields, LegalNameNote } from './LegalName.jsx'; // legal name for payroll (core/names.js)
import { PersonRatings } from './Ratings.jsx'; // their rating per position (managers only, never the person)
import { nameMatches, canSeeLegalName } from '../../../core/names.js';
import { SmartImportButton } from './SmartImportButton.jsx'; // Import people from a file (smart import)

const COLORS = ['#2563eb', '#16a34a', '#65a30d', '#0891b2', '#9333ea', '#a855f7', '#dc2626', '#e11d48', '#d97706', '#ca8a04', '#475569', '#0f766e', '#334155', '#7c2d12', '#db2777'];
const JOB_ROLES = ['employee', 'supervisor', 'manager'];
const shortDate = (iso) => stampDay(iso);

/** Where someone is with signing in, for the admin list. */
export function signInStatus(e) {
  if (e.active === false) return { label: t('team.inactive'), cls: '' };
  if (e.lastLoginAt) return { label: t('team.active'), cls: 'ok', title: t('team.lastSignedInShortdate', { shortDate: shortDate(e.lastLoginAt) }) };
  if (!deliverable(e.email)) return { label: t('team.noEmail'), cls: 'warn', title: t('team.addAnEmailAddressSo') };
  if (e.invitedAt) return { label: t('team.invitedShortdate', { shortDate: shortDate(e.invitedAt) }), cls: 'brand', title: t('team.hasntSignedInYet') };
  return { label: t('team.notInvited'), cls: 'warn' };
}

export default function Team({ parts = [] }) {
  const t = useT();
  const { employees, jobCodes, jobs, me, emailEnabled, refresh, toast, has } = useApp();
  const [tab, setTab] = useState('people');
  const [q, setQ] = useState('');
  const [job, setJob] = useState('');
  const [role, setRole] = useState('');
  const [edit, setEdit] = useState(null);
  const [editJob, setEditJob] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [run, busy] = useAction();
  // #/team/<id> (the schedule's person panel → Full Team profile) opens that person.
  useEffect(() => {
    const e = parts[1] && employees.find((x) => x.id === parts[1]);
    if (e) { setEdit(e); history.replaceState(null, '', '#/team'); }
  }, [parts[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = employees.filter((e) => (showInactive || e.active !== false) && nameMatches(e, q)
    && (!job || e.jobCodes?.some((j) => j.jobCodeId === job)) && (!role || roleOf(e) === role));
  const depts = [...new Set(jobCodes.map((j) => j.department))];
  // People this manager can invite: never signed in, active, with a real email.
  const invitable = useMemo(() => employees.filter((e) => e.id !== me.id && e.active !== false && !e.lastLoginAt && deliverable(e.email) && canManageUser(me, e)), [employees, me]);
  const missingEmail = employees.filter((e) => e.active !== false && !e.lastLoginAt && !deliverable(e.email)).length;

  const inviteOne = (e, ev) => {
    ev.stopPropagation();
    run(() => sendSignInLink(e.id), (r) => t('team.signInLinkSentTo', { to: r.to }));
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="tabs">
        <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>{t('common.people')}{' '}<span className="badge">{employees.filter((e) => e.active !== false).length}</span></button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>{t('team.roles')}</button>
        <button className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>{t('team.jobCodes')}{' '}<span className="badge">{jobCodes.filter((j) => !j.archived).length}</span></button>
        <button onClick={() => { location.hash = '#/trade-stats'; }}><Icon name="chart" size={14} />{t('tradeStats.title')}</button>
        {has('ratingsView') && <button onClick={() => { location.hash = '#/settings/ratings'; }}><Icon name="star" size={14} />{t('ratings.title')}</button>}
      </div>

      {tab === 'people' && <>
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 200 }} placeholder={t('team.searchName')} value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ maxWidth: 170 }} value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">{t('team.allJobCodes')}</option>
            {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 150 }} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t('team.allRoles')}</option>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{roleLabel(r.id, t.lang)}</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t('team.showInactive')}</label>
          <span className="spacer" />
          {emailEnabled && invitable.length > 0 && (
            <button className="btn sm" disabled={busy} title={t('team.emailASignInLink')}
              onClick={() => run(() => inviteAll(), (r) => `${t('team.sentLinks', { count: r.sent })}${r.noEmail ? t('team.stillNeedEmail', { count: r.noEmail }) : ''}`)}>
              <Icon name="send" />{t('team.inviteEveryoneInvitablecount', { invitableCount: invitable.length })}</button>
          )}
          <PreviewOnboardingLink />
          <SmartImportButton target="employees" />
          <button className="btn primary sm" onClick={() => setAdding(true)}><Icon name="plus" />{t('teamStatus.addEmployee')}</button>
        </div>
        {!IS_DEMO && !emailEnabled && <div className="alert info" style={{ marginBottom: 10 }}><Icon name="alert" size={16} />{t('team.emailIsntSwitchedOnYet')}</div>}
        {emailEnabled && missingEmail > 0 && <div className="small muted" style={{ marginBottom: 8 }}>{missingEmail} {missingEmail === 1 ? t('team.personNeeds') : t('team.peopleNeed')}{' '}{t('team.anEmailAddressBeforeThey')}</div>}
        <div className="card list">
          {!list.length && <Empty icon="users" title={t('team.noOneMatches')} />}
          {list.map((e) => {
            const canInvite = emailEnabled && !e.lastLoginAt && e.active !== false && deliverable(e.email) && e.id !== me.id && canManageUser(me, e);
            return (
              <div key={e.id} className="list-item click" onClick={() => setEdit(e)} style={{ opacity: e.active === false ? 0.5 : 1 }}>
                <Avatar user={e} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <b>{e.name}</b><LegalNameNote person={e} />
                    {e.sheetName && <span className="small muted" title={t('team.nameOnTheSchedule')}>“{e.sheetName}”</span>}
                    {roleOf(e) !== 'employee' && <span className="badge brand">{roleLabel(e, t.lang)}</span>}
                    {e.eventsAccess && roleOf(e) !== 'manager' && !['admin', 'super_admin'].includes(roleOf(e)) && <span className="badge">{t('common.events')}</span>}
                    <PersonBadges e={e} />
                  </div>
                  <div className="small muted">{e.email || t('team.noEmail')}{e.phone ? ` · ${e.phone}` : ''}</div>
                </div>
                <div className="row wrap desktop-only" style={{ gap: 4, justifyContent: 'flex-end', maxWidth: 340 }}>
                  {e.jobCodes?.map((j) => <span key={j.jobCodeId} className="badge"><JobDot job={jobs[j.jobCodeId]} />{jobs[j.jobCodeId]?.name}</span>)}
                </div>
                {canInvite && <button className="btn sm" disabled={busy} onClick={(ev) => inviteOne(e, ev)} title={t('team.emailALinkToSet')}>
                  <Icon name="send" />{e.invitedAt ? t('team.resend') : t('team.invite')}</button>}
                <span className="badge mobile-only">{e.jobCodes?.length || 0}{' '}{t('team.jobs')}</span>
              </div>
            );
          })}
        </div>
      </>}

      {tab === 'roles' && <RolesOverview />}

      {tab === 'jobs' && <>
        <div className="toolbar">
          <span className="muted small">{t('team.eachJobCodeHasIts')}</span>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setEditJob({ color: COLORS[jobCodes.length % COLORS.length], department: depts[0] || 'Restaurant', order: jobCodes.length, defaultRole: 'employee' })}><Icon name="plus" />{t('team.addJobCode')}</button>
        </div>
        {depts.map((d) => (
          <div key={d} className="section">
            <div className="section-title"><h3>{d}</h3></div>
            <div className="card list">
              {jobCodes.filter((j) => j.department === d).map((j) => (
                <div key={j.id} className="list-item click" onClick={() => setEditJob(j)} style={{ opacity: j.archived ? 0.5 : 1 }}>
                  <span className="swatch" style={{ background: j.color, width: 14, height: 14 }} />
                  <div style={{ flex: 1 }}><b>{j.name}</b> <span className="faint small">{j.short}</span>
                    {j.defaultRole && j.defaultRole !== 'employee' && <span className="badge brand" style={{ marginLeft: 6 }}>{roleLabel(j.defaultRole, t.lang)}</span>}
                    {j.eventRole && <span className="badge" style={{ marginLeft: 6 }}>{t('common.events')}</span>}{j.archived && <span className="badge" style={{ marginLeft: 6 }}>{t('team.archived')}</span>}</div>
                  <span className="small muted">{t('team.filtercountPeople', { filterCount: employees.filter((e) => e.active !== false && e.jobCodes?.some((x) => x.jobCodeId === j.id)).length })}</span>
                  <span className="small num" style={{ width: 70, textAlign: 'right' }}>{j.defaultRate ? t('team.defaultrateHr', { defaultRate: j.defaultRate }) : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </>}

      {edit && <EmployeeDialog emp={edit} onClose={(changed) => { setEdit(null); if (changed) refresh(); }} />}
      {adding && <AddEmployeeDialog onClose={(changed) => { setAdding(false); if (changed) refresh(); }}
        onFullEditor={() => { setAdding(false); setEdit({ jobCodes: [], role: 'employee', active: true, onSchedule: true }); }} />}
      {editJob && <JobDialog job={editJob} onClose={() => setEditJob(null)} />}
    </div>
  );
}

function RolesOverview() {
  const t = useT();
  const { employees, settings } = useApp();
  const count = (id) => employees.filter((e) => e.active !== false && roleOf(e) === id).length;
  const eventsPeople = employees.filter((e) => e.active !== false && e.eventsAccess && !canManageEvents({ role: roleOf(e) })).length;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">{t('team.eachRoleCanDoEverything')}</div>
      {ROLES.map((role) => roleInfo(role, t.lang)).map((r) => (
        <div key={r.id} className="card card-pad">
          <div className="row"><h3 style={{ flex: 1 }}>{r.label}</h3><span className="badge">{t('team.peopleCount', { count: count(r.id) })}</span></div>
          <div className="small muted" style={{ margin: '2px 0 8px' }}>{r.summary}</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {r.can.map((c, i) => <li key={c}>{c}{r.id === 'supervisor' && i === 1 ? t(settings.supervisorsCanApprove === false ? 'team.currentlyOff' : 'team.currentlyOn') : ''}</li>)}
          </ul>
        </div>
      ))}
      <div className="card card-pad">
        <div className="row"><h3 style={{ flex: 1 }}>{t('team.eventsBeosAccess')}</h3><span className="badge">{t('team.eventspeopleExtra', { eventsPeople })}</span></div>
        <div className="small muted">{t('team.managersAndUpAlwaysHave')}</div>
      </div>
    </div>
  );
}

function EmployeeDialog({ emp, onClose }) {
  const t = useT();
  const { call, jobCodes, me, employees, emailEnabled, settings } = useApp();
  const [f, setF] = useState({ onSchedule: true, ...emp, role: roleOf(emp), jobCodes: emp.jobCodes || [] });
  // The email typed is already someone's sign-in (e.g. an admin who also works shifts): offer to connect.
  const typed = String(f.email || '').trim().toLowerCase();
  const emailOwner = typed ? employees.find((x) => x.id !== emp.id && String(x.email || '').toLowerCase() === typed) : null;
  const canConnect = !!(emailOwner && emp.id && emp.id !== me.id && roleOf(emp) !== 'super_admin' && canManageUser(me, emp)
    && (emailOwner.id === me.id || canManageUser(me, emailOwner)));
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    const r = await run(() => call('employees.merge', { fromId: emp.id, intoId: emailOwner.id }),
      emailOwner.id === me.id ? t('team.connectedToYours', { name: emp.name }) : t('team.connectedToTheirs', { name: emp.name, owner: emailOwner.name }));
    if (r) onClose(true);
  };
  const [pw, setPw] = useState('');
  const [created, setCreated] = useState(null);
  const [temp, setTemp] = useState(null);
  const [run, busy] = useAction();
  const self = emp.id && emp.id === me.id;
  const editable = !emp.id || self || canManageUser(me, emp);
  const superAdminExists = employees.some((e) => roleOf(e) === 'super_admin' && e.active !== false);
  const roleChoices = self || !editable ? [roleOf(emp)] : assignableRoles(me, { superAdminExists });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const st = emp.id ? signInStatus(emp) : null;
  const managerOrUp = canManageEvents({ role: f.role });

  const save = async () => {
    const r = await run(() => call('employees.save', { ...f, password: pw || undefined }), emp.id ? t('common.saved') : null);
    if (!r) return;
    if (!emp.id) setCreated(r);
    else onClose(true);
  };

  if (created) return (
    <Modal title={t('team.nameAdded', { name: created.name })} onClose={() => onClose(true)} footer={<button className="btn primary" onClick={() => onClose(true)}>{t('common.done')}</button>}>
      {created.invited
        ? <div className="alert ok"><Icon name="send" size={16} />{t('team.weEmailedEmailALink', { email: created.email })}</div>
        : <div className="alert ok"><Icon name="check" size={16} />{t('team.nameCanNowSignIn', { name: created.name })}{created.email ? '' : t('team.onceYouAddAnEmail')}.</div>}
      {created.inviteError && <div className="alert warn"><Icon name="alert" size={16} />{created.inviteError}</div>}
      <div className="kv"><dt>{t('team.role')}</dt><dd>{roleLabel(created, t.lang)}</dd><dt>{t('common.email')}</dt><dd>{created.email || t('team.noneYet')}</dd><dt>{created.invited ? t('team.backupPassword') : t('team.tempPassword')}</dt><dd><code style={{ fontSize: 15 }}>{created.tempPassword}</code></dd></div>
      <div className="help">{created.invited ? t('team.onlyNeededIfTheEmail') : t('team.shareThisPrivatelyTheyCan')}</div>
    </Modal>
  );

  return (
    <Modal wide title={emp.id ? emp.name : t('team.addPerson')} sub={emp.id ? roleLabel(emp, t.lang) : undefined} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{editable ? t('common.cancel') : t('team.close')}</button>
        {editable && <button className="btn primary" disabled={busy || !f.name || !!emailOwner} onClick={save}>{emp.id ? t('common.save') : t('team.addPerson')}</button>}</>}>
      {!editable && <div className="alert info"><Icon name="alert" size={16} />{t('team.onlyHigherRoleCanEdit', { role: roleLabel(emp, t.lang), article: /^[AEIOU]/.test(roleLabel(emp)) ? 'an' : 'a' })}</div>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        <div className="grid2">
          <Field label={t('common.name')}><input className="input" value={f.name || ''} onChange={set('name')} autoFocus={!emp.id} /></Field>
          <Field label={t('team.nameOnTheSchedule')} help={t('team.howTheScheduleSheetWrites')}>
            <input className="input" value={f.sheetName || ''} onChange={set('sheetName')} placeholder={f.name ? String(f.name).split(' ')[0].toUpperCase() : t('team.eGMoe')} maxLength={40} />
          </Field>
          {(!emp.id || canSeeLegalName(me, emp)) && <LegalNameFields value={f} onChange={(v) => setF({ ...f, ...v })} help={t('legalName.teamHelp')} own={self} style={{ gridColumn: '1 / -1' }} />}
          <Field label={t('team.emailSignIn')}><input className="input" type="email" value={f.email || ''} onChange={(e) => { setConnecting(false); set('email')(e); }} placeholder={t('team.nameExampleCom')} /></Field>
          <Field label={t('team.phone')}><input className="input" type="tel" value={f.phone || ''} onChange={set('phone')} /></Field>
          <Field label={t('team.status')}><label className="check" style={{ height: 38 }}><input type="checkbox" checked={f.active !== false} onChange={set('active')} disabled={self} />{t('team.activeCanSignInAnd')}</label></Field>
        </div>
        {emailOwner && (
          <div className="alert warn col" style={{ alignItems: 'stretch', gap: 8 }}>
            <div className="row" style={{ gap: 8 }}><Icon name="alert" size={16} />
              <span>{emailOwner.id === me.id ? t('team.typedIsYourSignIn', { typed, role: roleLabel(emailOwner, t.lang) }) : t('team.typedIsTheirSignIn', { typed, name: emailOwner.name, role: roleLabel(emailOwner, t.lang) })}{canConnect ? t('team.isThisTheSamePerson') : emp.id ? '' : t('team.openNameSProfileTo', { name: emailOwner.name })}</span>
            </div>
            {canConnect && !connecting && (
              <div className="row wrap"><button type="button" className="btn sm primary" onClick={() => setConnecting(true)}><Icon name="user" />{emailOwner.id === me.id ? t('team.yesConnectToMine', { name: emp.name }) : t('team.yesConnectToTheirs', { name: emp.name, owner: emailOwner.name })}</button></div>
            )}
            {canConnect && connecting && (
              <div className="col" style={{ gap: 8 }}>
                <div className="small">{t(emailOwner.id === me.id ? 'team.sureMoveToMine' : 'team.sureMoveToTheirs', { name: emp.name, owner: emailOwner.name, role: roleLabel(emailOwner, t.lang) })}{emailOwner.sheetName ? '' : t('team.andValueBecomesTheName', { value: emp.sheetName || emp.name })}.</div>
                <div className="row wrap">
                  <button type="button" className="btn sm danger solid" disabled={busy} onClick={connect}>{t('team.connectAccounts')}</button>
                  <button type="button" className="btn sm" onClick={() => setConnecting(false)}>{t('common.cancel')}</button>
                </div>
              </div>
            )}
            {emailOwner && emp.id && !canConnect && <div className="small">{t('team.onlySomeoneWhoCanManage')}</div>}
          </div>
        )}

        <Field label={t('team.role')} help={self ? t('team.youCantChangeYourOwn') : undefined}>
          <div className="col" style={{ gap: 6 }}>
            {ROLES.filter((r) => roleChoices.includes(r.id)).map((role) => roleInfo(role, t.lang)).map((r) => (
              <React.Fragment key={r.id}>
                <label className="check" style={{ alignItems: 'flex-start', padding: '6px 8px', borderRadius: 8, background: f.role === r.id && !f.customRole ? 'var(--brand-soft)' : undefined }}>
                  <input type="radio" name="role" checked={f.role === r.id && !f.customRole} onChange={() => setF({ ...f, role: r.id, customRole: '' })} style={{ marginTop: 3 }} />
                  <span><b>{r.label}</b><span className="small muted"> — {r.summary}</span></span>
                </label>
                {/* Custom roles on this level (Settings → Roles & features → Custom roles): Bar Manager, Shift Lead… */}
                {(settings.customRoles || []).filter((c) => c.base === r.id).map((c) => (
                  <label key={c.id} className="check" style={{ alignItems: 'flex-start', padding: '6px 8px 6px 28px', borderRadius: 8, background: f.customRole === c.id ? 'var(--brand-soft)' : undefined }}>
                    <input type="radio" name="role" checked={f.customRole === c.id} onChange={() => setF({ ...f, role: c.base, customRole: c.id })} style={{ marginTop: 3 }} />
                    <span><b>{t.lang === 'es' && c.nameEs ? c.nameEs : c.name}</b><span className="small muted"> — {t('roles.customOn', { base: r.label })}</span></span>
                  </label>
                ))}
              </React.Fragment>
            ))}
          </div>
        </Field>
        <div className="row wrap" style={{ gap: 18 }}>
          <label className="check"><input type="checkbox" checked={managerOrUp || !!f.eventsAccess} disabled={managerOrUp} onChange={set('eventsAccess')} />{t('team.canCreateAndEditEvents')}{managerOrUp ? t('team.includedWithThisRole') : ''}</label>
          <label className="check"><input type="checkbox" checked={f.onSchedule !== false} onChange={set('onSchedule')} />{t('team.showOnTheSchedule')}</label>
        </div>

        <div className="field">
          <span>{t('team.positions')}</span>
          <PersonPositions value={f.jobCodes} onChange={(jobCodes) => setF({ ...f, jobCodes })} />
          <div className="help">{t('team.positionsHelp')}</div>
        </div>
        {/* Employment details (also filled by Team → Import): managers only; coworkers never see them. */}
        <details className="tp-help" open={!!(f.hireDate || f.birthday || f.employeeId || f.notes)}>
          <summary>{t('smartImport.detailsTitle')}</summary>
          <div className="row wrap" style={{ gap: 10, marginTop: 8, alignItems: 'flex-start' }}>
            <Field label={t('smartImport.f_employees_hireDate')}><input className="input" type="date" value={f.hireDate || ''} onChange={set('hireDate')} style={{ maxWidth: 170 }} /></Field>
            <Field label={t('smartImport.f_employees_birthday')} help={t('smartImport.birthdayHelp')}><input className="input" value={f.birthday || ''} onChange={set('birthday')} placeholder="MM-DD" style={{ maxWidth: 140 }} /></Field>
            <Field label={t('smartImport.f_employees_employeeId')}><input className="input" value={f.employeeId || ''} onChange={set('employeeId')} style={{ maxWidth: 160 }} /></Field>
          </div>
          <Field label={t('smartImport.f_employees_notes')}><textarea className="input" rows={2} value={f.notes || ''} onChange={set('notes')} /></Field>
        </details>
        {!emp.id && (
          <Field label={t('team.passwordOptional')} help={emailEnabled ? t('team.leaveBlankWellEmailThem') : t('team.leaveBlankToGenerateA')}>
            <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" style={{ maxWidth: 300 }} />
          </Field>
        )}
      </fieldset>
      {/* Outside the fieldset: a manager can edit an admin's availability; what someone approves has its own rules. */}
      {emp.id && <AvailabilitySummary person={emp} />}
      {emp.id && <ApprovesFor person={emp} />}
      {emp.id && <AddTimeOffButton person={emp} />}
      {emp.id && <PersonRatings person={emp} />}

      {emp.id && editable && !self && roleOf(emp) !== 'super_admin' && <MergePerson emp={emp} onDone={() => onClose(true)} />}

      {emp.id && !IS_DEMO && (editable || self) && (
        <div className="card card-pad col" style={{ gap: 8, background: 'var(--bg-2, transparent)' }}>
          <div className="row"><b style={{ flex: 1 }}>{t('team.signIn')}</b><span className={`badge ${st.cls}`} title={st.title}>{st.label}</span></div>
          <div className="small muted">
            {emp.lastLoginAt ? t('team.lastSignedInShortdate2', { shortDate: shortDate(emp.lastLoginAt) }) : emp.invitedAt ? t('team.invitedShortdateHasntSignedIn', { shortDate: shortDate(emp.invitedAt) }) : t('team.hasntBeenInvitedYet')}
          </div>
          <div className="row wrap">
            {emailEnabled && deliverable(emp.email) && !self && (
              <button className="btn sm" disabled={busy} onClick={() => run(() => sendSignInLink(emp.id), (r) => t(emp.lastLoginAt ? 'team.resetLinkSent' : 'team.inviteLinkSent', { to: r.to }))}>
                <Icon name="send" />{emp.lastLoginAt ? t('team.emailAPasswordResetLink') : emp.invitedAt ? t('team.resendInviteLink') : t('team.sendInviteLink')}
              </button>
            )}
            {!self && <button className="btn sm" disabled={busy} onClick={() => run(() => call('employees.resetPassword', { userId: emp.id }), t('team.temporaryPasswordSet')).then((r) => r && setTemp(r.tempPassword))}>
              <Icon name="edit" />{t('team.setATemporaryPassword')}</button>}
          </div>
          <SignInHelp emp={emp} />
          {!deliverable(emp.email) && !self && <div className="help">{t('team.addAnEmailAboveAnd')}</div>}
          {temp && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('team.temporaryPassword')}{' '}<code style={{ fontSize: 15 }}>{temp}</code>{t('team.shareItPrivatelyItWont')}</div></div>}
        </div>
      )}
    </Modal>
  );
}

/**
 * A person's positions: each with the rooms they work it in (the rooms whose layout lists that
 * position, Settings → Rooms & positions) and their pay rate for it. They're listed in those
 * sections on the schedule and offered first when scheduling there.
 */
function PersonPositions({ value, onChange }) {
  const t = useT();
  const { jobCodes, jobs, layout } = useApp();
  const update = (i, patch) => onChange(value.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const drop = (i) => {
    const next = value.filter((_, k) => k !== i);
    if (value[i].primary && next.length && !next.some((e) => e.primary)) next[0] = { ...next[0], primary: true };
    onChange(next);
  };
  const makeMain = (i) => onChange(value.map((e, k) => ({ ...e, primary: k === i })));
  const add = (id) => {
    const job = jobs[id];
    if (!job) return;
    // Starts in its usual room (its department's, else the first that shows it); tap other rooms to add them.
    const home = homeRoom(layout, job);
    onChange([...value, { jobCodeId: id, rate: null, primary: !value.length, ...(home ? { areas: [home] } : {}) }]);
  };
  const toggleRoom = (i, room) => {
    const e = value[i];
    const cur = entryRooms(e, jobs[e.jobCodeId]);
    const on = cur.some((a) => sameArea(a, room));
    if (on && cur.length === 1) return; // a position needs a room: take the position off instead
    // Taking off the primary room clears it (the primary room is always one of theirs).
    update(i, { areas: on ? cur.filter((a) => !sameArea(a, room)) : [...cur, room], ...(on && sameArea(e.primaryRoom, room) ? { primaryRoom: '' } : {}) });
  };
  const choices = jobCodes.filter((j) => !j.archived && !value.some((e) => e.jobCodeId === j.id));
  return (
    <div className="pp-list">
      {!value.length && <div className="small muted">{t('team.noPositions')}</div>}
      {value.map((e, i) => {
        const job = jobs[e.jobCodeId];
        if (!job) return null;
        const listed = roomsForPosition(layout, job.id);
        const mine = entryRooms(e, job);
        const extra = mine.filter((a) => !listed.some((r) => sameArea(r.room, a)));
        const shows = mine.some((a) => listed.some((r) => !r.hidden && sameArea(r.room, a)));
        return (
          <div key={e.jobCodeId} className="pp-item">
            <div className="pp-top">
              <span className="pp-name"><JobDot job={job} /><span className="ellipsis">{job.name}</span>{e.primary && <span className="badge brand">{t('team.main')}</span>}</span>
              <span className="pp-rate">
                <input className="input sm" type="number" step="0.25" min="0" placeholder={job.defaultRate ? `$${job.defaultRate}` : t('team.hr')} value={e.rate ?? ''}
                  onChange={(ev) => update(i, { rate: ev.target.value })} aria-label={t('team.rateFor', { position: job.name })} />
                <span className="small muted">{t('team.perHour')}</span>
              </span>
              {!e.primary && value.length > 1 && <button type="button" className="btn ghost sm" onClick={() => makeMain(i)}>{t('team.makeMain')}</button>}
              <button type="button" className="btn ghost icon sm danger" onClick={() => drop(i)} aria-label={t('team.removePosition', { position: job.name })} title={t('team.removePosition', { position: job.name })}><Icon name="trash" /></button>
            </div>
            <div className="pp-rooms">
              <span className="tiny muted">{t('team.rooms')}</span>
              {listed.map((r) => {
                const on = mine.some((a) => sameArea(a, r.room));
                return (
                  <button type="button" key={r.room} className={`chip ${on ? 'on' : ''} ${r.hidden ? 'dashed' : ''}`} aria-pressed={on} onClick={() => toggleRoom(i, r.room)}
                    title={r.hidden ? t('team.roomHidden', { room: r.room }) : undefined}>{r.hidden ? t('team.roomHidden', { room: r.room }) : r.room}</button>
                );
              })}
              {extra.map((a) => <button type="button" key={a} className="chip on dashed" aria-pressed="true" onClick={() => toggleRoom(i, a)} title={t('team.roomNotListed', { room: a })}>{t('team.roomNotListed', { room: a })}</button>)}
            </div>
            {mine.length > 1 && (
              <label className="row pp-primary">
                <span className="tiny muted">{t('availability.primaryRoom')}</span>
                <select className="input sm" value={mine.find((a) => sameArea(a, e.primaryRoom)) || ''} onChange={(ev) => update(i, { primaryRoom: ev.target.value })}
                  aria-label={t('availability.primaryRoomFor', { position: job.name })}>
                  <option value="">{t('availability.noPrimaryRoom')}</option>
                  {mine.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            )}
            {!listed.length && <div className="help">{t('team.noRoomsForPosition')}</div>}
            {listed.length > 0 && !shows && <div className="help">{t('team.notShown')}</div>}
          </div>
        );
      })}
      {choices.length > 0 && (
        <select className="input" value="" onChange={(ev) => add(ev.target.value)} aria-label={t('team.addPosition')}>
          <option value="">{t('team.addPosition')}</option>
          {choices.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** Two records for one person (an imported "Moe" and "Louis Henson"): fold this one into the other. */
function MergePerson({ emp, onDone }) {
  const t = useT();
  const { call, employees, me } = useApp();
  const [into, setInto] = useState('');
  const [sure, setSure] = useState(false);
  const [run, busy] = useAction();
  const target = employees.find((e) => e.id === into);
  const choices = employees.filter((e) => e.id !== emp.id && e.active !== false && (e.id === me.id || canManageUser(me, e)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const merge = async () => {
    if (!sure) return setSure(true);
    const r = await run(() => call('employees.merge', { fromId: emp.id, intoId: into }),
      (res) => `${t('team.mergedPerson', { name: emp.name, into: target?.name, count: res.shifts })}${res.timeOff ? t('team.mergedTimeOff', { count: res.timeOff }) : ''}`);
    if (r) onDone();
  };
  return (
    <Field label={t('team.samePersonAsSomeoneElse')} help={t('team.movesNameSShiftsTime', { name: emp.name, value: emp.sheetName || emp.name })}>
      <div className="row wrap">
        <select className="input" style={{ maxWidth: 260 }} value={into} onChange={(e) => { setInto(e.target.value); setSure(false); }}>
          <option value="">{t('team.chooseThePersonToKeep')}</option>
          {choices.map((e) => <option key={e.id} value={e.id}>{e.name}{e.sheetName ? ` (${e.sheetName})` : ''}</option>)}
        </select>
        <button type="button" className={`btn ${sure ? 'danger solid' : ''}`} disabled={!into || busy} onClick={merge}><Icon name="copy" />{sure ? t('team.tapAgainMergeIntoName', { name: target?.name }) : t('team.merge')}</button>
      </div>
    </Field>
  );
}

function JobDialog({ job, onClose }) {
  const t = useT();
  const { call, settings, jobCodes } = useApp();
  const [f, setF] = useState({ defaultRole: 'employee', ...job });
  const [run, busy] = useAction();
  const [into, setInto] = useState('');
  const [sure, setSure] = useState(false);
  const target = jobCodes.find((j) => j.id === into);
  const merge = async () => {
    if (!sure) return setSure(true);
    const r = await run(() => call('jobCodes.merge', { fromId: job.id, intoId: into }),
      (res) => `${t('team.mergedJob', { name: job.name, into: target?.name, count: res.shifts, people: res.people })}${res.events ? t('team.mergedEvents', { count: res.events }) : ''}`);
    if (r) onClose();
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => { const r = await run(() => call('jobCodes.save', f), t('team.jobCodeSaved')); if (r) onClose(); };
  const archive = async () => { const r = await run(() => call('jobCodes.delete', { id: job.id }), t('team.jobCodeRemoved')); if (r) onClose(); };
  return (
    <Modal title={job.id ? t('common.editName', { name: job.name }) : t('team.newJobCode')} onClose={onClose}
      footer={<>{job.id && <button className="btn danger" onClick={archive} disabled={busy}>{job.archived ? t('common.delete') : t('team.archive')}</button>}<span className="spacer" /><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !f.name} onClick={save}>{t('common.save')}</button></>}>
      <div className="grid2">
        <Field label={t('common.name')}><input className="input" value={f.name || ''} onChange={set('name')} placeholder={t('team.server')} autoFocus /></Field>
        <Field label={t('team.shortCode')}><input className="input" value={f.short || ''} onChange={set('short')} placeholder={t('team.srv')} maxLength={6} /></Field>
        <Field label={t('team.departmentArea')}>
          <input className="input" list="depts" value={f.department || ''} onChange={set('department')} />
          <datalist id="depts">{settings.departments.map((d) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label={t('team.defaultRateHr')}><input className="input" type="number" step="0.25" value={f.defaultRate ?? ''} onChange={set('defaultRate')} /></Field>
        <Field label={t('team.defaultRole')} help={t('team.theRolePeopleInThis')}>
          <select className="input" value={f.defaultRole || 'employee'} onChange={set('defaultRole')}>{JOB_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r, t.lang)}</option>)}</select>
        </Field>
        <Field label={t('team.sortOrder')}><input className="input" type="number" value={f.order ?? 0} onChange={set('order')} /></Field>
      </div>
      <Field label={t('team.color')}>
        <div className="row wrap" style={{ gap: 5 }}>{COLORS.map((c) => <button key={c} type="button" onClick={() => setF({ ...f, color: c })} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: f.color === c ? '3px solid var(--text)' : '0', cursor: 'pointer' }} aria-label={c} />)}</div>
      </Field>
      <label className="check"><input type="checkbox" checked={!!f.eventRole} onChange={set('eventRole')} />{t('team.usedForEventsSuggestedWhen')}</label>
      {job.archived && <label className="check"><input type="checkbox" checked={!f.archived} onChange={(e) => setF({ ...f, archived: !e.target.checked })} />{t('team.restoreUnArchive')}</label>}
      {job.id && (
        <Field label={t('team.mergeIntoAnotherJobCode')} help={t('team.movesNameSShiftsPeople', { name: job.name })}>
          <div className="row wrap">
            <select className="input" style={{ maxWidth: 240 }} value={into} onChange={(e) => { setInto(e.target.value); setSure(false); }}>
              <option value="">{t('team.chooseAJobCode')}</option>
              {jobCodes.filter((j) => j.id !== job.id && !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            <button type="button" className={`btn ${sure ? 'danger solid' : ''}`} disabled={!into || busy} onClick={merge}><Icon name="copy" />{sure ? t('team.tapAgainMergeIntoName', { name: target?.name }) : t('team.merge')}</button>
          </div>
        </Field>
      )}
    </Modal>
  );
}
