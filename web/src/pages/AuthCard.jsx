// The card every signed-out screen sits on (sign-in, the second step, reset, the welcome wizard), with the
// restaurant's name and logo from /api/config and the language switch.
import React from 'react';
import { useT } from '../i18n/index.js';
import LanguageSwitch from '../LanguageSwitch.jsx';
import '../auth.css';

// The restaurant's name and logo for the sign-in screens (from /api/config, before anyone signs in).
export const SignInBrand = React.createContext(null);
export const DEFAULT_NAME = 'Our Restaurant';

/** The restaurant's logo, or the first letter of its name in its color. */
export function BrandMark({ name, logo, size = 32 }) {
  if (logo) return <img className="brand-logo" src={logo} alt="" style={{ height: size, maxWidth: size * 4 }} />;
  return <div className="brand-mark" style={{ width: size, height: size }}>{(String(name || 'S').trim()[0] || 'S').toUpperCase()}</div>;
}

/** wide: the welcome wizard's roomier card. top: something above the form (progress dots). */
export function AuthCard({ children, onSubmit, wide = false, top = null }) {
  const t = useT();
  const brand = React.useContext(SignInBrand);
  const named = brand?.name && brand.name !== DEFAULT_NAME;
  return (
    <div className="login">
      <div className="login-lang"><LanguageSwitch onDark /></div>
      <form className={`card card-pad col auth-card ${wide ? 'wide' : ''}`} style={{ gap: 14, padding: 26 }} onSubmit={onSubmit || ((e) => e.preventDefault())}>
        <div className="brand" style={{ color: 'var(--text)', padding: 0 }}>
          <BrandMark name={named ? brand.name : 'S'} logo={brand?.logo} size={40} />
          <div style={{ minWidth: 0 }}><div className="brand-name">{named ? brand.name : t('main.shiftboard')}</div><div className="small muted">{named ? t('main.scheduleShiftboard') : t('main.restaurantScheduling')}</div></div>
        </div>
        {top}
        {children}
      </form>
    </div>
  );
}
