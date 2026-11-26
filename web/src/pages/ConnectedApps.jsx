// My settings → Sign-in & security → Connected apps: the apps (Claude) that can use ShiftBoard as me, when each
// was connected and last used, and Disconnect (it stops working right away). server/mcp/index.js.
import React, { useEffect, useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { myConnections, revokeConnection } from '../mcp-api.js';
import { useT, stampDay } from '../i18n/index.js';
import '../claude.css';

const SAMPLE = [{ id: 'sample', name: 'Claude', kind: 'claude', readOnly: false, connectedAt: '2026-09-20T15:00:00Z', lastUsedAt: '2026-09-27T11:40:00Z' }];

export default function ConnectedApps() {
  const t = useT();
  const { toast, tenant } = useApp();
  const [list, setList] = useState(IS_DEMO ? SAMPLE : null);
  const [available, setAvailable] = useState(true);
  const [sure, setSure] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (IS_DEMO) return;
    myConnections().then((r) => { setList(r.connections); setAvailable(r.available); }, (e) => toast(e.message, 'bad'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list || (!available && !list.length)) return null;
  const revoke = async (id) => {
    if (IS_DEMO) { toast(t('security.demoOnly')); setSure(null); return; }
    setBusy(true);
    try { const r = await revokeConnection(id); setList(r.connections); toast(t('claude.revoked')); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); setSure(null); }
  };
  return (
    <div className="sec-block" id="connected-apps">
      <div className="sec-head"><Icon name="link" size={18} /><b>{t('claude.connectedApps')}</b><span className="badge">{list.length}</span></div>
      <div className="small muted">{IS_DEMO ? t('claude.demoNote') : t('claude.connectedAppsHelp')}</div>
      {!list.length && <div className="small muted">{t('claude.noConnectedApps')}</div>}
      {list.map((c) => (
        <div key={c.id} className="claude-conn">
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{c.name}{c.kind === 'loopback' && <span className="tiny muted"> · {t('claude.localApp')}</span>}
              {c.readOnly && <span className="badge" style={{ marginLeft: 6 }}>{t('claude.readOnlyBadge')}</span>}</div>
            <div className="tiny muted">{t('claude.connectedOn', { date: stampDay(c.connectedAt) })} · {t('claude.lastUsed', { date: stampDay(c.lastUsedAt) })}</div>
          </div>
          {!tenant?.support && (sure === c.id
            ? <div className="row wrap" style={{ gap: 8 }}><span className="small">{t('claude.revokeSure', { name: c.name })}</span>
              <button type="button" className="btn sm danger solid" disabled={busy} onClick={() => revoke(c.id)}>{t('claude.yesRevoke')}</button>
              <button type="button" className="btn sm ghost" onClick={() => setSure(null)}>{t('common.cancel')}</button></div>
            : <button type="button" className="btn sm" onClick={() => setSure(c.id)}>{t('claude.revoke')}</button>)}
        </div>
      ))}
    </div>
  );
}
