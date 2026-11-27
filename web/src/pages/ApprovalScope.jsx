// "Approves for" on the web (core/approval-scope.js): which trades, giveaways, pickups and time off an approver decides.
//   ScopeEditor          all · only these · all except · none, with positions and rooms from Rooms & positions, and the
//                        "Positions in room: Bar" quick picks (two taps for the bar manager)
//   ApprovesFor          Team → a person (managers and supervisors): theirs or their role's default
//   MyApprovalScope      "You approve: Bar positions" on Trades → Needs approval and Time off → To approve
//   RoleApprovalScopes   Settings → Roles & features: what managers and supervisors approve by default
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { roleLabelPlural } from '../../../core/roles.js';
import '../availability.css';

const ALL = { mode: 'all', positions: [], rooms: [], timeOff: true };
const MODES = ['all', 'include', 'exclude', 'none'];
const sameRoom = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** The positions and rooms to pick from: the layout's rooms (Settings → Rooms & positions) and the active positions. */
function useChoices() {
  const { layout, jobCodes } = useApp();
  const rooms = (layout?.rooms || []).map((r) => ({ room: r.room, positions: r.positions.map((p) => p.jobCodeId) }));
  const jobs = jobCodes.filter((j) => !j.archived);
  return { rooms, jobs };
}

/** "Bar positions" / "Only: Bartender, Barback" in the reader's language, from what the server sent. */
export const scopeLabel = (t, s) => (s?.label ? s.label[t.lang] || s.label.en : '');

export function ScopeEditor({ value, onChange, disabled }) {
  const t = useT();
  const { rooms, jobs } = useChoices();
  const v = { ...ALL, ...(value || {}) };
  const listed = v.mode === 'include' || v.mode === 'exclude';
  const set = (patch) => onChange({ ...v, ...patch });
  const toggle = (k, id) => set({ [k]: v[k].includes(id) ? v[k].filter((x) => x !== id) : [...v[k], id] });
  const roomOn = (room) => v.rooms.some((r) => sameRoom(r, room));
  const roomJobs = (r) => r.positions.filter((id) => jobs.some((j) => j.id === id));
  const allIn = (r) => roomJobs(r).length > 0 && roomJobs(r).every((id) => v.positions.includes(id));
  const pickRoomPositions = (r) => set({ positions: allIn(r) ? v.positions.filter((id) => !roomJobs(r).includes(id)) : [...new Set([...v.positions, ...roomJobs(r)])] });
  return (
    <fieldset className="col scope-editor" disabled={disabled} style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
      <div className="seg scope-modes" role="radiogroup" aria-label={t('approvals.approvesFor')}>
        {MODES.map((m) => <button key={m} type="button" role="radio" aria-checked={v.mode === m} className={v.mode === m ? 'on' : ''}
          onClick={() => set({ mode: m, ...(m === 'all' || m === 'none' ? { positions: [], rooms: [] } : {}) })}>{t(`approvals.mode_${m}`)}</button>)}
      </div>
      <div className="tiny faint">{t(`approvals.modeHelp_${v.mode}`)}</div>
      {listed && (
        <>
          <div className="small"><b>{t('approvals.quickPick')}</b> <span className="muted">{t('approvals.quickPickHelp')}</span></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {rooms.filter((r) => roomJobs(r).length).map((r) => (
              <button key={r.room} type="button" className={`chip ${allIn(r) ? 'on' : ''}`} aria-pressed={allIn(r)} onClick={() => pickRoomPositions(r)}>
                {t('approvals.positionsInRoom', { room: r.room })}</button>
            ))}
          </div>
          <div className="small"><b>{t('approvals.positions')}</b></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {jobs.map((j) => <button key={j.id} type="button" className={`chip ${v.positions.includes(j.id) ? 'on' : ''}`} aria-pressed={v.positions.includes(j.id)} onClick={() => toggle('positions', j.id)}>{j.name}</button>)}
          </div>
          <div className="small"><b>{t('approvals.wholeRooms')}</b> <span className="muted">{t('approvals.wholeRoomsHelp')}</span></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {rooms.map((r) => <button key={r.room} type="button" className={`chip ${roomOn(r.room) ? 'on' : ''}`} aria-pressed={roomOn(r.room)}
              onClick={() => set({ rooms: roomOn(r.room) ? v.rooms.filter((x) => !sameRoom(x, r.room)) : [...v.rooms, r.room] })}>{r.room}</button>)}
          </div>
        </>
      )}
      {v.mode !== 'all' && (
        <label className="check small"><input type="checkbox" checked={v.timeOff !== false} onChange={(e) => set({ timeOff: e.target.checked })} />{t('approvals.sameForTimeOff')}</label>
      )}
    </fieldset>
  );
}
const ready = (s) => !(s.mode === 'include' || s.mode === 'exclude') || s.positions.length > 0 || s.rooms.length > 0;

/** Team → a person: what they approve (theirs, or their role's), and the editor when you may set it. */
export function ApprovesFor({ person }) {
  const t = useT();
  const { call } = useApp();
  const [data, setData] = useState(null);
  const [own, setOwn] = useState(null); // null: the role's default
  const [editing, setEditing] = useState(false);
  const [run, busy] = useAction();
  const load = () => call('approvalScope.get', { userId: person.id }).then((d) => { setData(d); setOwn(d.own); }, () => setData(false));
  useEffect(() => { load(); }, [person.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !data.canApprove) return null;
  const save = async () => {
    const r = await run(() => call('approvalScope.set', { userId: person.id, scope: own }), t('approvals.saved'));
    if (r) { setData(r); setOwn(r.own); setEditing(false); }
  };
  return (
    <div className="card card-pad col approves-for" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <b style={{ flex: 1 }}>{t('approvals.approvesFor')}</b>
        <span className="badge brand">{scopeLabel(t, data)}</span>
        {data.canSet && !editing && <button type="button" className="btn sm" onClick={() => setEditing(true)}><Icon name="edit" />{t('common.edit')}</button>}
      </div>
      <div className="tiny faint">{data.source === 'admin' ? t('approvals.adminAlways') : data.source === 'person' ? t('approvals.ownSetting') : t('approvals.roleDefault')}</div>
      {editing && (
        <>
          <label className="check small"><input type="checkbox" checked={own === null} onChange={(e) => setOwn(e.target.checked ? null : { ...data.roleDefault })} />{t('approvals.useRoleDefault')}</label>
          {own !== null && <ScopeEditor value={own} onChange={setOwn} disabled={busy} />}
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="spacer" />
            <button type="button" className="btn sm" onClick={() => { setOwn(data.own); setEditing(false); }}>{t('common.cancel')}</button>
            <button type="button" className="btn sm primary" disabled={busy || (own && !ready(own))} onClick={save}><Icon name="check" />{t('approvals.save')}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** "You approve: Bar positions" for approvers whose scope isn't everything (and a note that admins see all). */
export function MyApprovalScope({ kind = 'trades' }) {
  const t = useT();
  const { call, canApprove, version } = useApp();
  const [data, setData] = useState(null);
  useEffect(() => { if (canApprove) call('approvalScope.get', {}).then(setData, () => setData(null)); }, [canApprove, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const all = data.scope.mode === 'all';
  const timeOffAll = kind === 'timeOff' && data.scope.timeOff === false;
  return (
    <div className={`approval-scope-note small ${all || timeOffAll ? 'muted' : ''}`} role="note">
      <Icon name="shield" size={14} />
      <span>{t('approvals.youApprove', { scope: timeOffAll ? t('approvals.mode_all') : scopeLabel(t, data) })}</span>
      {!all && !timeOffAll && <span className="faint">{t('approvals.othersGoElsewhere')}</span>}
    </div>
  );
}

/** Settings → Roles & features: what managers and supervisors approve by default (a person's own setting wins). */
export function RoleApprovalScopes() {
  const t = useT();
  const { call, lang, toast } = useApp();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('approvalScope.roles').then((d) => { setData(d); setDraft(d); }, (e) => toast(e.message, 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);
  const save = async () => {
    const r = await run(() => call('approvalScope.saveRoles', draft), t('approvals.saved'));
    if (r) { setData(r); setDraft(r); }
  };
  return (
    <div className="card card-pad col" style={{ gap: 12 }} id="approval-scopes">
      <h2>{t('approvals.rolesTitle')}</h2>
      <div className="help">{t('approvals.rolesHelp')}</div>
      {Object.keys(draft).map((role) => (
        <div key={role} className="col" style={{ gap: 6 }}>
          <b>{t('approvals.roleApproves', { role: roleLabelPlural(role, lang) })}</b>
          <ScopeEditor value={draft[role]} onChange={(v) => setDraft({ ...draft, [role]: v })} disabled={busy} />
        </div>
      ))}
      <div className="row wrap" style={{ gap: 8 }}>
        {dirty && <span className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('roles.unsaved')}</span>}
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !dirty || !ready(draft.manager) || !ready(draft.supervisor)} onClick={save}><Icon name="check" />{t('approvals.save')}</button>
      </div>
    </div>
  );
}
