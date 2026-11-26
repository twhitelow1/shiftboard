// Settings → 86 List (admins): the lists staff report on (ingredients and supplies, not menu items). Rename them, add
// one per bar area, choose who reports and who sees each one, notifications and the nightly reset; behind "Also suggest
// menu items", the Training menu items a list offers too (off for every list unless an admin turns it on). Below them,
// the categories items can be filed under (Produce, Dairy… renamed or added to here).
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { Chips } from './TrainingShared.jsx';
import { listName } from './EightySix.jsx';
import { useT } from '../i18n/index.js';

const KINDS = [['bar', 'eightySix.kindBar'], ['kitchen', 'eightySix.kindKitchen'], ['other', 'eightySix.kindOther']];
const MENUS = [['drinks', 'eightySix.menuDrinks'], ['food', 'eightySix.menuFood'], ['all', 'eightySix.menuAll']];

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
  const blank = { name: '', nameEs: '', kind: 'bar', area: '', menu: 'none', sections: [], reporters: { departments: [], jobCodeIds: [] }, viewers: { all: true }, notify: true, notifyLow: false, resetAt: '' };
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
      <Categories saved={data.categories || []} onSaved={load} />
    </div>
  );
}

/** The categories staff can file items under: rename (English and Spanish), reorder, add, remove. Other always stays. */
function Categories({ saved, onSaved }) {
  const t = useT();
  const { call } = useApp();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(saved);
  useEffect(() => { setRows(saved); }, [saved]);
  const set = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i, d) => setRows((r) => { const n = [...r]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const label = (c) => c.name || t('eightySix.newCategory');
  const save = () => run(() => call('eightySix.saveCategories', { categories: rows.map(({ id, name, nameEs }) => ({ id, name, nameEs })) }), t('eightySix.categoriesSaved')).then((r) => { if (r) onSaved(); });
  return (
    <div className="e86-cats col">
      <h3>{t('eightySix.categoriesTitle')}</h3>
      <div className="help">{t('eightySix.categoriesHelp')}</div>
      <div className="list e86-set-lists">
        {rows.map((c, i) => (
          <div key={c.id || `new${i}`} className="list-item e86-cat">
            <div className="grid2 e86-cat-names">
              <input className="input" value={c.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} aria-label={`${t('eightySix.categoryName')}: ${label(c)}`} placeholder={t('eightySix.categoryName')} />
              <input className="input" value={c.nameEs} maxLength={40} onChange={(e) => set(i, { nameEs: e.target.value })} aria-label={`${t('eightySix.categoryNameEs')}: ${label(c)}`} placeholder={t('eightySix.categoryNameEs')} />
            </div>
            <div className="e86-cat-btns">
              <button type="button" className="btn sm icon ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('eightySix.moveUp', { name: label(c) })}><Icon name="up" /></button>
              <button type="button" className="btn sm icon ghost" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={t('eightySix.moveDown', { name: label(c) })}><Icon name="down" /></button>
              <button type="button" className="btn sm icon ghost danger" disabled={c.id === 'other'} onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label={t('eightySix.removeCategory', { name: label(c) })}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
      </div>
      <div className="help">{t('eightySix.otherStays')}</div>
      <div className="row wrap">
        <button type="button" className="btn sm" disabled={rows.length >= 30} onClick={() => setRows((r) => [...r, { id: '', name: '', nameEs: '' }])}><Icon name="plus" />{t('eightySix.addCategory')}</button>
        <span className="spacer" />
        {dirty && <button type="button" className="btn sm" onClick={() => setRows(saved)}>{t('common.cancel')}</button>}
        <button type="button" className="btn sm primary" disabled={busy || !dirty || rows.some((c) => !c.name.trim())} onClick={save}><Icon name="check" />{t('eightySix.saveCategories')}</button>
      </div>
    </div>
  );
}

function ListEditor({ list, options, canDelete, onDone, onCancel }) {
  const t = useT();
  const { call } = useApp();
  const [run, busy] = useAction();
  const [f, setF] = useState(() => ({ ...list, reporters: { departments: [], jobCodeIds: [], ...list.reporters }, viewers: list.viewers || { all: true } }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const menuOn = (f.menu && f.menu !== 'none') || f.sections.length > 0;
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
      <div className="col e86-menu-opt" style={{ gap: 4 }}>
        <label className="check"><input type="checkbox" checked={menuOn} onChange={(e) => setF((x) => ({ ...x, menu: e.target.checked ? (x.kind === 'bar' ? 'drinks' : 'food') : 'none', sections: [] }))} />{t('eightySix.suggestMenu')}</label>
        <div className="help">{t('eightySix.suggestMenuHelp')}</div>
        {menuOn && (
          <Field label={t('eightySix.suggest')}>
            <div className="seg">{MENUS.map(([k, label]) => <button key={k} type="button" className={f.menu === k && !f.sections.length ? 'on' : ''} onClick={() => setF((x) => ({ ...x, menu: k, sections: [] }))}>{t(label)}</button>)}</div>
            {options.sections.length > 0 && <>
              <div className="tiny faint" style={{ marginTop: 6 }}>{t('eightySix.menuSections')}</div>
              <Chips options={options.sections} value={f.sections} onChange={(v) => setF((x) => ({ ...x, sections: v, menu: v.length ? x.menu : x.menu === 'none' ? 'drinks' : x.menu }))} />
            </>}
          </Field>
        )}
      </div>
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
