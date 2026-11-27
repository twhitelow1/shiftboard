import { offPrimary } from '../../../core/layout.js';
import React, { useState } from 'react';
import { useApp, Modal, Field, Icon, useAction, startTimesOnly } from '../ui.jsx';
import { canTrade } from './TradeHint.jsx';
import { dow, parseDate } from '../../../core/time.js';
import { bannerColor, textOn } from '../../../core/areas.js';
import { useT, prettyDate , dowLong } from '../i18n/index.js';
import '../quick-shift.css';
import { BlockedLabel, WindowNote, ConflictMark } from './ScheduleConflicts.jsx'; // blocked days (managers)

// The schedule drawn like the house spreadsheet (and its PDF): a colored banner per area, a
// header row per position with the day names, names in capitals, yellow OFF cells, the dates and
// the day's notes and events under the first banner, Projected Covers, and a Notes line at the end.
// It prints on one page like the PDF.

/** MONDAY · LUNES: the sheet's day names, in the viewer's language. */
const dayName = (i) => dowLong(i).toUpperCase();

/** "16:00" → "4PM", "15:30" → "3:30PM"; with an end: "1-9PM", "10AM-6PM". */
export function sheetTime(s) {
  const part = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return { n: `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`, ap: h >= 12 ? 'PM' : 'AM' };
  };
  const a = part(s.start);
  if (!s.end || startTimesOnly()) return `${a.n}${a.ap}`;
  const b = part(s.end);
  return a.ap === b.ap ? `${a.n}-${b.n}${b.ap}` : `${a.n}${a.ap}-${b.n}${b.ap}`;
}

/** "Server" → "Servers", "Doorman" → "Doormen". */
export const plural = (n) => (/man$/i.test(n) ? n.replace(/man$/i, 'men') : /(s|x|ch|sh)$/i.test(n) ? `${n}es` : /[^aeiou]y$/i.test(n) ? `${n.slice(0, -1)}ies` : `${n}s`);
const usDate = (d) => { const x = parseDate(d); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; };

export default function ScheduleSheet({ sections, days, data, fc, ws, onAdd, onOpen, onSaved, onEditSection, onArrange, className = '', programming = null, daysOff = [], onUndoDayOff, paste = null, conflicts = null, onPerson }) {
  const t = useT();
  const { isMgr, me, settings, people, today } = useApp();
  const [editNote, setEditNote] = useState(null); // { kind, date, text }

  // Consecutive sections under the same banner form one block, like the sheet.
  const groups = [];
  for (const sec of sections) {
    const last = groups[groups.length - 1];
    if (last && last.banner === sec.banner) last.secs.push(sec);
    else groups.push({ banner: sec.banner, secs: [sec] });
  }
  if (!groups.length) groups.push({ banner: settings.restaurantName || t('scheduleSheet.schedule'), secs: [] });

  const note = (kind, date) => data.notes?.find((n) => n.kind === kind && n.date === date)?.text || '';
  const timeOffOn = (userId, date) => data.timeOff?.find((t) => t.userId === userId && t.startDate <= date && t.endDate >= date);
  const workingElsewhere = (userId, date) => data.shifts.find((s) => s.userId === userId && s.date === date);
  const covers = (d) => fc?.days?.find((x) => x.date === d)?.totalCovers;

  const { people: peopleById, jobs: jobsById } = useApp(); // light green: a shift outside their primary room (core/layout.js)
  // A plain function (not a component), so cells keep their focus and the paste selection across renders.
  // paste (pages/ShiftPaste.jsx, managers): each person's cell can be selected, copied from and pasted into.
  paste?.begin('sheet');
  const Cell = ({ list, date, sec, user }) => {
    const shifts = [...list].sort((a, b) => a.start.localeCompare(b.start));
    const add = isMgr && sec?.job ? () => onAdd(date, sec.job.id, user?.id, sec.area) : undefined;
    const pc = paste && user && sec ? paste.cell('sheet', `${sec.key}|${user.id}`, days.indexOf(date), isMgr && sec.job ? { userId: user.id, date, jobCodeId: sec.job.id, area: sec.area ?? '' } : null, shifts) : null;
    const p = pc ? pc.props : {};
    const sel = pc?.selected ? 'psel' : '';
    const pasteBtn = pc?.pasteButton(!shifts.length);
    if (shifts.length) {
      return (
        <td key={date} {...p} className={`${add ? 'can-add' : ''} ${sel}`} onClick={add}>
          {shifts.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 && ' / '}
              <span data-shift-id={s.id} className={`sh-shift ${s.published ? '' : 'draft'} ${s.userId === me.id ? 'mine' : ''} ${s.userId && offPrimary(s, peopleById[s.userId], jobsById[s.jobCodeId]) ? 'elsewhere' : ''}`} title={[!s.published && t('scheduleSheet.draftNotPostedYet'), canTrade(s, me, today) && t('schedule.yourShiftTapToTrade'), ...(data.warnings?.[s.id] || []), s.notes].filter(Boolean).join('\n')}
                onClick={(e) => { e.stopPropagation(); onOpen(s); }}>
                {sheetTime(s)}{s.tag ? ` ${s.tag}` : ''}{data.warnings?.[s.id] && <sup className="sh-warn">!</sup>}{s.pending && <sup>⇄</sup>}<ConflictMark info={conflicts?.shift(s.id)} />
              </span>
              {pc && s.userId && paste.copyButton(s, shifts.length - 1 - i)}
            </React.Fragment>
          ))}
        </td>
      );
    }
    if (!user) return <td key={date} {...p} className={add ? 'can-add' : ''} onClick={add} />;
    // DAY OFF: a manager marked them off on purpose (core/quick-shift.js), unlike OFF (just not scheduled).
    if (daysOff.some((d) => d.userId === user.id && d.date === date)) {
      return (
        <td key={date} {...p} className={`dayoff ${add ? 'can-add' : ''} ${sel}`} onClick={add} title={t('quickShift.cellTitle')}>{t('quickShift.cell')}
          {add && <button type="button" className="dayoff-undo no-print" onClick={(e) => { e.stopPropagation(); add(); }}>{t('quickShift.addShift')}</button>}{pasteBtn}</td>
      );
    }
    const cx = conflicts?.cell(user.id, date); // blocked: unavailable, standing request off, approved time off (ScheduleConflicts.jsx)
    // Not available (or a standing request off / time off): the reason, and "+ Shift" for managers (asks before saving over it).
    if (cx?.block) return <td key={date} {...p} className={`cx-blocked ${add ? 'can-add' : ''} ${sel}`} onClick={add}><BlockedLabel block={cx.block} />
      {add && <button type="button" className="dayoff-undo no-print" onClick={(e) => { e.stopPropagation(); add(); }}>{t('quickShift.plusShift')}</button>}{pasteBtn}</td>;
    const to = timeOffOn(user.id, date);
    if (to) return <td key={date} {...p} className={`off ${add ? 'can-add' : ''} ${sel}`} onClick={add} title={[to.status !== 'approved' && isMgr && t('conflicts.pendingHint'), to.reason].filter(Boolean).join('\n')}>{to.status === 'approved' ? t('scheduleSheet.requestOff') : t('scheduleSheet.reqPending')}{pasteBtn}</td>;
    const other = workingElsewhere(user.id, date);
    if (other) return <td key={date} {...p} className={`elsewhere ${add ? 'can-add' : ''} ${sel}`} onClick={add} title={`${t('scheduleSheet.workingTime', { time: sheetTime(other) })}${other.area ? ` · ${other.area}` : ''}`}>{pasteBtn}</td>;
    // No shift that day: DAY OFF, and managers get "Add shift".
    return <td key={date} {...p} className={`dayoff ${add ? 'can-add' : ''} ${sel}`} onClick={add}>{t('quickShift.cell')}{cx?.window && <WindowNote w={cx.window} />}
      {add && <button type="button" className="dayoff-undo no-print" onClick={(e) => { e.stopPropagation(); add(); }}>{t('quickShift.addShift')}</button>}{pasteBtn}</td>;
  };

  return (
    <div className={`sheet-wrap ${className}`}>
      <table className="sheet">
        <colgroup><col className="sh-namecol" />{days.map((d) => <col key={d} />)}</colgroup>
        <tbody>
          {groups.map((g, gi) => {
            // A room's own color, else a steady one by its place in Rooms & positions.
            const color = bannerColor(settings, g.banner, g.secs[0]?.roomIndex ?? gi);
            const fill = { background: color, color: textOn(color) };
            return (
              <React.Fragment key={g.banner + gi}>
                <tr className="sh-banner"><td colSpan={8} style={fill} className={onArrange ? 'sh-edit' : undefined} title={onArrange ? t('arrange.title', { banner: g.banner }) : undefined}
                  onClick={onArrange ? () => onArrange(g.banner) : undefined}><span className="sh-banner-t">{(!g.secs.some((x) => x.area) && g.secs.find((x) => x.sheetBanner)?.sheetBanner) || g.banner}
                  {onArrange && <span className="sh-edit-ic no-print" aria-hidden="true"><Icon name="layers" size={13} /></span>}</span></td></tr>
                {gi === 0 && <tr className="sh-dates"><td />{days.map((d) => <td key={d}>{usDate(d)}</td>)}</tr>}
                {g.secs.map((sec) => (
                  <React.Fragment key={sec.key}>
                    <tr className="sh-head"><td style={fill} title={onEditSection && sec.job ? t('sectionPeople.editTitle') : sec.label}
                      className={onEditSection && sec.job ? 'sh-edit' : undefined} onClick={onEditSection && sec.job ? () => onEditSection(sec) : undefined}>
                      {sec.sheetLabel || plural(sec.label)}{onEditSection && sec.job && <span className="sh-edit-ic no-print" aria-hidden="true"><Icon name="users" size={12} /></span>}</td>{days.map((d) => <td key={d}>{dayName(dow(d))}</td>)}</tr>
                    {sec.rows.map(({ user, shifts }) => (
                      <tr key={user.id} className={user.id === me.id ? 'me' : ''}>
                        <td className="sh-name" title={user.sheetName ? user.name : undefined}>{onPerson ? <button type="button" className="pp-name" onClick={() => onPerson(user.id)} title={t('personPanel.open', { name: user.name })}>{user.sheetName || user.name}</button> : user.sheetName || user.name}</td>
                        {days.map((d) => Cell({ date: d, sec, user, list: shifts.filter((s) => s.date === d) }))}
                      </tr>
                    ))}
                    {sec.open.length > 0 && (
                      <tr className="sh-open">
                        <td className="sh-name">{t('scheduleSheet.open')}</td>
                        {days.map((d) => Cell({ date: d, sec, list: sec.open.filter((s) => s.date === d) }))}
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {gi === 0 && (
                  <>
                    <tr className="sh-notes">
                      <td />
                      {days.map((d) => {
                        const text = note('day', d);
                        const evs = (data.events || []).filter((e) => e.date === d);
                        return (
                          <td key={d} className={isMgr ? 'can-add' : ''} onClick={isMgr ? () => setEditNote({ kind: 'day', date: d, text }) : undefined}
                            title={isMgr ? t('scheduleSheet.clickToEditTheDay') : undefined}>
                            {evs.map((e) => (
                              <a key={e.id} className="sh-evt" href={`#/events/${e.id}`} onClick={(x) => x.stopPropagation()}>
                                {[e.name, e.room, e.guestCount ? `${e.guestCount} PPL` : ''].filter(Boolean).join(' ')}
                              </a>
                            ))}
                            {text ? <div className="sh-daynote">{text}</div> : programming?.[d]?.autoNote ? <div className="sh-daynote auto">{programming[d].autoNote}</div> : null}{/* a manager's note wins over the programming's (core/programming.js) */}
                          </td>
                        );
                      })}
                    </tr>
                    {fc && <tr className="sh-covers"><td>{t('scheduleSheet.projectedCovers')}</td>{days.map((d) => <td key={d}>{covers(d) ?? ''}</td>)}</tr>}
                  </>
                )}
              </React.Fragment>
            );
          })}
          <tr className="sh-weeknote">
            <td>{t('scheduleSheet.notes')}</td>
            <td colSpan={7} className={isMgr ? 'can-add' : ''} onClick={isMgr ? () => setEditNote({ kind: 'week', date: ws, text: note('week', ws) }) : undefined}>
              {note('week', ws)}
            </td>
          </tr>
        </tbody>
      </table>
      {editNote && <NoteDialog note={editNote} onClose={(changed) => { setEditNote(null); if (changed) onSaved?.(); }} />}
    </div>
  );
}

function NoteDialog({ note, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [text, setText] = useState(note.text || '');
  const [run, busy] = useAction();
  const save = async () => {
    const r = await run(() => call('notes.save', { kind: note.kind, date: note.date, text }), t('scheduleSheet.noteSaved'));
    if (r) onClose(true);
  };
  return (
    <Modal title={note.kind === 'week' ? t('scheduleSheet.notesForTheWeek') : t('scheduleSheet.noteForDate', { date: prettyDate(note.date) })} sub={t('scheduleSheet.showsOnTheScheduleFor')} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t('common.save')}</button></>}>
      <Field label={note.kind === 'week' ? t('common.notes') : t('scheduleSheet.dayNote')} help={note.kind === 'day' ? t('scheduleSheet.forExampleClosedMeetingOpening') : t('scheduleSheet.shownOnTheNotesLine')}>
        <textarea className="input" style={{ minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
