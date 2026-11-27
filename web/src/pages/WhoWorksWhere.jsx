// "Who works where" (#/who-works-where, from Settings → Rooms & positions and the schedule): pick a position, then
// tick each person into the rooms they work it in (the rooms that list it) and pick their primary room. Save once
// (layout.saveWhoWorksWhere; every change is in the schedule log). People nobody ticked keep their department's room.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, Empty, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import '../availability.css';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export default function WhoWorksWhere({ parts = [] }) {
  const t = useT();
  const { call, jobCodes, toast } = useApp();
  const [jobId, setJobId] = useState(parts[1] || jobCodes.find((j) => !j.archived)?.id || '');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [run, busy] = useAction();
  useEffect(() => {
    if (!jobId) return;
    setData(null);
    call('layout.whoWorksWhere', { jobCodeId: jobId }).then((d) => {
      setData(d);
      setDraft(Object.fromEntries(d.people.map((p) => [p.id, { rooms: p.rooms, primaryRoom: p.primaryRoom }])));
    }, (e) => toast(e.message, 'bad'));
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const rooms = data ? [...new Set([...data.rooms, ...data.people.flatMap((p) => p.rooms)])] : [];
  const toggle = (id, room) => {
    const cur = draft[id];
    const on = cur.rooms.some((r) => same(r, room));
    const next = on ? cur.rooms.filter((r) => !same(r, room)) : [...cur.rooms, room];
    if (!next.length) return; // at least one room
    setDraft({ ...draft, [id]: { rooms: next, primaryRoom: on && same(cur.primaryRoom, room) ? '' : cur.primaryRoom } });
  };
  const changed = data ? data.people.filter((p) => JSON.stringify(draft[p.id]) !== JSON.stringify({ rooms: p.rooms, primaryRoom: p.primaryRoom })) : [];
  const save = async () => {
    const r = await run(() => call('layout.saveWhoWorksWhere', { jobCodeId: jobId, people: changed.map((p) => ({ id: p.id, ...draft[p.id] })) }), (out) => t('whoWorks.saved', { count: out.saved }));
    if (r) { setData(r); setDraft(Object.fromEntries(r.people.map((p) => [p.id, { rooms: p.rooms, primaryRoom: p.primaryRoom }]))); }
  };
  return (
    <div style={{ maxWidth: 980 }} className="col">
      <div><a className="btn ghost sm" href="#/settings"><Icon name="left" />{t('whoWorks.back')}</a></div>
      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('whoWorks.title')}</h2>
        <div className="help">{t('whoWorks.help')}</div>
        <Field label={t('whoWorks.position')}>
          <select className="input" value={jobId} onChange={(e) => setJobId(e.target.value)} style={{ maxWidth: 280 }}>
            {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </Field>
        {!data ? <div className="empty">{t('common.loading')}</div> : !data.people.length ? <Empty icon="users" title={t('whoWorks.nobody')} /> : (
          <div className="rf-scroll">
            <table className="rf-table ww-table">
              <thead><tr><th className="rf-name">{t('whoWorks.person')}</th>{rooms.map((r) => <th key={r} scope="col">{r}</th>)}<th scope="col">{t('availability.primaryRoom')}</th></tr></thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className="rf-name">{p.name}{!p.explicit && <div className="tiny faint">{t('whoWorks.defaultRoom')}</div>}</th>
                    {rooms.map((r) => {
                      const on = draft[p.id]?.rooms.some((x) => same(x, r));
                      return <td key={r}><input type="checkbox" checked={!!on} onChange={() => toggle(p.id, r)} aria-label={t('whoWorks.worksIn', { name: p.name, room: r })} /></td>;
                    })}
                    <td>
                      <select className="input sm" value={draft[p.id]?.primaryRoom || ''} onChange={(e) => setDraft({ ...draft, [p.id]: { ...draft[p.id], primaryRoom: e.target.value } })} aria-label={t('availability.primaryRoomFor', { position: p.name })}>
                        <option value="">{t('availability.noPrimaryRoom')}</option>
                        {(draft[p.id]?.rooms || []).map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          {changed.length > 0 && <span className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('whoWorks.unsaved', { count: changed.length })}</span>}
          <span className="spacer" />
          <button className="btn primary" disabled={busy || !changed.length} onClick={save}><Icon name="check" />{t('whoWorks.save')}</button>
        </div>
      </div>
    </div>
  );
}
