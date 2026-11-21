import React, { useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import { useT } from '../i18n/index.js';

/** Can this person trade or give away this shift right now (their own, posted, still ahead, nothing pending)? */
export function canTrade(s, me, today) {
  return !!s && s.userId === me.id && s.published && s.date >= today && !s.pending;
}

/**
 * A one-line pointer to trading, shown where people see their own shifts (Schedule, Calendar)
 * when they have one they could trade. "Got it" hides it on this device.
 */
export default function TradeHint({ shifts }) {
  const t = useT();
  const { me, today } = useApp();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('sb_trade_hint') === '1'; } catch { return false; } });
  if (hidden || !(shifts || []).some((s) => canTrade(s, me, today))) return null;
  const hide = () => { setHidden(true); try { localStorage.setItem('sb_trade_hint', '1'); } catch { /* ignore */ } };
  return (
    <div className="trade-hint no-print">
      <Icon name="swap" size={16} />
      <span>{t('tradeHint.cantMakeOneOfYour')}</span>
      <span className="spacer" />
      <a className="btn sm primary" href="#/swaps"><Icon name="swap" />{t('tradeHint.tradeAShift')}</a>
      <button type="button" className="btn sm ghost" onClick={hide}>{t('tradeHint.gotIt')}</button>
    </div>
  );
}
