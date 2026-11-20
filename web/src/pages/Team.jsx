import React, { useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, useAction, JobDot, money, Empty } from '../ui.jsx';
import { sendSignInLink } from '../api.js';

const ROLES = { admin: 'Admin', manager: 'Manager', events: 'Events team', employee: 'Employee' };
const COLORS = ['#2563eb', '#16a34a', '#65a30d', '#0891b2', '#9333ea', '#a855f7', '#dc2626', '#e11d48', '#d97706', '#ca8a04', '#475569', '#0f766e', '#334155', '#7c2d12', '#db2777'];

export default function Team() {
  const { employees, jobCodes, jobs } = useApp();
  const [tab, setTab] = useState('people');
  const [q, setQ] = useState('');
  const [job, setJob] = useState('');
  const [edit, setEdit] = useState(null);
  const [editJob, setEditJob] = useState(null);
  const [showInactive, setShowInactive] = useState(false);

  const list = employees.filter((e) => (showInactive || e.active !== false) && (!q || e.name.toLowerCase().includes(q.toLowerCase())) && (!job || e.jobCodes?.some((j) => j.jobCodeId === job)));
  const depts = [...new Set(jobCodes.map((j) => j.department))];

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="tabs">
        <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>People <span className="badge">{employees.filter((e) => e.active !== false).length}</span></button>
        <button className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>Job codes <span className="badge">{jobCodes.filter((j) => !j.archived).length}</span></button>
      </div>

      {tab === 'people' && <>
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 240 }} placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ maxWidth: 200 }} value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">All job codes</option>
            {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show inactive</label>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setEdit({ jobCodes: [], role: 'employee', active: true })}><Icon name="plus" />Add employee</button>
        </div>
        <div className="card list">
          {!list.length && <Empty icon="users" title="No one matches" />}
          {list.map((e) => (
            <div key={e.id} className="list-item click" onClick={() => setEdit(e)} style={{ opacity: e.active === false ? 0.5 : 1 }}>
              <Avatar user={e} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}><b>{e.name}</b>{e.role !== 'employee' && <span className="badge brand">{ROLES[e.role]}</span>}{e.active === false && <span className="badge">Inactive</span>}</div>
                <div className="small muted">{e.email || 'No email'}{e.phone ? ` · ${e.phone}` : ''}</div>
              </div>
              <div className="row wrap desktop-only" style={{ gap: 4, justifyContent: 'flex-end', maxWidth: 380 }}>
                {e.jobCodes?.map((j) => <span key={j.jobCodeId} className="badge"><JobDot job={jobs[j.jobCodeId]} />{jobs[j.jobCodeId]?.name}</span>)}
              </div>
              <span className="badge mobile-only">{e.jobCodes?.length || 0} jobs</span>
            </div>
          ))}
        </div>
      </>}

      {tab === 'jobs' && <>
        <div className="toolbar">
          <span className="muted small">Employees can hold any number of job codes, each with its own pay rate.</span>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setEditJob({ color: COLORS[jobCodes.length % COLORS.length], department: depts[0] || 'Restaurant', order: jobCodes.length })}><Icon name="plus" />Add job code</button>
        </div>
        {depts.map((d) => (
          <div key={d} className="section">
            <div className="section-title"><h3>{d}</h3></div>
            <div className="card list">
              {jobCodes.filter((j) => j.department === d).map((j) => (
                <div key={j.id} className="list-item click" onClick={() => setEditJob(j)} style={{ opacity: j.archived ? 0.5 : 1 }}>
                  <span className="swatch" style={{ background: j.color, width: 14, height: 14 }} />
                  <div style={{ flex: 1 }}><b>{j.name}</b> <span className="faint small">{j.short}</span>{j.eventRole && <span className="badge" style={{ marginLeft: 6 }}>Events</span>}{j.archived && <span className="badge" style={{ marginLeft: 6 }}>Archived</span>}</div>
                  <span className="small muted">{employees.filter((e) => e.active !== false && e.jobCodes?.some((x) => x.jobCodeId === j.id)).length} people</span>
                  <span className="small num" style={{ width: 70, textAlign: 'right' }}>{j.defaultRate ? `$${j.defaultRate}/hr` : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </>}

      {edit && <EmployeeDialog emp={edit} onClose={() => setEdit(null)} />}
      {editJob && <JobDialog job={editJob} onClose={() => setEditJob(null)} />}
    </div>
  );
}

function EmployeeDialog({ emp, onClose }) {
  const { call, jobCodes, isAdmin, toast, emailEnabled } = useApp();
  const [f, setF] = useState({ ...emp, jobCodes: emp.jobCodes || [] });
  const [pw, setPw] = useState('');
  const [created, setCreated] = useState(null);
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const has = (id) => f.jobCodes.find((j) => j.jobCodeId === id);
  const toggle = (id) => setF({ ...f, jobCodes: has(id) ? f.jobCodes.filter((j) => j.jobCodeId !== id) : [...f.jobCodes, { jobCodeId: id, rate: null }] });
  const setRate = (id, rate) => setF({ ...f, jobCodes: f.jobCodes.map((j) => (j.jobCodeId === id ? { ...j, rate } : j)) });

  const save = async () => {
    const r = await run(() => call('employees.save', { ...f, password: pw || undefined }), emp.id ? 'Saved' : null);
    if (!r) return;
    if (!emp.id && r.tempPassword) setCreated(r);
    else onClose();
  };

  if (created) return (
    <Modal title="Employee added" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      {created.invited
        ? <div className="alert ok"><Icon name="send" size={16} />We emailed {created.email} a link to set their password.</div>
        : <div className="alert ok"><Icon name="check" size={16} />{created.name} can now sign in.</div>}
      {created.inviteError && <div className="alert warn"><Icon name="alert" size={16} />{created.inviteError}</div>}
      <div className="kv"><dt>Email</dt><dd>{created.email || '(add an email so they can sign in)'}</dd><dt>{created.invited ? 'Backup password' : 'Temp password'}</dt><dd><code style={{ fontSize: 15 }}>{created.tempPassword}</code></dd></div>
      <div className="help">{created.invited ? 'Only needed if the email doesn’t arrive. Share it privately.' : 'Share this privately. They can change it after signing in.'}</div>
    </Modal>
  );

  return (
    <Modal wide title={emp.id ? emp.name : 'Add employee'} onClose={onClose}
      footer={<>
        {emp.id && emailEnabled && emp.email && <button className="btn" disabled={busy} title="Email them a link to set a new password"
          onClick={() => run(() => sendSignInLink(emp.id), (r) => `Sign-in link sent to ${r.to}`)}><Icon name="send" />Email sign-in link</button>}
        <span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name} onClick={save}>{emp.id ? 'Save' : 'Add employee'}</button></>}>
      <div className="grid2">
        <Field label="Name"><input className="input" value={f.name || ''} onChange={set('name')} autoFocus /></Field>
        <Field label="Role">
          <select className="input" value={f.role} onChange={set('role')}>
            {Object.entries(ROLES).filter(([k]) => k !== 'admin' || isAdmin).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Email (sign-in)"><input className="input" type="email" value={f.email || ''} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" type="tel" value={f.phone || ''} onChange={set('phone')} /></Field>
      </div>
      <Field label="Job codes & pay rates" help="Pick every position this person can work. Leave rate blank to use the job's default.">
        <div className="col" style={{ gap: 4, maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 6 }}>
          {jobCodes.filter((j) => !j.archived).map((j) => {
            const h = has(j.id);
            return (
              <div key={j.id} className="row" style={{ padding: '4px 6px', borderRadius: 8, background: h ? 'var(--brand-soft)' : undefined }}>
                <label className="check" style={{ flex: 1 }}><input type="checkbox" checked={!!h} onChange={() => toggle(j.id)} /><JobDot job={j} />{j.name} <span className="faint small">{j.department}</span></label>
                {h && <input className="input sm" type="number" step="0.25" style={{ width: 100 }} placeholder={j.defaultRate ? `$${j.defaultRate}` : '$/hr'} value={h.rate ?? ''} onChange={(e) => setRate(j.id, e.target.value)} />}
              </div>
            );
          })}
        </div>
      </Field>
      <div className="grid2">
        <Field label={emp.id ? 'Reset password' : 'Password (optional)'} help={emp.id ? 'Leave blank to keep current' : 'Leave blank to generate a temporary one'}>
          <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Status"><label className="check" style={{ height: 38 }}><input type="checkbox" checked={f.active !== false} onChange={set('active')} />Active (can be scheduled)</label></Field>
      </div>
    </Modal>
  );
}

function JobDialog({ job, onClose }) {
  const { call, settings } = useApp();
  const [f, setF] = useState({ ...job });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => { const r = await run(() => call('jobCodes.save', f), 'Job code saved'); if (r) onClose(); };
  const archive = async () => { const r = await run(() => call('jobCodes.delete', { id: job.id }), 'Job code removed'); if (r) onClose(); };
  return (
    <Modal title={job.id ? `Edit ${job.name}` : 'New job code'} onClose={onClose}
      footer={<>{job.id && <button className="btn danger" onClick={archive} disabled={busy}>{job.archived ? 'Delete' : 'Archive'}</button>}<span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name} onClick={save}>Save</button></>}>
      <div className="grid2">
        <Field label="Name"><input className="input" value={f.name || ''} onChange={set('name')} placeholder="Server" autoFocus /></Field>
        <Field label="Short code"><input className="input" value={f.short || ''} onChange={set('short')} placeholder="SRV" maxLength={6} /></Field>
        <Field label="Department">
          <input className="input" list="depts" value={f.department || ''} onChange={set('department')} />
          <datalist id="depts">{settings.departments.map((d) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label="Default rate ($/hr)"><input className="input" type="number" step="0.25" value={f.defaultRate ?? ''} onChange={set('defaultRate')} /></Field>
        <Field label="Sort order"><input className="input" type="number" value={f.order ?? 0} onChange={set('order')} /></Field>
        <Field label="Color">
          <div className="row wrap" style={{ gap: 5 }}>{COLORS.map((c) => <button key={c} type="button" onClick={() => setF({ ...f, color: c })} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: f.color === c ? '3px solid var(--text)' : '0', cursor: 'pointer' }} aria-label={c} />)}</div>
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={!!f.eventRole} onChange={set('eventRole')} />Used for events (suggested when building BEO staffing)</label>
      {job.archived && <label className="check"><input type="checkbox" checked={!f.archived} onChange={(e) => setF({ ...f, archived: !e.target.checked })} />Restore (un-archive)</label>}
    </Modal>
  );
}
