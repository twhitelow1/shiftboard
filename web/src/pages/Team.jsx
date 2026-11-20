import React, { useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, useAction, JobDot, Empty } from '../ui.jsx';
import { ROLES, roleLabel, roleOf, assignableRoles, canManageUser, canManageEvents } from '../../../core/roles.js';
import { deliverable } from '../../../core/email-address.js';
import { scheduleAreas, uniqueAreas, sameArea } from '../../../core/areas.js';
import { sendSignInLink, inviteAll, IS_DEMO } from '../api.js';

const COLORS = ['#2563eb', '#16a34a', '#65a30d', '#0891b2', '#9333ea', '#a855f7', '#dc2626', '#e11d48', '#d97706', '#ca8a04', '#475569', '#0f766e', '#334155', '#7c2d12', '#db2777'];
const JOB_ROLES = ['employee', 'supervisor', 'manager'];
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** Where someone is with signing in, for the admin list. */
export function signInStatus(e) {
  if (e.active === false) return { label: 'Inactive', cls: '' };
  if (e.lastLoginAt) return { label: 'Active', cls: 'ok', title: `Last signed in ${shortDate(e.lastLoginAt)}` };
  if (!deliverable(e.email)) return { label: 'No email', cls: 'warn', title: 'Add an email address so they can get a sign-in link' };
  if (e.invitedAt) return { label: `Invited ${shortDate(e.invitedAt)}`, cls: 'brand', title: 'Hasn’t signed in yet' };
  return { label: 'Not invited', cls: 'warn' };
}

export default function Team() {
  const { employees, jobCodes, jobs, me, emailEnabled, refresh, toast } = useApp();
  const [tab, setTab] = useState('people');
  const [q, setQ] = useState('');
  const [job, setJob] = useState('');
  const [role, setRole] = useState('');
  const [edit, setEdit] = useState(null);
  const [editJob, setEditJob] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [run, busy] = useAction();

  const list = employees.filter((e) => (showInactive || e.active !== false) && (!q || e.name.toLowerCase().includes(q.toLowerCase()))
    && (!job || e.jobCodes?.some((j) => j.jobCodeId === job)) && (!role || roleOf(e) === role));
  const depts = [...new Set(jobCodes.map((j) => j.department))];
  // People this manager can invite: never signed in, active, with a real email.
  const invitable = useMemo(() => employees.filter((e) => e.id !== me.id && e.active !== false && !e.lastLoginAt && deliverable(e.email) && canManageUser(me, e)), [employees, me]);
  const missingEmail = employees.filter((e) => e.active !== false && !e.lastLoginAt && !deliverable(e.email)).length;

  const inviteOne = (e, ev) => {
    ev.stopPropagation();
    run(() => sendSignInLink(e.id), (r) => `Sign-in link sent to ${r.to}`);
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="tabs">
        <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>People <span className="badge">{employees.filter((e) => e.active !== false).length}</span></button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>Roles</button>
        <button className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>Job codes <span className="badge">{jobCodes.filter((j) => !j.archived).length}</span></button>
      </div>

      {tab === 'people' && <>
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 200 }} placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ maxWidth: 170 }} value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">All job codes</option>
            {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 150 }} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show inactive</label>
          <span className="spacer" />
          {emailEnabled && invitable.length > 0 && (
            <button className="btn sm" disabled={busy} title="Email a sign-in link to everyone who hasn't signed in yet"
              onClick={() => run(() => inviteAll(), (r) => `Sent ${r.sent} sign-in links${r.noEmail ? ` · ${r.noEmail} still need an email address` : ''}`)}>
              <Icon name="send" />Invite everyone ({invitable.length})
            </button>
          )}
          <button className="btn primary sm" onClick={() => setEdit({ jobCodes: [], role: 'employee', active: true, onSchedule: true })}><Icon name="plus" />Add person</button>
        </div>
        {!IS_DEMO && !emailEnabled && <div className="alert info" style={{ marginBottom: 10 }}><Icon name="alert" size={16} />Email isn’t switched on yet, so invites can’t be sent. You can still set a temporary password for anyone from their profile.</div>}
        {emailEnabled && missingEmail > 0 && <div className="small muted" style={{ marginBottom: 8 }}>{missingEmail} {missingEmail === 1 ? 'person needs' : 'people need'} an email address before they can be invited.</div>}
        <div className="card list">
          {!list.length && <Empty icon="users" title="No one matches" />}
          {list.map((e) => {
            const st = signInStatus(e);
            const canInvite = emailEnabled && !e.lastLoginAt && e.active !== false && deliverable(e.email) && e.id !== me.id && canManageUser(me, e);
            return (
              <div key={e.id} className="list-item click" onClick={() => setEdit(e)} style={{ opacity: e.active === false ? 0.5 : 1 }}>
                <Avatar user={e} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <b>{e.name}</b>
                    {roleOf(e) !== 'employee' && <span className="badge brand">{roleLabel(e)}</span>}
                    {e.eventsAccess && roleOf(e) !== 'manager' && !['admin', 'super_admin'].includes(roleOf(e)) && <span className="badge">Events</span>}
                    {!IS_DEMO && <span className={`badge ${st.cls}`} title={st.title}>{st.label}</span>}
                  </div>
                  <div className="small muted">{e.email || 'No email'}{e.phone ? ` · ${e.phone}` : ''}</div>
                </div>
                <div className="row wrap desktop-only" style={{ gap: 4, justifyContent: 'flex-end', maxWidth: 340 }}>
                  {e.jobCodes?.map((j) => <span key={j.jobCodeId} className="badge"><JobDot job={jobs[j.jobCodeId]} />{jobs[j.jobCodeId]?.name}</span>)}
                </div>
                {canInvite && <button className="btn sm" disabled={busy} onClick={(ev) => inviteOne(e, ev)} title="Email a link to set their password">
                  <Icon name="send" />{e.invitedAt ? 'Resend' : 'Invite'}</button>}
                <span className="badge mobile-only">{e.jobCodes?.length || 0} jobs</span>
              </div>
            );
          })}
        </div>
      </>}

      {tab === 'roles' && <RolesOverview />}

      {tab === 'jobs' && <>
        <div className="toolbar">
          <span className="muted small">Each job code has its own pay rate, and each person can override it. The default role is used when importing a schedule.</span>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setEditJob({ color: COLORS[jobCodes.length % COLORS.length], department: depts[0] || 'Restaurant', order: jobCodes.length, defaultRole: 'employee' })}><Icon name="plus" />Add job code</button>
        </div>
        {depts.map((d) => (
          <div key={d} className="section">
            <div className="section-title"><h3>{d}</h3></div>
            <div className="card list">
              {jobCodes.filter((j) => j.department === d).map((j) => (
                <div key={j.id} className="list-item click" onClick={() => setEditJob(j)} style={{ opacity: j.archived ? 0.5 : 1 }}>
                  <span className="swatch" style={{ background: j.color, width: 14, height: 14 }} />
                  <div style={{ flex: 1 }}><b>{j.name}</b> <span className="faint small">{j.short}</span>
                    {j.defaultRole && j.defaultRole !== 'employee' && <span className="badge brand" style={{ marginLeft: 6 }}>{roleLabel(j.defaultRole)}</span>}
                    {j.eventRole && <span className="badge" style={{ marginLeft: 6 }}>Events</span>}{j.archived && <span className="badge" style={{ marginLeft: 6 }}>Archived</span>}</div>
                  <span className="small muted">{employees.filter((e) => e.active !== false && e.jobCodes?.some((x) => x.jobCodeId === j.id)).length} people</span>
                  <span className="small num" style={{ width: 70, textAlign: 'right' }}>{j.defaultRate ? `$${j.defaultRate}/hr` : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </>}

      {edit && <EmployeeDialog emp={edit} onClose={(changed) => { setEdit(null); if (changed) refresh(); }} />}
      {editJob && <JobDialog job={editJob} onClose={() => setEditJob(null)} />}
    </div>
  );
}

function RolesOverview() {
  const { employees, settings } = useApp();
  const count = (id) => employees.filter((e) => e.active !== false && roleOf(e) === id).length;
  const eventsPeople = employees.filter((e) => e.active !== false && e.eventsAccess && !canManageEvents({ role: roleOf(e) })).length;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">Each role can do everything the roles below it can. Change someone's role from their profile in People.</div>
      {ROLES.map((r) => (
        <div key={r.id} className="card card-pad">
          <div className="row"><h3 style={{ flex: 1 }}>{r.label}</h3><span className="badge">{count(r.id)} {count(r.id) === 1 ? 'person' : 'people'}</span></div>
          <div className="small muted" style={{ margin: '2px 0 8px' }}>{r.summary}</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {r.can.map((c) => <li key={c}>{c}{r.id === 'supervisor' && c.startsWith('Approve') ? ` — currently ${settings.supervisorsCanApprove === false ? 'off' : 'on'}` : ''}</li>)}
          </ul>
        </div>
      ))}
      <div className="card card-pad">
        <div className="row"><h3 style={{ flex: 1 }}>Events & BEOs access</h3><span className="badge">{eventsPeople} extra</span></div>
        <div className="small muted">Managers and up always have it. Give it to Supervisors or Employees who run events (for example an events coordinator) with the switch on their profile.</div>
      </div>
    </div>
  );
}

function EmployeeDialog({ emp, onClose }) {
  const { call, jobCodes, me, employees, emailEnabled, settings } = useApp();
  const [f, setF] = useState({ onSchedule: true, ...emp, role: roleOf(emp), jobCodes: emp.jobCodes || [] });
  const allAreas = uniqueAreas([...scheduleAreas(settings), ...f.jobCodes.flatMap((j) => j.areas || [])]);
  const [pw, setPw] = useState('');
  const [created, setCreated] = useState(null);
  const [temp, setTemp] = useState(null);
  const [run, busy] = useAction();
  const self = emp.id && emp.id === me.id;
  const editable = !emp.id || self || canManageUser(me, emp);
  const superAdminExists = employees.some((e) => roleOf(e) === 'super_admin' && e.active !== false);
  const roleChoices = self || !editable ? [roleOf(emp)] : assignableRoles(me, { superAdminExists });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const has = (id) => f.jobCodes.find((j) => j.jobCodeId === id);
  const toggle = (id) => setF({ ...f, jobCodes: has(id) ? f.jobCodes.filter((j) => j.jobCodeId !== id) : [...f.jobCodes, { jobCodeId: id, rate: null }] });
  const setRate = (id, rate) => setF({ ...f, jobCodes: f.jobCodes.map((j) => (j.jobCodeId === id ? { ...j, rate } : j)) });
  const toggleArea = (id, area) => setF({ ...f, jobCodes: f.jobCodes.map((j) => (j.jobCodeId !== id ? j
    : { ...j, areas: (j.areas || []).some((a) => sameArea(a, area)) ? j.areas.filter((a) => !sameArea(a, area)) : [...(j.areas || []), area] })) });
  const st = emp.id ? signInStatus(emp) : null;
  const managerOrUp = canManageEvents({ role: f.role });

  const save = async () => {
    const r = await run(() => call('employees.save', { ...f, password: pw || undefined }), emp.id ? 'Saved' : null);
    if (!r) return;
    if (!emp.id) setCreated(r);
    else onClose(true);
  };

  if (created) return (
    <Modal title={`${created.name} added`} onClose={() => onClose(true)} footer={<button className="btn primary" onClick={() => onClose(true)}>Done</button>}>
      {created.invited
        ? <div className="alert ok"><Icon name="send" size={16} />We emailed {created.email} a link to set their password.</div>
        : <div className="alert ok"><Icon name="check" size={16} />{created.name} can now sign in{created.email ? '' : ' once you add an email'}.</div>}
      {created.inviteError && <div className="alert warn"><Icon name="alert" size={16} />{created.inviteError}</div>}
      <div className="kv"><dt>Role</dt><dd>{roleLabel(created)}</dd><dt>Email</dt><dd>{created.email || '(none yet)'}</dd><dt>{created.invited ? 'Backup password' : 'Temp password'}</dt><dd><code style={{ fontSize: 15 }}>{created.tempPassword}</code></dd></div>
      <div className="help">{created.invited ? 'Only needed if the email doesn’t arrive. Share it privately.' : 'Share this privately. They can change it after signing in.'}</div>
    </Modal>
  );

  return (
    <Modal wide title={emp.id ? emp.name : 'Add person'} sub={emp.id ? roleLabel(emp) : undefined} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button className="btn primary" disabled={busy || !f.name} onClick={save}>{emp.id ? 'Save' : 'Add person'}</button>}</>}>
      {!editable && <div className="alert info"><Icon name="alert" size={16} />Only a higher role can edit {/^[AEIOU]/.test(roleLabel(emp)) ? 'an' : 'a'} {roleLabel(emp)}.</div>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        <div className="grid2">
          <Field label="Name"><input className="input" value={f.name || ''} onChange={set('name')} autoFocus={!emp.id} /></Field>
          <Field label="Email (sign-in)"><input className="input" type="email" value={f.email || ''} onChange={set('email')} placeholder="name@example.com" /></Field>
          <Field label="Phone"><input className="input" type="tel" value={f.phone || ''} onChange={set('phone')} /></Field>
          <Field label="Status"><label className="check" style={{ height: 38 }}><input type="checkbox" checked={f.active !== false} onChange={set('active')} disabled={self} />Active (can sign in and be scheduled)</label></Field>
        </div>

        <Field label="Role" help={self ? 'You can’t change your own role. Ask another admin.' : undefined}>
          <div className="col" style={{ gap: 6 }}>
            {ROLES.filter((r) => roleChoices.includes(r.id)).map((r) => (
              <label key={r.id} className="check" style={{ alignItems: 'flex-start', padding: '6px 8px', borderRadius: 8, background: f.role === r.id ? 'var(--brand-soft)' : undefined }}>
                <input type="radio" name="role" checked={f.role === r.id} onChange={() => setF({ ...f, role: r.id })} style={{ marginTop: 3 }} />
                <span><b>{r.label}</b><span className="small muted"> — {r.summary}</span></span>
              </label>
            ))}
          </div>
        </Field>
        <div className="row wrap" style={{ gap: 18 }}>
          <label className="check"><input type="checkbox" checked={managerOrUp || !!f.eventsAccess} disabled={managerOrUp} onChange={set('eventsAccess')} />Can create and edit events & BEOs{managerOrUp ? ' (included with this role)' : ''}</label>
          <label className="check"><input type="checkbox" checked={f.onSchedule !== false} onChange={set('onSchedule')} />Show on the schedule</label>
        </div>

        <Field label="Job codes, pay rates & areas" help="Pick every position this person can work; they can only pick up shifts for these. Leave the rate blank to use the job's default. Areas are where they usually work it; they're listed there on the schedule.">
          <div className="col" style={{ gap: 4, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 6 }}>
            {jobCodes.filter((j) => !j.archived).map((j) => {
              const h = has(j.id);
              return (
                <div key={j.id} style={{ padding: '4px 6px', borderRadius: 8, background: h ? 'var(--brand-soft)' : undefined }}>
                  <div className="row">
                    <label className="check" style={{ flex: 1 }}><input type="checkbox" checked={!!h} onChange={() => toggle(j.id)} /><JobDot job={j} />{j.name} <span className="faint small">{j.department}</span></label>
                    {h && <input className="input sm" type="number" step="0.25" style={{ width: 100 }} placeholder={j.defaultRate ? `$${j.defaultRate}` : '$/hr'} value={h.rate ?? ''} onChange={(e) => setRate(j.id, e.target.value)} />}
                  </div>
                  {h && allAreas.length > 0 && (
                    <div className="row wrap" style={{ gap: 4, margin: '4px 0 2px 26px' }}>
                      {allAreas.map((a) => {
                        const on = (h.areas || []).some((x) => sameArea(x, a));
                        return <button type="button" key={a} className={`chip ${on ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => toggleArea(j.id, a)}>{a}</button>;
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Field>
        {!emp.id && (
          <Field label="Password (optional)" help={emailEnabled ? 'Leave blank: we’ll email them a link to set their own (if they have an email).' : 'Leave blank to generate a temporary one.'}>
            <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" style={{ maxWidth: 300 }} />
          </Field>
        )}
      </fieldset>

      {emp.id && !IS_DEMO && (editable || self) && (
        <div className="card card-pad col" style={{ gap: 8, background: 'var(--bg-2, transparent)' }}>
          <div className="row"><b style={{ flex: 1 }}>Sign-in</b><span className={`badge ${st.cls}`} title={st.title}>{st.label}</span></div>
          <div className="small muted">
            {emp.lastLoginAt ? `Last signed in ${shortDate(emp.lastLoginAt)}.` : emp.invitedAt ? `Invited ${shortDate(emp.invitedAt)}; hasn't signed in yet.` : 'Hasn’t been invited yet.'}
          </div>
          <div className="row wrap">
            {emailEnabled && deliverable(emp.email) && !self && (
              <button className="btn sm" disabled={busy} onClick={() => run(() => sendSignInLink(emp.id), (r) => `${emp.lastLoginAt ? 'Reset' : 'Invite'} link sent to ${r.to}`)}>
                <Icon name="send" />{emp.lastLoginAt ? 'Email a password reset link' : emp.invitedAt ? 'Resend invite link' : 'Send invite link'}
              </button>
            )}
            {!self && <button className="btn sm" disabled={busy} onClick={() => run(() => call('employees.resetPassword', { userId: emp.id }), 'Temporary password set').then((r) => r && setTemp(r.tempPassword))}>
              <Icon name="edit" />Set a temporary password</button>}
          </div>
          {!deliverable(emp.email) && !self && <div className="help">Add an email above (and save) to send them a link instead of a password.</div>}
          {temp && <div className="alert warn"><Icon name="alert" size={16} /><div>Temporary password: <code style={{ fontSize: 15 }}>{temp}</code>. Share it privately; it won't be shown again. Their other sessions were signed out.</div></div>}
        </div>
      )}
    </Modal>
  );
}

function JobDialog({ job, onClose }) {
  const { call, settings, jobCodes } = useApp();
  const [f, setF] = useState({ defaultRole: 'employee', ...job });
  const [run, busy] = useAction();
  const [into, setInto] = useState('');
  const [sure, setSure] = useState(false);
  const target = jobCodes.find((j) => j.id === into);
  const merge = async () => {
    if (!sure) return setSure(true);
    const r = await run(() => call('jobCodes.merge', { fromId: job.id, intoId: into }),
      (res) => `Merged ${job.name} into ${target?.name}: ${res.shifts} shifts, ${res.people} people${res.events ? `, ${res.events} events` : ''}`);
    if (r) onClose();
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => { const r = await run(() => call('jobCodes.save', f), 'Job code saved'); if (r) onClose(); };
  const archive = async () => { const r = await run(() => call('jobCodes.delete', { id: job.id }), 'Job code removed'); if (r) onClose(); };
  return (
    <Modal title={job.id ? `Edit ${job.name}` : 'New job code'} onClose={onClose}
      footer={<>{job.id && <button className="btn danger" onClick={archive} disabled={busy}>{job.archived ? 'Delete' : 'Archive'}</button>}<span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name} onClick={save}>Save</button></>}>
      <div className="grid2">
        <Field label="Name"><input className="input" value={f.name || ''} onChange={set('name')} placeholder="Server" autoFocus /></Field>
        <Field label="Short code"><input className="input" value={f.short || ''} onChange={set('short')} placeholder="SRV" maxLength={6} /></Field>
        <Field label="Department / area">
          <input className="input" list="depts" value={f.department || ''} onChange={set('department')} />
          <datalist id="depts">{settings.departments.map((d) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label="Default rate ($/hr)"><input className="input" type="number" step="0.25" value={f.defaultRate ?? ''} onChange={set('defaultRate')} /></Field>
        <Field label="Default role" help="The role people in this job get when they're added from an imported schedule.">
          <select className="input" value={f.defaultRole || 'employee'} onChange={set('defaultRole')}>{JOB_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select>
        </Field>
        <Field label="Sort order"><input className="input" type="number" value={f.order ?? 0} onChange={set('order')} /></Field>
      </div>
      <Field label="Color">
        <div className="row wrap" style={{ gap: 5 }}>{COLORS.map((c) => <button key={c} type="button" onClick={() => setF({ ...f, color: c })} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: f.color === c ? '3px solid var(--text)' : '0', cursor: 'pointer' }} aria-label={c} />)}</div>
      </Field>
      <label className="check"><input type="checkbox" checked={!!f.eventRole} onChange={set('eventRole')} />Used for events (suggested when building BEO staffing)</label>
      {job.archived && <label className="check"><input type="checkbox" checked={!f.archived} onChange={(e) => setF({ ...f, archived: !e.target.checked })} />Restore (un-archive)</label>}
      {job.id && (
        <Field label="Merge into another job code" help={`Moves ${job.name}'s shifts, people (their pay rates and areas are kept), BEO staffing and labor rules to the job code you pick, then deletes ${job.name}. Use it for duplicates, e.g. "Moon Rabbit Bartender" into "Bartender" now that the area is kept on each shift.`}>
          <div className="row wrap">
            <select className="input" style={{ maxWidth: 240 }} value={into} onChange={(e) => { setInto(e.target.value); setSure(false); }}>
              <option value="">Choose a job code…</option>
              {jobCodes.filter((j) => j.id !== job.id && !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            <button type="button" className={`btn ${sure ? 'danger solid' : ''}`} disabled={!into || busy} onClick={merge}><Icon name="copy" />{sure ? `Tap again: merge into ${target?.name}` : 'Merge'}</button>
          </div>
        </Field>
      )}
    </Modal>
  );
}
