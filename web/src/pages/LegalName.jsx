// The legal name for payroll (core/names.js): first and last name side by side under the name people go by.
// Used by Team's person editor, the welcome wizard's profile step and My settings.
import React from 'react';
import { useT } from '../i18n/index.js';
import { legalDiffers, legalNameOf } from '../../../core/names.js';

/**
 * @param value     { legalFirstName, legalLastName }
 * @param onChange  (next) => void, with both fields
 * @param own       the person's own name (lets the browser fill it in); off for someone else's
 */
export function LegalNameFields({ value, onChange, label, help, own = false, disabled = false, style }) {
  const t = useT();
  const set = (k) => (e) => onChange({ legalFirstName: value?.legalFirstName || '', legalLastName: value?.legalLastName || '', [k]: e.target.value });
  return (
    <div className="field" style={style}>
      <span>{label || t('legalName.label')}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
        <input className="input" value={value?.legalFirstName || ''} onChange={set('legalFirstName')} placeholder={t('legalName.first')} maxLength={60}
          aria-label={`${label || t('legalName.label')}: ${t('legalName.first')}`} autoComplete={own ? 'given-name' : 'off'} disabled={disabled} />
        <input className="input" value={value?.legalLastName || ''} onChange={set('legalLastName')} placeholder={t('legalName.last')} maxLength={60}
          aria-label={`${label || t('legalName.label')}: ${t('legalName.last')}`} autoComplete={own ? 'family-name' : 'off'} disabled={disabled} />
      </div>
      {help && <div className="help">{help}</div>}
    </div>
  );
}

/** "(Carlos Javier Ortiz)" after a name, for people whose legal name the viewer may see and that differs. */
export function LegalNameNote({ person }) {
  if (!legalDiffers(person)) return null;
  return <span className="small muted">({legalNameOf(person)})</span>;
}
