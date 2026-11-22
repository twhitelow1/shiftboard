import React, { useEffect, useState } from 'react';
import { useApp, Modal, Icon, Avatar, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';

/**
 * Who's listed in one schedule section (e.g. Servers under RESTAURANT): add someone, take someone off
 * (moving their shifts there to another section if they have any), and set the order of names.
 * A person shows in a section when their position lists that area, or when they have a shift there.
 */
export default function SectionPeople({ section, ws, sections = [], onClose }) {
  const t = useT();
  const { call, employees, refresh } = useApp();
  const [order, setOrder] = useState(() => section.rows.map((r) => r.user));
  const [removing, setRemoving] = useState(null); // the person being taken off
  const [adding, setAdding] = useState('');
  const [changed, setChanged] = useState(false);
  const [run, busy] = useAction();
  const where = section.banner || section.area;
  const title = `${section.label}${where ? ` · ${where}` : ''}`;
  const base = { jobCodeId: section.job.id, area: section.area || '' };
  const shiftsThisWeek = (id) => section.rows.find((r) => r.user.id === id)?.shifts.length || 0;

  const done = () => { if (changed) refresh(); onClose(changed); };
  const saveOrder = async (next) => {
    setOrder(next);
    const r = await run(() => call('roster.order', { ...base, userIds: next.map((u) => u.id) }));
    if (r) setChanged(true);
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    saveOrder(next);
  };
  const add = async () => {
    const u = employees.find((e) => e.id === adding);
    if (!u) return;
    const r = await run(() => call('roster.add', { ...base, userId: u.id }), t('sectionPeople.added', { name: u.name }));
    if (!r) return;
    const next = [...order, u];
    setOrder(next); setAdding(''); setChanged(true);
    call('roster.order', { ...base, userIds: next.map((x) => x.id) }).catch(() => {});
  };

  const listed = new Set(order.map((u) => u.id));
  const candidates = (employees || []).filter((e) => e.active !== false && e.onSchedule !== false && !listed.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (removing) {
    return (
      <RemovePerson person={removing} section={section} title={title} ws={ws} sections={sections}
        onBack={(didRemove) => {
          if (didRemove) { setOrder(order.filter((u) => u.id !== removing.id)); setChanged(true); }
          setRemoving(null);
        }} />
    );
  }

  return (
    <Modal title={title} sub={t('sectionPeople.sub')} onClose={done}
      footer={<><span className="spacer" /><button className="btn primary" onClick={done}>{t('common.done')}</button></>}>
      <div className="list card">
        {!order.length && <div className="empty small">{t('sectionPeople.empty')}</div>}
        {order.map((u, i) => (
          <div key={u.id} className="list-item sp-row">
            <Avatar user={u} size="sm" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{u.name}</b>
              {shiftsThisWeek(u.id) > 0 && <div className="tiny muted">{t('sectionPeople.shiftsThisWeek', { count: shiftsThisWeek(u.id) })}</div>}
            </div>
            <button className="btn ghost icon sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={t('sectionPeople.moveUp')}><Icon name="up" /></button>
            <button className="btn ghost icon sm" disabled={busy || i === order.length - 1} onClick={() => move(i, 1)} aria-label={t('sectionPeople.moveDown')}><Icon name="down" /></button>
            <button className="btn sm" disabled={busy} onClick={() => setRemoving(u)}>{t('common.remove')}</button>
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="input" style={{ flex: '1 1 180px' }} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label={t('sectionPeople.addSomeone')}>
          <option value="">{t('sectionPeople.addSomeone')}</option>
          {candidates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button className="btn" disabled={!adding || busy} onClick={add}><Icon name="plus" />{t('sectionPeople.add')}</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('sectionPeople.how')}</p>
    </Modal>
  );
}

function RemovePerson({ person, section, title, ws, sections, onBack }) {
  const t = useT();
  const { call } = useApp();
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState('move');
  const [target, setTarget] = useState('');
  const [run, busy] = useAction();
  const base = { userId: person.id, jobCodeId: section.job.id, area: section.area || '', from: ws };

  useEffect(() => {
    call('roster.get', base).then((r) => {
      setInfo(r);
      if (r.targets[0]) setTarget(`${r.targets[0].jobCodeId}|${r.targets[0].area}`);
      if (!r.shifts) setMode('keep');
    }).catch(() => setInfo({ error: true }));
  }, []);

  // Where the shifts can go: their own other positions first, then any section on the schedule.
  const options = [];
  const seen = new Set();
  for (const x of info?.targets || []) { const k = `${x.jobCodeId}|${x.area}`; if (!seen.has(k)) { seen.add(k); options.push({ k, label: x.label, mine: true }); } }
  for (const s of sections) {
    const k = `${s.job.id}|${s.area || ''}`;
    if (seen.has(k) || (s.job.id === section.job.id && (s.area || '') === (section.area || ''))) continue;
    seen.add(k); options.push({ k, label: `${s.label}${s.banner ? ` · ${s.banner}` : ''}` });
  }

  const remove = async () => {
    const [jobCodeId, area = ''] = target.split('|');
    const r = await run(() => call('roster.remove', { ...base, shifts: info?.shifts && mode === 'move' ? 'move' : 'keep', moveTo: { jobCodeId, area } }),
      t('sectionPeople.removed', { name: person.name }));
    if (r) onBack(true);
  };

  return (
    <Modal title={t('sectionPeople.removeTitle', { name: person.name })} sub={title} onClose={() => onBack(false)}
      footer={<><button className="btn" onClick={() => onBack(false)}>{t('common.cancel')}</button><span className="spacer" />
        <button className="btn danger" disabled={busy || !info || info.error || (info.shifts > 0 && mode === 'move' && !target)} onClick={remove}>{t('common.remove')}</button></>}>
      {!info && <div className="empty small">{t('common.loading')}</div>}
      {info?.error && <div className="alert bad">{t('sectionPeople.loadFailed')}</div>}
      {info && !info.error && (
        <>
          <p style={{ margin: 0 }}>
            {info.removesJob ? t('sectionPeople.losesPosition', { name: person.name, position: section.label })
              : info.keepsAreas.length ? t('sectionPeople.keepsAreas', { position: section.label, areas: info.keepsAreas.join(', ') })
                : t('sectionPeople.onlyShifts', { name: person.name })}
          </p>
          {info.shifts > 0 && (
            <div className="col" style={{ gap: 8 }}>
              <b>{t('sectionPeople.shiftsHere', { count: info.shifts })}</b>
              <label className="check"><input type="radio" checked={mode === 'move'} onChange={() => setMode('move')} />{t('sectionPeople.moveThem')}</label>
              {mode === 'move' && (
                <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('sectionPeople.moveThem')}>
                  {!options.length && <option value="">—</option>}
                  {options.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
                </select>
              )}
              <label className="check"><input type="radio" checked={mode === 'keep'} onChange={() => setMode('keep')} />{t('sectionPeople.keepThem')}</label>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Arrange one banner (an area such as RESTAURANT): the order of its sections, the position each
 * section is (turning a "Staff" section into Bartenders, or a new position), and its name on the sheet.
 */
export function ArrangeArea({ banner, sections, onClose }) {
  const t = useT();
  const { call, jobCodes, refresh } = useApp();
  const [changing, setChanging] = useState(null); // section key whose position is being changed
  const [changed, setChanged] = useState(false);
  const [run, busy] = useAction();
  const done = () => onClose(changed);
  const ids = sections.map((s) => s.job.id);

  const move = async (i, d) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    const r = await run(() => call('roster.arrange', { banner, jobCodeIds: next }));
    if (r) { setChanged(true); refresh(); }
  };

  return (
    <Modal title={t('arrange.title', { banner })} sub={t('arrange.sub')} onClose={done}
      footer={<><span className="spacer" /><button className="btn primary" onClick={done}>{t('common.done')}</button></>}>
      <div className="list card">
        {!sections.length && <div className="empty small">{t('arrange.empty')}</div>}
        {sections.map((sec, i) => (
          <div key={sec.key} className="col" style={{ gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{sec.sheetLabel || sec.label}</b>
                <div className="tiny muted">{t('arrange.positionPeople', { position: sec.job.name, count: sec.rows.length })}</div>
              </div>
              <button className="btn ghost icon sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={t('sectionPeople.moveUp')}><Icon name="up" /></button>
              <button className="btn ghost icon sm" disabled={busy || i === sections.length - 1} onClick={() => move(i, 1)} aria-label={t('sectionPeople.moveDown')}><Icon name="down" /></button>
              <button className="btn sm" disabled={busy} onClick={() => setChanging(changing === sec.key ? null : sec.key)}>{t('arrange.change')}</button>
            </div>
            {changing === sec.key && (
              <ChangeSection sec={sec} jobCodes={jobCodes} busy={busy} run={run} call={call}
                onDone={() => { setChanging(null); setChanged(true); refresh(); }} />
            )}
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('arrange.how')}</p>
    </Modal>
  );
}

function ChangeSection({ sec, jobCodes, busy, run, call, onDone }) {
  const t = useT();
  const NEW = '__new__';
  const [to, setTo] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState(sec.sheetLabel || '');
  const options = (jobCodes || []).filter((j) => !j.archived && j.id !== sec.job.id);
  const saveLabel = async () => {
    if ((label || '') === (sec.sheetLabel || '')) return;
    const r = await run(() => call('roster.label', { jobCodeId: sec.job.id, area: sec.area || '', label }), t('arrange.labelSaved'));
    if (r) onDone();
  };
  const change = async () => {
    const args = { area: sec.area || '', fromJobCodeId: sec.job.id, ...(to === NEW ? { newPosition: { name } } : { toJobCodeId: to }) };
    const r = await run(() => call('roster.changePosition', args),
      (res) => t('arrange.changed', { people: res.people, shifts: res.shifts }));
    if (r) onDone();
  };
  return (
    <div className="col" style={{ gap: 8, background: 'var(--surface-2)', borderRadius: 10, padding: 10 }}>
      <label className="field"><span>{t('arrange.positionFor', { section: sec.sheetLabel || sec.label })}</span>
        <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('arrange.pickPosition')}</option>
          {options.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          <option value={NEW}>{t('arrange.newPosition')}</option>
        </select>
      </label>
      {to === NEW && (
        <label className="field"><span>{t('arrange.newPositionName')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('arrange.newPositionPlaceholder')} />
        </label>
      )}
      {to && <p className="small muted" style={{ margin: 0 }}>{t('arrange.changeWhat', { from: sec.job.name, count: sec.rows.length })}</p>}
      <div className="row" style={{ gap: 8 }}>
        <span className="spacer" />
        <button className="btn primary sm" disabled={busy || !to || (to === NEW && !name.trim())} onClick={change}>{t('arrange.changePosition')}</button>
      </div>
      <label className="field"><span>{t('arrange.nameOnSheet')}</span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={saveLabel} placeholder={sec.job.name} />
      </label>
    </div>
  );
}
