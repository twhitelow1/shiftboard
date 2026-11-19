import React, { useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, useAction } from '../ui.jsx';
import { parseSchedule, dateForDow, matchEmployee, matchJob } from '../../../core/importer.js';
import { addDays } from '../../../core/time.js';
import { weekLabel } from './Schedule.jsx';

const SAMPLE = `SERVER\tMONDAY\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY
ALEX D\tOFF\t3:30PM BC\tOFF\t4PM\t4:30PM*\t3:30PM BC\tOFF
STYVES\tOFF\t4PM LIB\t4PM\tOFF\t4PM\t4PM\tOFF`;

export default function ImportDialog({ ws: initialWs, onClose }) {
  const { employees, jobCodes, settings, call } = useApp();
  const [text, setText] = useState('');
  const [ws, setWs] = useState(initialWs);
  const [jobMap, setJobMap] = useState({});
  const [empMap, setEmpMap] = useState({});
  const [timeOff, setTimeOff] = useState(true);
  const [run, busy] = useAction();

  const parsed = useMemo(() => parseSchedule(text), [text]);
  const activeJobs = jobCodes.filter((j) => !j.archived);
  const people = employees.filter((e) => e.onSchedule !== false);

  const jobFor = (label) => jobMap[label] ?? matchJob(label, activeJobs)?.id ?? '';
  const empFor = (name) => empMap[name] ?? matchEmployee(name, people)?.id ?? '';

  const plan = useMemo(() => {
    const shifts = [], tos = [], skipped = new Set();
    if (parsed.mode === 'grid') {
      for (const sec of parsed.sections) {
        const jobCodeId = jobFor(sec.label);
        for (const row of sec.rows) {
          const userId = empFor(row.name);
          for (const c of row.cells) {
            const date = dateForDow(ws, settings.weekStartDow, c.dow);
            if (c.parsed.timeOff) { if (userId) tos.push({ userId, date }); continue; }
            if (!userId || !jobCodeId) { skipped.add(!userId ? row.name : sec.label); continue; }
            shifts.push({ date, userId, jobCodeId, start: c.parsed.start, end: c.parsed.end, tag: c.parsed.tag });
          }
        }
      }
    } else if (parsed.mode === 'csv') {
      for (const r of parsed.csvRows) {
        const userId = empFor(r.name);
        const jobCodeId = r.job ? jobFor(r.job) : people.find((p) => p.id === userId)?.jobCodes?.[0]?.jobCodeId;
        if (!userId || !jobCodeId) { skipped.add(!userId ? r.name : r.job); continue; }
        shifts.push({ date: r.date, userId, jobCodeId, start: r.start, end: r.end, tag: r.tag });
      }
    }
    return { shifts, tos, skipped: [...skipped] };
  }, [parsed, jobMap, empMap, ws]);

  const names = useMemo(() => {
    const s = new Set();
    parsed.sections.forEach((sec) => sec.rows.forEach((r) => s.add(r.name)));
    parsed.csvRows.forEach((r) => s.add(r.name));
    return [...s];
  }, [parsed]);
  const labels = parsed.mode === 'grid' ? parsed.sections.map((s) => s.label) : [...new Set(parsed.csvRows.map((r) => r.job).filter(Boolean))];

  const doImport = async () => {
    const r = await run(async () => {
      const res = await call('shifts.bulkCreate', { shifts: plan.shifts, publish: false });
      if (timeOff) {
        for (const t of plan.tos) await call('timeOff.create', { userId: t.userId, startDate: t.date, endDate: t.date, reason: 'Imported: request off' });
      }
      return res;
    }, (r) => `Imported ${r.created} draft shifts${timeOff && plan.tos.length ? ` and ${plan.tos.length} requests off` : ''}`);
    if (r) onClose(true);
  };

  return (
    <Modal wide title="Import schedule" sub="Paste straight from your Excel / Google Sheets schedule, or a CSV" onClose={() => onClose(false)}
      footer={<>
        <span className="small muted" style={{ marginRight: 'auto' }}>{plan.shifts.length} shifts{plan.tos.length ? ` · ${plan.tos.length} requests off` : ''} ready</span>
        <button className="btn" onClick={() => onClose(false)}>Cancel</button>
        <button className="btn primary" disabled={!plan.shifts.length || busy} onClick={doImport}><Icon name="upload" />Import as drafts</button>
      </>}>
      <div className="alert info"><Icon name="sparkle" size={16} />
        <div>Select your whole schedule in Excel (all sections), copy, and paste below. Section headers like <b>SERVER · MONDAY · TUESDAY…</b> are detected automatically, and cells like <b>4PM</b>, <b>3:30PM BC</b>, <b>12-4PM</b>, <b>REQUEST OFF</b> are understood. CSV with <code>date,employee,job,start,end,tag</code> also works.</div>
      </div>
      <Field label="Week to import into">
        <div className="row">
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))}><Icon name="left" /></button>
          <div style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{weekLabel(ws)}</div>
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))}><Icon name="right" /></button>
        </div>
      </Field>
      <Field label="Paste here">
        <textarea className="input" style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} />
      </Field>
      <div className="row">
        <label className="btn sm"><Icon name="upload" />Load .csv / .tsv file
          <input type="file" accept=".csv,.tsv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        </label>
        <button className="btn sm ghost" onClick={() => setText(SAMPLE)}>Try sample</button>
      </div>

      {labels.length > 0 && (
        <div className="grid2">
          <div className="col">
            <h3>Sections → job codes</h3>
            {labels.map((l) => (
              <div key={l} className="row">
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{l}</span>
                <select className="input sm" style={{ width: 180 }} value={jobFor(l)} onChange={(e) => setJobMap((m) => ({ ...m, [l]: e.target.value }))}>
                  <option value="">Skip</option>
                  {activeJobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="col">
            <h3>Names → employees</h3>
            <div className="col" style={{ maxHeight: 260, overflowY: 'auto', gap: 6 }}>
              {names.map((n) => (
                <div key={n} className="row">
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: empFor(n) ? undefined : 'var(--bad)' }}>{n}</span>
                  <select className="input sm" style={{ width: 180 }} value={empFor(n)} onChange={(e) => setEmpMap((m) => ({ ...m, [n]: e.target.value }))}>
                    <option value="">Not matched — skip</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {plan.tos.length > 0 && <label className="check"><input type="checkbox" checked={timeOff} onChange={(e) => setTimeOff(e.target.checked)} />Also record {plan.tos.length} “REQUEST OFF” cells as approved time off</label>}
      {plan.skipped.length > 0 && <div className="alert warn"><Icon name="alert" size={16} />Skipping (not matched): {plan.skipped.join(', ')}. Add them in Team, or match them above.</div>}
      {parsed.problems.length > 0 && <div className="alert warn"><Icon name="alert" size={16} /><div>Couldn't read {parsed.problems.length} cell(s): {parsed.problems.slice(0, 5).join('; ')}{parsed.problems.length > 5 ? '…' : ''}</div></div>}
    </Modal>
  );
}
