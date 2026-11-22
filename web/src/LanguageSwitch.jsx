// The language switch: a globe and the current language (EN / ES) at the top right of every screen
// (the top bar, and the sign-in, forgot-password and reset-password screens). It opens a two-option
// menu, each language written in its own language. Switching re-renders right away on the same screen;
// signed in, it's saved on the account too (main.jsx). My Shifts has the same choice in its settings.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { useI18n, useT, LANGS, LANGUAGE_NAMES } from './i18n/index.js';

export default function LanguageSwitch({ onDark = false }) {
  const { lang, setLang } = useI18n();
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const pick = (l) => { setOpen(false); if (l !== lang) setLang(l); };
  return (
    <div className={`lang-switch${onDark ? ' on-dark' : ''}`} ref={box}>
      <button type="button" className="lang-btn" aria-label={t('lang.change')} title={t('lang.change')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} data-testid="language-switch">
        <Icon name="globe" size={18} /><span className="lang-code">{lang.toUpperCase()}</span>
      </button>
      {open && (
        <div className="lang-menu" role="menu" aria-label={t('lang.title')}>
          {LANGS.map((l) => (
            <button key={l} type="button" role="menuitemradio" aria-checked={l === lang} lang={l} className={l === lang ? 'on' : ''} onClick={() => pick(l)}>
              <span className="lang-check">{l === lang && <Icon name="check" size={16} />}</span>
              <span>{LANGUAGE_NAMES[l]}</span>
              <span className="lang-menu-code">{l.toUpperCase()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
