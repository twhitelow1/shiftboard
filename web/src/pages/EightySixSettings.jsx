// Settings → 86 List (admins): the lists staff report on. Rename them, add one per bar area, choose who reports and
// who sees each one, what it suggests from the Training menu, notifications, and the nightly reset.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { Chips } from './TrainingShared.jsx';
import { listName } from './EightySix.jsx';
import { useT } from '../i18n/index.js';

const KINDS = [['bar', 'eightySix.kindBar'], ['kitchen', 'eightySix.kindKitchen'], ['other', 'eightySix.kindOther']];
const MENUS = [['drinks', 'eightySix.menuDrinks'], ['food', 'eightySix.menuFood'], ['all', 'eightySix.menuAll'], ['none', 'eightySix.menuNone']];

export default function EightySixSettings() {
  const t = useT();
  const { call } = useApp();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // a list's id, or 'new'
  const load = () => call('eightySix.settings.get').then(setData).catch(() => {});
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const jobName = Object.fromEntries(data.options.jobCodes.map((j) => [j.id, j.name]));
  const who = (l) => [...(l.reporters.departments || []), ...(l.reporters.jobCodeIds || []).map((id) => jobName[id]).filter(Boolean)].join(', ') || '—';
  const done = () => { setOpen(null); load(); };
  const blank = { name: '', nameEs: '', kind: 'bar', area: '', menu: 'drinks', sections: [], reporters: { departments: [], jobCodeIds: [] }, viewers: { all: true }, notify: true, notifyLow: false, resetAt: '' };
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('main.eightySix')}</h2>
      <div className="help">{t('eightySix.settingsHelp')}</div>
      <div className="list e86-set-lists">
        {data.lists.map((l) => (open === l.id
          ? <ListEditor key={l.id} list={l} options={data.options} canDelete={data.lists.length > 1} onDone={done} onCancel={() => setOpen(null)} />
          : (
            <div key={l.id} className="list-item click" onClick={() => setOpen(l.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(l.id); }}>
              <span className={`e86-ico ${l.kind}`}><Icon name={l.kind === 'bar' ? 'glass' : 'ban'} size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}><b>{listName(l, t.lang)}</b>{l.area && <span className="badge">{l.area}</span>}</div>
                <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{t('eightySix.whoReports')}: {who(l)}</div>
                {l.itemCount > 0 && <div className="tiny faint">{t('eightySix.itemsNow', { count: l.itemCount })}</div>}
              </div>
              <Icon name="edit" size={16} />
            </div>
          )))}
        {open === 'new' && <ListEditor list={{ ...blank, name: t('eightySix.newList') }} options={data.options} onDone={done} onCancel={() => setOpen(null)} />}
      </div>
      {open !== 'new' && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen('new')}><Icon name="plus" />{t('eightySix.addList')}</button>}
    </div>
  );
}

function ListEditor({ list, options, canDelete, onDone, onCancel }) {
  const t = useT();
  const { call } = useApp();
  const [run, busy] = useAction();
  const [f, setF] = useState(() => ({ ...list, reporters: { departments: [], jobCodeIds: [], ...list.reporters }, viewers: list.viewers || { all: true } }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = () => run(() => call('eightySix.saveList', {
    id: f.id, name: f.name, nameEs: f.nameEs, kind: f.kind, area: f.area, menu: f.menu, sections: f.sections,
    reporters: f.reporters, viewers: f.viewers, notify: f.notify, notifyLow: f.notifyLow, resetAt: f.resetAt,
  }), t('eightySix.listSaved')).then((r) => { if (r) onDone(); });
  const remove = () => {
    if (window.confirm(t('eightySix.deleteConfirm', { name: f.name }))) run(() => call('eightySix.deleteList', { id: f.id }), t('eightySix.listDeleted')).then((r) => { if (r) onDone(); });
  };
  return (
    <div className="e86-edit col">
      <div className="grid2">
        <Field label={t('common.name')}><input className="input" value={f.name} maxLength={40} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label={t('eightySix.nameEs')}><input className="input" value={f.nameEs} maxLength={40} onChange={(e) => set('nameEs', e.target.value)} /></Field>
        <Field label={t('eightySix.kind')} help={t('eightySix.kindHelp')}>
          <div className="seg">{KINDS.map(([k, label]) => <button key={k} type="button" className={f.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>{t(label)}</button>)}</div>
        </Field>
        <Field label={t('eightySix.area')}>
          <select className="input" value={f.area} onChange={(e) => set('area', e.target.value)}>
            <option value="">{t('eightySix.anyArea')}</option>
            {options.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
      </div>
      <Field label={t('eightySix.suggest')}>
        <div className="seg">{MENUS.map(([k, label]) => <button key={k} type="button" className={f.menu === k && !f.sections.length ? 'on' : ''} onClick={() => setF((x) => ({ ...x, menu: k, sections: [] }))}>{t(label)}</button>)}</div>
        {options.sections.length > 0 && <>
          <div className="tiny faint" style={{ marginTop: 6 }}>{t('eightySix.menuSections')}</div>
          <Chips options={options.sections} value={f.sections} onChange={(v) => set('sections', v)} />
        </>}
      </Field>
      <Field label={t('eightySix.whoReports')} help={t('eightySix.whoReportsHelp')}>
        <div className="tiny faint">{t('eightySix.departments')}</div>
        <Chips options={options.departments} value={f.reporters.departments} onChange={(v) => set('reporters', { ...f.reporters, departments: v })} />
        <div className="tiny faint" style={{ marginTop: 4 }}>{t('eightySix.positions')}</div>
        <Chips options={options.jobCodes.map((j) => ({ id: j.id, label: j.name }))} value={f.reporters.jobCodeIds} onChange={(v) => set('reporters', { ...f.reporters, jobCodeIds: v })} />
      </Field>
      <Field label={t('eightySix.whoSees')} help={t('eightySix.whoSeesHelp')}>
        <div className="seg">
          <button type="button" className={f.viewers.all ? 'on' : ''} onClick={() => set('viewers', { all: true })}>{t('eightySix.everyone')}</button>
          <button type="button" className={!f.viewers.all ? 'on' : ''} onClick={() => set('viewers', { departments: f.viewers.departments || [], jobCodeIds: f.viewers.jobCodeIds || [] })}>{t('eightySix.onlySome')}</button>
        </div>
        {!f.viewers.all && <Chips options={options.departments} value={f.viewers.departments || []} onChange={(v) => set('viewers', { ...f.viewers, departments: v })} />}
      </Field>
      <label className="check"><input type="checkbox" checked={f.notify} onChange={(e) => set('notify', e.target.checked)} />{t('eightySix.notifyOut')}</label>
      {f.notify && <label className="check" style={{ marginLeft: 24 }}><input type="checkbox" checked={f.notifyLow} onChange={(e) => set('notifyLow', e.target.checked)} />{t('eightySix.notifyLow')}</label>}
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={!!f.resetAt} onChange={(e) => set('resetAt', e.target.checked ? '04:00' : '')} />{t('eightySix.reset')}</label>
        {f.resetAt && <input className="input sm" type="time" style={{ width: 130 }} value={f.resetAt} onChange={(e) => set('resetAt', e.target.value)} aria-label={t('eightySix.reset')} />}
      </div>
      {!f.resetAt && <div className="help" style={{ marginTop: -6 }}>{t('eightySix.resetHelp')}</div>}
      <div className="row wrap">
        {f.id && canDelete && <button type="button" className="btn sm danger" disabled={busy} onClick={remove}><Icon name="trash" />{t('eightySix.deleteList')}</button>}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn sm primary" disabled={busy || !f.name.trim()} onClick={save}><Icon name="check" />{t('eightySix.saveList')}</button>
      </div>
    </div>
  );
}
