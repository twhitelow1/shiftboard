import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, useAction } from '../ui.jsx';
import { parseSchedule, readSections, dateForDow, matchPeople, matchPosition, positionName, departmentFor, suggestRole, notesToEvents, personName, titleCase } from '../../../core/importer.js';
import { scheduleAreas, findArea, uniqueAreas } from '../../../core/areas.js';
import { ROLES, rankOf, roleLabel, assignableRoles } from '../../../core/roles.js';
import { addDays, weekStart } from '../../../core/time.js';
import { weekLabel } from './Schedule.jsx';
import { tx, useT, prettyDate } from '../i18n/index.js';

const NEW = '__new__';
const SAMPLE = `SERVER\tMONDAY\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY
ALEX D\tOFF\t3:30PM BC\tOFF\t4PM\t4:30PM*\t3:30PM BC\tOFF
STYVES\tOFF\t4PM LIB\t4PM\tOFF\t4PM\t4PM\tOFF`;

// Ask ShiftBoard opens it with the grid it found in a file (initialText, initialName).
export default function ImportDialog({ ws: initialWs, onClose, initialText = '', initialName = '' }) {
  const t = useT();
  const { employees, jobCodes, settings, call, toast, me } = useApp();
  const [text, setText] = useState(initialText);
  const [pdfColors, setPdfColors] = useState({}); // banner text → cell color, read from the PDF
  const [fileName, setFileName] = useState(initialName);
  const [reading, setReading] = useState(false);
  const [ws, setWs] = useState(initialWs);
  const [jobMap, setJobMap] = useState({});     // section label -> job id | NEW | ''
  const [jobNames, setJobNames] = useState({}); // section label -> name for a new job code
  const [areaMap, setAreaMap] = useState({});   // section label -> area name | ''
  const [empMap, setEmpMap] = useState({});     // schedule name -> user id | NEW | ''
  const [roleMap, setRoleMap] = useState({});   // section label -> role for new people
  const [opts, setOpts] = useState({ timeOff: true, dupes: true, events: true, covers: true, notes: true });
  const [skipEvent, setSkipEvent] = useState({});
  const [run, busy] = useAction();

  const parsed = useMemo(() => parseSchedule(text), [text]);
  // Jump to the week printed on the schedule.
  useEffect(() => { if (parsed.weekOf) setWs(weekStart(parsed.weekOf, settings.weekStartDow)); }, [parsed.weekOf, settings.weekStartDow]);

  const activeJobs = jobCodes.filter((j) => !j.archived);
  const people = employees.filter((e) => e.onSchedule !== false);
  // Each section's area (its banner) and position (its own label), e.g. RABBIT HOLE · Bar → Rabbit Hole, Bar.
  const read = useMemo(() => (parsed.mode === 'grid' ? readSections(parsed.sections)
    : [...new Set(parsed.csvRows.map((r) => r.job).filter(Boolean))].map((job) => ({ label: job, area: '', position: job, inferred: false }))), [parsed]);
  const info = Object.fromEntries(read.map((r) => [r.label, r]));
  const labels = read.map((r) => r.label);
  const knownAreas = scheduleAreas(settings);
  const areaName = (raw) => (raw ? findArea(raw, knownAreas) || titleCase(raw) : '');
  // Areas offered: the ones the schedule has, then the new ones on this sheet.
  const areaChoices = uniqueAreas([...knownAreas, ...read.map((r) => areaName(r.area)), ...parsed.csvRows.map((r) => areaName(r.area))]);
  const names = useMemo(() => {
    const s = new Set();
    parsed.sections.forEach((sec) => sec.rows.forEach((r) => s.add(r.name)));
    parsed.csvRows.forEach((r) => s.add(r.name));
    return [...s];
  }, [parsed]);

  const jobFor = (label) => jobMap[label] ?? (matchPosition(info[label]?.position, activeJobs)?.id || NEW);
  const newJobName = (label) => jobNames[label] ?? positionName(info[label]?.position) ?? '';
  const areaFor = (label) => areaMap[label] ?? areaName(info[label]?.area);
  // Names → people, surest first (name on the schedule, full name, first name, then a guess).
  const auto = useMemo(() => matchPeople(names, people), [names, employees]);
  const empFor = (name) => empMap[name] ?? (auto.get(name)?.id || NEW);
  const isGuess = (name) => empMap[name] === undefined && auto.get(name)?.how === 'guess';
  const superAdminExists = employees.some((e) => e.role === 'super_admin' && e.active !== false);
  const roleChoices = assignableRoles(me, { superAdminExists }).filter((r) => ['manager', 'supervisor', 'employee'].includes(r));
  const roleFor = (label) => {
    const v = jobFor(label);
    const r = roleMap[label] ?? (v && v !== NEW ? jobCodes.find((j) => j.id === v)?.defaultRole : suggestRole(info[label]?.position || label)) ?? 'employee';
    return roleChoices.includes(r) ? r : 'employee';
  };
  const found = useMemo(() => notesToEvents(parsed.notes, settings.rooms || []), [parsed, settings.rooms]);
  const dateOf = (dow) => dateForDow(ws, settings.weekStartDow, dow);

  const plan = useMemo(() => {
    const shifts = [], tos = [], assignments = [], newJobs = new Map(), newPeople = new Map(), skipped = new Set();
    // Sections that make the same new position ("Bar" under two banners) share one job code.
    const jobRef = (label) => {
      const v = jobFor(label);
      if (v !== NEW) return v;
      const name = newJobName(label).trim();
      const key = `new:${name.toLowerCase()}`;
      if (!newJobs.has(key)) newJobs.set(key, { key, name, department: departmentFor(info[label]?.position, areaFor(label), info[label]?.area ? '' : info[label]?.banner), defaultRole: roleFor(label) });
      return key;
    };
    const personRef = (name, job, role) => {
      const v = empFor(name);
      if (v !== NEW) return v;
      const key = `new:${name}`;
      const p = newPeople.get(key) || { key, name: personName(name), jobs: [], role: 'employee' };
      if (job && !p.jobs.includes(job)) p.jobs.push(job);
      if (role && rankOf({ role }) > rankOf({ role: p.role })) p.role = role; // in two sections → the higher role
      newPeople.set(key, p);
      return key;
    };
    if (parsed.mode === 'grid') {
      for (const sec of parsed.sections) {
        const job = jobFor(sec.label) ? jobRef(sec.label) : '';
        const area = areaFor(sec.label);
        for (const row of sec.rows) {
          if (!job) { if (row.cells.length) skipped.add(sec.label); continue; }
          const user = empFor(row.name) ? personRef(row.name, job, roleFor(sec.label)) : '';
          if (user) assignments.push({ user, job, area });
          for (const c of row.cells) {
            if (!user) { skipped.add(row.name); continue; }
            const date = dateOf(c.dow);
            if (c.parsed.timeOff) tos.push({ user, date });
            else shifts.push({ date, user, job, area, start: c.parsed.start, end: c.parsed.end, tag: c.parsed.tag });
          }
        }
      }
    } else if (parsed.mode === 'csv') {
      for (const r of parsed.csvRows) {
        const job = r.job ? (jobFor(r.job) ? jobRef(r.job) : '') : people.find((p) => p.id === empFor(r.name))?.jobCodes?.[0]?.jobCodeId;
        const user = job && empFor(r.name) ? personRef(r.name, job) : '';
        if (!user || !job) { skipped.add(!user ? r.name : r.job); continue; }
        shifts.push({ date: r.date, user, job, area: areaName(r.area), start: r.start, end: r.end, tag: r.tag });
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
    const areas = uniqueAreas(shifts.map((s) => s.area).concat(assignments.map((x) => x.area)));
    const jobOrder = parsed.mode === 'grid' ? [...new Set(parsed.sections.map((sec) => (jobFor(sec.label) ? jobRef(sec.label) : '')).filter(Boolean))] : [];
    // Banner colors from the PDF, for the area (or, for a banner like M.O.D., the job's department).
    const areaColors = {};
    for (const r of read) {
      const color = pdfColors[String(r.banner || '').toUpperCase()];
      if (!color || !jobFor(r.label)) continue;
      const v = jobFor(r.label);
      const name = areaFor(r.label) || (v === NEW ? newJobs.get(`new:${newJobName(r.label).trim().toLowerCase()}`)?.department : jobCodes.find((j) => j.id === v)?.department);
      if (name && !areaColors[name]) areaColors[name] = color;
    }
    const dayNotes = opts.notes ? found.dayNotes.map((n) => ({ date: dateOf(n.dow), text: n.text })) : [];
    // Each section as laid out on the sheet: banner and label as written, names in order.
    const rosters = parsed.mode !== 'grid' ? [] : parsed.sections.filter((sec) => jobFor(sec.label)).map((sec) => ({
      area: areaFor(sec.label), job: jobRef(sec.label), label: sec.role || '', banner: sec.banner || '',
      users: sec.rows.map((r) => (empFor(r.name) ? personRef(r.name) : '')).filter(Boolean),
    }));
    // How the sheet writes existing people's names (MOE for Louis Henson), remembered for next time.
    const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sheetNames = names.map((n) => ({ n, p: people.find((x) => x.id === empFor(n)) }))
      .filter(({ n, p }) => p && !p.sheetName && key(p.name) !== key(n)).map(({ n, p }) => ({ user: p.id, name: personName(n) }));
    return { shifts, tos, assignments, areas, jobOrder, areaColors, dayNotes, rosters, sheetNames, dupes, events, covers, newJobs: [...newJobs.values()], newPeople: [...newPeople.values()], skipped: [...skipped] };
  }, [parsed, jobMap, jobNames, areaMap, empMap, roleMap, ws, opts, skipEvent, found, employees, jobCodes, settings, pdfColors]);

  const badJobName = plan.newJobs.some((j) => !j.name);

  const loadFile = async (f) => {
    if (!f) return;
    setFileName(f.name);
    setPdfColors({});
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      const reader = __DEMO__ ? null : await import('../pdf.js');
      if (!reader) return toast(tx('importDialog.pdfImportWorksInThe'), 'bad');
      setReading(true);
      try {
        const { text: t, colors } = await reader.pdfToGridText(f);
        if (!t.trim()) toast(tx('importDialog.couldntFindAScheduleIn'), 'bad');
        setText(t);
        setPdfColors(colors || {});
      } catch (e) {
        toast(tx('importDialog.couldntReadThatPdfMessage', { message: e.message }), 'bad');
      } finally {
        setReading(false);
      }
    } else {
      setText(await f.text());
    }
  };

  const doImport = async () => {
    const r = await run(() => call('import.apply', {
      newJobCodes: plan.newJobs, newEmployees: plan.newPeople, shifts: plan.shifts, assignments: plan.assignments, areas: plan.areas, jobOrder: plan.jobOrder, areaColors: plan.areaColors, dayNotes: plan.dayNotes, rosters: plan.rosters, sheetNames: plan.sheetNames,
      timeOff: opts.timeOff ? plan.tos : [], events: plan.events, covers: plan.covers, skipDuplicates: opts.dupes,
    }), (r) => [
      `Imported ${r.shifts} draft shifts`, r.updated && `${r.updated} existing shifts updated`,
      r.employees && `${r.employees} new people`, r.jobCodes && `${r.jobCodes} job codes`, r.areas && `${r.areas} areas`, r.events && `${r.events} events`,
      r.timeOff && `${r.timeOff} requests off`, r.notes && `${r.notes} day notes`, r.sheetNames && `${r.sheetNames} schedule names remembered`, r.duplicates && `${r.duplicates} duplicates skipped`, r.rolesLowered && `${r.rolesLowered} added as Employee (your role can't give that role)`,
    ].filter(Boolean).join(' · '));
    if (r) onClose(true);
  };

  const summary = [
    `${plan.shifts.length - (opts.dupes ? plan.dupes : 0)} shifts`,
    plan.newPeople.length && `${plan.newPeople.length} new people`,
    plan.newJobs.length && `${plan.newJobs.length} new job codes`,
    plan.areas.filter((a) => !findArea(a, knownAreas)).length && `${plan.areas.filter((a) => !findArea(a, knownAreas)).length} new areas`,
    plan.events.length && `${plan.events.length} events`,
    opts.timeOff && plan.tos.length && `${plan.tos.length} requests off`,
  ].filter(Boolean).join(' · ');

  return (
    <Modal wide title={t('importDialog.importSchedule')} sub={t('importDialog.uploadTheSchedulePdfOr')} onClose={() => onClose(false)}
      footer={<>
        <span className="small muted" style={{ marginRight: 'auto' }}>{plan.shifts.length ? t('importDialog.summaryReady', { summary }) : t('importDialog.nothingToImportYet')}</span>
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!plan.shifts.length || busy || badJobName} onClick={doImport}><Icon name="upload" />{t('importDialog.importAsDrafts')}</button>
      </>}>
      <div className="alert info"><Icon name="sparkle" size={16} />
        <div>{t('importDialog.uploadTheBPdfB')}</div>
      </div>

      <div className="row wrap">
        <label className="btn primary sm"><Icon name="upload" />{reading ? t('importDialog.reading') : t('importDialog.uploadPdfCsv')}
          <input type="file" accept=".pdf,application/pdf,.csv,.tsv,.txt" hidden disabled={reading} onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {fileName && <span className="small muted">{fileName}</span>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => { setFileName(''); setText(SAMPLE); }}>{t('importDialog.trySample')}</button>
      </div>

      <Field label={t('importDialog.weekToImportInto')} help={parsed.weekOf ? t('importDialog.takenFromTheDatesOn', { date: prettyDate(parsed.weekOf) }) : undefined}>
        <div className="row">
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))}><Icon name="left" /></button>
          <div style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{weekLabel(ws)}</div>
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))}><Icon name="right" /></button>
        </div>
      </Field>

      <Field label={fileName ? t('importDialog.scheduleReadFromFilename', { fileName }) : t('importDialog.orPasteHere')}>
        <textarea className="input" style={{ minHeight: fileName ? 90 : 140, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} />
      </Field>

      {labels.length > 0 && (
        <div className="col" style={{ gap: 8 }}>
          <h3>{parsed.mode === 'grid' ? t('importDialog.sectionsAreaAndPosition') : t('importDialog.jobsJobCodes')}</h3>
          {parsed.mode === 'grid' && <div className="help" style={{ marginTop: -4 }}>{t('importDialog.theBannerOverASection')}</div>}
          <div className="imp-secs">
            {labels.map((l) => {
              const v = jobFor(l), r = info[l];
              const area = areaFor(l);
              return (
                <div key={l} className="imp-sec">
                  <div className="imp-sec-label">
                    <b>{l}</b>
                    {r?.inferred && <div className="small muted">{t('importDialog.noLabelOnTheSheet')}</div>}
                  </div>
                  {parsed.mode === 'grid' && (
                    <label className="imp-ctl"><span>{t('importDialog.area')}</span>
                      <select className="input sm" value={area} onChange={(e) => setAreaMap((m) => ({ ...m, [l]: e.target.value }))}>
                        <option value="">{t('importDialog.noArea')}</option>
                        {areaChoices.map((a) => <option key={a} value={a}>{a}{findArea(a, knownAreas) ? '' : t('importDialog.new')}</option>)}
                      </select>
                    </label>
                  )}
                  <label className="imp-ctl"><span>{t('common.position')}</span>
                    <select className="input sm" value={v} onChange={(e) => setJobMap((m) => ({ ...m, [l]: e.target.value }))}>
                      <option value={NEW}>{t('importDialog.newJobCode')}</option>
                      <option value="">{t('importDialog.skipThisSection')}</option>
                      {activeJobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                    </select>
                  </label>
                  {v === NEW && (
                    <label className="imp-ctl"><span>{t('importDialog.newJobCode2')}</span>
                      <input className="input sm" value={newJobName(l)} placeholder={t('importDialog.jobCodeName')} onChange={(e) => setJobNames((m) => ({ ...m, [l]: e.target.value }))} />
                    </label>
                  )}
                  {v !== '' && parsed.mode === 'grid' && (
                    <label className="imp-ctl"><span>{t('importDialog.newPeopleAre')}</span>
                      <select className="input sm" title={t('importDialog.roleForNewPeopleFrom')} value={roleFor(l)} onChange={(e) => setRoleMap((m) => ({ ...m, [l]: e.target.value }))}>
                        {ROLES.filter((x) => roleChoices.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{roleLabel(x.id, t.lang)}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              );
            })}
          </div>

          <h3 style={{ marginTop: 6 }}>{t('importDialog.namesPeople')}</h3>
          <div className="imp-names">
            {names.map((n) => {
              const v = empFor(n);
              return (
                <div key={n} className="row">
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: v === '' ? 'var(--text-3)' : undefined, minWidth: 0 }}>{n}
                    {v === NEW && <span className="badge ok" style={{ marginLeft: 6 }}>{t('importDialog.new2')}</span>}
                    {isGuess(n) && <span className="badge warn" style={{ marginLeft: 6 }} title={t('importDialog.matchedByACloseSpelling')}>{t('importDialog.check')}</span>}
                  </span>
                  <select className="input sm" style={{ width: 170 }} value={v} onChange={(e) => setEmpMap((m) => ({ ...m, [n]: e.target.value }))}>
                    <option value={NEW}>{t('importDialog.addAsPersonname', { personName: personName(n) })}</option>
                    <option value="">{t('importDialog.skip')}</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sheetName ? ` (${p.sheetName})` : ''}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          <div className="help">{t('importDialog.namesAreMatchedByEach')}</div>
          {plan.newPeople.length > 0 && <div className="help">{t('importDialog.newPeopleGetTheirSections')}{[...new Set(plan.newPeople.map((p) => roleLabel(p.role, t.lang)))].join(', ')}{t('importDialog.positionAndAreasPeopleAlready')}</div>}
        </div>
      )}

      {found.events.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <label className="check"><input type="checkbox" checked={opts.events} onChange={(e) => setOpts({ ...opts, events: e.target.checked })} />{t('importDialog.bCreateEventscountEventsFrom', { eventsCount: found.events.length })}</label>
          {opts.events && found.events.map((e, i) => (
            <label key={i} className="check small" style={{ marginLeft: 24 }}>
              <input type="checkbox" checked={!skipEvent[i]} onChange={(x) => setSkipEvent((m) => ({ ...m, [i]: !x.target.checked }))} />
              {prettyDate(dateOf(e.dow))} · {e.name}{e.room ? ` · ${e.room}` : ''}{' '}{t('importDialog.guestcountGuests', { guestCount: e.guestCount })}</label>
          ))}
          {opts.events && <div className="help" style={{ marginLeft: 24 }}>{t('importDialog.createdAsConfirmedEventsAdd')}</div>}
        </div>
      )}
      {found.dayNotes.length > 0 && (
        <label className="check"><input type="checkbox" checked={opts.notes} onChange={(e) => setOpts({ ...opts, notes: e.target.checked })} />
          <span>{t('importDialog.showTheSheetsDayNotes')}{' '}{found.dayNotes.map((n) => `${prettyDate(dateOf(n.dow))} ${titleCase(n.text)}`).join(' · ')}</span></label>
      )}
      {Object.keys(plan.areaColors).length > 0 && (
        <div className="row wrap small muted" style={{ gap: 6 }}>{t('importDialog.bannerColorsFromThePdf')}{Object.entries(plan.areaColors).map(([n, c]) => <span key={n} className="sheet-swatch" style={{ background: c }}>{n}</span>)}
        </div>
      )}
      {parsed.covers.length > 0 && (
        <label className="check"><input type="checkbox" checked={opts.covers} onChange={(e) => setOpts({ ...opts, covers: e.target.checked })} />{t('importDialog.useTheProjectedCovers')}{parsed.covers.map((c) => c.covers).join(', ')}{t('importDialog.asThisWeeksForecast')}{opts.events && plan.events.length ? t('importDialog.minusEventGuestsTheForecast') : ''}
        </label>
      )}
      <label className="check"><input type="checkbox" checked={opts.dupes} onChange={(e) => setOpts({ ...opts, dupes: e.target.checked })} />
        <span>{t('importDialog.dontDoubleUp')}{' '}{plan.dupes > 0 ? t('importDialog.skipDupesShiftsListedTwice', { dupes: plan.dupes }) : ''}{t('importDialog.updateShiftsAlreadyOnThe')}</span></label>
      {plan.tos.length > 0 && <label className="check"><input type="checkbox" checked={opts.timeOff} onChange={(e) => setOpts({ ...opts, timeOff: e.target.checked })} />{t('importDialog.alsoRecordToscountRequestOff', { tosCount: plan.tos.length })}</label>}
      {badJobName && <div className="alert bad"><Icon name="alert" size={16} />{t('importDialog.giveEveryNewJobCode')}</div>}
      {plan.skipped.length > 0 && <div className="alert warn"><Icon name="alert" size={16} />{t('importDialog.skipping')}{' '}{plan.skipped.join(', ')}.</div>}
      {parsed.problems.length > 0 && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('importDialog.couldntReadProblemscountCellS', { problemsCount: parsed.problems.length })}{' '}{parsed.problems.slice(0, 5).join('; ')}{parsed.problems.length > 5 ? '…' : ''}</div></div>}
    </Modal>
  );
}
