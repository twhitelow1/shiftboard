// Settings → Roles & features → Custom roles: Bar Manager, Kitchen Manager, Shift Lead… a name (and a Spanish name) on
// a base level (core/custom-roles.js). Admins and Super Admins make, rename and delete them; deleting one with people
// asks first, naming how many, and moves them to the base level. Each gets its own column in the table above and its
// own "Approves for" default below.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { roleLabel } from '../../../core/roles.js';

const BASES = ['manager', 'supervisor', 'employee'];

export function CustomRoles({ onChange }) {
  const t = useT();
  const { call, lang, refresh } = useApp();
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // { id?, name, nameEs, base }
  const [confirm, setConfirm] = useState(null); // { role, people }
  const [run, busy] = useAction();
  const load = () => call('roles.custom.list').then(setList, () => setList([]));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const r = await run(() => call('roles.custom.save', edit), t('customRoles.saved'));
    if (r) { setEdit(null); await load(); refresh(); onChange?.(); }
  };
  const remove = async (role, sure = false) => {
    const r = await run(() => call('roles.custom.delete', { id: role.id, confirm: sure }));
    if (!r) return;
    if (r.needsConfirm) { setConfirm({ role, people: r.people }); return; }
    setConfirm(null); await load(); refresh(); onChange?.();
  };
  return (
    <div className="card card-pad col" style={{ gap: 10 }} id="custom-roles">
      <h2>{t('customRoles.title')}</h2>
      <div className="help">{t('customRoles.help')}</div>
      {(list || []).map((r) => (
        <div key={r.id} className="row wrap" style={{ gap: 8 }}>
          <b style={{ flex: '1 1 160px' }}>{lang === 'es' && r.nameEs ? r.nameEs : r.name}</b>
          <span className="badge">{t('customRoles.basedOn', { base: roleLabel(r.base, lang) })}</span>
          <span className="small muted">{t('customRoles.people', { count: r.people })}</span>
          <button className="btn ghost sm" onClick={() => setEdit({ id: r.id, name: r.name, nameEs: r.nameEs || '', base: r.base })}><Icon name="edit" />{t('common.edit')}</button>
          <button className="btn ghost sm danger" disabled={busy} onClick={() => remove(r)}><Icon name="trash" />{t('common.delete')}</button>
        </div>
      ))}
      {list && !list.length && <div className="small muted">{t('customRoles.none')}</div>}
      {confirm && (
        <div className="alert warn col" style={{ alignItems: 'stretch', gap: 8 }}>
          <div>{t('customRoles.confirmDelete', { name: confirm.role.name, count: confirm.people, base: roleLabel(confirm.role.base, lang) })}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm danger solid" disabled={busy} onClick={() => remove(confirm.role, true)}>{t('customRoles.deleteMove')}</button>
            <button className="btn sm" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {edit ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="grid2">
            <Field label={t('customRoles.name')}><input className="input" value={edit.name} maxLength={40} placeholder={t('customRoles.namePh')} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t('customRoles.nameEs')} help={t('customRoles.nameEsHelp')}><input className="input" value={edit.nameEs} maxLength={40} onChange={(e) => setEdit({ ...edit, nameEs: e.target.value })} /></Field>
          </div>
          <Field label={t('customRoles.base')} help={t('customRoles.baseHelp')}>
            <div className="seg" role="radiogroup">
              {BASES.map((b) => <button key={b} type="button" role="radio" aria-checked={edit.base === b} className={edit.base === b ? 'on' : ''} onClick={() => setEdit({ ...edit, base: b })}>{roleLabel(b, lang)}</button>)}
            </div>
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <span className="spacer" />
            <button className="btn" onClick={() => setEdit(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy || !edit.name.trim()} onClick={save}><Icon name="check" />{t('customRoles.save')}</button>
          </div>
        </div>
      ) : (
        <div><button className="btn sm" onClick={() => setEdit({ name: '', nameEs: '', base: 'manager' })}><Icon name="plus" />{t('customRoles.add')}</button></div>
      )}
    </div>
  );
}
