// Settings → Roles & features (#/settings/roles): a grid of features (down the side) × roles (across) with a
// switch per cell. The plan decides what's possible (locked "Not in your plan"), a Super Admin always has
// everything, Admins change only the roles below Admin, and "Preview" opens View as with that role and the
// unsaved changes. The rules and the server's checks are in core/role-features.js.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import { roleLabel, roleOf } from '../../../core/roles.js';
import { useT } from '../i18n/index.js';
import { beginView } from './ViewAs.jsx';
import { peekDraft, keepDraft } from '../view-as-api.js';
import '../view-as.css';

/** Only the switches (true/false) of the roles below Super Admin: what the server takes. */
const switches = (values, roles) => Object.fromEntries(roles.filter((r) => r !== 'super_admin').map((r) => [r,
  Object.fromEntries(Object.entries(values[r] || {}).filter(([, v]) => typeof v === 'boolean'))]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function RolesEditor() {
  const t = useT();
  const { call, toast, refresh, me, lang, viewAs } = useApp();
  const isSuper = roleOf(me) === 'super_admin' && !viewAs;
  const [data, setData] = useState(null);
  const [values, setValues] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('roleFeatures.get').then((d) => {
      setData(d);
      // Back from a preview: the changes that were previewed, still unsaved.
      const kept = peekDraft();
      keepDraft(null);
      if (!kept?.roleFeatures) return setValues(d.values);
      const next = JSON.parse(JSON.stringify(d.values));
      for (const r of d.editable) for (const [k, v] of Object.entries(kept.roleFeatures[r] || {})) if (typeof next[r]?.[k] === 'boolean' && typeof v === 'boolean') next[r][k] = v;
      setValues(next);
    }, (e) => toast(e.message, 'bad'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => data && values && !same(switches(values, data.roles), switches(data.values, data.roles)), [data, values]);
  if (!data || !values) return <div className="empty">{t('common.loading')}</div>;

  const editable = (role) => !viewAs && data.editable.includes(role);
  const label = (key) => t(`roles.f_${key}`);
  const set = (role, key, on) => setValues({ ...values, [role]: { ...values[role], [key]: on } });
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('roleFeatures.save', { roleFeatures: switches(values, data.roles) });
      setData(r); setValues(r.values);
      toast(t('roles.saved'));
      refresh();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const reset = () => {
    const next = JSON.parse(JSON.stringify(values));
    for (const r of data.editable) for (const f of data.features) if (f.cells[r] === 'switch' && f.inPlan) next[r][f.key] = data.defaults[r][f.key];
    setValues(next);
  };
  const preview = (role) => beginView({ role }, { refresh, toast, returnTo: '#/settings/roles',
    draft: { roleFeatures: switches(values, data.roles), supervisorsCanApprove: values.supervisor?.approve !== false } });

  const groups = [['feature', 'roles.groupFeatures'], ['capability', 'roles.groupCapabilities']];
  const cell = (f, role) => {
    const kind = f.cells[role];
    if (kind === 'on') return <span className="rf-cell-fixed"><Icon name="check" size={14} />{t('roles.always')}</span>;
    if (kind === null) return <span className="rf-cell-fixed" title={t('roles.notForRole')} aria-label={t('roles.notForRole')}>—</span>;
    if (!f.inPlan) return <span className="rf-cell-fixed" title={t('roles.notInPlan')} aria-label={t('roles.notInPlan')}><Icon name="lock" size={14} /></span>;
    const on = values[role]?.[f.key] !== false;
    return (
      <>
        <label className="rf-switch" title={t('roles.onOff', { feature: label(f.key), role: roleLabel(role, lang) })}>
          <input type="checkbox" role="switch" checked={on} disabled={busy || !editable(role)} aria-label={t('roles.onOff', { feature: label(f.key), role: roleLabel(role, lang) })}
            onChange={(e) => set(role, f.key, e.target.checked)} />
          <span />
        </label>
        {on !== data.defaults[role][f.key] && <span className="rf-changed" title={t('roles.changed')} />}
      </>
    );
  };

  return (
    <div style={{ maxWidth: 980 }} className="col">
      <div><a className="btn ghost sm" href="#/settings"><Icon name="left" />{t('roles.back')}</a></div>
      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('roles.title')}</h2>
        <div className="help">{t('roles.intro')}</div>
        <div className="rf-scroll">
          <table className="rf-table">
            <thead>
              <tr>
                <th className="rf-name">{t('roles.feature')}</th>
                {data.roles.map((r) => (
                  <th key={r} scope="col">
                    <div>{roleLabel(r, lang)}</div>
                    {isSuper && r !== 'super_admin' && (
                      <button className="btn sm rf-preview" onClick={() => preview(r)} title={t('roles.previewAs', { role: roleLabel(r, lang) })}><Icon name="eye" size={13} />{t('roles.preview')}</button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([group, title]) => (
                <React.Fragment key={group}>
                  <tr className="rf-group"><td className="rf-name">{t(title)}</td><td colSpan={data.roles.length} /></tr>
                  {data.features.filter((f) => f.group === group).map((f) => (
                    <tr key={f.key}>
                      <th scope="row" className="rf-name">
                        <div style={{ fontWeight: 600 }}>{label(f.key)}</div>
                        <div className="small muted">{t(`roles.h_${f.key}`)}</div>
                        {!f.inPlan && <div className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}><Icon name="lock" size={12} /> {t('roles.notInPlan')}</div>}
                      </th>
                      {data.roles.map((r) => <td key={r}>{cell(f, r)}</td>)}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!data.editable.includes('admin') && <div className="help"><Icon name="lock" size={12} /> {t('roles.adminNote')}</div>}
        {isSuper && <div className="help">{t('roles.previewHelp')}</div>}
        <div className="row wrap" style={{ gap: 8 }}>
          {dirty && <span className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('roles.unsaved')}</span>}
          <span className="spacer" />
          <button className="btn" disabled={busy || !!viewAs} onClick={reset}>{t('roles.reset')}</button>
          <button className="btn primary" disabled={busy || !dirty || !!viewAs} onClick={save}><Icon name="check" />{t('roles.save')}</button>
        </div>
      </div>
    </div>
  );
}

/** The card on the Settings page that opens the editor. */
export function RolesCard() {
  const t = useT();
  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <h2>{t('roles.title')}</h2>
      <div className="help">{t('roles.cardHelp')}</div>
      <div><a className="btn" href="#/settings/roles"><Icon name="users" />{t('roles.open')}</a></div>
    </div>
  );
}
