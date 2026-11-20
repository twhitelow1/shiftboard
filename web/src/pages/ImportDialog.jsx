import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, useAction } from '../ui.jsx';
import { parseSchedule, dateForDow, matchEmployee, matchJob, suggestJob, notesToEvents, personName, titleCase } from '../../../core/importer.js';
import { addDays, weekStart, prettyDate } from '../../../core/time.js';
import { weekLabel } from './Schedule.jsx';

const NEW = '__new__';
const SAMPLE = `SERVER\tMONDAY\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY
ALEX D\tOFF\t3:30PM BC\tOFF\t4PM\t4:30PM*\t3:30PM BC\tOFF
STYVES\tOFF\t4PM LIB\t4PM\tOFF\t4PM\t4PM\tOFF`;

export default function ImportDialog({ ws: initialWs, onClose }) {
  const { employees, jobCodes, settings, call, toast } = useApp();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [ws, setWs] = useState(initialWs);
  const [jobMap, setJobMap] = useState({});     // section label -> job id | NEW | ''
  const [jobNames, setJobNames] = useState({}); // section label -> name for a new job code
  const [empMap, setEmpMap] = useState({});     // schedule name -> user id | NEW | ''
  const [opts, setOpts] = useState({ timeOff: true, dupes: true, events: true, covers: true });
  const [skipEvent, setSkipEvent] = useState({});
  const [run, busy] = useAction();

  const parsed = useMemo(() => parseSchedule(text), [text]);
  // Jump to the week printed on the schedule.
  useEffect(() => { if (parsed.weekOf) setWs(weekStart(parsed.weekOf, settings.weekStartDow)); }, [parsed.weekOf, settings.weekStartDow]);

  const activeJobs = jobCodes.filter((j) => !j.archived);
  const people = employees.filter((e) => e.onSchedule !== false);
  const labels = parsed.mode === 'grid' ? parsed.sections.map((s) => s.label) : [...new Set(parsed.csvRows.map((r) => r.job).filter(Boolean))];
  const names = useMemo(() => {
    const s = new Set();
    parsed.sections.forEach((sec) => sec.rows.forEach((r) => s.add(r.name)));
    parsed.csvRows.forEach((r) => s.add(r.name));
    return [...s];
  }, [parsed]);

  const jobFor = (label) => jobMap[label] ?? (matchJob(label, activeJobs)?.id || NEW);
  const newJobName = (label) => jobNames[label] ?? suggestJob(label, labels).name;
  const empFor = (name) => empMap[name] ?? (matchEmployee(name, people)?.id || NEW);
  const found = useMemo(() => notesToEvents(parsed.notes, settings.rooms || []), [parsed, settings.rooms]);
  const dateOf = (dow) => dateForDow(ws, settings.weekStartDow, dow);

  const plan = useMemo(() => {
    const shifts = [], tos = [], newJobs = new Map(), newPeople = new Map(), skipped = new Set();
    const jobRef = (label) => {
      const v = jobFor(label);
      if (v !== NEW) return v;
      const key = `new:${label}`;
      newJobs.set(key, { key, name: newJobName(label).trim(), department: suggestJob(label, labels).department });
      return key;
    };
    const personRef = (name, job) => {
      const v = empFor(name);
      if (v !== NEW) return v;
      const key = `new:${name}`;
      const p = newPeople.get(key) || { key, name: personName(name), jobs: [] };
      if (job && !p.jobs.includes(job)) p.jobs.push(job);
      newPeople.set(key, p);
      return key;
    };
    if (parsed.mode === 'grid') {
      for (const sec of parsed.sections) {
        const job = jobFor(sec.label) ? jobRef(sec.label) : '';
        for (const row of sec.rows) {
          if (!job) { if (row.cells.length) skipped.add(sec.label); continue; }
          const user = empFor(row.name) ? personRef(row.name, job) : '';
          for (const c of row.cells) {
            if (!user) { skipped.add(row.name); continue; }
            const date = dateOf(c.dow);
            if (c.parsed.timeOff) tos.push({ user, date });
            else shifts.push({ date, user, job, start: c.parsed.start, end: c.parsed.end, tag: c.parsed.tag });
          }
        }
      }
    } else if (parsed.mode === 'csv') {
      for (const r of parsed.csvRows) {
        const job = r.job ? (jobFor(r.job) ? jobRef(r.job) : '') : people.find((p) => p.id === empFor(r.name))?.jobCodes?.[0]?.jobCodeId;
        const user = job && empFor(r.name) ? personRef(r.name, job) : '';
        if (!user || !job) { skipped.add(!user ? r.name : r.job); continue; }
        shifts.push({ date: r.date, user, job, start: r.start, end: r.end, tag: r.tag });
      }
    }
    const keys = new Set();
    let dupes = 0;
    for (const s of shifts) { const k = `${s.user}|${s.date}|${s.start}`; if (keys.has(k)) dupes++; else keys.add(k); }
    const events = opts.events ? found.events.filter((_, i) => !skipEvent[i]).map((e) => ({ ...e, date: dateOf(e.dow), notes: `From the schedule: ${e.source}` })) : [];
    // The sheet's projected covers include event guests; the forecast adds those from the events.
    const guests = {};
    for (const e of events) guests[e.date] = (guests[e.date] || 0) + e.guestCount;
    const covers = opts.covers ? parsed.covers.map((c) => ({ date: dateOf(c.dow), covers: Math.max(0, c.covers - (guests[dateOf(c.dow)] || 0)) })) : [];
    return { shifts, tos, dupes, events, covers, newJobs: [...newJobs.values()], newPeople: [...newPeople.values()], skipped: [...skipped] };
  }, [parsed, jobMap, jobNames, empMap, ws, opts, skipEvent, found, employees, jobCodes]);

  const badJobName = plan.newJobs.some((j) => !j.name);

  const loadFile = async (f) => {
    if (!f) return;
    setFileName(f.name);
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      const reader = __DEMO__ ? null : await import('../pdf.js');
      if (!reader) return toast('PDF import works in the hosted app', 'bad');
      setReading(true);
      try {
        const t = await reader.pdfToGridText(f);
        if (!t.trim()) toast('Couldn’t find a schedule in that PDF (it needs day names across the top)', 'bad');
        setText(t);
      } catch (e) {
        toast(`Couldn’t read that PDF: ${e.message}`, 'bad');
      } finally {
        setReading(false);
      }
    } else {
      setText(await f.text());
    }
  };

  const doImport = async () => {
    const r = await run(() => call('import.apply', {
      newJobCodes: plan.newJobs, newEmployees: plan.newPeople, shifts: plan.shifts,
      timeOff: opts.timeOff ? plan.tos : [], events: plan.events, covers: plan.covers, skipDuplicates: opts.dupes,
    }), (r) => [
      `Imported ${r.shifts} draft shifts`,
      r.employees && `${r.employees} new people`, r.jobCodes && `${r.jobCodes} job codes`, r.events && `${r.events} events`,
      r.timeOff && `${r.timeOff} requests off`, r.duplicates && `${r.duplicates} duplicates skipped`,
    ].filter(Boolean).join(' · '));
    if (r) onClose(true);
  };

  const summary = [
    `${plan.shifts.length - (opts.dupes ? plan.dupes : 0)} shifts`,
    plan.newPeople.length && `${plan.newPeople.length} new people`,
    plan.newJobs.length && `${plan.newJobs.length} new job codes`,
    plan.events.length && `${plan.events.length} events`,
    opts.timeOff && plan.tos.length && `${plan.tos.length} requests off`,
  ].filter(Boolean).join(' · ');

  return (
    <Modal wide title="Import schedule" sub="Upload the schedule PDF, or paste from Excel / Google Sheets" onClose={() => onClose(false)}
      footer={<>
        <span className="small muted" style={{ marginRight: 'auto' }}>{plan.shifts.length ? `${summary} ready` : 'Nothing to import yet'}</span>
        <button className="btn" onClick={() => onClose(false)}>Cancel</button>
        <button className="btn primary" disabled={!plan.shifts.length || busy || badJobName} onClick={doImport}><Icon name="upload" />Import as drafts</button>
      </>}>
      <div className="alert info"><Icon name="sparkle" size={16} />
        <div>Upload the <b>PDF</b> of your weekly schedule, or copy the whole sheet in Excel and paste it below. Sections like <b>Servers · MONDAY · TUESDAY…</b>, banners like <b>RABBIT HOLE</b>, cells like <b>4PM</b>, <b>3:30PM BC</b>, <b>1-9PM</b>, <b>REQUEST OFF</b>, the dates, event notes and projected covers are all read. Everything comes in as drafts until you publish.</div>
      </div>

      <div className="row wrap">
        <label className="btn primary sm"><Icon name="upload" />{reading ? 'Reading…' : 'Upload PDF / CSV'}
          <input type="file" accept=".pdf,application/pdf,.csv,.tsv,.txt" hidden disabled={reading} onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {fileName && <span className="small muted">{fileName}</span>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => { setFileName(''); setText(SAMPLE); }}>Try sample</button>
      </div>

      <Field label="Week to import into" help={parsed.weekOf ? `Taken from the dates on the schedule (${prettyDate(parsed.weekOf)}).` : undefined}>
        <div className="row">
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))}><Icon name="left" /></button>
          <div style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{weekLabel(ws)}</div>
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))}><Icon name="right" /></button>
        </div>
      </Field>

      <Field label={fileName ? `Schedule read from ${fileName}` : 'Or paste here'}>
        <textarea className="input" style={{ minHeight: fileName ? 90 : 140, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} />
      </Field>

      {labels.length > 0 && (
        <div className="grid2">
          <div className="col">
            <h3>Sections → job codes</h3>
            {labels.map((l) => {
              const v = jobFor(l);
              return (
                <div key={l} className="col" style={{ gap: 4 }}>
                  <div className="row">
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{l}</span>
                    <select className="input sm" style={{ width: 190 }} value={v} onChange={(e) => setJobMap((m) => ({ ...m, [l]: e.target.value }))}>
                      <option value={NEW}>＋ New job code</option>
                      <option value="">Skip this section</option>
                      {activeJobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                    </select>
                  </div>
                  {v === NEW && <input className="input sm" style={{ alignSelf: 'flex-end', width: 190 }} value={newJobName(l)} placeholder="Job code name"
                    onChange={(e) => setJobNames((m) => ({ ...m, [l]: e.target.value }))} />}
                </div>
              );
            })}
          </div>
          <div className="col">
            <h3>Names → people</h3>
            <div className="col" style={{ maxHeight: 300, overflowY: 'auto', gap: 6 }}>
              {names.map((n) => {
                const v = empFor(n);
                return (
                  <div key={n} className="row">
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: v === '' ? 'var(--text-3)' : undefined }}>{n}{v === NEW && <span className="badge ok" style={{ marginLeft: 6 }}>new</span>}</span>
                    <select className="input sm" style={{ width: 190 }} value={v} onChange={(e) => setEmpMap((m) => ({ ...m, [n]: e.target.value }))}>
                      <option value={NEW}>＋ Add as {personName(n)}</option>
                      <option value="">Skip</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
            {plan.newPeople.length > 0 && <div className="help">New people are added as Employees with their job codes. Add their email in Team to send a sign-in link.</div>}
          </div>
        </div>
      )}

      {found.events.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <label className="check"><input type="checkbox" checked={opts.events} onChange={(e) => setOpts({ ...opts, events: e.target.checked })} /><b>Create {found.events.length} events from the schedule notes</b></label>
          {opts.events && found.events.map((e, i) => (
            <label key={i} className="check small" style={{ marginLeft: 24 }}>
              <input type="checkbox" checked={!skipEvent[i]} onChange={(x) => setSkipEvent((m) => ({ ...m, [i]: !x.target.checked }))} />
              {prettyDate(dateOf(e.dow))} · {e.name}{e.room ? ` · ${e.room}` : ''} · {e.guestCount} guests
            </label>
          ))}
          {opts.events && <div className="help" style={{ marginLeft: 24 }}>Created as confirmed events. Add times, menus, drinks and staffing on each BEO.</div>}
        </div>
      )}
      {found.dayNotes.length > 0 && (
        <div className="small muted">Also on the schedule: {found.dayNotes.map((n) => `${prettyDate(dateOf(n.dow))} ${titleCase(n.text)}`).join(' · ')}</div>
      )}
      {parsed.covers.length > 0 && (
        <label className="check"><input type="checkbox" checked={opts.covers} onChange={(e) => setOpts({ ...opts, covers: e.target.checked })} />
          Use the projected covers ({parsed.covers.map((c) => c.covers).join(', ')}) as this week's forecast{opts.events && plan.events.length ? ', minus event guests (the forecast adds those from the events)' : ''}
        </label>
      )}
      {plan.dupes > 0 && <label className="check"><input type="checkbox" checked={opts.dupes} onChange={(e) => setOpts({ ...opts, dupes: e.target.checked })} />Skip {plan.dupes} duplicate shifts (same person, same day, same start, listed in two sections) and any already on the schedule</label>}
      {plan.tos.length > 0 && <label className="check"><input type="checkbox" checked={opts.timeOff} onChange={(e) => setOpts({ ...opts, timeOff: e.target.checked })} />Also record {plan.tos.length} “REQUEST OFF” cells as approved time off</label>}
      {badJobName && <div className="alert bad"><Icon name="alert" size={16} />Give every new job code a name.</div>}
      {plan.skipped.length > 0 && <div className="alert warn"><Icon name="alert" size={16} />Skipping: {plan.skipped.join(', ')}.</div>}
      {parsed.problems.length > 0 && <div className="alert warn"><Icon name="alert" size={16} /><div>Couldn't read {parsed.problems.length} cell(s), so they're left out: {parsed.problems.slice(0, 5).join('; ')}{parsed.problems.length > 5 ? '…' : ''}</div></div>}
    </Modal>
  );
}
