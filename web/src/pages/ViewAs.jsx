// View as (Super Admins): the header button, the picker (a person, or a role with positions and rooms, or a typical
// person in a role), and the banner shown the whole time. The server computes everything as the viewed person and
// refuses every change (server/view-as.js); this only starts, shows and ends the view.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal } from '../ui.jsx';
import { roleLabel } from '../../../core/roles.js';
import { useT, fmtTime } from '../i18n/index.js';
import { IS_DEMO } from '../api.js';
import { viewAsOptions, startViewAs, stopViewAs, rememberReturn, takeReturn, keepDraft } from '../view-as-api.js';
import '../view-as.css';

// Hosted: load the app again from scratch as the other person, so nothing from before carries over (pages, caches,
// requests in flight). The demo keeps its data in memory, so it reloads its state instead.
function reopen(hash, refresh) {
  location.hash = hash;
  if (IS_DEMO) refresh(); else location.reload();
}

const clock = (iso) => { const d = new Date(iso); return fmtTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`); };

/** Start a view and reload the app as that person. draft: Roles & features changes to preview (kept for the editor). */
export async function beginView(ask, { refresh, toast, returnTo = location.hash, draft = null }) {
  try {
    await startViewAs(draft ? { ...ask, draft } : ask);
    rememberReturn(returnTo || '#/', draft);
    if (draft) keepDraft(draft);
    reopen('#/', refresh);
    return true;
  } catch (e) {
    toast(e.message, 'bad');
    return false;
  }
}

/** Exit view: back to the real person, where they were before. */
export async function endView({ refresh, toast }) {
  try { await stopViewAs(); } catch (e) { toast(e.message, 'bad'); }
  const back = takeReturn();
  reopen(back?.hash || '#/', refresh);
}

/** The header's View as button (Super Admins, when not already viewing). */
export function ViewAsButton({ onOpen }) {
  const t = useT();
  return (
    <button className="btn sm viewas-topbtn" onClick={onOpen} title={t('viewAs.title')}>
      <Icon name="eye" /><span className="desktop-only">{t('main.viewAs')}</span>
    </button>
  );
}

/** The bright banner, all the time while viewing: who, read-only, until when, Switch and Exit. */
export function ViewAsBanner({ onSwitch }) {
  const t = useT();
  const { viewAs, refresh, toast, lang } = useApp();
  // When the view runs out, the next load comes back as the real person; reload right then.
  useEffect(() => {
    if (!viewAs?.until) return undefined;
    const ms = Date.parse(viewAs.until) - Date.now();
    const id = setTimeout(() => { toast(t('viewAs.ended')); refresh(); }, Math.max(1000, ms + 1500));
    return () => clearTimeout(id);
  }, [viewAs?.until]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!viewAs) return null;
  const role = roleLabel(viewAs.role, lang);
  const notes = [
    viewAs.typical && t('viewAs.typicalNote'),
    viewAs.kind === 'role' && [...viewAs.positions, ...viewAs.rooms].join(', '),
    viewAs.draft && t('viewAs.draftNote'),
    viewAs.until && t('viewAs.until', { time: clock(viewAs.until) }),
  ].filter(Boolean);
  return (
    <div className="viewas-banner no-print" role="status" aria-live="polite">
      <Icon name="eye" size={18} />
      <span className="viewas-text">
        {viewAs.kind === 'role' ? t('viewAs.bannerRole', { role }) : t('viewAs.bannerPerson', { name: viewAs.name, role })}
        {notes.length > 0 && <span className="viewas-note">{notes.join(' · ')}</span>}
      </span>
      <span className="viewas-actions">
        <button className="btn sm ghost" onClick={onSwitch}>{t('viewAs.switch')}</button>
        <button className="btn sm" onClick={() => endView({ refresh, toast })}><Icon name="x" />{t('viewAs.exit')}</button>
      </span>
    </div>
  );
}

/** The picker: a person (search the team), or a role with positions and rooms, or a typical person in that role. */
export function ViewAsDialog({ onClose }) {
  const t = useT();
  const { refresh, toast, lang } = useApp();
  const [opts, setOpts] = useState(null);
  const [tab, setTab] = useState('person');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('employee');
  const [typical, setTypical] = useState(false);
  const [positions, setPositions] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { viewAsOptions().then(setOpts, (e) => { toast(e.message, 'bad'); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const people = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (opts?.people || []).filter((p) => words.every((w) => `${p.name} ${roleLabel(p.role, lang)} ${p.positions.join(' ')}`.toLowerCase().includes(w)));
  }, [opts, q, lang]);
  const flip = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const go = async (ask) => {
    setBusy(true);
    if (await beginView(ask, { refresh, toast })) onClose();
    else setBusy(false);
  };

  return (
    <Modal title={t('viewAs.title')} sub={t('viewAs.sub', { minutes: opts?.minutes || 45 })} onClose={onClose}
      footer={tab === 'role' && (
        <button className="btn primary" disabled={busy || !opts} onClick={() => go(typical ? { role, typical: true } : { role, positions, rooms })}>
          <Icon name="eye" />{t('viewAs.start')}
        </button>
      )}>
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === 'person'} className={tab === 'person' ? 'on' : ''} onClick={() => setTab('person')}>{t('viewAs.tabPerson')}</button>
        <button role="tab" aria-selected={tab === 'role'} className={tab === 'role' ? 'on' : ''} onClick={() => setTab('role')}>{t('viewAs.tabRole')}</button>
      </div>
      {!opts && <div className="empty">{t('common.loading')}</div>}
      {opts && tab === 'person' && (
        <>
          <input className="input viewas-search" type="search" placeholder={t('viewAs.search')} aria-label={t('viewAs.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="viewas-people">
            {people.map((p) => (
              <button key={p.id} className="viewas-person" disabled={busy} onClick={() => go({ userId: p.id })}>
                <Avatar user={p} />
                <span className="who">
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="small muted">{[roleLabel(p.role, lang), ...p.positions].join(' · ')}</div>
                </span>
                <Icon name="right" size={16} />
              </button>
            ))}
            {!people.length && <div className="empty small">{t('viewAs.noMatches')}</div>}
          </div>
        </>
      )}
      {opts && tab === 'role' && (
        <>
          <div className="col" style={{ gap: 6 }}>
            <div className="small" style={{ fontWeight: 700 }}>{t('viewAs.role')}</div>
            <div className="viewas-chips">
              {opts.roles.map((r) => <button key={r} className={`viewas-chip ${role === r ? 'on' : ''}`} aria-pressed={role === r} onClick={() => setRole(r)}>{roleLabel(r, lang)}</button>)}
            </div>
          </div>
          <div className="col" style={{ gap: 8 }}>
            <div className="small" style={{ fontWeight: 700 }}>{t('viewAs.who')}</div>
            <label className={`viewas-choice ${!typical ? 'on' : ''}`}>
              <input type="radio" name="viewas-who" checked={!typical} onChange={() => setTypical(false)} />
              <span><b>{t('viewAs.nobody')}</b><div className="small muted">{t('viewAs.nobodyHelp')}</div></span>
            </label>
            <label className={`viewas-choice ${typical ? 'on' : ''}`}>
              <input type="radio" name="viewas-who" checked={typical} onChange={() => setTypical(true)} />
              <span><b>{t('viewAs.typical')}</b><div className="small muted">{t('viewAs.typicalHelp')}</div></span>
            </label>
          </div>
          {!typical && (
            <>
              <div className="col" style={{ gap: 6 }}>
                <div className="small" style={{ fontWeight: 700 }}>{t('viewAs.positions')}</div>
                <div className="viewas-chips">
                  {opts.positions.map((p) => <button key={p.id} className={`viewas-chip ${positions.includes(p.id) ? 'on' : ''}`} aria-pressed={positions.includes(p.id)} onClick={() => flip(positions, setPositions, p.id)}>{p.name}</button>)}
                </div>
              </div>
              {opts.rooms.length > 0 && (
                <div className="col" style={{ gap: 6 }}>
                  <div className="small" style={{ fontWeight: 700 }}>{t('viewAs.rooms')}</div>
                  <div className="viewas-chips">
                    {opts.rooms.map((r) => <button key={r} className={`viewas-chip ${rooms.includes(r) ? 'on' : ''}`} aria-pressed={rooms.includes(r)} onClick={() => flip(rooms, setRooms, r)}>{r}</button>)}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** My settings → Sign-in & security while viewing: a placeholder (their sign-in details stay private). */
export function SecurityHidden() {
  const t = useT();
  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <h2>{t('security.signInSecurity')}</h2>
      <div className="alert warn"><Icon name="lock" size={16} />{t('viewAs.securityHidden')}</div>
    </div>
  );
}
